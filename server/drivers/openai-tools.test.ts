// Tests for the shared OpenAI-shaped tool machinery: wire-shape parsing,
// the capped agentic loop (with fake MCP clients), and one end-to-end turn
// per driver family through a REAL spawned MCP server (fake-mcp-server.mjs)
// with the model's HTTP responses mocked.
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { newId, type ProviderInstance, type SendTurnInput } from "../contracts.ts";
import type { McpClient, McpToolResult } from "../mcp-client.ts";
import {
  MAX_TOOL_ROUNDS,
  parseChatToolResponse,
  runToolLoop,
  toOpenAiTool,
  type ToolChat,
} from "./openai-tools.ts";

const FAKE_SERVER = join(import.meta.dirname, "../testing/fake-mcp-server.mjs");

/** A scripted model: pops one canned response per call, recording requests. */
interface ScriptedModel {
  chat: ToolChat;
  calls: Array<{ messages: any[]; tools: any[] }>;
}

function scriptedChat(responses: Array<{ content?: string; toolCalls?: Array<{ name: string; args?: string }> }>): ScriptedModel {
  const calls: Array<{ messages: any[]; tools: any[] }> = [];
  const chat: ToolChat = async (messages, _model, tools) => {
    calls.push({ messages: structuredClone(messages), tools: structuredClone(tools) });
    const next = responses[calls.length - 1] ?? {};
    return {
      text: next.content ?? "",
      toolCalls: (next.toolCalls ?? []).map((tc, i) => ({
        id: `call-${calls.length}-${i}`,
        name: tc.name,
        arguments: tc.args ?? "{}",
      })),
      usage: { input: 10 * (calls.length), output: 5 },
    };
  };
  return { chat, calls };
}

function fakeClient(resultText = "tool-ok", calls: Array<{ name: string; args: any }> = []): McpClient {
  return {
    tools: [],
    async callTool(name, args): Promise<McpToolResult> {
      calls.push({ name, args });
      return { content: [{ type: "text", text: resultText }] };
    },
    close() {},
  };
}

describe("parseChatToolResponse", () => {
  it("decodes tool_calls with stringified arguments and usage", () => {
    const round = parseChatToolResponse({
      choices: [{
        message: {
          content: null,
          tool_calls: [{ id: "c1", function: { name: "computer__screenshot", arguments: "{\"x\":1}" } }],
        },
      }],
      usage: { prompt_tokens: 12, completion_tokens: 3 },
    });
    expect(round.text).toBe("");
    expect(round.toolCalls).toEqual([{ id: "c1", name: "computer__screenshot", arguments: "{\"x\":1}" }]);
    expect(round.usage).toEqual({ input: 12, output: 3 });
  });

  it("tolerates plain answers and missing fields", () => {
    expect(parseChatToolResponse({ choices: [{ message: { content: "hi" } }] })).toEqual({
      text: "hi",
      toolCalls: [],
      usage: null,
    });
    expect(parseChatToolResponse({})).toEqual({ text: "", toolCalls: [], usage: null });
  });

  it("translates an MCP tool into the OpenAI function shape with its server prefix", () => {
    const tool = toOpenAiTool("computer", {
      name: "screenshot",
      description: "take one",
      inputSchema: { type: "object", properties: {} },
    });
    expect(tool).toMatchObject({
      type: "function",
      function: { name: "computer__screenshot", description: "take one" },
    });
    expect(toOpenAiTool("computer", { name: "t", inputSchema: undefined }).function.parameters).toEqual({
      type: "object",
      properties: {},
    });
  });
});

describe("runToolLoop", () => {
  const baseMessages = [{ role: "user", content: "go" }];

  it("executes requested tools, feeds results back, and settles on the final answer", async () => {
    const { chat, calls } = scriptedChat([
      { toolCalls: [{ name: "computer__echo", args: '{"msg":"ping"}' }] },
      { content: "all done" },
    ]);
    const clients = new Map([["computer", fakeClient('echo:{"msg":"ping"}')]]);
    const out = await runToolLoop({
      chat,
      messages: baseMessages,
      model: "m",
      clients,
      tools: [toOpenAiTool("computer", { name: "echo", inputSchema: { type: "object", properties: {} } })],
    });
    expect(out.text).toBe("all done");
    expect(out.usage).toEqual({ input: 30, output: 10 }); // accumulated across rounds
    // the assistant's tool_calls and the tool result both reached round two
    const second = calls[1].messages;
    expect(second.at(-2)).toMatchObject({ role: "assistant", tool_calls: [{ id: "call-1-0" }] });
    expect(second.at(-1)).toMatchObject({ role: "tool", tool_call_id: "call-1-0", content: 'echo:{"msg":"ping"}' });
  });

  it("feeds an error back when the tool source is unknown, then lets the model answer", async () => {
    const { chat, calls } = scriptedChat([
      { toolCalls: [{ name: "nosuch__tool" }] },
      { content: "recovered" },
    ]);
    const out = await runToolLoop({ chat, messages: baseMessages, model: "m", clients: new Map(), tools: [] });
    expect(out.text).toBe("recovered");
    expect(calls[1].messages.at(-1)).toMatchObject({
      role: "tool",
      content: 'error: no such tool source "nosuch"',
    });
  });

  it("keeps going after a throwing tool call by feeding the error back", async () => {
    const { chat, calls } = scriptedChat([
      { toolCalls: [{ name: "computer__boom" }] },
      { content: "ok" },
    ]);
    const clients = new Map([["computer", {
      tools: [],
      async callTool() { throw new Error("device offline"); },
      close() {},
    }]]);
    const out = await runToolLoop({ chat, messages: baseMessages, model: "m", clients, tools: [] });
    expect(out.text).toBe("ok");
    expect(calls[1].messages.at(-1)).toMatchObject({ role: "tool", content: "error: device offline" });
  });

  it("gives up after the cap instead of looping forever", async () => {
    let n = 0;
    const chat: ToolChat = async () => ({ text: "", toolCalls: [{ id: `c${n++}`, name: "a__b", arguments: "{}" }], usage: null });
    const out = await runToolLoop({ chat, messages: baseMessages, model: "m", clients: new Map(), tools: [] });
    expect(n).toBe(MAX_TOOL_ROUNDS);
    expect(out.text).toContain("too many tool calls");
  });
});

// ── driver-level end-to-end: real spawned MCP server, mocked model HTTP ──
describe.each([
  ["openai-compatible factory", "compatible"],
  ["first-party openai", "openai"],
  ["grok", "grok"],
])("tool-using turn via %s", (label, kind) => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
    delete process.env.TEST_TOOL_KEY;
  });

  it(`mounts the computer MCP server, runs the call, and completes (${label})`, async () => {
    process.env.TEST_TOOL_KEY = "k";
    const completionBody = (content: string | null, toolCalls: any[] | undefined) => ({
      choices: [{ message: { content, tool_calls: toolCalls } }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    });
    // A minimal chat-completions response body — the fields the drivers read.
    interface CompletionResponse {
      choices: Array<{ message: { content: string | null; tool_calls?: unknown } }>;
      usage: { prompt_tokens: number; completion_tokens: number };
    }
    const jsonResponse = (body: CompletionResponse) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    const toolRound = completionBody(null, [
      { id: "c1", type: "function", function: { name: "computer__echo", arguments: '{"msg":"ping"}' } },
    ]);
    const finalRound = completionBody("done", undefined);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(toolRound))
      .mockResolvedValueOnce(jsonResponse(finalRound))
      .mockResolvedValue(jsonResponse(finalRound));
    // SAFETY: the suite swaps in a jest-fetch mock whose resolved Responses
    // are the only thing the driver reads back.
    (global.fetch as any) = fetchMock;

    const events: any[] = [];
    let instance: ProviderInstance;
    if (kind === "compatible") {
      const { createOpenAICompatibleDriver } = await import("./openai-compatible.ts");
      instance = await createOpenAICompatibleDriver({
        driverKind: "testcomp",
        displayName: "TestComp",
        defaultUrl: "https://fake.api/v1",
        defaultApiKeyEnv: "TEST_TOOL_KEY",
        models: { default: "m1", options: [{ id: "m1", label: "M1" }] },
        quickModel: "m1",
      }).create({
        instanceId: newId(),
        config: { url: "https://fake.api/v1", apiKeyEnv: "TEST_TOOL_KEY" },
        environment: { TEST_TOOL_KEY: "k" },
        displayName: "TestComp",
        enabled: true,
      });
    } else if (kind === "openai") {
      const { OpenAIDriver } = await import("./openai.ts");
      instance = await OpenAIDriver.create({
        instanceId: newId(),
        config: { url: "https://fake.api/v1", apiKeyEnv: "TEST_TOOL_KEY" },
        environment: { TEST_TOOL_KEY: "k" },
        displayName: "OpenAI (API)",
        enabled: true,
      });
    } else {
      const { GrokDriver } = await import("./grok.ts");
      instance = await GrokDriver.create({
        instanceId: newId(),
        config: { url: "https://fake.api/v1", apiKeyEnv: "TEST_TOOL_KEY" },
        environment: { TEST_TOOL_KEY: "k" },
        displayName: "Grok (API)",
        enabled: true,
      });
    }
    instance.adapter.onEvent((e: any) => events.push(e));

    const turn: SendTurnInput = {
      threadId: `t-${kind}`,
      text: "screenshot please",
      model: "m1",
      integrations: {
        localComputer: { command: process.execPath, args: [FAKE_SERVER], env: {} },
      },
    };
    await instance.adapter.sendTurn(turn);

    const done = await vi.waitFor(() => {
      const d = events.find((e) => e.type === "turn.completed");
      if (!d) throw new Error("turn not settled");
      return d;
    }, { timeout: 15_000 });
    expect(done.ok).toBe(true);

    // Round 1 asked for tools; round 2 carried the tool result message.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // SAFETY: both calls are fetch(url, init); the body lives on init.
    const second = JSON.parse(String((fetchMock.mock.calls[1]![1] as RequestInit).body));
    expect(second.messages.at(-1)).toMatchObject({
      role: "tool",
      content: 'echo:{"msg":"ping"}',
    });
    // and round 1 actually offered the prefixed tool
    // SAFETY: fetch was called as (url, init); the JSON body lives on init.
    const first = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body));
    expect(first.tools?.[0]?.function?.name).toBe("computer__echo");
    const final = events.find((e) => e.type === "item.completed");
    expect(final?.text).toBe("done");
    await instance.dispose();
  }, 30_000);
});
