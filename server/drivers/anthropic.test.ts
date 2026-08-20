import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnthropicDriver } from "./anthropic.ts";

function messageStart(inputTokens: number) {
  return `event: message_start\ndata: ${JSON.stringify({
    type: "message_start",
    message: { usage: { input_tokens: inputTokens } },
  })}\n\n`;
}
function textDelta(text: string) {
  return `event: content_block_delta\ndata: ${JSON.stringify({
    type: "content_block_delta",
    delta: { type: "text_delta", text },
  })}\n\n`;
}
function messageDelta(outputTokens: number) {
  return `event: message_delta\ndata: ${JSON.stringify({
    type: "message_delta",
    usage: { output_tokens: outputTokens },
  })}\n\n`;
}

function streamResponse(chunks: string[]) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("AnthropicDriver", () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    global.fetch = vi.fn();
  });
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("reports unavailable with no API key", async () => {
    const instance = await AnthropicDriver.create({
      instanceId: "anthropicApi",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: AnthropicDriver.decodeConfig({}),
    });
    const snap = await instance.snapshot();
    expect(snap.state).toBe("unavailable");
  });

  it("streams a turn end-to-end, parsing the Messages API's named SSE events", async () => {
    (global.fetch as any).mockResolvedValue(
      streamResponse([messageStart(12), textDelta("Hel"), textDelta("lo!"), messageDelta(3)]),
    );
    const instance = await AnthropicDriver.create({
      instanceId: "anthropicApi",
      displayName: undefined,
      environment: { ANTHROPIC_API_KEY: "sk-ant-test" },
      enabled: true,
      config: AnthropicDriver.decodeConfig({}),
    });

    let completed: any = null;
    let usage: any = null;
    let text = "";
    instance.adapter.onEvent((e) => {
      if (e.type === "content.delta") text += (e as any).delta;
      if (e.type === "thread.token-usage.updated") usage = e;
      if (e.type === "turn.completed") completed = e;
    });

    await instance.adapter.sendTurn({ threadId: "t1", text: "hi", system: "be nice" });
    for (let i = 0; i < 50 && !completed; i++) await new Promise((r) => setTimeout(r, 5));

    expect(text).toBe("Hello!");
    expect(completed?.ok).toBe(true);
    expect(usage).toMatchObject({ input: 12, output: 3 });

    const call = (fetch as any).mock.calls[0];
    expect(call[0]).toBe("https://api.anthropic.com/v1/messages");
    expect(call[1].headers["x-api-key"]).toBe("sk-ant-test");
    const sentBody = JSON.parse(call[1].body);
    expect(sentBody.system).toBe("be nice");
  });

  it("surfaces a non-2xx response as a failed turn", async () => {
    (global.fetch as any).mockResolvedValue(new Response("bad key", { status: 401 }));
    const instance = await AnthropicDriver.create({
      instanceId: "anthropicApi",
      displayName: undefined,
      environment: { ANTHROPIC_API_KEY: "sk-ant-bad" },
      enabled: true,
      config: AnthropicDriver.decodeConfig({}),
    });
    let completed: any = null;
    instance.adapter.onEvent((e) => {
      if (e.type === "turn.completed") completed = e;
    });
    await instance.adapter.sendTurn({ threadId: "t2", text: "hi" });
    for (let i = 0; i < 50 && !completed; i++) await new Promise((r) => setTimeout(r, 5));
    expect(completed?.ok).toBe(false);
  });
});
