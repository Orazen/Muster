import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CohereDriver } from "./cohere.ts";

function contentDelta(text: string) {
  return `data: ${JSON.stringify({ type: "content-delta", delta: { message: { content: { text } } } })}\n\n`;
}
function messageEnd(inputTokens: number, outputTokens: number) {
  return `data: ${JSON.stringify({
    type: "message-end",
    delta: { usage: { billed_units: { input_tokens: inputTokens, output_tokens: outputTokens } } },
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
  return new Response(body, { status: 200 });
}

describe("CohereDriver", () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    global.fetch = vi.fn();
  });
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("reports unavailable with no key", async () => {
    const instance = await CohereDriver.create({
      instanceId: "x",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: CohereDriver.decodeConfig({}),
    });
    expect((await instance.snapshot()).state).toBe("unavailable");
  });

  it("streams a turn, parsing content-delta/message-end typed events", async () => {
    // SAFETY: fetch is replaced by a vi.fn() mock; only mockResolvedValue
    // exists on the double.
    (global.fetch as any).mockResolvedValue(streamResponse([contentDelta("Hel"), contentDelta("lo!"), messageEnd(10, 3)]));
    const instance = await CohereDriver.create({
      instanceId: "x",
      displayName: undefined,
      environment: { COHERE_API_KEY: "co-test" },
      enabled: true,
      config: CohereDriver.decodeConfig({}),
    });
    let completed: any = null;
    let usage: any = null;
    let text = "";
    instance.adapter.onEvent((e) => {
      if (e.type === "content.delta") text += e.delta;
      if (e.type === "thread.token-usage.updated") usage = e;
      if (e.type === "turn.completed") completed = e;
    });
    await instance.adapter.sendTurn({ threadId: "t1", text: "hi" });
    for (let i = 0; i < 50 && !completed; i++) await new Promise((r) => setTimeout(r, 5));

    expect(text).toBe("Hello!");
    expect(completed?.ok).toBe(true);
    expect(usage).toMatchObject({ input: 10, output: 3 });
    // SAFETY: fetch is a vi.fn() here; mock.calls exists on every mock.
    const call = (fetch as any).mock.calls[0];
    expect(call[0]).toBe("https://api.cohere.com/v2/chat");
    expect(call[1].headers.authorization).toBe("Bearer co-test");
  });

  it("surfaces a non-2xx response as a failed turn", async () => {
    // SAFETY: fetch is replaced by a vi.fn() mock; only mockResolvedValue
    // exists on the double.
    (global.fetch as any).mockResolvedValue(new Response("bad key", { status: 401 }));
    const instance = await CohereDriver.create({
      instanceId: "x",
      displayName: undefined,
      environment: { COHERE_API_KEY: "co-bad" },
      enabled: true,
      config: CohereDriver.decodeConfig({}),
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
