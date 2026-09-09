import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenRouterDriver } from "./openrouter.ts";

function sseChunk(delta: string) {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`;
}
function streamResponse(chunks: string[]) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("OpenRouterDriver", () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    global.fetch = vi.fn();
  });
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("has driverKind openrouter and reads OPENROUTER_API_KEY", () => {
    expect(OpenRouterDriver.driverKind).toBe("openrouter");
    expect(OpenRouterDriver.decodeConfig({}).apiKeyEnv).toBe("OPENROUTER_API_KEY");
  });

  it("lists the Nex AGI free models alongside the free tier", () => {
    const options = OpenRouterDriver.models.options;
    const ids = options.map((m) => m.id);
    expect(ids).toContain("nex-agi/nex-n2.5-mini:free");
    expect(ids).toContain("nex-agi/nex-n2.5-pro:free");
    const pro = options.find((m) => m.id === "nex-agi/nex-n2.5-pro:free");
    expect(pro?.vision).toBe(true);
    const mini = options.find((m) => m.id === "nex-agi/nex-n2.5-mini:free");
    expect(mini?.vision).toBeFalsy();
  });

  it("posts to openrouter.ai/api/v1/chat/completions with the default model", async () => {
    // SAFETY: fetch is replaced by a vi.fn() mock; only mockResolvedValue
    // exists on the double.
    (global.fetch as any).mockResolvedValue(streamResponse([sseChunk("OK")]));
    const instance = await OpenRouterDriver.create({
      instanceId: "x",
      displayName: undefined,
      environment: { OPENROUTER_API_KEY: "key-123" },
      enabled: true,
      config: OpenRouterDriver.decodeConfig({}),
    });
    let completed: any = null;
    instance.adapter.onEvent((e) => {
      if (e.type === "turn.completed") completed = e;
    });
    await instance.adapter.sendTurn({ threadId: "t1", text: "hi" });
    for (let i = 0; i < 50 && !completed; i++) await new Promise((r) => setTimeout(r, 5));

    expect(completed?.ok).toBe(true);
    // SAFETY: fetch is a vi.fn() here; mock.calls exists on every mock.
    const call = (fetch as any).mock.calls[0];
    expect(call[0]).toBe("https://openrouter.ai/api/v1/chat/completions");
    const sentBody = JSON.parse(call[1].body);
    expect(sentBody.model).toBe("openai/gpt-4o");
  });
});
