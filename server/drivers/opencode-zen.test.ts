import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenCodeZenDriver } from "./opencode-zen.ts";

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

describe("OpenCodeZenDriver", () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    global.fetch = vi.fn();
  });
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("has driverKind opencodeZen and reads OPENCODE_API_KEY (shared with OpenCode Go)", () => {
    expect(OpenCodeZenDriver.driverKind).toBe("opencodeZen");
    expect(OpenCodeZenDriver.decodeConfig({}).apiKeyEnv).toBe("OPENCODE_API_KEY");
  });

  it("reports unavailable with no key, available with one", async () => {
    const noKey = await OpenCodeZenDriver.create({
      instanceId: "x",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: OpenCodeZenDriver.decodeConfig({}),
    });
    expect((await noKey.snapshot()).state).toBe("unavailable");

    const withKey = await OpenCodeZenDriver.create({
      instanceId: "x",
      displayName: undefined,
      environment: { OPENCODE_API_KEY: "key" },
      enabled: true,
      config: OpenCodeZenDriver.decodeConfig({}),
    });
    expect((await withKey.snapshot()).state).toBe("available");
  });

  it("posts to opencode.ai/zen/v1/chat/completions with the default free model", async () => {
    // SAFETY: fetch is replaced by a vi.fn() mock; only mockResolvedValue
    // exists on the double.
    (global.fetch as any).mockResolvedValue(streamResponse([sseChunk("OK")]));
    const instance = await OpenCodeZenDriver.create({
      instanceId: "x",
      displayName: undefined,
      environment: { OPENCODE_API_KEY: "key-123" },
      enabled: true,
      config: OpenCodeZenDriver.decodeConfig({}),
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
    expect(call[0]).toBe("https://opencode.ai/zen/v1/chat/completions");
    const sentBody = JSON.parse(call[1].body);
    expect(sentBody.model).toBe("deepseek-v4-flash-free");
  });
});
