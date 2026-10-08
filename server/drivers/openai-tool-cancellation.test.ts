import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import type { ProviderInstance, RuntimeEvent } from "../contracts.ts";
import type { McpClient, McpToolResult } from "../mcp-client.ts";
import { GrokDriver } from "./grok.ts";
import { OpenAIDriver } from "./openai.ts";
import { createOpenAICompatibleDriver } from "./openai-compatible.ts";
import { MAX_TOOL_ROUNDS, runToolLoop, type ToolChat, type ToolCallRound } from "./openai-tools.ts";

const toolRound: ToolCallRound = {
  text: "",
  toolCalls: [
    { id: "first", name: "owned__first", arguments: "{}" },
    { id: "second", name: "owned__second", arguments: "{}" },
  ],
  usage: null,
};
const finalRound: ToolCallRound = { text: "finished", toolCalls: [], usage: null };
const toolResult: McpToolResult = { content: [{ type: "text", text: "finished" }] };

function loop(chat: ToolChat, controller: AbortController, client: McpClient) {
  return runToolLoop({ chat, signal: controller.signal, clients: new Map([["owned", client]]),
    messages: [{ role: "user", content: "owned cancellation check" }], model: "owned", tools: [] });
}

describe("API tool cancellation boundaries", () => {
  it("does not ask the model when the turn was already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const chat = vi.fn<ToolChat>().mockResolvedValue(finalRound);
    const callTool = vi.fn<McpClient["callTool"]>().mockResolvedValue(toolResult);
    await expect(loop(chat, controller, { tools: [], callTool, close() {} })).rejects.toMatchObject({ name: "AbortError" });
    expect(chat).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
  });

  for (const response of [toolRound, finalRound]) {
    it(`refuses a ${response.toolCalls.length ? "tool" : "final"} model response arriving after cancellation`, async () => {
      const controller = new AbortController();
      const chat = vi.fn<ToolChat>().mockImplementation(async () => {
        controller.abort();
        return response;
      });
      const callTool = vi.fn<McpClient["callTool"]>().mockResolvedValue(toolResult);
      await expect(loop(chat, controller, { tools: [], callTool, close() {} })).rejects.toMatchObject({ name: "AbortError" });
      expect(chat).toHaveBeenCalledTimes(1);
      expect(callTool).not.toHaveBeenCalled();
    });
  }

  for (const rejects of [false, true]) {
    it(`does not continue after an interrupted tool ${rejects ? "rejects" : "answers"}`, async () => {
      const controller = new AbortController();
      const chat = vi.fn<ToolChat>().mockResolvedValueOnce(toolRound).mockResolvedValue(finalRound);
      const callTool = vi.fn<McpClient["callTool"]>().mockImplementation(async () => {
        controller.abort();
        if (rejects) throw new Error("owned tool ended during cancellation");
        return toolResult;
      });
      await expect(loop(chat, controller, { tools: [], callTool, close() {} })).rejects.toMatchObject({ name: "AbortError" });
      expect(chat).toHaveBeenCalledTimes(1);
      expect(callTool).toHaveBeenCalledTimes(1);
    });
  }

  it("handles a tool that cancels and throws before returning its promise", async () => {
    const controller = new AbortController();
    const chat = vi.fn<ToolChat>().mockResolvedValueOnce(toolRound).mockResolvedValue(finalRound);
    const callTool = vi.fn<McpClient["callTool"]>().mockImplementation(() => {
      controller.abort();
      throw new Error("owned synchronous dispatch failure");
    });
    await expect(loop(chat, controller, { tools: [], callTool, close() {} })).rejects.toMatchObject({ name: "AbortError" });
    // Vitest also fails this test file for any unhandled rejection.
    await pause(0);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it("settles cancellation while an MCP call remains unanswered", async () => {
    const controller = new AbortController();
    const chat = vi.fn<ToolChat>().mockResolvedValueOnce(toolRound).mockResolvedValue(finalRound);
    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    const toolStarted = new Promise<void>(resolve => { started = resolve; });
    const callTool = vi.fn<McpClient["callTool"]>().mockImplementationOnce(() => {
      started?.();
      return new Promise<McpToolResult>(resolve => { release = () => resolve(toolResult); });
    }).mockResolvedValue(toolResult);
    const running = loop(chat, controller, { tools: [], callTool, close() {} });
    // Attach a rejection handler before triggering the cancellation.
    const settled = running.then(() => "completed", error => error);
    try {
      await toolStarted;
      controller.abort();
      expect(await Promise.race([settled, pause(500).then(() => "still waiting for MCP")])).toMatchObject({ name: "AbortError" });
      expect(chat).toHaveBeenCalledTimes(1);
      expect(callTool).toHaveBeenCalledTimes(1);
    } finally {
      release?.();
      await settled;
    }
  });

  it("does not turn cancellation in the final allowed tool round into success", async () => {
    const controller = new AbortController();
    let calls = 0;
    const chat = vi.fn<ToolChat>().mockImplementation(async () => ({
      ...toolRound, toolCalls: [{ id: "one", name: "owned__first", arguments: JSON.stringify({ round: calls }) }],
    }));
    const callTool = vi.fn<McpClient["callTool"]>().mockImplementation(async () => {
      if (++calls === MAX_TOOL_ROUNDS) controller.abort();
      return toolResult;
    });
    await expect(loop(chat, controller, { tools: [], callTool, close() {} })).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(MAX_TOOL_ROUNDS);
    expect(chat).toHaveBeenCalledTimes(MAX_TOOL_ROUNDS);
  });

  it("keeps a late MCP rejection handled after the interrupted turn settles", async () => {
    const controller = new AbortController();
    const chat = vi.fn<ToolChat>().mockResolvedValueOnce(toolRound).mockResolvedValue(finalRound);
    let fail: ((error: Error) => void) | undefined;
    let started: (() => void) | undefined;
    const toolStarted = new Promise<void>(resolve => { started = resolve; });
    const callTool = vi.fn<McpClient["callTool"]>().mockImplementationOnce(() => {
      started?.();
      return new Promise<McpToolResult>((_resolve, reject) => { fail = reject; });
    }).mockResolvedValue(toolResult);
    const settled = loop(chat, controller, { tools: [], callTool, close() {} }).catch(error => error);
    try {
      await toolStarted;
      controller.abort();
      expect(await Promise.race([settled, pause(500).then(() => "still waiting for MCP")])).toMatchObject({ name: "AbortError" });
    } finally {
      fail?.(new Error("owned MCP process exited after Stop"));
      await settled;
    }
    await pause(0);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledTimes(1);
  });
});

// These use actual loopback HTTP and a spawned MCP process, through each
// production driver family. The endpoint is deterministic and the tools only
// append to an owned temporary receipt; no real provider or external action.
for (const family of ["compatible", "openai", "grok"] as const) {
  it(`${family}: Stop prevents the next action in an actual HTTP/MCP tool batch`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "muster-tool-cancel-"));
    const receipt = join(directory, "receipt.txt");
    const release = join(directory, "release");
    const mcp = join(directory, "owned-mcp.mjs");
    await writeFile(mcp, `
import { appendFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";
const record = value => appendFileSync(${JSON.stringify(receipt)}, value + "\\n");
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
process.on("SIGTERM", () => { record("closed"); process.exit(0); });
createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") reply(message.id, { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "owned", version: "1" } });
  else if (message.method === "tools/list") reply(message.id, { tools: ["first", "second"].map(name => ({ name, inputSchema: { type: "object", properties: {} } })) });
  else if (message.method === "tools/call") {
    const name = message.params.name;
    record(name);
    const finish = () => reply(message.id, { content: [{ type: "text", text: name }] });
    if (name === "first") {
      const timer = setInterval(() => { if (existsSync(${JSON.stringify(release)})) { clearInterval(timer); finish(); } }, 10);
    } else finish();
  }
});
`, { mode: 0o600 });
    const requests: string[] = [];
    const provider = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      requests.push(body);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: toolRound.toolCalls.map(call => ({
        id: call.id, type: "function", function: { name: call.name, arguments: call.arguments },
      })) } }] }));
    });
    let instance: ProviderInstance | undefined;
    const events: RuntimeEvent[] = [];
    const entries = async () => (await readFile(receipt, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
    try {
      await new Promise<void>((resolve, reject) => { provider.once("error", reject); provider.listen(0, "127.0.0.1", resolve); });
      const address = provider.address();
      if (!(address instanceof Object)) throw new Error("Owned HTTP provider has no TCP address");
      const url = `http://127.0.0.1:${address.port}/v1`;
      const driver = family === "openai" ? OpenAIDriver : family === "grok" ? GrokDriver : createOpenAICompatibleDriver({
        driverKind: "owned-cancellation", displayName: "Owned cancellation", defaultUrl: url,
        defaultApiKeyEnv: "OWNED_CANCELLATION_KEY", models: { default: "owned", options: [{ id: "owned", label: "Owned" }] }, quickModel: "owned",
      });
      instance = await driver.create({ instanceId: `owned-${family}`, enabled: true, displayName: undefined,
        config: driver.decodeConfig({ url, apiKeyEnv: "OWNED_CANCELLATION_KEY" }), environment: { OWNED_CANCELLATION_KEY: "owned-fixture-value" } });
      instance.adapter.onEvent(event => events.push(event));
      const threadId = `owned-cancel-${family}`;
      await instance.adapter.sendTurn({ threadId, text: "perform the owned batch", model: "owned",
        integrations: { custom: [{ name: "owned", command: process.execPath, args: [mcp], env: {} }] } });
      await vi.waitFor(async () => expect(await entries()).toEqual(["first"]), { timeout: 5_000 });
      await instance.adapter.interruptTurn(threadId);
      // Do not release the first tool: Stop must settle the production turn
      // and close its MCP process even when that tool never answers.
      await vi.waitFor(() => expect(events.filter(event => event.type === "turn.completed")).toHaveLength(1), { timeout: 5_000 });
      expect(events).toContainEqual(expect.objectContaining({ type: "turn.completed", ok: false, stopReason: "interrupted" }));
      expect(events.some(event => event.type === "runtime.error" || event.type === "item.completed")).toBe(false);
      await vi.waitFor(async () => expect(await entries()).toContain("closed"), { timeout: 5_000 });
      expect(await entries()).toEqual(["first", "closed"]);
      expect(requests).toHaveLength(1);
      expect(instance.adapter.hasSession(threadId)).toBe(false);
    } finally {
      let mcpClosed = !instance;
      try {
        await writeFile(release, "", { mode: 0o600 });
        await instance?.dispose();
        if (instance) await vi.waitFor(async () => expect(await entries()).toContain("closed"), { timeout: 5_000 });
        mcpClosed = true;
      } finally {
        provider.closeAllConnections();
        if (provider.listening) await new Promise<void>(resolve => provider.close(() => resolve()));
        // Retain the owned receipt if a child failed to confirm shutdown;
        // never remove a directory while that process may still use it.
        if (mcpClosed) await rm(directory, { recursive: true, force: true });
      }
    }
  });
}
