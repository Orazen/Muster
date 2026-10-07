import { createServer, type RequestListener, type Server } from "node:http";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { waitForExit } from "./testing/cleanup.ts";
import type { JsonObject } from "./schema.ts";

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), "connector-proxy.ts");
let child: ChildProcessWithoutNullStreams | null = null;
const servers: Server[] = [];
const lineReaders: readline.Interface[] = [];

async function listen(handler: RequestListener) {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address) throw new Error("test server did not bind");
  // SAFETY: bound to an explicit 127.0.0.1 host, so address() is AddressInfo
  // with the assigned port — never a pipe-path string.
  return `http://127.0.0.1:${z.object({ port: z.number() }).parse(address).port}`;
}

function start(env: Record<string, string>) {
  child = spawn(process.execPath, ["--experimental-strip-types", ENTRY], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = readline.createInterface({ input: child.stdout });
  lineReaders.push(lines);
  return lines;
}

/** JSON-RPC reply frame the bridge writes on stdout; only the fields the
 * assertions read are declared. */
interface BridgeReply {
  jsonrpc?: string;
  id?: number;
  result?: { content?: Array<{ text?: string }>; isError?: boolean };
}

function nextJson(lines: readline.Interface) {
  return new Promise<BridgeReply>((resolve, reject) => {
    lines.once("line", (line) => {
      try { resolve(JSON.parse(line)); } catch (error) { reject(error); }
    });
  });
}

afterEach(async () => {
  await waitForExit(child ?? undefined, { signal: "SIGTERM", graceMs: 2_000 });
  expect(child === null || child.exitCode !== null || child.signalCode !== null, "owned proxy exited").toBe(true);
  child = null;
  for (const lines of lineReaders.splice(0)) lines.close();
  for (const server of servers.splice(0)) {
    const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await closed;
    expect(server.listening, "owned loopback listener closed").toBe(false);
  }
});

describe("connector MCP bridge", () => {
  it("turns agent connection requests into authenticated chat-card requests", async () => {
    let received: any = null;
    const harness = await listen((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        received = { authorization: request.headers.authorization, body: JSON.parse(body) };
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      });
    });
    const lines = start({
      OMB_HARNESS_URL: harness,
      OMB_COMMS_TOKEN: "bridge-secret",
      OMB_BOT_ID: "bot-1",
      OMB_THREAD_ID: "thread-1",
    });
    child!.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "COMPOSIO_MANAGE_CONNECTIONS", arguments: { toolkits: ["GMAIL"] } },
    })}\n`);
    const reply = await nextJson(lines);
    expect(reply.id).toBe(7);
    expect(reply.result?.content?.[0]?.text).toMatch(/secure connection card/i);
    expect(received.authorization).toBe("Bearer bridge-secret");
    expect(received.body).toMatchObject({ botId: "bot-1", threadId: "thread-1", slugs: ["gmail"] });
    expect(received.body.resumeKey).toMatch(/^[\w-]{8,100}$/);
  });

  it("relays ordinary MCP JSON-RPC without exposing upstream headers on stdout", async () => {
    let upstreamAuthorization = "";
    const upstream = await listen((request, response) => {
      upstreamAuthorization = String(request.headers.authorization ?? "");
      response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "transport-1" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { protocolVersion: "2025-06-18" } }));
    });
    const lines = start({
      OMB_CONNECTOR_UPSTREAM_URL: upstream,
      OMB_CONNECTOR_UPSTREAM_HEADERS: JSON.stringify({ authorization: "Bearer upstream-secret" }),
    });
    child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize", params: {} })}\n`);
    const reply = await nextJson(lines);
    expect(reply).toEqual({ jsonrpc: "2.0", id: 2, result: { protocolVersion: "2025-06-18" } });
    expect(upstreamAuthorization).toBe("Bearer upstream-secret");
    expect(JSON.stringify(reply)).not.toContain("upstream-secret");
  });

  // ── connector approval gate (CONNECTOR-APPROVAL-GATE/v1) ─────────────

  function gateHarness(handler: (approval: { path: string; body: any }) => { approved: boolean } | "hold" | null) {
    return async (request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        if (String(request.url).endsWith("/approve")) {
          const verdict = handler({ path: String(request.url), body: body ? JSON.parse(body) : {} });
          if (verdict !== "hold" && verdict !== null) {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify(verdict.approved ? { approved: true, permit: "a".repeat(64) } : { approved: false }));
          }
          // "hold"/null: the request stays open (the timeout case)
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      });
    };
  }

  it("requires approval for an executable batch with read-looking names", async () => {
    let approvals = 0;
    let upstreamCalls = 0;
    const upstream = await listen((_request, response) => {
      upstreamCalls += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: 11, result: { content: [{ type: "text", text: "listed" }] } }));
    });
    const harness = await listen(gateHarness(() => { approvals += 1; return { approved: true }; }));
    const lines = start({
      OMB_HARNESS_URL: harness,
      OMB_BOT_ID: "bot-1",
      OMB_THREAD_ID: "thread-1",
      OMB_CONNECTOR_UPSTREAM_URL: upstream,
    });
    child!.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: ["GMAIL_LIST_EMAILS", { tool_slug: "SLACK_SEARCH_MESSAGES" }] } },
    })}\n`);
    const reply = await nextJson(lines);
    expect(approvals).toBe(1);
    expect(upstreamCalls).toBe(1);
    expect(reply.result?.content?.[0]?.text).toBe("listed");
    expect(reply.result?.isError).toBeUndefined();
  });

  it("gates a write on one card, and relays once approved", async () => {
    let approvals = 0;
    let approvalBody: any = null;
    let upstreamBody: any = null;
    let upstreamPermit = "";
    const upstream = await listen((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        upstreamBody = JSON.parse(body);
        upstreamPermit = String(request.headers["x-muster-connector-permit"] ?? "");
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: 12, result: { content: [{ type: "text", text: "sent" }] } }));
      });
    });
    const harness = await listen(gateHarness((approval) => {
      approvals += 1;
      approvalBody = approval.body;
      return { approved: true };
    }));
    const lines = start({
      OMB_HARNESS_URL: harness,
      OMB_BOT_ID: "bot-1",
      OMB_THREAD_ID: "thread-1",
      OMB_CONNECTOR_UPSTREAM_URL: upstream,
    });
    child!.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [{ tool_slug: "GMAIL_SEND_EMAIL" }] } },
    })}\n`);
    const reply = await nextJson(lines);
    expect(approvals).toBe(1);
    expect(approvalBody).toMatchObject({ botId: "bot-1", threadId: "thread-1", frame: { jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [{ tool_slug: "GMAIL_SEND_EMAIL" }] } } } });
    // the card content: toolkit named, arg names only
    expect(Object.keys(approvalBody).sort()).toEqual(["botId", "frame", "threadId"]);
    // approved → the original call is relayed unchanged
    expect(upstreamBody).toEqual(approvalBody.frame);
    expect(upstreamPermit).toBe("a".repeat(64));
    expect(JSON.stringify(reply)).not.toContain("a".repeat(64));
    expect(reply.result?.content?.[0]?.text).toBe("sent");
  });

  it("gates a mixed batch as one call listing all its actions", async () => {
    let approvalBody: any = null;
    let upstreamCalls = 0;
    const upstream = await listen((_request, response) => {
      upstreamCalls += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    const harness = await listen(gateHarness((approval) => {
      approvalBody = approval.body;
      return { approved: true };
    }));
    const lines = start({
      OMB_HARNESS_URL: harness,
      OMB_BOT_ID: "bot-1",
      OMB_THREAD_ID: "thread-1",
      OMB_CONNECTOR_UPSTREAM_URL: upstream,
    });
    child!.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 13,
      method: "tools/call",
      params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [{ tool_slug: "GMAIL_LIST_EMAILS" }, { tool_slug: "GMAIL_SEND_EMAIL" }] } },
    })}\n`);
    await nextJson(lines);
    expect(approvalBody.frame.params.arguments.tools).toEqual([{ tool_slug: "GMAIL_LIST_EMAILS" }, { tool_slug: "GMAIL_SEND_EMAIL" }]);
    expect(upstreamCalls).toBe(1);
  });

  it("gates an unknown verb slug (deny-by-default)", async () => {
    let approvals = 0;
    let relayed = false;
    const upstream = await listen((_request, response) => {
      relayed = true;
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    const harness = await listen(gateHarness(() => { approvals += 1; return { approved: true }; }));
    const lines = start({
      OMB_HARNESS_URL: harness,
      OMB_BOT_ID: "bot-1",
      OMB_THREAD_ID: "thread-1",
      OMB_CONNECTOR_UPSTREAM_URL: upstream,
    });
    child!.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 14,
      method: "tools/call",
      params: { name: "GMAIL_WIBBLE_EMAIL" },
    })}\n`);
    await nextJson(lines);
    expect(approvals).toBe(1);
    expect(relayed).toBe(true);
  });

  it("a declined call answers with an isError and never reaches upstream", async () => {
    let upstreamCalls = 0;
    const upstream = await listen((_request, response) => {
      upstreamCalls += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    const harness = await listen(gateHarness(() => ({ approved: false })));
    const lines = start({
      OMB_HARNESS_URL: harness,
      OMB_BOT_ID: "bot-1",
      OMB_THREAD_ID: "thread-1",
      OMB_CONNECTOR_UPSTREAM_URL: upstream,
    });
    child!.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 15,
      method: "tools/call",
      params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [{ tool_slug: "GMAIL_SEND_EMAIL" }] } },
    })}\n`);
    const reply = await nextJson(lines);
    expect(reply.result?.isError).toBe(true);
    expect(reply.result?.content?.[0]?.text).toMatch(/not granted/i);
    expect(upstreamCalls).toBe(0);
  });

  it.each([{ approved: true }, { approved: true, permit: "invalid" }, { approved: true, permit: "a".repeat(64), elevated: true }])("refuses malformed executable permits without relaying", async verdict => {
    let upstreamCalls = 0;
    const upstream = await listen((_request, response) => { upstreamCalls++; response.end("{}"); });
    const harness = await listen((request, response) => { request.resume(); request.on("end", () => response.end(JSON.stringify(verdict))); });
    const lines = start({ OMB_HARNESS_URL: harness, OMB_BOT_ID: "bot-1", OMB_THREAD_ID: "thread-1", OMB_CONNECTOR_UPSTREAM_URL: upstream });
    const reply = nextJson(lines); sendFrame(writeFrame(39));
    expect((await reply).result?.isError).toBe(true);
    expect(upstreamCalls).toBe(0);
  });

  it("a timed-out approval denies", async () => {
    let upstreamCalls = 0;
    const upstream = await listen((_request, response) => {
      upstreamCalls += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    // the harness never answers, so the hold runs out its short test clock
    const harness = await listen(gateHarness(() => null));
    const lines = start({
      OMB_HARNESS_URL: harness,
      OMB_BOT_ID: "bot-1",
      OMB_THREAD_ID: "thread-1",
      OMB_CONNECTOR_UPSTREAM_URL: upstream,
      OMB_CONNECTOR_APPROVAL_TIMEOUT_MS: "150",
    });
    child!.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 16,
      method: "tools/call",
      params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [{ tool_slug: "GMAIL_SEND_EMAIL" }] } },
    })}\n`);
    const reply = await nextJson(lines);
    expect(reply.result?.isError).toBe(true);
    expect(reply.result?.content?.[0]?.text).toMatch(/not granted/i);
    expect(upstreamCalls).toBe(0);
  });

  const writeFrame = (id: number | string) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "GMAIL_SEND_EMAIL", arguments: { action: "GMAIL_LIST_EMAILS", to: "private@example.test" } } });
  const sendFrame = (frame: JsonObject) => child!.stdin.write(`${JSON.stringify(frame)}\n`);

  it("cancels a held request locally before any original frame or cancellation reaches upstream", async () => {
    const upstreamFrames: object[] = [];
    let heldResponse: import("node:http").ServerResponse | undefined;
    const upstream = await listen((request, response) => {
      let body = ""; request.on("data", chunk => { body += chunk; });
      request.on("end", () => { upstreamFrames.push(JSON.parse(body)); response.end("{}"); });
    });
    const harness = await listen((request, response) => {
      request.resume(); request.on("end", () => { heldResponse = response; });
    });
    start({ OMB_HARNESS_URL: harness, OMB_BOT_ID: "bot-1", OMB_THREAD_ID: "thread-1", OMB_CONNECTOR_UPSTREAM_URL: upstream });
    sendFrame(writeFrame(31));
    await expect.poll(() => Boolean(heldResponse), { timeout: 5_000 }).toBe(true);
    sendFrame({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 31 } });
    await expect.poll(() => ({ closed: heldResponse?.destroyed, frames: upstreamFrames }), { timeout: 2_000 }).toEqual({ closed: true, frames: [] });
    // Even a late Allow cannot resurrect the aborted HTTP wait.
    heldResponse!.end(JSON.stringify({ approved: true, permit: "a".repeat(64) }));
    expect(upstreamFrames).toEqual([]);
  });

  it("stdin closure cancels a held approval and exits without executing it", async () => {
    let heldResponse: import("node:http").ServerResponse | undefined;
    let upstreamCalls = 0;
    const upstream = await listen((_request, response) => { upstreamCalls++; response.end("{}"); });
    const harness = await listen((request, response) => { request.resume(); request.on("end", () => { heldResponse = response; }); });
    start({ OMB_HARNESS_URL: harness, OMB_BOT_ID: "bot-1", OMB_THREAD_ID: "thread-1", OMB_CONNECTOR_UPSTREAM_URL: upstream });
    sendFrame(writeFrame(32));
    await expect.poll(() => Boolean(heldResponse), { timeout: 5_000 }).toBe(true);
    child!.stdin.end();
    await waitForExit(child!, { graceMs: 2_000 });
    expect(child!.exitCode).toBe(0);
    expect(heldResponse?.destroyed).toBe(true);
    heldResponse!.end(JSON.stringify({ approved: true, permit: "a".repeat(64) }));
    expect(upstreamCalls).toBe(0);
  });

  it("stdin closure also aborts an ordinary in-flight notification transport", async () => {
    let heldResponse: import("node:http").ServerResponse | undefined;
    const upstream = await listen((request, response) => { request.resume(); request.on("end", () => { heldResponse = response; }); });
    start({ OMB_CONNECTOR_UPSTREAM_URL: upstream });
    sendFrame({ jsonrpc: "2.0", method: "notifications/initialized" });
    await expect.poll(() => Boolean(heldResponse), { timeout: 5_000 }).toBe(true);
    child!.stdin.end();
    await waitForExit(child!, { graceMs: 2_000 });
    expect(child!.exitCode).toBe(0);
    expect(heldResponse?.destroyed).toBe(true);
  });

  it("distinguishes numeric and string request IDs so unrelated cancellation cannot revoke consent", async () => {
    let heldResponse: import("node:http").ServerResponse | undefined;
    const upstreamFrames: object[] = [];
    const upstream = await listen((request, response) => {
      let body = ""; request.on("data", chunk => { body += chunk; });
      request.on("end", () => { const frame = JSON.parse(body); upstreamFrames.push(frame); response.end(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { content: [{ text: "sent" }] } })); });
    });
    const harness = await listen((request, response) => { request.resume(); request.on("end", () => { heldResponse = response; }); });
    const lines = start({ OMB_HARNESS_URL: harness, OMB_BOT_ID: "bot-1", OMB_THREAD_ID: "thread-1", OMB_CONNECTOR_UPSTREAM_URL: upstream });
    const frame = writeFrame("33"); sendFrame(frame);
    await expect.poll(() => Boolean(heldResponse), { timeout: 5_000 }).toBe(true);
    sendFrame({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 33 } });
    const reply = nextJson(lines);
    heldResponse!.end(JSON.stringify({ approved: true, permit: "a".repeat(64) }));
    expect((await reply).result?.content?.[0]?.text).toBe("sent");
    expect(upstreamFrames).toEqual([frame]);
  });

  it("refuses duplicate pending IDs and prevents the original held request from executing", async () => {
    let heldResponse: import("node:http").ServerResponse | undefined;
    let upstreamCalls = 0;
    const upstream = await listen((_request, response) => { upstreamCalls++; response.end("{}"); });
    const harness = await listen((request, response) => { request.resume(); request.on("end", () => { heldResponse = response; }); });
    const lines = start({ OMB_HARNESS_URL: harness, OMB_BOT_ID: "bot-1", OMB_THREAD_ID: "thread-1", OMB_CONNECTOR_UPSTREAM_URL: upstream });
    sendFrame(writeFrame(34)); await expect.poll(() => Boolean(heldResponse), { timeout: 5_000 }).toBe(true);
    const reply = nextJson(lines); sendFrame(writeFrame(34));
    expect((await reply).result?.isError).toBe(true);
    await expect.poll(() => heldResponse?.destroyed).toBe(true);
    heldResponse!.end(JSON.stringify({ approved: true, permit: "a".repeat(64) }));
    expect(upstreamCalls).toBe(0);
  });

  it("passes only the exact search and schema meta-tools without an approval", async () => {
    let approvals = 0;
    const upstreamFrames: object[] = [];
    const upstream = await listen((request, response) => {
      let body = ""; request.on("data", chunk => { body += chunk; }); request.on("end", () => {
        const frame = JSON.parse(body); upstreamFrames.push(frame); response.end(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { content: [{ text: "discovered" }] } }));
      });
    });
    const harness = await listen(gateHarness(() => { approvals++; return { approved: false }; }));
    const lines = start({ OMB_HARNESS_URL: harness, OMB_BOT_ID: "bot-1", OMB_THREAD_ID: "thread-1", OMB_CONNECTOR_UPSTREAM_URL: upstream });
    for (const [id, name] of [[35, "COMPOSIO_SEARCH_TOOLS"], [36, "COMPOSIO_GET_TOOL_SCHEMAS"]]) {
      const reply = nextJson(lines); sendFrame({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: {} } });
      expect((await reply).result?.content?.[0]?.text).toBe("discovered");
    }
    expect(approvals).toBe(0); expect(upstreamFrames).toHaveLength(2);
  });

  it("refuses malformed and over-limit batches before card or upstream transport", async () => {
    let approvals = 0, upstreamCalls = 0;
    const upstream = await listen((_request, response) => { upstreamCalls++; response.end("{}"); });
    const harness = await listen(gateHarness(() => { approvals++; return { approved: true }; }));
    const lines = start({ OMB_HARNESS_URL: harness, OMB_BOT_ID: "bot-1", OMB_THREAD_ID: "thread-1", OMB_CONNECTOR_UPSTREAM_URL: upstream });
    for (const tools of [["GMAIL_LIST_EMAILS", { unrecognized: "GMAIL_SEND_EMAIL" }], Array.from({ length: 13 }, () => "GMAIL_SEND_EMAIL")]) {
      const reply = nextJson(lines); sendFrame({ jsonrpc: "2.0", id: 37, method: "tools/call", params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools } } });
      expect((await reply).result?.isError).toBe(true);
    }
    expect(approvals).toBe(0); expect(upstreamCalls).toBe(0);
  });

  it("does not treat connection-tool suffixes as authorized connection handlers", async () => {
    let approvals = 0, connections = 0, upstreamCalls = 0;
    const upstream = await listen((_request, response) => { upstreamCalls++; response.end("{}"); });
    const harness = await listen((request, response) => {
      request.resume(); request.on("end", () => { if (request.url?.endsWith("/approve")) approvals++; else connections++; response.end(JSON.stringify({ approved: false })); });
    });
    const lines = start({ OMB_HARNESS_URL: harness, OMB_BOT_ID: "bot-1", OMB_THREAD_ID: "thread-1", OMB_CONNECTOR_UPSTREAM_URL: upstream });
    for (const name of ["EVIL_MANAGE_CONNECTIONS", "EVIL_WAIT_FOR_CONNECTIONS", "EVIL_COMPOSIO_SEARCH_TOOLS_EXECUTE"]) {
      const reply = nextJson(lines); sendFrame({ jsonrpc: "2.0", id: 38, method: "tools/call", params: { name, arguments: { toolkits: ["GMAIL"] } } });
      expect((await reply).result?.isError).toBe(true);
    }
    expect(approvals).toBe(3); expect(connections).toBe(0); expect(upstreamCalls).toBe(0);
  });

  it("flag off (MUSTER_CONNECTOR_APPROVAL=off) bypasses the gate entirely", async () => {
    let approvals = 0;
    let upstreamCalls = 0;
    const upstream = await listen((_request, response) => {
      upstreamCalls += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: 17, result: { content: [{ type: "text", text: "sent" }] } }));
    });
    const harness = await listen(gateHarness(() => { approvals += 1; return { approved: true }; }));
    const lines = start({
      OMB_HARNESS_URL: harness,
      OMB_BOT_ID: "bot-1",
      OMB_THREAD_ID: "thread-1",
      OMB_CONNECTOR_UPSTREAM_URL: upstream,
      MUSTER_CONNECTOR_APPROVAL: "off",
    });
    child!.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 17,
      method: "tools/call",
      params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [{ tool_slug: "GMAIL_SEND_EMAIL" }] } },
    })}\n`);
    const reply = await nextJson(lines);
    expect(approvals).toBe(0);
    expect(upstreamCalls).toBe(1);
    expect(reply.result?.content?.[0]?.text).toBe("sent");
  });
});
