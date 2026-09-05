// hi.new agent-mail bridge — a harness-owned stdio MCP server that gives a
// bot a mailbox on hi.new (store-and-forward mail between agents,
// https://hi.new/api.md). Mounted only when the owner stored a token, so a
// bot whose human never configured mail sees nothing.
//
// The token rides in env (HI_NEW_TOKEN) and is never logged; every request
// goes to the fixed https://hi.new host — validated before use, no
// user-influenceable URLs anywhere (SSRF guard).
//
// stdout is the MCP transport. Never log there.
import readline from "node:readline";

type JsonPrimitive = string | number | boolean | null;
interface JsonRecord {
  [key: string]: JsonValue;
}
type JsonValue = JsonPrimitive | JsonRecord | JsonValue[];
type Json = JsonRecord;

const isText = <T>(value: T): value is T & string => String(value) === value;
const isJsonRecord = <T>(value: T): value is T & Json =>
  value instanceof Object && value.constructor === Object;

// The one host this bridge ever talks to. Validated (https, exact host) on
// every use so a future env override can never silently loosen into an
// arbitrary-target fetch.
const DEFAULT_BASE = "https://hi.new";
const BASE = (process.env.HI_NEW_BASE_URL ?? DEFAULT_BASE).replace(/\/+$/, "");

function validatedBase(): string {
  let parsed: URL;
  try {
    parsed = new URL(BASE);
  } catch {
    throw new Error("hi.new base URL is not a valid URL");
  }
  if (parsed.protocol !== "https:") throw new Error("hi.new requires https");
  if (parsed.hostname !== "hi.new") throw new Error("hi.new host mismatch");
  return BASE;
}

function token(): string {
  const value = process.env.HI_NEW_TOKEN?.trim() ?? "";
  if (!value) throw new Error("hi.new is not configured — add your token in Settings → Agent mail");
  return value;
}

async function call(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: Json,
): Promise<Json> {
  const base = validatedBase();
  const headers: Record<string, string> = {};
  const bearer = token();
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (body) headers["content-type"] = "application/json";
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let parsed: Json = {};
  try {
    // SAFETY: hi.new error and success bodies are JSON objects.
    parsed = JSON.parse(text) as Json;
  } catch {
    parsed = { raw: text.slice(0, 400) };
  }
  if (!response.ok) {
    const detail = isText(parsed.error) ? parsed.error : `HTTP ${response.status}`;
    throw new Error(`hi.new: ${detail}`);
  }
  return parsed;
}

function result(id: JsonValue, text: string, isError = false): Json {
  const out: Json = { content: [{ type: "text", text }] };
  if (isError) out.isError = true;
  return { jsonrpc: "2.0", id, result: out };
}

const send = (message: Json) => process.stdout.write(`${JSON.stringify(message)}\n`);

function textArg(args: JsonValue, key: string): string {
  // SAFETY: tool arguments arrive as parsed JSON off the wire; the record
  // shape is checked here and the value's string-ness immediately below.
  if (!isJsonRecord(args)) return "";
  const value = args[key];
  return isText(value) ? value.trim() : "";
}

const TOOLS: Array<{
  name: string;
  description: string;
  inputSchema: Json;
}> = [
  {
    name: "hi_new_inbox",
    description:
      "List your hi.new inbox — envelopes waiting from other agents. Bodies are included; ack deletes them, so persist anything you want to keep BEFORE calling hi_new_ack.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "hi_new_read",
    description: "Fetch one inbox message by id (also returns its body).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "number", description: "message id from hi_new_inbox" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "hi_new_ack",
    description:
      "Acknowledge (delete) inbox messages by id. The payload is permanently removed from hi.new; delivery metadata only. Persist first.",
    inputSchema: {
      type: "object",
      properties: { ids: { type: "array", items: { type: "number" }, minItems: 1 } },
      required: ["ids"],
      additionalProperties: false,
    },
  },
  {
    name: "hi_new_send",
    description:
      "Send a message to another agent's handle. Requires a grant (exchange invite links with their human first). The recipient's published age key means they require encrypted mail, which this tool does not compose — the error will tell you.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "recipient handle, e.g. vlads-bot" },
        body: { type: "string", description: "message text (max 64KB)", maxLength: 65536 },
      },
      required: ["to", "body"],
      additionalProperties: false,
    },
  },
  {
    name: "hi_new_invite",
    description: "Create a single-use invite link (30 days) that grants another agent permission to message you.",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string", description: "why — shown to the other human on the link page" } },
      additionalProperties: false,
    },
  },
  {
    name: "hi_new_redeem",
    description: "Redeem an invite link you received (https://hi.new/i/…). Creates a mutual grant.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "the full invite URL" } },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "hi_new_grants",
    description: "List the agents allowed to message you (and your grants out), with key-change flags.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "hi_new_me",
    description: "Your hi.new profile: handle, public profile URL, key fingerprint, ownership warnings.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

async function dispatch(name: string, args: JsonValue): Promise<string> {
  switch (name) {
    case "hi_new_inbox": {
      const data = await call("GET", "/api/inbox");
      return JSON.stringify(data, null, 2);
    }
    case "hi_new_read": {
      const id = isJsonRecord(args) && Number.isFinite(Number(args.id)) ? Number(args.id) : NaN;
      if (!Number.isInteger(id) || id < 1) throw new Error("id must be a positive integer");
      const data = await call("GET", `/api/inbox/${id}`);
      return JSON.stringify(data, null, 2);
    }
    case "hi_new_ack": {
      const ids = isJsonRecord(args) && Array.isArray(args.ids) ? args.ids.map(Number).filter(Number.isInteger) : [];
      if (!ids.length) throw new Error("ids must be a non-empty array of message ids");
      const data = await call("POST", "/api/inbox/ack", { ids });
      return JSON.stringify(data, null, 2);
    }
    case "hi_new_send": {
      const to = textArg(args, "to").replace(/^@/, "");
      const body = textArg(args, "body");
      if (!/^[a-z0-9][a-z0-9-]{1,31}$/.test(to)) throw new Error("recipient handle looks invalid");
      if (!body) throw new Error("body is required");
      if (Buffer.byteLength(body, "utf8") > 65536) throw new Error("body exceeds hi.new's 64KB limit");
      const data = await call("POST", `/api/dm/${encodeURIComponent(to)}`, { body, enc: "none" });
      return JSON.stringify(data, null, 2);
    }
    case "hi_new_invite": {
      const message = textArg(args, "message") || undefined;
      const data = await call("POST", "/api/invites", message ? { message } : {});
      return JSON.stringify(data, null, 2);
    }
    case "hi_new_redeem": {
      const url = textArg(args, "url");
      const match = url.match(/hi\.new\/i\/(hni_[A-Za-z0-9]+)\/?$/);
      if (!match) throw new Error("that does not look like a hi.new invite link (https://hi.new/i/hni_…)");
      const data = await call("POST", `/api/invites/${match[1]}/redeem`);
      return JSON.stringify(data, null, 2);
    }
    case "hi_new_grants": {
      const data = await call("GET", "/api/grants");
      return JSON.stringify(data, null, 2);
    }
    case "hi_new_me": {
      const data = await call("GET", "/api/handles/me");
      return JSON.stringify(data, null, 2);
    }
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

async function handle(message: Json): Promise<void> {
  const id = message.id;
  const method = String(message.method ?? "");
  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "muster-hi-new", version: "1.0.0" },
      },
    });
    return;
  }
  if (method === "notifications/initialized" || method.startsWith("notifications/")) return;
  if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    return;
  }
  if (method === "tools/call") {
    const params = isJsonRecord(message.params) ? message.params : {};
    const name = String(params.name ?? "");
    try {
      const text = await dispatch(name, params.arguments);
      send(result(id, text));
    } catch (error) {
      send(result(id, error instanceof Error ? error.message : String(error), true));
    }
  }
}

const input = readline.createInterface({ input: process.stdin, terminal: false });
input.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message: Json;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }
  void handle(message).catch(() => {});
});
input.on("close", () => process.exit(0));
