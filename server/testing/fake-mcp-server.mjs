// Minimal MCP stdio server for tests: speaks exactly the subset of
// newline-delimited JSON-RPC that mcp-client.ts uses (initialize,
// notifications/initialized, tools/list, tools/call) and exposes one tool —
// "echo" — whose result text is JSON of the arguments it received. Run with
// node via integrations.localComputer = { command: process.execPath,
// args: [this-file] }.
import { createInterface } from "node:readline";

const TOOL = {
  name: "echo",
  description: "echoes its arguments back as text",
  inputSchema: {
    type: "object",
    properties: { msg: { type: "string" } },
    required: ["msg"],
  },
};

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === "initialize") {
    reply(msg.id, { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fake-mcp", version: "1.0" } });
  } else if (msg.method === "tools/list") {
    reply(msg.id, { tools: [TOOL] });
  } else if (msg.method === "tools/call") {
    const text = `echo:${JSON.stringify(msg.params?.arguments ?? {})}`;
    reply(msg.id, { content: [{ type: "text", text }], isError: false });
  }
  // notifications (no id) are ignored by design
});

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
