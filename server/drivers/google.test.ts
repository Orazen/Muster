import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { GoogleDriver } from "./google.ts";

function candidateChunk(text: string) {
  return `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] })}\n\n`;
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

describe("GoogleDriver", () => {
  const originalFetch = global.fetch;
  let fetchMock: Mock;
  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock;
  });
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("reports unavailable with no key", async () => {
    const instance = await GoogleDriver.create({
      instanceId: "x",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: GoogleDriver.decodeConfig({}),
    });
    expect((await instance.snapshot()).state).toBe("unavailable");
  });

  it("streams a turn, puts the key as a query param, and maps assistant->model role", async () => {
    fetchMock.mockResolvedValue(streamResponse([candidateChunk("Hel"), candidateChunk("lo!")]));
    const instance = await GoogleDriver.create({
      instanceId: "x",
      displayName: undefined,
      environment: { GOOGLE_API_KEY: "AIza-test" },
      enabled: true,
      config: GoogleDriver.decodeConfig({}),
    });
    let completed: any = null;
    let text = "";
    instance.adapter.onEvent((e) => {
      if (e.type === "content.delta") text += e.delta;
      if (e.type === "turn.completed") completed = e;
    });
    await instance.adapter.sendTurn({
      threadId: "t1",
      text: "hi",
      transcript: [{ role: "assistant", text: "prior reply" }],
    });
    for (let i = 0; i < 50 && !completed; i++) await new Promise((r) => setTimeout(r, 5));

    expect(text).toBe("Hello!");
    expect(completed?.ok).toBe(true);
    const call = fetchMock.mock.calls[0];
    expect(call[0]).toContain("key=AIza-test");
    expect(call[0]).toContain(":streamGenerateContent");
    const sentBody = JSON.parse(call[1].body);
    expect(sentBody.contents[0].role).toBe("model"); // assistant -> model
  });
});
