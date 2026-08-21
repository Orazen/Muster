// Minimal MCP stdio client — the piece direct-API drivers need that CLI
// drivers (Claude, ACP) never did. Claude/ACP just hand an MCP server's
// spawn contract (command/args/env) to their own CLI subprocess, which
// already speaks MCP as a client internally (server/drivers/claude.ts:
// mcpServers.computer = {...}). A direct-API driver has no CLI to delegate
// to — this process has to become the MCP client itself: spawn the server,
// do the JSON-RPC handshake, list its tools, and call them.
//
// Deliberately minimal, not a general MCP SDK: initialize + notifications/
// initialized + tools/list + tools/call is the entire surface every
// integration this codebase mounts (computer-proxy.ts, connector-proxy.ts,
// agents-proxy.ts, dweb-proxy.ts) actually needs from a client.
import { spawn, type ChildProcess } from "node:child_process";

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}

export interface McpClient {
  tools: McpTool[];
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult>;
  close(): void;
}

/** Spawn an MCP server over stdio, complete the initialize handshake, and
 * list its tools. Rejects if the server doesn't answer within `timeoutMs` —
 * a hung spawn must not hang the whole turn. */
export async function connectMcpStdio(
  command: string,
  args: string[],
  env: Record<string, string>,
  opts: { timeoutMs?: number } = {},
): Promise<McpClient> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const child: ChildProcess = spawn(command, args, {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let buf = "";
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  let nextId = 1;
  let closed = false;

  child.stdout!.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id)!;
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message ?? "MCP error"));
        else resolve(msg.result);
      }
    }
  });
  child.on("exit", () => {
    closed = true;
    for (const { reject } of pending.values()) reject(new Error("MCP server exited"));
    pending.clear();
  });
  child.on("error", (e) => {
    closed = true;
    for (const { reject } of pending.values()) reject(e);
    pending.clear();
  });

  const rpc = (method: string, params?: unknown): Promise<any> => {
    if (closed) return Promise.reject(new Error("MCP server is not running"));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP ${method} timed out`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  };
  const notify = (method: string, params?: unknown) => {
    if (closed) return;
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  };

  try {
    await rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "muster-openai-compatible", version: "1.0" },
    });
    notify("notifications/initialized");
    const listed = await rpc("tools/list", {});
    const tools: McpTool[] = Array.isArray(listed?.tools) ? listed.tools : [];

    return {
      tools,
      async callTool(name, args) {
        const result = await rpc("tools/call", { name, arguments: args });
        return result as McpToolResult;
      },
      close() {
        if (!closed) {
          closed = true;
          child.kill();
        }
      },
    };
  } catch (e) {
    child.kill();
    throw e;
  }
}
