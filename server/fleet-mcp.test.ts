// Tests for the fleet MCP server: protocol handshake over stdio-style
// streams, tool listing, and each tool's harness interaction (with fetch
// stubbed — the real REST shapes are index.ts's contract, re-tested here
// only as far as this client maps them).
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { loadFleetConfig, serveFleetMcp } from "./fleet-mcp.ts";
import { Store, type BotRecord, type Message } from "./store.ts";
import { parseJson, type JsonObject, type JsonValue } from "./schema.ts";

const dirs: string[] = [];
const sessions: Array<() => void> = [];
const jsonObjectSchema = z.record(z.string(), z.json());
const replySchema = z.object({
  jsonrpc: z.literal("2.0"), id: z.union([z.string(), z.number().int(), z.null()]),
  result: jsonObjectSchema.optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});
type RpcReply = z.infer<typeof replySchema>;
type RpcId = string | number;
const toolResultSchema = z.object({
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })).min(1),
  isError: z.boolean().optional(),
});
function toolResult(reply: RpcReply) { return toolResultSchema.parse(reply.result); }
function toolPayload(reply: RpcReply): JsonObject {
  return jsonObjectSchema.parse(parseJson(toolResult(reply).content[0].text));
}

function pairedDir(cfg: JsonObject) {
  const dir = mkdtempSync(join(tmpdir(), "fleet-mcp-"));
  dirs.push(dir);
  writeFileSync(join(dir, "cli.json"), JSON.stringify(cfg));
  return dir;
}

// Every request must be explicitly mocked; fixtures cannot reach the demo.
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(new Error("Unexpected fleet fixture request")));
});

afterEach(() => {
  for (const close of sessions.splice(0)) close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Correlate replies directly by ID, with a bounded failure deadline.
 * Every owned stream and pending timer is closed after its test. */
function session() {
  const input = new PassThrough();
  const replies: RpcReply[] = [];
  const pending = new Map<RpcId, {
    resolve: (reply: RpcReply) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>;
  }>();
  const reader = serveFleetMcp(input, (line) => {
    const reply = replySchema.parse(parseJson(line));
    replies.push(reply);
    if (reply.id === null) return;
    const waiting = pending.get(reply.id);
    if (waiting) {
      clearTimeout(waiting.timer);
      pending.delete(reply.id);
      waiting.resolve(reply);
    }
  });
  sessions.push(() => {
    reader.close();
    input.destroy();
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Fleet fixture closed before its reply"));
    }
    pending.clear();
  });
  let nextId = 0;
  const request = (message: JsonObject, id: RpcId) =>
    new Promise<RpcReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Fleet fixture timed out waiting for ${id}`));
      }, 15_000);
      pending.set(id, { resolve, reject, timer });
      input.write(JSON.stringify(message) + "\n");
    });
  const call = (method: string, params?: JsonObject, id: RpcId = ++nextId) => {
    const message: JsonObject = { jsonrpc: "2.0", id, method };
    if (params !== undefined) message.params = params;
    return request(message, id);
  };
  return { input, replies, call, request };
}

type HttpFixture = JsonValue | { bot: BotRecord & { messages: Message[] } };
function jsonRes(status: number, body: HttpFixture) {
  return new Response(JSON.stringify(body), { status });
}

describe("loadFleetConfig", () => {
  it("reads the paired config and rejects an unpaired dir", () => {
    const cfg = { base: "https://fleet-fixture.invalid", cookie: "muster_session=abc" };
    expect(loadFleetConfig(pairedDir(cfg))).toEqual(cfg);
    const empty = mkdtempSync(join(tmpdir(), "fleet-mcp-"));
    dirs.push(empty);
    expect(() => loadFleetConfig(empty)).toThrow(/Not paired/);
  });

  it("rejects a MUSTER_DIR with .. traversal and a config of the wrong shape", () => {
    expect(() => loadFleetConfig("/tmp/escape/../elsewhere")).toThrow(/MUSTER_DIR/);
    const bad = pairedDir({ base: "http://x", cookie: 42 });
    expect(() => loadFleetConfig(bad)).toThrow(/unreadable/);
  });
});

describe("protocol", () => {
  it("answers initialize and lists the eight bounded tools", async () => {
    const { call } = session();
    const init = await call("initialize", { capabilities: {} });
    expect(init.result?.protocolVersion).toBe("2024-11-05");
    expect(init.result?.serverInfo).toMatchObject({ name: "muster-fleet" });
    const listed = await call("tools/list", {});
    const names = z.array(z.object({ name: z.string() })).parse(listed.result?.tools).map((t) => t.name);
    expect(names).toEqual([
      "fleet_status",
      "send_task",
      "wait_for_conversation",
      "get_receipt",
      "read_memory",
      "get_approval_history",
      "get_why_journal",
      "get_scorecard",
    ]);
  });

  it("ignores notifications and returns -32601 for unknown methods", async () => {
    const { input, replies, call } = session();
    input.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const err = await call("some/future/method");
    expect(err.error?.code).toBe(-32601);
    expect(replies).toHaveLength(1);
  });

  it("returns -32602 for an unknown tool", async () => {
    const { call } = session();
    const err = await call("tools/call", { name: "delete_everything", arguments: {} });
    expect(err.error?.code).toBe(-32602);
  });

  it.each([0, -3, "0", "request-abc"])("round-trips request ID %j without coercion", async (id) => {
    const { call } = session();
    const reply = await call("tools/list", {}, id);
    expect(reply.id).toBe(id);
    expect(z.array(z.json()).parse(reply.result?.tools)).toHaveLength(8);
  });

  it.each([
    { raw: "{broken", code: -32700, id: null },
    { raw: "null", code: -32600, id: null },
    { raw: "42", code: -32600, id: null },
    { raw: "[]", code: -32600, id: null },
    { raw: "{}", code: -32600, id: null },
    { raw: '{"jsonrpc":"2.0","id":null,"method":"initialize"}', code: -32600, id: null },
    { raw: '{"jsonrpc":"2.0","id":1.5,"method":"initialize"}', code: -32600, id: null },
    { raw: '{"jsonrpc":"2.0","id":false,"method":"initialize"}', code: -32600, id: null },
    { raw: '{"id":0,"method":"initialize"}', code: -32600, id: 0 },
    { raw: '{"jsonrpc":"2.0","id":"broken-method","method":7}', code: -32600, id: "broken-method" },
  ])("reports malformed frame $raw and continues serving", async ({ raw, code, id }) => {
    const { input, replies, call } = session();
    input.write(raw + "\n");
    const following = await call("initialize", {}, "following");
    expect(replies).toHaveLength(2);
    expect(replies[0]).toMatchObject({ id, error: { code } });
    expect(following.id).toBe("following");
    expect(following.result?.protocolVersion).toBe("2024-11-05");
  });

  it.each([null, [], "params", 7])("rejects non-object request params %j with their exact ID", async (params) => {
    const { request } = session();
    const response = await request({ jsonrpc: "2.0", id: 0, method: "initialize", params }, 0);
    expect(response.id).toBe(0);
    expect(response.error?.code).toBe(-32600);
  });

  it.each([null, [], "arguments", 7])("rejects non-object tool arguments %j before any REST call", async (args) => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const { call } = session();
    const response = await call("tools/call", { name: "fleet_status", arguments: args });
    expect(response.error?.code).toBe(-32602);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("tools", () => {
  let paired: string;
  beforeEach(() => {
    // Tool run()s read the env like the real process does — point MUSTER_DIR
    // at a paired temp dir so tests never touch the developer's ~/.muster.
    paired = pairedDir({ base: "https://fleet-fixture.invalid", cookie: "muster_session=test" });
    vi.stubEnv("MUSTER_DIR", paired);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const malformedArguments: Array<{ name: string; arguments: JsonObject }> = [
    { name: "fleet_status", arguments: { approve: true } },
    { name: "send_task", arguments: { botId: "b1", text: null } },
    { name: "wait_for_conversation", arguments: { botId: 7 } },
    { name: "wait_for_conversation", arguments: { botId: "b1", timeoutSeconds: "fast" } },
    { name: "get_receipt", arguments: { botId: "b1", threadId: false } },
    { name: "read_memory", arguments: { botId: ["b1"] } },
    { name: "get_approval_history", arguments: { botId: "b1", approve: true } },
  ];
  it.each(malformedArguments)("$name rejects malformed domain arguments before fetching", async (params) => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const response = await session().call("tools/call", params);
    expect(toolResult(response).isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  const malformedResponses: Array<{ name: string; arguments: JsonObject; body: JsonValue }> = [
    { name: "fleet_status", arguments: {}, body: null },
    { name: "fleet_status", arguments: {}, body: {} },
    { name: "fleet_status", arguments: {}, body: { bots: "bad list" } },
    { name: "send_task", arguments: { botId: "b1", text: "Task" }, body: {} },
    { name: "send_task", arguments: { botId: "b1", text: "Task" }, body: { ok: false } },
    { name: "read_memory", arguments: { botId: "b1" }, body: { text: 42 } },
    { name: "get_receipt", arguments: { botId: "b1", threadId: "t1" }, body: { receipt: null } },
    { name: "get_approval_history", arguments: { botId: "b1" }, body: { entries: "bad list" } },
  ];
  it.each(malformedResponses)("$name rejects malformed success body $body", async ({ name, arguments: args, body }) => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonRes(200, body));
    vi.stubGlobal("fetch", fetchMock);
    const response = await session().call("tools/call", { name, arguments: args });
    expect(toolResult(response).isError).toBe(true);
    expect(toolResult(response).content[0].text).toMatch(/unreadable response/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid JSON success without presenting an empty fleet", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("{broken", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const response = await session().call("tools/call", { name: "fleet_status" });
    expect(toolResult(response).isError).toBe(true);
    expect(toolResult(response).content[0].text).toMatch(/unreadable response/);
  });

  it("preserves a valid ack without a message echo and sends the pairing headers", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonRes(202, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const response = await session().call("tools/call", { name: "send_task", arguments: { botId: "b1", text: "Task" } });
    expect(toolPayload(response)).toEqual({ ok: true, queued: false, note: "Turn started." });
    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(headers.get("cookie")).toBe("muster_session=test");
    expect(headers.get("origin")).toBe("https://fleet-fixture.invalid");
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("preserves complete audit entries, pagination and extra JSON evidence", async () => {
    const audit = { entries: [{ id: "decision", at: 1, action: "read_file", decision: "allowed", summary: "Read report" }],
      nextBefore: "older", evidence: { recorded: true } };
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => jsonRes(200, audit)));
    const response = await session().call("tools/call", { name: "get_approval_history", arguments: { botId: "b1" } });
    expect(toolPayload(response)).toEqual(audit);
  });

  it("preserves a meaningful non-401 server error", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => jsonRes(503, { error: "Fixture engine unavailable" })));
    const response = await session().call("tools/call", { name: "fleet_status" });
    expect(toolResult(response)).toEqual({ content: [{ type: "text", text: "Fixture engine unavailable" }], isError: true });
  });

  it("get_why_journal issues a bounded GET and returns only the requested bot", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonRes(200, { entries: [
      { runId: "r", botId: "b1", threadId: "t", at: 1, intent: "Inspect", decisions: [], outcome: "failed" },
      { runId: "r2", botId: "b2", threadId: "t2", at: 2, intent: "Other", decisions: [], outcome: "done" },
    ] }));
    vi.stubGlobal("fetch", fetchMock);
    const { call } = session();
    const response = await call("tools/call", { name: "get_why_journal", arguments: { botId: "b1", limit: 2 } });
    expect(toolResult(response).isError).toBeUndefined();
    expect(toolPayload(response).entries).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith("https://fleet-fixture.invalid/api/bots/b1/why?limit=2", expect.objectContaining({ method: "GET" }));
  });

  it("get_scorecard checks bot access and projects routine evidence with GET only", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonRes(200, { bot: { id: "b1" } })).mockResolvedValueOnce(jsonRes(200, {
      runs: [{ id: "r", botId: "b1", routineId: "routine", routineName: "Inspect", scheduledFor: 1, status: "completed", output: "private" }],
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { call } = session();
    const response = await call("tools/call", { name: "get_scorecard", arguments: { botId: "b1" } });
    const payload = toolPayload(response);
    expect(z.array(jsonObjectSchema).parse(payload.runs)[0].output).toBeUndefined();
    expect(z.array(jsonObjectSchema).parse(payload.runs)[0].scorecard).toBeUndefined();
    expect(fetchMock).toHaveBeenNthCalledWith(1, "https://fleet-fixture.invalid/api/bots/b1?messages=0", expect.objectContaining({ method: "GET" }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "https://fleet-fixture.invalid/api/routines", expect.objectContaining({ method: "GET" }));
  });

  it("evidence tools reject write arguments before making a request", async () => {
    const fetchMock = vi.fn<typeof fetch>(); vi.stubGlobal("fetch", fetchMock);
    const { call } = session();
    for (const name of ["get_why_journal", "get_scorecard"]) {
      const response = await call("tools/call", { name, arguments: { botId: "b1", approve: true } });
      expect(toolResult(response).isError).toBe(true);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("get_scorecard stops when the requested bot is inaccessible", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonRes(404, { error: "no such bot" }));
    vi.stubGlobal("fetch", fetchMock);
    const { call } = session();
    const response = await call("tools/call", { name: "get_scorecard", arguments: { botId: "b1" } });
    expect(toolResult(response).isError).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("send_task attaches an authenticated receipt snapshot before posting", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonRes(200, { bot: { id: "source" } }))
      .mockResolvedValueOnce(jsonRes(200, { receipt: {
        version: 1, bot: "Source", job: "Report", startedAt: "2026-09-09T00:00:00Z", durationMs: 10,
        turns: 1, tokensIn: 10, tokensOut: 20, costUsd: null, result: "done", summary: "Prior output",
      } }))
      .mockResolvedValueOnce(jsonRes(202, { queued: false, messageId: "new-message" }));
    vi.stubGlobal("fetch", fetchMock);
    const { call } = session();
    const receiptRef = { botId: "source", threadId: "old-thread" };
    const response = await call("tools/call", { name: "send_task", arguments: { botId: "target", text: "Review this", receiptRef } });
    expect(toolPayload(response).receiptRef).toEqual(receiptRef);
    expect(fetchMock).toHaveBeenNthCalledWith(1, "https://fleet-fixture.invalid/api/bots/source?messages=0", expect.objectContaining({ method: "GET" }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "https://fleet-fixture.invalid/api/receipts/source/old-thread", expect.objectContaining({ method: "GET" }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, "https://fleet-fixture.invalid/api/bots/target/messages", expect.objectContaining({ method: "POST", body: expect.stringContaining("Prior output") }));
  });

  it("send_task does not post when its receipt source is inaccessible", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonRes(404, { error: "no such bot" }));
    vi.stubGlobal("fetch", fetchMock);
    const { call } = session();
    const response = await call("tools/call", { name: "send_task", arguments: { botId: "target", text: "Review", receiptRef: { botId: "source", threadId: "thread" } } });
    expect(toolResult(response).isError).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("send_task does not post when the fetched receipt is malformed", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonRes(200, { bot: { id: "source" } })).mockResolvedValueOnce(jsonRes(200, { receipt: null }));
    vi.stubGlobal("fetch", fetchMock);
    const { call } = session();
    const response = await call("tools/call", { name: "send_task", arguments: { botId: "target", text: "Review", receiptRef: { botId: "source", threadId: "thread" } } });
    expect(toolResult(response).isError).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fleet_status maps the roster compactly", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        jsonRes(200, {
          bots: [
            {
              id: "b1",
              name: "Atlas",
              busy: true,
              modelSelection: { model: "gpt-6", instanceId: "inst-1" },
              tasks: [{ title: "Draft brief", usage: { input: 10, output: 5 } }],
            },
            { id: "b2", name: "Vex", busy: false },
          ],
        }),
      ),
    );
    const { call } = session();
    const res = await call("tools/call", { name: "fleet_status", arguments: {} });
    const payload = toolPayload(res);
    expect(payload.count).toBe(2);
    expect(z.array(jsonObjectSchema).parse(payload.bots)[0]).toEqual({
      id: "b1",
      name: "Atlas",
      title: "",
      activity: "working",
      busy: true,
      unread: false,
      engine: { model: "gpt-6", instance: "inst-1" },
      lastTask: { title: "Draft brief", usage: { input: 10, output: 5 } },
    });
    expect(z.array(jsonObjectSchema).parse(payload.bots)[1]).not.toHaveProperty("engine");
  });

  it("send_task posts and reports queueing", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonRes(202, { ok: true, queued: true, messageId: "m9" }));
    vi.stubGlobal("fetch", fetchMock);
    const { call } = session();
    const res = await call("tools/call", {
      name: "send_task",
      arguments: { botId: "b1", text: "Draft the brief" },
    });
    const payload = toolPayload(res);
    expect(payload).toEqual({
      ok: true,
      queued: true,
      messageId: "m9",
      note: "Bot was mid-turn; your message is queued and will steer the running turn.",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://fleet-fixture.invalid/api/bots/b1/messages");
    expect(init?.method).toBe("POST");
  });

  it.each(["waiting-on-you", "no-signal"] as const)("wait_for_conversation preserves the store's %s state despite busy", async (activity) => {
    const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
    const bot = store.createBot({ name: "State fixture" }, { seedMessages: false });
    store.setActivity(bot.id, activity);
    expect(bot.busy).toBe(true);
    if (activity === "waiting-on-you") {
      store.appendMessage(bot.threadId, {
        role: "bot", kind: "options",
        card: { title: "Allow inspection?", subtitle: "Read the report", options: ["Allow", "Deny"], requestId: "request", tool: "read_file" },
      });
    }
    const fetchMock = vi.fn<typeof fetch>(async () => jsonRes(200, { bot: { ...bot, messages: store.messagesFor(bot.threadId) } }));
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    const { call } = session();
    const pending = call("tools/call", { name: "wait_for_conversation", arguments: { botId: bot.id, timeoutSeconds: 5 } });
    await vi.advanceTimersByTimeAsync(5_005);
    const payload = toolPayload(await pending);
    expect(payload.outcome).toBe(activity === "waiting-on-you" ? "needs-user" : "stalled");
    expect(payload.threadId).toBe(bot.threadId);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]?.method ?? "GET").toBe("GET");
    if (activity === "waiting-on-you") {
      expect(payload.needsUser).toMatchObject({ title: "Allow inspection?", options: ["Allow", "Deny"], permission: "read_file" });
      expect(store.messagesFor(bot.threadId)[0].card?.answered).toBeUndefined();
    }
  });

  it("wait_for_conversation reports explicit waiting when its card is outside the excerpt", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonRes(200, { bot: { id: "b1", busy: true, activity: "waiting-on-you", threadId: "t1", messages: [] } }));
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    const { call } = session();
    const pending = call("tools/call", { name: "wait_for_conversation", arguments: { botId: "b1", timeoutSeconds: 5 } });
    await vi.advanceTimersByTimeAsync(5_005);
    const payload = toolPayload(await pending);
    expect(payload.outcome).toBe("needs-user");
    expect(payload.needsUser).toBeUndefined();
    expect(payload.hint).toContain("human owner");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("wait_for_conversation stops polling when a working bot opens an approval", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonRes(200, { bot: { id: "b1", busy: true, activity: "working", threadId: "t1", messages: [] } }))
      .mockResolvedValue(jsonRes(200, { bot: { id: "b1", busy: true, activity: "waiting-on-you", threadId: "t1", messages: [] } }));
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    const { call } = session();
    const pending = call("tools/call", { name: "wait_for_conversation", arguments: { botId: "b1", timeoutSeconds: 5 } });
    await vi.advanceTimersByTimeAsync(5_005);
    expect(toolPayload(await pending).outcome).toBe("needs-user");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("wait_for_conversation returns needs-user for an idle bot with a pending card", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        jsonRes(200, {
          bot: {
            id: "b1",
            busy: false,
            activity: "idle",
            threadId: "t1",
            messages: [
              { id: "m1", role: "user", kind: "text", text: "go" },
              {
                id: "m2",
                role: "bot",
                kind: "options",
                card: { title: "Deploy to prod?", options: ["Allow", "Deny"] },
              },
            ],
          },
        }),
      ),
    );
    const { call } = session();
    const res = await call("tools/call", {
      name: "wait_for_conversation",
      arguments: { botId: "b1", timeoutSeconds: 5 },
    });
    const payload = toolPayload(res);
    expect(payload.outcome).toBe("needs-user");
    expect(payload.needsUser).toMatchObject({ title: "Deploy to prod?", options: ["Allow", "Deny"] });
  });

  it("wait_for_conversation settles on the latest bot reply and ignores stale cards", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        jsonRes(200, {
          bot: {
            id: "b1",
            busy: false,
            activity: "idle",
            threadId: "t1",
            messages: [
              {
                id: "m1",
                role: "bot",
                kind: "options",
                card: { title: "Old question", options: ["A"], answered: "A" },
              },
              { id: "m2", role: "bot", kind: "text", text: "Done — brief drafted." },
            ],
          },
        }),
      ),
    );
    const { call } = session();
    const res = await call("tools/call", {
      name: "wait_for_conversation",
      arguments: { botId: "b1", timeoutSeconds: 5 },
    });
    const payload = toolPayload(res);
    expect(payload.outcome).toBe("settled");
    expect(payload.reply).toBe("Done — brief drafted.");
    expect(payload.needsUser).toBeUndefined();
  });

  it("keeps the latest substantive reply as a barrier to an unmarked older card", async () => {
    vi.useFakeTimers();
    const messages: JsonObject[] = [
      { id: "old", role: "bot", kind: "options", card: { title: "Old request", options: ["Allow", "Deny"] } },
      { id: "reply", role: "bot", kind: "text", text: "Latest substantive reply" },
      { id: "tick", role: "bot", kind: "activity", text: "Idle" },
      { id: "whitespace", role: "bot", kind: "text", text: "  " },
    ];
    const fetchMock = vi.fn<typeof fetch>(async () => jsonRes(200, { bot: {
      id: "b1", threadId: "t1", activity: "idle", busy: false, messages,
    } }));
    vi.stubGlobal("fetch", fetchMock);
    const pending = session().call("tools/call", { name: "wait_for_conversation", arguments: { botId: "b1", timeoutSeconds: 5 } });
    await vi.advanceTimersByTimeAsync(2_500);
    expect(toolPayload(await pending)).toEqual({
      outcome: "settled", reply: "Latest substantive reply", threadId: "t1",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails on a malformed conversation instead of reporting a stalled empty transcript", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => jsonRes(200, {
      bot: { id: "b1", activity: "idle", messages: "bad transcript" },
    })));
    const pending = session().call("tools/call", { name: "wait_for_conversation", arguments: { botId: "b1", timeoutSeconds: 5 } });
    await vi.advanceTimersByTimeAsync(2_500);
    const response = await pending;
    expect(toolResult(response).isError).toBe(true);
    expect(toolResult(response).content[0].text).toMatch(/unreadable response/);
  });

  it("wait_for_conversation reports failed for a dead engine", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        jsonRes(200, {
          bot: { id: "b1", busy: false, activity: "dead", messages: [] },
        }),
      ),
    );
    const { call } = session();
    const res = await call("tools/call", {
      name: "wait_for_conversation",
      arguments: { botId: "b1", timeoutSeconds: 5 },
    });
    const payload = toolPayload(res);
    expect(payload.outcome).toBe("failed");
  });

  it("wait_for_conversation keeps working until the deadline, then reports working", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => jsonRes(200, { bot: { id: "b1", busy: true, activity: "working", messages: [] } })),
    );
    const { call } = session();
    const res = await call("tools/call", {
      name: "wait_for_conversation",
      arguments: { botId: "b1", timeoutSeconds: 5 },
    });
    const payload = toolPayload(res);
    expect(payload.outcome).toBe("working");
    expect(payload.hint).toMatch(/poll again/i);
  }, 20_000);

  it("get_receipt and read_memory pass through the harness payloads", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) =>
      String(url).includes("/receipts/")
        ? jsonRes(200, { receipt: { botName: "Atlas" }, text: "Receipt: Atlas" })
        : jsonRes(200, { text: "Remembers: prefers terse replies." }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { call } = session();
    const receipt = await call("tools/call", {
      name: "get_receipt",
      arguments: { botId: "b1", threadId: "t1" },
    });
    expect(toolPayload(receipt).text).toBe("Receipt: Atlas");
    const memory = await call("tools/call", {
      name: "read_memory",
      arguments: { botId: "b1" },
    });
    expect(toolPayload(memory).memory).toContain("terse");
  });

  it("surfaces HTTP errors and 401s as tool errors, not crashes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => jsonRes(401, { error: "unauthorized" })),
    );
    const { call } = session();
    const res = await call("tools/call", { name: "fleet_status", arguments: {} });
    expect(toolResult(res).isError).toBe(true);
    expect(toolResult(res).content[0].text).toMatch(/muster pair/i);
  });
});
