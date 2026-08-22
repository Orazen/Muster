// Agent-to-agent comms MCP proxy — spawned as an MCP server inside a bot's
// agent process (via the "agents" integration). Exposes three tools that
// let one bot talk to another, routed back through the harness so the
// harness stays the single owner of turns, permissions, and recursion
// limits:
//
//   list_bots()                          → the other bots in this workspace + their status
//   ask_bot(bot_id, msg)                 → send msg to that bot, wait, return its reply
//   delegate_bot(bot_id, msg, reason?)   → hand the task to a peer ASYNC: returns
//                                          immediately, the peer runs after your
//                                          current turn finishes, the user sees
//                                          the peer's reply as its own turn
//
// Speaks raw JSON-RPC 2.0 over stdio (no MCP SDK — house style, matches
// computer-proxy / permission-proxy). All state comes from env, injected by
// the harness when it builds the integration:
//   OMB_HARNESS_URL  base URL of the harness (http://127.0.0.1:8799)
//   OMB_BOT_ID       the calling bot's id (excluded from list_bots; sender)
//   OMB_COMMS_TOKEN  shared secret for the localhost-only internal endpoints
//   OMB_TURN_DEPTH   this turn's comms depth (the harness refuses recursion)
import readline from "node:readline";

import { z } from "zod";

import { parseJson, type JsonObject, type JsonValue } from "../schema.ts";

const HARNESS = process.env.OMB_HARNESS_URL ?? "http://127.0.0.1:8799";
const BOT_ID = process.env.OMB_BOT_ID ?? "";
const THREAD_ID = process.env.OMB_THREAD_ID ?? "";
const TOKEN = process.env.OMB_COMMS_TOKEN ?? "";
const DEPTH = Number(process.env.OMB_TURN_DEPTH ?? "0") || 0;

const TOOLS: JsonObject[] = [
  {
    name: "list_bots",
    description:
      "List the other bots (agents) in this Muster workspace you can message, with their model and whether they're busy. Call this before ask_bot to discover who's available.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "ask_bot",
    description:
      "Send a message to another bot in this workspace and wait for its reply. Use it to delegate a subtask to a specialist bot or ask a peer a question. The other bot runs a full turn under its own model and permissions; the reply is returned to you as text. Returns promptly with a note if that bot is busy.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: { type: "string", description: "The target bot's id (from list_bots)." },
        message: { type: "string", description: "What to say / ask the bot." },
      },
      required: ["bot_id", "message"],
    },
  },
  {
    name: "delegate_bot",
    description:
      "Hand a task to another bot ASYNCHRONOUSLY: returns immediately and the peer runs after your current turn finishes. Use this when you want to keep working or hand off a long-running subtask without waiting. The user sees the peer's reply as its own turn; you do NOT receive the reply inline.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: { type: "string", description: "The target bot's id (from list_bots)." },
        message: { type: "string", description: "What the peer should do / answer." },
        reason: { type: "string", description: "Optional one-line reason for the delegation (shown to the user as a chip)." },
      },
      required: ["bot_id", "message"],
    },
  },
];

type Json = JsonObject;
/** Echoed-back request id: whatever JSON value the caller sent, absent for
 * notifications. */
type RpcId = JsonValue | undefined;

// Stdio is the trust boundary: a line must be a JSON-RPC object with a
// string method before anything may read .method/.id/.params off it.
const jsonObject = z.record(z.string(), z.json());
const rpcMessageSchema = z.object({
  id: z.json().optional().catch(undefined),
  method: z.string(),
  params: jsonObject.optional().catch({}),
});

type RpcMessage = z.output<typeof rpcMessageSchema>;

// Wire strings: a JSON string, or absent. Any other value reads as absent.
const wireText = z.string().optional().catch(undefined);

const send = (msg: Record<string, JsonValue | undefined>) => process.stdout.write(JSON.stringify(msg) + "\n");
const ok = (id: RpcId, result: JsonValue) => send({ jsonrpc: "2.0", id, result });
const rpcErr = (id: RpcId, code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message } });
const textResult = (id: RpcId, text: string, isError = false) =>
  ok(id, { content: [{ type: "text", text }], isError });

async function api(path: string, init?: RequestInit): Promise<Json> {
  const res = await fetch(HARNESS + path, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...init?.headers },
  });
  // A body that is missing or not an object reads as empty, exactly like
  // the previous catch(() => ({})) fallback.
  const parsed = jsonObject.safeParse(await res.json().catch(() => null));
  const body: Json = parsed.success ? parsed.data : {};
  if (!res.ok) throw new Error(String(body.error ?? `HTTP ${res.status}`));
  return body;
}

async function callTool(name: string, args: Json): Promise<{ text: string; isError?: boolean }> {
  if (name === "list_bots") {
    const r = await api(`/api/internal/agents?self=${encodeURIComponent(BOT_ID)}`);
    const bots = (Array.isArray(r.bots) ? r.bots : []).flatMap((b) => {
      const row = jsonObject.safeParse(b);
      return row.success ? [row.data] : [];
    });
    if (!bots.length) return { text: "No other bots in this workspace yet." };
    const lines = bots.map((b) => {
      const role = b.title ? ` — ${b.title}` : "";
      const about = b.description ? ` (${String(b.description).slice(0, 120)})` : "";
      return `- ${b.name}${role}${about} [id: ${b.id}, model: ${b.model}${b.busy ? ", busy" : ""}]`;
    });
    return { text: `Other bots you can message with ask_bot:\n${lines.join("\n")}` };
  }
  if (name === "ask_bot") {
    const toBotId = String(args.bot_id ?? "").trim();
    const message = String(args.message ?? "").trim();
    if (!toBotId || !message) return { text: "ask_bot needs bot_id and message.", isError: true };
    const r = await api(`/api/internal/ask-bot`, {
      method: "POST",
      body: JSON.stringify({ fromBotId: BOT_ID, fromThreadId: THREAD_ID, toBotId, message, depth: DEPTH }),
    });
    if (r.busy) return { text: `That bot is busy right now — try again after it finishes.` };
    if (r.error) return { text: `Couldn't reach that bot: ${r.error}`, isError: true };
    return { text: `${r.botName ?? "Bot"} replied:\n${r.text ?? "(no reply)"}` };
  }
  if (name === "delegate_bot") {
    const toBotId = String(args.bot_id ?? "").trim();
    const message = String(args.message ?? "").trim();
    const reason = wireText.parse(args.reason)?.trim() ?? "";
    if (!toBotId || !message) return { text: "delegate_bot needs bot_id and message.", isError: true };
    const body: JsonObject = {
      fromBotId: BOT_ID,
      fromThreadId: THREAD_ID,
      toBotId,
      message,
      depth: DEPTH,
    };
    if (reason) body.reason = reason;
    const r = await api(`/api/internal/delegate-bot`, { method: "POST", body: JSON.stringify(body) });
    if (r.error) return { text: `Couldn't queue the delegation: ${r.error}`, isError: true };
    // Fire-and-forget by contract: the harness returns immediately, the
    // peer turn runs after our current turn finishes.
    return { text: wireText.parse(r.message) ?? "Delegation queued." };
  }
  return { text: `Unknown tool: ${name}`, isError: true };
}

async function handle(msg: RpcMessage) {
  const id = msg.id;
  const { method } = msg;
  const params: Json = msg.params ?? {};
  switch (method) {
    case "initialize":
      ok(id, {
        protocolVersion: wireText.parse(params.protocolVersion) ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "opengrokbot-agents", version: "0.1.0" },
      });
      return;
    case "notifications/initialized":
    case "notifications/cancelled":
      return;
    case "ping":
      ok(id, {});
      return;
    case "tools/list":
      ok(id, { tools: TOOLS });
      return;
    case "tools/call": {
      const name = wireText.parse(params.name) ?? "";
      if (!TOOLS.some((t) => t.name === name)) return rpcErr(id, -32602, `Unknown tool: ${name}`);
      try {
        const argsParsed = jsonObject.safeParse(params.arguments);
        const args: Json = argsParsed.success ? argsParsed.data : {};
        const { text, isError } = await callTool(name, args);
        textResult(id, text, isError);
      } catch (e) {
        textResult(id, e instanceof Error ? e.message : String(e), true);
      }
      return;
    }
    default:
      if (id !== undefined) rpcErr(id, -32601, `Method not found: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  let raw: JsonValue;
  try {
    raw = parseJson(t);
  } catch {
    return;
  }
  const parsed = rpcMessageSchema.safeParse(raw);
  if (!parsed.success) return;
  const msg = parsed.data;
  void handle(msg).catch((e) => {
    if (msg.id !== undefined) rpcErr(msg.id, -32603, e instanceof Error ? e.message : String(e));
  });
});
rl.on("close", () => process.exit(0));
