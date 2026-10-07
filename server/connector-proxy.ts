// Harness-owned Composio MCP bridge.
//
// Provider CLIs only see this stdio server. Ordinary MCP traffic is relayed
// to the configured Composio Session, but connection requests are converted
// into first-class Muster chat cards. The agent never authors an auth
// URL and credentials never pass through its transcript.
//
// stdout is the MCP transport. Never log there.
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { connectorGateIntent } from "./connector-gate.ts";

import type { JsonValue } from "./schema.ts";
type Json = Record<string, JsonValue>;
const recordSchema = z.record(z.string(), z.json());
const rpcIdSchema = z.union([z.string(), z.number().finite()]);
const frameSchema = z.object({ jsonrpc: z.literal("2.0"), id: rpcIdSchema.optional(), method: z.string(), params: z.json().optional() }).passthrough();
const textSchema = z.string();
const isText = (value: JsonValue | undefined): value is string => textSchema.safeParse(value).success;
const isJsonRecord = (value: JsonValue | undefined): value is Json => recordSchema.safeParse(value).success;

const UPSTREAM = process.env.OMB_CONNECTOR_UPSTREAM_URL ?? "";
const HARNESS = process.env.OMB_HARNESS_URL ?? "http://127.0.0.1:8799";
const BOT_ID = process.env.OMB_BOT_ID ?? "";
const THREAD_ID = process.env.OMB_THREAD_ID ?? "";
const TOKEN = process.env.OMB_COMMS_TOKEN ?? "";
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;

function parsedHeaders(): Record<string, string> {
  try {
    const value = recordSchema.safeParse(JSON.parse(process.env.OMB_CONNECTOR_UPSTREAM_HEADERS ?? "{}"));
    if (!value.success) return {};
    return Object.fromEntries(
      Object.entries(value.data).filter((entry): entry is [string, string] => isText(entry[1])),
    );
  } catch {
    return {};
  }
}

const upstreamHeaders = parsedHeaders();
let upstreamSessionId = "";
const send = (message: Json | ReturnType<typeof textResult>) => process.stdout.write(`${JSON.stringify(message)}\n`);

interface ConnectorTextResult { content: Array<{ type: "text"; text: string }>; isError?: boolean }
function textResult(id: JsonValue, text: string, isError = false) {
  const result: ConnectorTextResult = { content: [{ type: "text", text }] };
  if (isError) result.isError = true;
  return { jsonrpc: "2.0", id, result };
}

async function readBounded(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_RESPONSE_BYTES) throw new Error("connector response exceeded 20 MB");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("connector response exceeded 20 MB");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function parseUpstream(text: string, id: JsonValue): Json | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  // SAFETY: a leading "{" means the frame is one complete JSON object document.
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const frames = trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line && line !== "[DONE]")
    .flatMap((line): Json[] => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  return frames.findLast((frame) => frame.id === id) ?? frames.at(-1) ?? null;
}

async function relay(message: Json, state?: CallState): Promise<Json | null> {
  if (state?.controller.signal.aborted) throw new Error("Connector call cancelled before execution.");
  if (!UPSTREAM) throw new Error("connected apps are unavailable");
  const headers: Record<string, string> = {};
  headers["content-type"] = "application/json";
  headers.accept = "application/json, text/event-stream";
  Object.assign(headers, upstreamHeaders);
  if (upstreamSessionId) headers["mcp-session-id"] = upstreamSessionId;
  if (state?.permit) { headers["x-muster-connector-permit"] = state.permit; delete state.permit; }
  if (state) state.relayed = true;
  const response = await fetch(UPSTREAM, {
    method: "POST",
    headers,
    body: JSON.stringify(message),
    signal: state ? AbortSignal.any([state.controller.signal, AbortSignal.timeout(10 * 60_000)]) : AbortSignal.timeout(10 * 60_000),
  });
  const nextSession = response.headers.get("mcp-session-id");
  if (nextSession) upstreamSessionId = nextSession;
  if (!response.ok) throw new Error(`connector service returned HTTP ${response.status}`);
  return parseUpstream(await readBounded(response), message.id);
}

function connectorAdds(args: JsonValue): string[] {
  const slug = z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/);
  const toolkit = z.union([slug, z.object({ toolkit: slug.optional(), name: slug.optional(),
    action: z.enum(["add", "connect", "initiate"]).optional() }).passthrough()
    .refine(item => Boolean(item.toolkit || item.name))]);
  const parsed = z.object({ toolkits: z.array(toolkit).min(1).max(12) }).passthrough().safeParse(args);
  if (!parsed.success) return [];
  return [...new Set(parsed.data.toolkits.map(item => item instanceof Object ? (item.toolkit ?? item.name ?? "").toLowerCase() : item.toLowerCase()))];
}

// The connector gate flag (CONNECTOR-APPROVAL-GATE/v1): default ON. Only
// the explicit value "off" disables it, for local dev and tests.
const CONNECTOR_APPROVAL_OFF = process.env.MUSTER_CONNECTOR_APPROVAL === "off";
// The hold's own clock: 10 minutes by default (the harness denies at the
// same beat); tests shorten it via this knob instead of sleeping.
const APPROVAL_FETCH_TIMEOUT_MS = (() => {
  const override = Number(process.env.OMB_CONNECTOR_APPROVAL_TIMEOUT_MS ?? "");
  return Number.isFinite(override) && override > 0 && override < 10 * 60_000
    ? override
    : (10 * 60_000 + 30_000);
})();

/** Hold a write-classified connector call on an approval card. Mints the
 * card via the harness and blocks this call's own HTTP wait until it is
 * approved (the bridge relays only then), or denies — declined, timed out
 * or unreachable harness — fail-closed. */
async function requestConnectorApproval(frame: Json, state: CallState): Promise<"allow" | "deny"> {
  if (!BOT_ID || !THREAD_ID) {
    process.stderr.write("connector gate: no conversation context — denying the call\n");
    return "deny";
  }
  try {
    const response = await fetch(`${HARNESS}/api/internal/connectors/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        botId: BOT_ID,
        threadId: THREAD_ID,
        frame,
      }),
      // the harness answers when the card settles or denies at its own
      // 10-minute beat; this bound covers that with margin
      signal: AbortSignal.any([state.controller.signal, AbortSignal.timeout(APPROVAL_FETCH_TIMEOUT_MS)]),
    });
    if (!response.ok) {
      // SAFETY: harness error frames are JSON objects; only the error field is read.
      const body = (await response.json().catch(() => ({}))) as { error?: unknown };
      process.stderr.write(`connector gate: HTTP ${response.status} ${String(body.error ?? "")}\n`);
      return "deny";
    }
    const answer = z.object({ approved: z.literal(true), permit: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
      .safeParse(await response.json().catch(() => null));
    if (state.controller.signal.aborted || !answer.success) return "deny";
    state.permit = answer.data.permit;
    return "allow";
  } catch (error) {
    process.stderr.write(`connector gate: ${error instanceof Error ? error.message : String(error)}\n`);
    return "deny";
  }
}

/** The tool result a declined (or timed-out) connector call gets back. The
 * agent must not retry it — the human saw the card and said no. */
function declinedResult(actions: string[]): string {
  const named = actions.length ? actions.join(", ") : "this action";
  return `Approval was not granted for ${named}. The call was not executed; do not retry it.`;
}

async function showConnectorCards(slugs: string[], state: CallState): Promise<void> {
  const response = await fetch(`${HARNESS}/api/internal/connectors/request`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ botId: BOT_ID, threadId: THREAD_ID, slugs, resumeKey: randomUUID() }),
    signal: AbortSignal.any([state.controller.signal, AbortSignal.timeout(30_000)]),
  });
  if (!response.ok) {
    // SAFETY: harness error bodies are JSON objects; only the error field is read.
    const body = (await response.json().catch(() => ({}))) as { error?: unknown };
    throw new Error(String(body.error ?? `could not show connection card (HTTP ${response.status})`));
  }
}

interface CallState { controller: AbortController; relayed: boolean; permit?: string }
const calls = new Map<string, CallState>();
const controllers = new Set<AbortController>();
const running = new Set<Promise<void>>();
let closing = false;
const callKey = (id: string | number) => JSON.stringify(id);

async function handle(message: Json, state?: CallState): Promise<void> {
  const id = message.id;
  const method = String(message.method ?? "");
  if (method === "tools/call") {
    if (!state || id === undefined) return; // executable notifications require a request identity
    const params = isJsonRecord(message.params) ? message.params : {};
    const name = String(params.name ?? "");
    const slugs = name === "COMPOSIO_MANAGE_CONNECTIONS" ? connectorAdds(params.arguments) : [];
    if (name === "COMPOSIO_MANAGE_CONNECTIONS") {
      if (!slugs.length || slugs.length > 12) throw new Error("A complete, bounded connection request is required.");
      await showConnectorCards(slugs, state);
      if (state.controller.signal.aborted) return;
      send(textResult(id, `Muster showed the user a secure connection card for ${slugs.join(", ")}. End this turn now. The app will continue the task automatically after the connection finishes.`));
      return;
    }
    if (name === "COMPOSIO_WAIT_FOR_CONNECTIONS") {
      send(textResult(id, "Muster is handling connection completion and will continue the task automatically."));
      return;
    }
    const intent = connectorGateIntent(name, params.arguments);
    if (intent.kind === "refuse") { send(textResult(id, intent.reason, true)); return; }
    if (!CONNECTOR_APPROVAL_OFF && intent.kind === "write" && (await requestConnectorApproval(message, state)) !== "allow") {
      if (!state.controller.signal.aborted) send(textResult(id, declinedResult(intent.actions), true));
      return;
    }
    if (state.controller.signal.aborted || closing) return;
  }
  const response = await relay(message, state);
  if (response && id !== undefined && !closing && !state?.controller.signal.aborted) send(response);
}

const input = readline.createInterface({ input: process.stdin, terminal: false });
input.on("line", (line) => {
  let raw: unknown;
  try { raw = JSON.parse(line); } catch { return; }
  const parsed = frameSchema.safeParse(raw);
  if (!parsed.success || closing) return;
  const message = recordSchema.parse(parsed.data);
  if (parsed.data.method === "notifications/cancelled") {
    const cancel = z.object({ requestId: rpcIdSchema }).passthrough().safeParse(parsed.data.params);
    if (!cancel.success) return;
    const state = calls.get(callKey(cancel.data.requestId));
    if (!state) return;
    state.controller.abort();
    // An original frame never sent upstream has no upstream request to cancel.
    if (state.relayed) {
      const cancellationState = { controller: new AbortController(), relayed: false };
      controllers.add(cancellationState.controller);
      const cancellation = relay(message, cancellationState).then(() => {}).catch(() => {}).finally(() => controllers.delete(cancellationState.controller));
      running.add(cancellation);
      void cancellation.finally(() => running.delete(cancellation));
    }
    return;
  }
  const id = parsed.data.id;
  const state: CallState = { controller: new AbortController(), relayed: false };
  if (id !== undefined) {
    const key = callKey(id);
    const previous = calls.get(key);
    if (previous) {
      previous.controller.abort();
      send(textResult(id, "Duplicate pending connector request ID; neither call is authorized to continue.", true));
      return;
    }
    calls.set(key, state);
  }
  controllers.add(state.controller);
  const task = handle(message, state).catch((error) => {
    if (id !== undefined && !closing && !state?.controller.signal.aborted) send(textResult(id, error instanceof Error ? error.message : String(error), true));
  }).finally(() => {
    controllers.delete(state.controller);
    if (id !== undefined && calls.get(callKey(id)) === state) calls.delete(callKey(id));
  });
  running.add(task);
  void task.finally(() => running.delete(task));
});
function shutdown(): void {
  if (closing) return;
  closing = true;
  for (const controller of controllers) controller.abort();
  void Promise.allSettled(running).then(() => process.exit(0));
}
input.on("close", shutdown);
process.on("SIGTERM", shutdown);
