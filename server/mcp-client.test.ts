// mcp-client.ts tests against a tiny real stdio MCP server (a throwaway
// script, not a mock of the JSON-RPC framing) — the actual protocol
// handling this module does (line-delimited JSON-RPC, initialize handshake,
// tools/list, tools/call, error propagation) is exactly what a mock would
// risk hiding a bug in. The real cross-server, real-tool-execution proof is
// this session's live test against server/computer-proxy.ts + a live
// OpenSandbox sandbox, not repeated here as a unit test.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { connectMcpStdio } from "./mcp-client.ts";

const FAKE_SERVER = [
  "const readline = require(\"node:readline\");",
  "const rl = readline.createInterface({ input: process.stdin });",
  "rl.on(\"line\", (line) => {",
  "  let msg;",
  "  try { msg = JSON.parse(line); } catch { return; }",
  "  if (msg.method === \"initialize\") {",
  "    process.stdout.write(JSON.stringify({ jsonrpc: \"2.0\", id: msg.id, result: { protocolVersion: \"2024-11-05\" } }) + \"\\n\");",
  "  } else if (msg.method === \"notifications/initialized\") {",
  "  } else if (msg.method === \"tools/list\") {",
  "    process.stdout.write(JSON.stringify({ jsonrpc: \"2.0\", id: msg.id, result: { tools: [{ name: \"echo\", description: \"echoes back\", inputSchema: { type: \"object\", properties: { text: { type: \"string\" } } } }] } }) + \"\\n\");",
  "  } else if (msg.method === \"tools/call\") {",
  "    if (msg.params && msg.params.name === \"boom\") {",
  "      process.stdout.write(JSON.stringify({ jsonrpc: \"2.0\", id: msg.id, error: { message: \"tool exploded\" } }) + \"\\n\");",
  "    } else {",
  "      const t = (msg.params && msg.params.arguments && msg.params.arguments.text) || \"\";",
  "      process.stdout.write(JSON.stringify({ jsonrpc: \"2.0\", id: msg.id, result: { content: [{ type: \"text\", text: \"echo:\" + t }] } }) + \"\\n\");",
  "    }",
  "  }",
  "});",
].join("\n");

function writeFakeServer(): string {
  const dir = mkdtempSync(join(tmpdir(), "mcp-client-test-"));
  const file = join(dir, "server.cjs");
  writeFileSync(file, FAKE_SERVER);
  return file;
}

describe("connectMcpStdio", () => {
  it("completes the handshake and lists tools", async () => {
    const file = writeFakeServer();
    const client = await connectMcpStdio("node", [file], {});
    try {
      expect(client.tools).toEqual([
        { name: "echo", description: "echoes back", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
      ]);
    } finally {
      client.close();
      rmSync(file, { force: true });
    }
  });

  it("calls a tool and returns its result", async () => {
    const file = writeFakeServer();
    const client = await connectMcpStdio("node", [file], {});
    try {
      const result = await client.callTool("echo", { text: "hi" });
      expect(result.content).toEqual([{ type: "text", text: "echo:hi" }]);
    } finally {
      client.close();
      rmSync(file, { force: true });
    }
  });

  it("rejects when the server returns a JSON-RPC error", async () => {
    const file = writeFakeServer();
    const client = await connectMcpStdio("node", [file], {});
    try {
      await expect(client.callTool("boom", {})).rejects.toThrow("tool exploded");
    } finally {
      client.close();
      rmSync(file, { force: true });
    }
  });

  it("rejects connecting to a command that does not exist", async () => {
    await expect(connectMcpStdio("this-command-does-not-exist-xyz", [], {}, { timeoutMs: 2000 })).rejects.toThrow();
  });

  it("close() is idempotent", async () => {
    const file = writeFakeServer();
    const client = await connectMcpStdio("node", [file], {});
    client.close();
    expect(() => client.close()).not.toThrow();
    rmSync(file, { force: true });
  });
});
