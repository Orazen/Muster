// Tests for the fleet MCP server: protocol handshake over stdio-style
// streams, tool listing, and each tool's harness interaction (with fetch
// stubbed — the real REST shapes are index.ts's contract, re-tested here
// only as far as this client maps them).
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadFleetConfig, serveFleetMcp } from "./fleet-mcp.ts";

const dirs: string[] = [];

function pairedDir(cfg: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "fleet-mcp-"));
  dirs.push(dir);
  writeFileSync(join(dir, "cli.json"), JSON.stringify(cfg));
  return dir;
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Feed JSON-RPC lines through a PassThrough and collect replies until the
 *  predicate sees the id it wants. serveFleetMcp answers asynchronously for
 *  tools/call, so the caller waits on a specific id, not a fixed count. */
function session() {
  const input = new PassThrough();
  const replies: any[] = [];
  serveFleetMcp(input, (line) => {
    replies.push(JSON.parse(line));
  });
  let nextId = 0;
  const call = (method: string, params?: unknown) =>
    new Promise<any>((resolve) => {
      const id = ++nextId;
      const poll = setInterval(() => {
        const hit = replies.find((r) => r.id === id);
        if (hit) {
          clearInterval(poll);
          resolve(hit);
        }
      }, 5);
      input.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  return { input, replies, call };
}

function jsonRes(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status });
}

describe("loadFleetConfig", () => {
  it("reads the paired config and rejects an unpaired dir", () => {
    const cfg = { base: "http://127.0.0.1:8845", cookie: "muster_session=abc" };
    expect(loadFleetConfig(pairedDir(cfg))).toEqual(cfg);
    const empty = mkdtempSync(join(tmpdir(), "fleet-mcp-"));
    dirs.push(empty);
    expect(() => loadFleetConfig(empty)).toThrow(/Not paired/);
  });

  it("rejects a MUSTER_DIR with .. traversal and a config of the wrong shape", () => {
    expect(() => loadFleetConfig("/tmp/escape/../elsewhere")).toThrow(/MUSTER_DIR/);
    const bad = pairedDir({ base: "http://x", cookie: 42 as unknown as string });
    expect(() => loadFleetConfig(bad)).toThrow(/unreadable/);
  });
});

describe("protocol", () => {
  it("answers initialize and lists the six bounded tools", async () => {
    const { call } = session();
    const init = await call("initialize", { capabilities: {} });
    expect(init.result.protocolVersion).toBe("2024-11-05");
    expect(init.result.serverInfo.name).toBe("muster-fleet");
    const listed = await call("tools/list", {});
    const names = listed.result.tools.map((t: any) => t.name);
    expect(names).toEqual([
      "fleet_status",
      "send_task",
      "wait_for_conversation",
      "get_receipt",
      "read_memory",
      "get_approval_history",
    ]);
  });

  it("ignores notifications and returns -32601 for unknown methods", async () => {
    const { input, replies, call } = session();
    input.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const err = await call("some/future/method");
    expect(err.error.code).toBe(-32601);
    expect(replies.filter((r) => r.id === undefined)).toHaveLength(0);
  });

  it("returns -32602 for an unknown tool", async () => {
    const { call } = session();
    const err = await call("tools/call", { name: "delete_everything", arguments: {} });
    expect(err.error.code).toBe(-32602);
  });
});

describe("tools", () => {
  let paired: string;
  beforeEach(() => {
    // Tool run()s read the env like the real process does — point MUSTER_DIR
    // at a paired temp dir so tests never touch the developer's ~/.muster.
    paired = pairedDir({ base: "http://127.0.0.1:8845", cookie: "muster_session=test" });
    process.env.MUSTER_DIR = paired;
  });
  afterEach(() => {
    delete process.env.MUSTER_DIR;
  });

  it("fleet_status maps the roster compactly", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
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
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload.count).toBe(2);
    expect(payload.bots[0]).toEqual({
      id: "b1",
      name: "Atlas",
      title: "",
      activity: "working",
      busy: true,
      unread: false,
      engine: { model: "gpt-6", instance: "inst-1" },
      lastTask: { title: "Draft brief", usage: { input: 10, output: 5 } },
    });
    expect(payload.bots[1]).not.toHaveProperty("engine");
  });

  it("send_task posts and reports queueing", async () => {
    const fetchMock = vi.fn(async () => jsonRes(202, { ok: true, queued: true, messageId: "m9" }));
    vi.stubGlobal("fetch", fetchMock);
    const { call } = session();
    const res = await call("tools/call", {
      name: "send_task",
      arguments: { botId: "b1", text: "Draft the brief" },
    });
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload).toEqual({
      ok: true,
      queued: true,
      messageId: "m9",
      note: "Bot was mid-turn; your message is queued and will steer the running turn.",
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8845/api/bots/b1/messages");
    expect(init.method).toBe("POST");
  });

  it("wait_for_conversation returns needs-user with the pending card", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
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
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload.outcome).toBe("needs-user");
    expect(payload.needsUser.title).toBe("Deploy to prod?");
    expect(payload.needsUser.options).toEqual(["Allow", "Deny"]);
  });

  it("wait_for_conversation settles on the latest bot reply and ignores stale cards", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
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
                card: { title: "Old question", options: ["A"], answered: true },
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
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload.outcome).toBe("settled");
    expect(payload.reply).toBe("Done — brief drafted.");
    expect(payload.needsUser).toBeUndefined();
  });

  it("wait_for_conversation reports failed for a dead engine", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
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
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload.outcome).toBe("failed");
  });

  it("wait_for_conversation keeps working until the deadline, then reports working", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonRes(200, { bot: { id: "b1", busy: true, activity: "working", messages: [] } })),
    );
    const { call } = session();
    const res = await call("tools/call", {
      name: "wait_for_conversation",
      arguments: { botId: "b1", timeoutSeconds: 5 },
    });
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload.outcome).toBe("working");
    expect(payload.hint).toMatch(/poll again/i);
  }, 20_000);

  it("get_receipt and read_memory pass through the harness payloads", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.includes("/receipts/")
        ? jsonRes(200, { receipt: { botName: "Atlas" }, text: "Receipt: Atlas" })
        : jsonRes(200, { text: "Remembers: prefers terse replies." }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { call } = session();
    const receipt = await call("tools/call", {
      name: "get_receipt",
      arguments: { botId: "b1", threadId: "t1" },
    });
    expect(JSON.parse(receipt.result.content[0].text).text).toBe("Receipt: Atlas");
    const memory = await call("tools/call", {
      name: "read_memory",
      arguments: { botId: "b1" },
    });
    expect(JSON.parse(memory.result.content[0].text).memory).toContain("terse");
  });

  it("surfaces HTTP errors and 401s as tool errors, not crashes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonRes(401, { error: "unauthorized" })),
    );
    const { call } = session();
    const res = await call("tools/call", { name: "fleet_status", arguments: {} });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/muster pair/i);
  });
});
