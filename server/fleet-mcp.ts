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
// beats a sprawling one): fleet status, send a task, wait for it to settle,
// read receipts and memory. There is deliberately NO tool for approvals,
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
// CLI's `pair` writes — so this server never sees or stores credentials.
import { createInterface } from "node:readline";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { attachReceipt, parseDelegatedTask } from "./fleet-delegation.ts";
import { parseEvidenceQuery, parseScorecardEvidence, parseWhyEvidence } from "./fleet-evidence.ts";
import type { JsonObject } from "./schema.ts";

// ── protocol envelope ───────────────────────────────────────────────────

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "muster-fleet", version: "1.0" };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: JsonObject;
  /** Execute; return a JSON-serializable payload rendered as tool text. */
  run(args: JsonObject): Promise<unknown>;
}

// ── harness client (reuses the CLI session) ─────────────────────────────

export interface FleetConfig {
  base: string;
  cookie: string;
}

/** Guard the MUSTER_DIR override: absolute, no `..` segments, so a hostile
 *  environment can't steer the config read outside the expected locations.
 *  The override exists for tests and sandboxes, not as an escape hatch. */
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
  // Containment assertion: the only file this module may ever read is
  // `<musterDir>/cli.json` with musterDir already validated above. resolve()
  // here collapses any remaining traversal, and the startsWith bound makes
  // an escape impossible rather than merely unlikely.
  const resolved = resolve(path);
  if (!resolved.startsWith(resolve(musterDir) + sep)) {
    throw new Error("Config path escaped the Muster directory.");
  }
  if (!existsSync(path)) {
    throw new Error("Not paired. Run `muster pair` first.");
  }
  try {
    const cfg = JSON.parse(readFileSync(path, "utf8"));
    if (typeof cfg.base !== "string" || typeof cfg.cookie !== "string" || !cfg.base || !cfg.cookie) {
      throw new Error("bad shape");
    }
    return { base: cfg.base, cookie: cfg.cookie };
  } catch {
    throw new Error("Pairing config is unreadable. Run `muster pair` again.");
  }
}

async function harness(cfg: FleetConfig, path: string, init: RequestInit = {}): Promise<any> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    cookie: cfg.cookie,
    origin: cfg.base,
  };
  Object.assign(headers, init.headers ?? {});
  const res = await fetch(`${cfg.base}${path}`, { ...init, headers, signal: AbortSignal.timeout(20_000) });
  if (res.status === 401) {
    throw new Error("Session expired. Run `muster pair` again.");
  }
  // typed any: error bodies are arbitrary server JSON
  const body: any = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = typeof body?.error === "string" ? body.error : `HTTP ${res.status}`;
    throw new Error(detail);
  }
  return body;
}

// ── fleet helpers ───────────────────────────────────────────────────────

/** Compact roster line per bot — never the full wire shape; the caller is
 *  a model with a context budget. */
function describeBot(bot: any): JsonObject {
  const engine = bot.modelSelection
    ? { model: bot.modelSelection.model, instance: bot.modelSelection.instanceId }
    : undefined;
  const task = bot.tasks?.[0];
  return {
    id: bot.id,
    name: bot.name,
    title: bot.title ?? "",
    activity: bot.activity ?? (bot.busy ? "working" : "idle"),
    busy: !!bot.busy,
    unread: !!bot.unread,
    // JsonObject forbids undefined values — omit the key, never null-hole it.
    ...(engine ? { engine } : {}),
    ...(task
      ? { lastTask: { title: task.title ?? "", ...(task.usage ? { usage: task.usage } : {}) } }
      : {}),
  };
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
function pendingAsk(messages: any[]): JsonObject | undefined {
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
function outcomeOf(bot: any, messages: any[]): "settled" | "needs-user" | "failed" | "stalled" | "working" {
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
    async run() {
      const cfg = loadFleetConfig();
      const data = await harness(cfg, "/api/bots?messages=0");
      const bots = Array.isArray(data.bots) ? data.bots.map(describeBot) : [];
      return { bots, count: bots.length };
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
        await harness(cfg, `/api/bots/${encodeURIComponent(source.botId)}?messages=0`, { method: "GET" });
        const evidence = await harness(cfg, `/api/receipts/${encodeURIComponent(source.botId)}/${encodeURIComponent(source.threadId)}`, { method: "GET" });
        text = attachReceipt(task, evidence);
      }
      const data = await harness(cfg, `/api/bots/${encodeURIComponent(botId)}/messages`, {
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
      const botId = String(args.botId ?? "");
      if (!botId) throw new Error("botId is required");
      const timeoutMs = Math.min(Math.max(Number(args.timeoutSeconds ?? 90) * 1000, 5_000), 600_000);
      const cfg = loadFleetConfig();
      const deadline = Date.now() + timeoutMs;
      let bot: any;
      let outcome: string;
      let messages: any[] = [];
      do {
        await new Promise((r) => setTimeout(r, 2_500));
        const data = await harness(cfg, `/api/bots/${encodeURIComponent(botId)}?messages=25`);
        bot = data.bot ?? data;
        messages = Array.isArray(bot.messages) ? bot.messages : [];
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
      "Read the job receipt for a settled task — bot, task title, duration, tokens, cost, final word. Needs the bot id and its active thread id (both in fleet_status / wait_for_conversation output).",
    inputSchema: {
      type: "object",
      properties: { botId: botIdSchema, threadId: { type: "string" } },
      required: ["botId", "threadId"],
      additionalProperties: false,
    },
    async run(args) {
      const botId = String(args.botId ?? "");
      const threadId = String(args.threadId ?? "");
      if (!botId || !threadId) throw new Error("botId and threadId are required");
      const cfg = loadFleetConfig();
      const data = await harness(
        cfg,
        `/api/receipts/${encodeURIComponent(botId)}/${encodeURIComponent(threadId)}`,
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
      const botId = String(args.botId ?? "");
      if (!botId) throw new Error("botId is required");
      const cfg = loadFleetConfig();
      const data = await harness(cfg, `/api/bots/${encodeURIComponent(botId)}/memory`);
      return { memory: data.text ?? "" };
    },
  },
  {
    name: "get_approval_history",
    description:
      "Read one bot's approval history (who allowed or denied its tool requests, and why) — evidence, not a verdict.",
    inputSchema: { type: "object", properties: { botId: botIdSchema }, required: ["botId"], additionalProperties: false },
    async run(args) {
      const botId = String(args.botId ?? "");
      if (!botId) throw new Error("botId is required");
      const cfg = loadFleetConfig();
      return await harness(cfg, `/api/bots/${encodeURIComponent(botId)}/audit`);
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
      const data = await harness(loadFleetConfig(), `/api/bots/${encodeURIComponent(query.botId)}/why?limit=${query.limit}`, { method: "GET" });
      return parseWhyEvidence(data, query);
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
      await harness(cfg, `/api/bots/${encodeURIComponent(query.botId)}?messages=0`, { method: "GET" });
      const data = await harness(cfg, "/api/routines", { method: "GET" });
      return parseScorecardEvidence(data, query);
    },
  },
];

// ── JSON-RPC plumbing ───────────────────────────────────────────────────

function rpcResult(id: number, result: unknown) {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

function rpcError(id: number, code: number, message: string) {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

/** Serve MCP over a readline line stream. Exported for tests: tests feed
 *  lines in and collect replies without spawning a process. */
export function serveFleetMcp(input: NodeJS.ReadableStream, write: (line: string) => void) {
  const rl = createInterface({ input });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: any;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (msg.id === undefined) return; // notifications: nothing to answer

    if (msg.method === "initialize") {
      write(
        rpcResult(msg.id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        }),
      );
      return;
    }
    if (msg.method === "tools/list") {
      write(
        rpcResult(msg.id, {
          tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        }),
      );
      return;
    }
    if (msg.method === "tools/call") {
      const name = String(msg.params?.name ?? "");
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) {
        write(rpcError(msg.id, -32602, `Unknown tool: ${name}`));
        return;
      }
      (async () => {
        try {
          const payload = await tool.run((msg.params?.arguments ?? {}) as JsonObject);
          write(rpcResult(msg.id, { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] }));
        } catch (e) {
          const text = e instanceof Error ? e.message : String(e);
          write(rpcResult(msg.id, { content: [{ type: "text", text }], isError: true }));
        }
      })();
      return;
    }
    write(rpcError(msg.id, -32601, `Method not found: ${msg.method}`));
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
