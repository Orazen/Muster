import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAIDriver } from "./openai.ts";

function sseChunk(delta: string) {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`;
}

function streamResponse(chunks: string[], usage?: { prompt_tokens: number; completion_tokens: number }) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      if (usage) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ usage })}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("OpenAIDriver", () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    global.fetch = vi.fn();
  });
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("reports unavailable with no API key", async () => {
    const instance = await OpenAIDriver.create({
      instanceId: "openaiApi",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: OpenAIDriver.decodeConfig({}),
    });
    const snap = await instance.snapshot();
    expect(snap.state).toBe("unavailable");
  });

  it("reports available once a key is present", async () => {
    const instance = await OpenAIDriver.create({
      instanceId: "openaiApi",
      displayName: undefined,
      environment: { OPENAI_API_KEY: "sk-test" },
      enabled: true,
      config: OpenAIDriver.decodeConfig({}),
    });
    const snap = await instance.snapshot();
    expect(snap.state).toBe("available");
  });

  it("streams a turn end-to-end and emits token-level deltas", async () => {
    (global.fetch as any).mockResolvedValue(
      streamResponse([sseChunk("Hel"), sseChunk("lo!")], { prompt_tokens: 5, completion_tokens: 2 }),
    );
    const instance = await OpenAIDriver.create({
      instanceId: "openaiApi",
      displayName: undefined,
      environment: { OPENAI_API_KEY: "sk-test" },
      enabled: true,
      config: OpenAIDriver.decodeConfig({}),
    });

    const events: string[] = [];
    let completed: any = null;
    let text = "";
    instance.adapter.onEvent((e) => {
      events.push(e.type);
      if (e.type === "content.delta") text += (e as any).delta;
      if (e.type === "turn.completed") completed = e;
    });

    await instance.adapter.sendTurn({ threadId: "t1", text: "hi" });
    // sendTurn's work runs in a detached async IIFE — wait for turn.completed.
    for (let i = 0; i < 50 && !completed; i++) await new Promise((r) => setTimeout(r, 5));

    expect(text).toBe("Hello!");
    expect(completed?.ok).toBe(true);
    expect(events).toContain("turn.started");
    expect(events).toContain("item.completed");
    expect(fetch).toHaveBeenCalledWith(
      "https://api.openai.com/v1/chat/completions",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("surfaces a non-2xx response as a failed turn, not a throw", async () => {
    (global.fetch as any).mockResolvedValue(new Response("bad key", { status: 401 }));
    const instance = await OpenAIDriver.create({
      instanceId: "openaiApi",
      displayName: undefined,
      environment: { OPENAI_API_KEY: "sk-bad" },
      enabled: true,
      config: OpenAIDriver.decodeConfig({}),
    });
    let completed: any = null;
    instance.adapter.onEvent((e) => {
      if (e.type === "turn.completed") completed = e;
    });
    await instance.adapter.sendTurn({ threadId: "t2", text: "hi" });
    for (let i = 0; i < 50 && !completed; i++) await new Promise((r) => setTimeout(r, 5));
    expect(completed?.ok).toBe(false);
  });

  it("rejects a second concurrent turn on the same thread", async () => {
    (global.fetch as any).mockImplementation(
      () => new Promise(() => {}), // never resolves — turn stays in-flight
    );
    const instance = await OpenAIDriver.create({
      instanceId: "openaiApi",
      displayName: undefined,
      environment: { OPENAI_API_KEY: "sk-test" },
      enabled: true,
      config: OpenAIDriver.decodeConfig({}),
    });
    await instance.adapter.sendTurn({ threadId: "t3", text: "first" });
    await expect(instance.adapter.sendTurn({ threadId: "t3", text: "second" })).rejects.toThrow(
      /already running/,
    );
  });
});
