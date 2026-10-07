import { createServer, type RequestListener, type Server } from "node:http";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { afterEach, describe, expect, it } from "vitest";

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), "connector-proxy.ts");
let child: ChildProcessWithoutNullStreams | null = null;
let server: Server | null = null;

async function listen(handler: RequestListener) {
  server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address) throw new Error("test server did not bind");
  // SAFETY: bound to an explicit 127.0.0.1 host, so address() is AddressInfo
  // with the assigned port — never a pipe-path string.
  return `http://127.0.0.1:${(address as { port: number }).port}`;
}

function start(env: Record<string, string>) {
  child = spawn(process.execPath, ["--experimental-strip-types", ENTRY], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  return readline.createInterface({ input: child.stdout });
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
  child?.kill("SIGKILL");
  child = null;
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
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
            response.end(JSON.stringify({ approved: verdict.approved }));
          }
          // "hold"/null: the request stays open (the timeout case)
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      });
    };
  }

  it("passes a read-only multi-execute batch through with no approval ask", async () => {
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
    expect(approvals).toBe(0);
    expect(upstreamCalls).toBe(1);
    expect(reply.result?.content?.[0]?.text).toBe("listed");
    expect(reply.result?.isError).toBeUndefined();
  });

  it("gates a write on one card, and relays once approved", async () => {
    let approvals = 0;
    let approvalBody: any = null;
    let upstreamBody: any = null;
    const upstream = await listen((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        upstreamBody = JSON.parse(body);
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
    expect(approvalBody).toMatchObject({ botId: "bot-1", threadId: "thread-1", actions: ["GMAIL_SEND_EMAIL"] });
    // the card content: toolkit named, arg names only
    expect(approvalBody.toolkits).toEqual(["gmail"]);
    expect(String(approvalBody.argsSummary)).not.toMatch(/@/);
    // approved → the original call is relayed unchanged
    expect(upstreamBody?.method).toBe("tools/call");
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
    expect(approvalBody.actions).toEqual(["GMAIL_LIST_EMAILS", "GMAIL_SEND_EMAIL"]);
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
    expect(reply.result?.content?.[0]?.text).toMatch(/declined/i);
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
    expect(reply.result?.content?.[0]?.text).toMatch(/declined/i);
    expect(upstreamCalls).toBe(0);
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
