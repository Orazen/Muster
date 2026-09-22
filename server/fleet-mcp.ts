// The fleet MCP server — Muster exposed TO external agents.
//
// Every other MCP surface in this codebase is client-side: the harness
// *consumes* MCP servers (mcp-client.ts, mcp-bridge.ts, container-mcp.ts).
// Nothing let an external agent — Claude Desktop, Cursor, a GPT-6-class
// harness — drive Muster natively. This file is that door: a bounded
// stdio MCP server that re-uses the CLI's own session auth and fans tools
// out to the harness REST API.
//
// Bounded by design, mirroring the OpenMausBot lesson (a bounded MCP server
// beats a sprawling one): fleet status, a bot's sessions, send a task, wait
// for it to settle, read receipts and memory. There is deliberately NO tool for approvals,
// deletes, credentials, engine changes, or memory writes — a connected
// agent can watch and work the fleet, never gut it. Approvals stay human
// (Watch / OptionCard); that is the product's spine.
//
// Wire style matches mcp-client.ts exactly: newline-delimited JSON-RPC,
// initialize handshake, tools/list, tools/call. Deliberately not an SDK.
//
// Run with `muster mcp` (cli/muster.mjs) or directly:
//   node --experimental-strip-types server/fleet-mcp.ts
// Auth comes from ~/.muster/cli.json ({base, cookie}) — the same file the
// CLI's `pair` writes. The cookie is a session credential read here; this
// module does not mint or store new provider keys.
import { createInterface } from "node:readline";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

import { attachReceipt, parseDelegatedTask } from "./fleet-delegation.ts";
import type { DelegatedTask } from "./fleet-delegation.ts";
import { parseEvidenceQuery, parseScorecardEvidence, parseWhyEvidence } from "./fleet-evidence.ts";
import type { ScorecardEvidence, WhyEvidence } from "./fleet-evidence.ts";
import { parseJson, type JsonObject } from "./schema.ts";

// ── protocol envelope ───────────────────────────────────────────────────

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "muster-fleet", version: "1.0" };

const jsonObjectSchema = z.record(z.string(), z.json());
const fleetConfigSchema = z.object({ base: z.string().min(1), cookie: z.string().min(1) });
const messageSchema = z.object({
  id: z.string(), role: z.string(), kind: z.string(), text: z.string().optional(),
  card: z.object({
    title: z.string().optional(), options: z.array(z.string()).optional(),
    tool: z.string().optional(), answered: z.string().optional(), dismissed: z.boolean().optional(),
  }).optional(),
});
const botSchema = z.object({
  id: z.string(), name: z.string().optional(), title: z.string().optional(),
  activity: z.string().optional(), busy: z.boolean().optional(), unread: z.boolean().optional(),
  modelSelection: z.object({ model: z.string(), instanceId: z.string() }).optional(),
  tasks: z.array(z.object({
    threadId: z.string().optional(), title: z.string().optional(),
    createdAt: z.number().optional(), usage: jsonObjectSchema.optional(),
  })).optional(),
  threadId: z.string().optional(), messages: z.array(messageSchema).optional(),
});
const rosterBotSchema = botSchema.extend({ name: z.string() });
const rosterSchema = z.object({ bots: z.array(rosterBotSchema) });
const botResponseSchema = z.union([z.object({ bot: botSchema }).transform((data) => data.bot), botSchema]);
const sentSchema = z.object({
  ok: z.literal(true).optional(), queued: z.boolean().optional(),
  message: z.object({ id: z.string() }).optional(), messageId: z.string().optional(),
}).refine((data) => data.ok === true || data.queued !== undefined || data.message !== undefined || data.messageId !== undefined);
const receiptSchema = z.object({ receipt: jsonObjectSchema, text: z.string().optional() });
const memorySchema = z.object({ text: z.string() });
const auditSchema = z.object({
  entries: z.array(jsonObjectSchema), nextBefore: z.string().optional(),
}).catchall(z.json());
const botArgsSchema = z.object({ botId: z.string().min(1) }).strict();
const receiptArgsSchema = botArgsSchema.extend({ threadId: z.string().min(1) });
const waitArgsSchema = botArgsSchema.extend({ timeoutSeconds: z.number().finite().optional() });
const brainWriteSchema = z.object({
  text: z.string().min(1),
  source: z.string().min(1),
  kind: z.enum(["person", "company", "project", "decision", "note"]).optional(),
  supersedes: z.string().optional(),
}).strict();
const brainQuerySchema = z.object({
  text: z.string().min(1),
  limit: z.number().int().min(1).max(50).optional(),
}).strict();
type FleetBot = z.infer<typeof botSchema>;
type FleetMessage = z.infer<typeof messageSchema>;
type Outcome = "settled" | "needs-user" | "failed" | "stalled" | "working";
interface BotSummary {
  id: string; name: string; title: string; activity: string; busy: boolean; unread: boolean;
  engine?: { model: string; instance: string };
  lastTask?: { title: string; usage?: JsonObject };
}
interface PendingAsk {
  messageId: string; title: string; options: string[]; permission?: string;
}
interface SessionSummary {
  threadId: string; title: string; active: boolean;
  createdAt?: number; usage?: JsonObject;
}
interface SessionList {
  sessions: SessionSummary[]; count: number; activeThreadId?: string;
}
interface SentTask {
  ok: boolean; queued: boolean; receiptRef?: DelegatedTask["receiptRef"]; messageId?: string; note: string;
}
interface ConversationOutcome {
  outcome: Outcome; reply?: string; needsUser?: PendingAsk; threadId?: string; hint?: string;
}
type FleetToolResult = { bots: BotSummary[]; count: number } | SentTask | ConversationOutcome
  | SessionList
  | z.infer<typeof receiptSchema> | z.infer<typeof auditSchema> | { memory: string } | WhyEvidence | ScorecardEvidence
  | { written: boolean; fact?: { id: string; text: string; kind: string; source: string } }
  | { hits: Array<{ fact: { id: string; text: string; kind: string; source: string }; matched: string[]; score: number }>; gaps: string[]; unknownEntities: string[] };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: JsonObject;
  /** Execute; return a JSON-serializable payload rendered as tool text. */
  run(args: JsonObject): Promise<FleetToolResult>;
}

// ── harness client (reuses the CLI session) ─────────────────────────────

export interface FleetConfig {
  base: string;
  cookie: string;
}

/** Require an absolute caller-selected MUSTER_DIR without '..' segments.
 * This is lexical path validation; it does not resolve symlinks. */
function safeMusterDir(raw: string): string {
  if (!isAbsolute(raw) || raw.split(sep).includes("..")) {
    throw new Error("MUSTER_DIR must be an absolute path without '..' segments.");
  }
  return resolve(raw);
}

/** Read ~/.muster/cli.json — the exact config `muster pair` maintains.
 *  MUSTER_DIR override honored for tests, same as the CLI. */
export function loadFleetConfig(dir?: string): FleetConfig {
  const musterDir = dir
    ? safeMusterDir(dir)
    : process.env.MUSTER_DIR
      ? safeMusterDir(process.env.MUSTER_DIR)
      : join(homedir(), ".muster");
  const path = join(musterDir, "cli.json");
  // Read cli.json beneath the selected directory. This lexical check does
  // not establish the filesystem destination of a symlink.
  const resolved = resolve(path);
  if (!resolved.startsWith(resolve(musterDir) + sep)) {
    throw new Error("Config path escaped the Muster directory.");
  }
  if (!existsSync(path)) {
    throw new Error("Not paired. Run `muster pair` first.");
  }
  try {
    return fleetConfigSchema.parse(parseJson(readFileSync(path, "utf8")));
  } catch {
    throw new Error("Pairing config is unreadable. Run `muster pair` again.");
  }
}

async function harness<Schema extends z.ZodType>(
  cfg: FleetConfig, path: string, schema: Schema, init: RequestInit = {},
): Promise<z.output<Schema>> {
  const headers = new Headers({
    "content-type": "application/json",
    cookie: cfg.cookie,
    origin: cfg.base,
  });
  new Headers(init.headers).forEach((value, name) => headers.set(name, value));
  const res = await fetch(`${cfg.base}${path}`, { ...init, headers, signal: AbortSignal.timeout(20_000) });
  if (res.status === 401) {
    throw new Error("Session expired. Run `muster pair` again.");
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const error = z.object({ error: z.string() }).safeParse(body);
    const detail = error.success ? error.data.error : `HTTP ${res.status}`;
    throw new Error(detail);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new Error("Harness returned an unreadable response.");
  return parsed.data;
}

// ── fleet helpers ───────────────────────────────────────────────────────

/** Compact roster line per bot — never the full wire shape; the caller is
 *  a model with a context budget. */
function describeBot(bot: z.infer<typeof rosterBotSchema>): BotSummary {
  const engine = bot.modelSelection
    ? { model: bot.modelSelection.model, instance: bot.modelSelection.instanceId }
    : undefined;
  const task = bot.tasks?.[0];
  const summary: BotSummary = {
    id: bot.id,
    name: bot.name,
    title: bot.title ?? "",
    activity: bot.activity ?? (bot.busy ? "working" : "idle"),
    busy: !!bot.busy,
    unread: !!bot.unread,
  };
  if (engine) summary.engine = engine;
  if (task) {
    summary.lastTask = { title: task.title ?? "" };
    if (task.usage) summary.lastTask.usage = task.usage;
  }
  return summary;
}

/** Summarize the newest pending option card on a thread, if any — the
 *  wait tool uses this to say WHY a turn is stalled instead of just
 *  hanging: a bot mid-approval needs a human, not more polling.
 *
 *  Scan is newest-significant: walk backwards past transcript noise
 *  (activity ticks, screens, compactions, privacy notices) and stop at
 *  the first thing that matters — an unanswered card, or the bot's own
 *  text reply. Stopping at a bot reply is what keeps a stale, long-since
 *  answered card from reading as "needs-user" forever. */
function pendingAsk(messages: FleetMessage[]): PendingAsk | undefined {
  for (const m of [...messages].reverse()) {
    if (m.role === "bot" && m.kind === "text" && m.text?.trim()) return undefined;
    const card = m.card;
    if (!card || card.dismissed || card.answered) continue;
    return {
      messageId: m.id,
      title: card.title ?? "",
      options: card.options ?? [],
      permission: card.tool ?? undefined,
    };
  }
  return undefined;
}

/** One settled verdict for a thread, OpenMausBot-style vocabulary. */
function outcomeOf(bot: FleetBot, messages: FleetMessage[]): Outcome {
  const activity = bot.activity ?? (bot.busy ? "working" : "idle");
  // busy means the bot cannot accept another message. It also covers
  // waiting-on-you and no-signal, so preserve those specific states first.
  // "dead" is the engine-gone-activity state — the harness crashed or the
  // process was killed. That is a failure, not a question for the user.
  if (activity === "dead") return "failed";
  if (activity === "waiting-on-you") return "needs-user";
  if (activity === "no-signal") return "stalled";
  if (bot.busy || activity === "working") return "working";
  if (pendingAsk(messages)) return "needs-user";
  const last = [...messages].reverse().find((m) => m.role === "bot" && m.kind === "text" && m.text?.trim());
  if (activity === "idle" && last) return "settled";
  return "stalled";
}

// ── tool definitions ────────────────────────────────────────────────────

const botIdSchema: JsonObject = {
  type: "string",
  description: "Bot id from fleet_status (the `id` field, not the display name).",
};

const TOOLS: ToolDef[] = [
  {
    name: "fleet_status",
    description:
      "List every bot in the Muster fleet with activity, engine, and the newest task per bot. Call this first; other tools want a bot id.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run(args) {
      z.object({}).strict().parse(args);
      const cfg = loadFleetConfig();
      const data = await harness(cfg, "/api/bots?messages=0", rosterSchema);
      const bots = data.bots.map(describeBot);
      return { bots, count: bots.length };
    },
  },
  {
    name: "list_sessions",
    description:
      "List one bot's sessions — each session is one task thread with its own transcript, receipt and provider session. Returns thread id, title, creation time, per-session usage, and which session is active. Read-only discovery for get_receipt, wait_for_conversation, get_why_journal and get_scorecard.",
    inputSchema: {
      type: "object", properties: { botId: botIdSchema },
      required: ["botId"], additionalProperties: false,
    },
    async run(args) {
      const { botId } = botArgsSchema.parse(args);
      const cfg = loadFleetConfig();
      const bot = await harness(cfg, `/api/bots/${encodeURIComponent(botId)}?messages=0`, botResponseSchema, { method: "GET" });
      const activeThreadId = bot.threadId;
      const sessions: SessionSummary[] = [];
      for (const task of bot.tasks ?? []) {
        if (!task.threadId) continue;
        const session: SessionSummary = {
          threadId: task.threadId,
          title: task.title ?? "",
          active: task.threadId === activeThreadId,
        };
        if (task.createdAt !== undefined) session.createdAt = task.createdAt;
        if (task.usage) session.usage = task.usage;
        sessions.push(session);
      }
      // A record that predates per-task metadata still has its active
      // thread — an honest list names that one session instead of
      // reading as an empty fleet.
      if (sessions.length === 0 && activeThreadId) {
        sessions.push({ threadId: activeThreadId, title: bot.title ?? "", active: true });
      }
      const reply: SessionList = {
        sessions, count: sessions.length,
      };
      if (activeThreadId) reply.activeThreadId = activeThreadId;
      return reply;
    },
  },
  {
    name: "send_task",
    description:
      "Send a task (or any message) to one bot and start its turn. Optionally attach a historical receipt from another bot using receiptRef. Returns immediately with the queued/started message id — use wait_for_conversation for the outcome.",
    inputSchema: {
      type: "object",
      properties: {
        botId: botIdSchema, text: { type: "string", description: "The task text to send." },
        receiptRef: {
          type: "object", properties: { botId: botIdSchema, threadId: { type: "string" } },
          required: ["botId", "threadId"], additionalProperties: false,
          description: "Read a source bot's receipt and attach its snapshot as historical data. Grants no permissions.",
        },
      },
      required: ["botId", "text"],
      additionalProperties: false,
    },
    async run(args) {
      const task = parseDelegatedTask(args);
      const { botId } = task;
      let text = task.text;
      const cfg = loadFleetConfig();
      if (task.receiptRef) {
        const source = task.receiptRef;
        // Verify source-bot access before fetching a historical thread.
        await harness(cfg, `/api/bots/${encodeURIComponent(source.botId)}?messages=0`, botResponseSchema, { method: "GET" });
        const evidence = await harness(cfg, `/api/receipts/${encodeURIComponent(source.botId)}/${encodeURIComponent(source.threadId)}`, jsonObjectSchema, { method: "GET" });
        text = attachReceipt(task, evidence);
      }
      const data = await harness(cfg, `/api/bots/${encodeURIComponent(botId)}/messages`, sentSchema, {
        method: "POST",
        body: JSON.stringify({ text }),
      });
      return {
        ok: true,
        queued: !!data.queued,
        receiptRef: task.receiptRef,
        messageId: data.message?.id ?? data.messageId ?? undefined,
        note: data.queued
          ? "Bot was mid-turn; your message is queued and will steer the running turn."
          : "Turn started.",
      };
    },
  },
  {
    name: "wait_for_conversation",
    description:
      "Poll one bot's active thread until the turn settles. Outcome is one of: settled (replied), needs-user (the bot is waiting on a human — an approval or a question; relay it, do not answer it yourself), failed (turn errored), stalled (no reply yet), working (still busy — poll again later).",
    inputSchema: {
      type: "object",
      properties: {
        botId: botIdSchema,
        timeoutSeconds: { type: "number", description: "Max wait. Default 90, capped at 600." },
      },
      required: ["botId"],
      additionalProperties: false,
    },
    async run(args) {
      const { botId, timeoutSeconds } = waitArgsSchema.parse(args);
      const timeoutMs = Math.min(Math.max((timeoutSeconds ?? 90) * 1000, 5_000), 600_000);
      const cfg = loadFleetConfig();
      const deadline = Date.now() + timeoutMs;
      let bot: FleetBot;
      let outcome: Outcome;
      let messages: FleetMessage[] = [];
      do {
        await new Promise((r) => setTimeout(r, 2_500));
        bot = await harness(cfg, `/api/bots/${encodeURIComponent(botId)}?messages=25`, botResponseSchema);
        messages = bot.messages ?? [];
        outcome = outcomeOf(bot, messages);
      } while (outcome === "working" && Date.now() < deadline);

      const lastBot = [...messages].reverse().find((m) => m.role === "bot" && m.kind === "text" && m.text?.trim());
      const ask = pendingAsk(messages);
      return {
        outcome,
        reply: lastBot?.text ?? undefined,
        needsUser: ask ?? undefined,
        threadId: bot?.threadId ?? undefined,
        hint:
          outcome === "needs-user"
            ? "The bot is waiting on its human owner — relay the question through your own channel; approvals must be granted in Muster by a person."
            : outcome === "stalled"
              ? "No reply yet; check fleet_status for activity, then poll again."
              : outcome === "failed"
                ? "The turn errored — see the bot's transcript in Muster."
                : outcome === "working"
                  ? "Still working; poll again."
                  : undefined,
      };
    },
  },
  {
    name: "get_receipt",
    description:
      "Read the job receipt for a settled task — bot, task title, duration, tokens, cost, final word. Needs the bot id and its thread id (both in list_sessions / wait_for_conversation output).",
    inputSchema: {
      type: "object",
      properties: { botId: botIdSchema, threadId: { type: "string" } },
      required: ["botId", "threadId"],
      additionalProperties: false,
    },
    async run(args) {
      const { botId, threadId } = receiptArgsSchema.parse(args);
      const cfg = loadFleetConfig();
      const data = await harness(
        cfg,
        `/api/receipts/${encodeURIComponent(botId)}/${encodeURIComponent(threadId)}`,
        receiptSchema,
      );
      return { receipt: data.receipt, text: data.text };
    },
  },
  {
    name: "read_memory",
    description:
      "Read one bot's persistent memory (what it remembers across tasks). Read-only — an agent never edits another agent's memory here.",
    inputSchema: { type: "object", properties: { botId: botIdSchema }, required: ["botId"], additionalProperties: false },
    async run(args) {
      const { botId } = botArgsSchema.parse(args);
      const cfg = loadFleetConfig();
      const data = await harness(cfg, `/api/bots/${encodeURIComponent(botId)}/memory`, memorySchema);
      return { memory: data.text ?? "" };
    },
  },
  {
    name: "get_approval_history",
    description:
      "Read one bot's approval history (who allowed or denied its tool requests, and why) — evidence, not a verdict.",
    inputSchema: { type: "object", properties: { botId: botIdSchema }, required: ["botId"], additionalProperties: false },
    async run(args) {
      const { botId } = botArgsSchema.parse(args);
      const cfg = loadFleetConfig();
      return await harness(cfg, `/api/bots/${encodeURIComponent(botId)}/audit`, auditSchema);
    },
  },
  {
    name: "get_why_journal",
    description: "Read one bot's recorded intent, decisions, hypotheses and findings. Read-only, newest first; missing evidence is not a successful outcome.",
    inputSchema: {
      type: "object", properties: { botId: botIdSchema, limit: { type: "integer", minimum: 1, maximum: 100, default: 10 } },
      required: ["botId"], additionalProperties: false,
    },
    async run(args) {
      const query = parseEvidenceQuery(args);
      const data = await harness(loadFleetConfig(), `/api/bots/${encodeURIComponent(query.botId)}/why?limit=${query.limit}`, jsonObjectSchema, { method: "GET" });
      return parseWhyEvidence(data, query);
    },
  },
  {
    name: "brain_write",
    description:
      "Record one explicit fact into the Muster workspace brain — with its source (provenance). Facts survive across tasks and are visible to the whole fleet. Use for durable knowledge: people, companies, decisions, preferences. Do NOT write transient task state here.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The fact, one self-contained sentence." },
        source: { type: "string", description: "Where this came from, e.g. 'standup 2026-09-17' or 'user reply'." },
        kind: { type: "string", enum: ["person", "company", "project", "decision", "note"], description: "Optional; inferred when omitted." },
        supersedes: { type: "string", description: "Fact id this corrects — the old fact stays for provenance but stops answering queries." },
      },
      required: ["text", "source"],
      additionalProperties: false,
    },
    async run(args) {
      const input = brainWriteSchema.parse(args);
      const cfg = loadFleetConfig();
      const payload: JsonObject = { text: input.text, source: input.source, origin: "fleet-mcp" };
      if (input.kind) payload.kind = input.kind;
      if (input.supersedes) payload.supersedes = input.supersedes;
      const data = await harness(cfg, "/api/brain/facts", jsonObjectSchema, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      // SAFETY: the fact envelope is the harness's own route; shape pinned
      // by server/workspace-brain.test.ts, absence degrades to written:true.
      const fact = data.fact as { id: string; text: string; kind: string; source: string } | undefined;
      const reply = { written: true, fact };
      if (!fact) delete reply.fact;
      return reply;
    },
  },
  {
    name: "brain_query",
    description:
      "Search the Muster workspace brain for durable facts — people, companies, decisions, project history — with matched-evidence citations and an honest gap analysis (what the brain does NOT know yet). Answers come from facts the fleet recorded, not guesses.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The question or topic to search for." },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "Max hits. Default 8." },
      },
      required: ["text"],
      additionalProperties: false,
    },
    async run(args) {
      const input = brainQuerySchema.parse(args);
      const cfg = loadFleetConfig();
      const payload: JsonObject = { text: input.text };
      if (input.limit) payload.limit = input.limit;
      const data = await harness(cfg, "/api/brain/query", jsonObjectSchema, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      // SAFETY: the /api/brain/query envelope is the harness's own route,
      // shape pinned by server/workspace-brain.test.ts.
      const result = data.result as { hits: Array<{ fact: { id: string; text: string; kind: string; source: string }; matched: string[]; score: number }>; gaps: string[]; unknownEntities: string[] };
      return result;
    },
  },
  {
    name: "get_scorecard",
    description: "Read recent routine run statuses and recorded checks for one bot. Read-only; absent checks never mean passed. No routine prompts or full run output are returned.",
    inputSchema: {
      type: "object", properties: { botId: botIdSchema, limit: { type: "integer", minimum: 1, maximum: 100, default: 10 } },
      required: ["botId"], additionalProperties: false,
    },
    async run(args) {
      const query = parseEvidenceQuery(args);
      const cfg = loadFleetConfig();
      // Confirm this bot is visible before querying the owner-scoped routine
      // list; orphaned routine records cannot establish bot access.
      await harness(cfg, `/api/bots/${encodeURIComponent(query.botId)}?messages=0`, botResponseSchema, { method: "GET" });
      const data = await harness(cfg, "/api/routines", jsonObjectSchema, { method: "GET" });
      return parseScorecardEvidence(data, query);
    },
  },
];

// ── JSON-RPC plumbing ───────────────────────────────────────────────────

const rpcIdSchema = z.union([z.string(), z.number().int()]);
const rpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"), id: rpcIdSchema.optional(), method: z.string().min(1), params: jsonObjectSchema.optional(),
});
const toolCallSchema = z.object({
  name: z.string().min(1), arguments: jsonObjectSchema.optional().default({}),
});
type RpcId = z.infer<typeof rpcIdSchema>;
interface ToolReply { content: Array<{ type: "text"; text: string }>; isError?: boolean }
type RpcResult = { protocolVersion: string; capabilities: { tools: JsonObject }; serverInfo: typeof SERVER_INFO }
  | { tools: Array<Omit<ToolDef, "run">> } | ToolReply;

function rpcResult(id: RpcId, result: RpcResult) {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

function rpcError(id: RpcId | null, code: number, message: string) {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

/** Serve MCP over a readline line stream. Exported for tests: tests feed
 *  lines in and collect replies without spawning a process. */
export function serveFleetMcp(input: NodeJS.ReadableStream, write: (line: string) => void) {
  const rl = createInterface({ input });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: ReturnType<typeof rpcRequestSchema.safeParse>;
    try {
      const raw = parseJson(trimmed);
      parsed = rpcRequestSchema.safeParse(raw);
      if (!parsed.success) {
        const requestId = z.object({ id: rpcIdSchema }).safeParse(raw);
        write(rpcError(requestId.success ? requestId.data.id : null, -32600, "Invalid request"));
        return;
      }
    } catch {
      write(rpcError(null, -32700, "Parse error"));
      return;
    }
    const msg = parsed.data;
    const id = msg.id;
    if (id === undefined) return; // notifications: nothing to answer

    if (msg.method === "initialize") {
      write(
        rpcResult(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        }),
      );
      return;
    }
    if (msg.method === "tools/list") {
      write(
        rpcResult(id, {
          tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        }),
      );
      return;
    }
    if (msg.method === "tools/call") {
      const params = toolCallSchema.safeParse(msg.params);
      if (!params.success) {
        write(rpcError(id, -32602, "Invalid tool parameters"));
        return;
      }
      const { name, arguments: args } = params.data;
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) {
        write(rpcError(id, -32602, `Unknown tool: ${name}`));
        return;
      }
      (async () => {
        try {
          const payload = await tool.run(args);
          write(rpcResult(id, { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] }));
        } catch (e) {
          const text = e instanceof Error ? e.message : String(e);
          write(rpcResult(id, { content: [{ type: "text", text }], isError: true }));
        }
      })();
      return;
    }
    write(rpcError(id, -32601, `Method not found: ${msg.method}`));
  });
  return rl;
}

// ── entry point ─────────────────────────────────────────────────────────

function main() {
  // Fail fast with a human error when not paired — an MCP client surfaces
  // stderr, and a silent empty-tool-list server is miserable to debug.
  try {
    loadFleetConfig();
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
  const out = (line: string) => process.stdout.write(line + "\n");
  serveFleetMcp(process.stdin, out);
}

// Import-as-main guard: tests import this module for serveFleetMcp access
// without triggering the stdio listener. The URL comparison holds for both
// `node --experimental-strip-types server/fleet-mcp.ts` and the bundled
// dist-server/fleet-mcp.js — a suffix check would miss the bundle.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
