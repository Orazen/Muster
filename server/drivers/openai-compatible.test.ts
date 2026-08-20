import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOpenAICompatibleDriver } from "./openai-compatible.ts";
import { DeepSeekDriver } from "./deepseek.ts";
import { MistralDriver } from "./mistral.ts";
import { GroqDriver } from "./groq.ts";
import { TogetherDriver } from "./together.ts";
import { FireworksDriver } from "./fireworks.ts";
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

describe("createOpenAICompatibleDriver (generic factory)", () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    global.fetch = vi.fn();
  });
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  const testDriver = createOpenAICompatibleDriver({
    driverKind: "test-provider",
    displayName: "Test Provider",
    defaultUrl: "https://api.test-provider.example/v1",
    defaultApiKeyEnv: "TEST_PROVIDER_API_KEY",
    models: { default: "test-model", options: [{ id: "test-model", label: "Test Model" }] },
    quickModel: "test-model",
  });

  it("reports unavailable with no key, available with one", async () => {
    const noKey = await testDriver.create({
      instanceId: "x",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: testDriver.decodeConfig({}),
    });
    expect((await noKey.snapshot()).state).toBe("unavailable");

    const withKey = await testDriver.create({
      instanceId: "x",
      displayName: undefined,
      environment: { TEST_PROVIDER_API_KEY: "key" },
      enabled: true,
      config: testDriver.decodeConfig({}),
    });
    expect((await withKey.snapshot()).state).toBe("available");
  });

  it("streams a turn and posts to the configured URL with a Bearer header", async () => {
    (global.fetch as any).mockResolvedValue(streamResponse([sseChunk("hi "), sseChunk("there")]));
    const instance = await testDriver.create({
      instanceId: "x",
      displayName: undefined,
      environment: { TEST_PROVIDER_API_KEY: "key-123" },
      enabled: true,
      config: testDriver.decodeConfig({}),
    });
    let completed: any = null;
    let text = "";
    instance.adapter.onEvent((e) => {
      if (e.type === "content.delta") text += (e as any).delta;
      if (e.type === "turn.completed") completed = e;
    });
    await instance.adapter.sendTurn({ threadId: "t1", text: "hi" });
    for (let i = 0; i < 50 && !completed; i++) await new Promise((r) => setTimeout(r, 5));

    expect(text).toBe("hi there");
    expect(completed?.ok).toBe(true);
    const call = (fetch as any).mock.calls[0];
    expect(call[0]).toBe("https://api.test-provider.example/v1/chat/completions");
    expect(call[1].headers.authorization).toBe("Bearer key-123");
  });
});

// Every OpenAI-compatible provider driver: verify each one is correctly
// configured (right kind, right default URL/env var), catching copy-paste
// mistakes across the six near-identical files.
describe.each([
  { driver: DeepSeekDriver, kind: "deepseek", envVar: "DEEPSEEK_API_KEY" },
  { driver: MistralDriver, kind: "mistral", envVar: "MISTRAL_API_KEY" },
  { driver: GroqDriver, kind: "groq", envVar: "GROQ_API_KEY" },
  { driver: TogetherDriver, kind: "together", envVar: "TOGETHER_API_KEY" },
  { driver: FireworksDriver, kind: "fireworks", envVar: "FIREWORKS_API_KEY" },
  { driver: OpenRouterDriver, kind: "openrouter", envVar: "OPENROUTER_API_KEY" },
])("$kind driver", ({ driver, kind, envVar }) => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    global.fetch = vi.fn();
  });
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it(`has driverKind "${kind}"`, () => {
    expect(driver.driverKind).toBe(kind);
  });

  it(`reads its key from ${envVar}`, async () => {
    (global.fetch as any).mockResolvedValue(
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            c.close();
          },
        }),
        { status: 200 },
      ),
    );
    const instance = await driver.create({
      instanceId: "x",
      displayName: undefined,
      environment: { [envVar]: "the-key" },
      enabled: true,
      config: driver.decodeConfig({}),
    });
    expect((await instance.snapshot()).state).toBe("available");
    let completed: any = null;
    instance.adapter.onEvent((e) => {
      if (e.type === "turn.completed") completed = e;
    });
    await instance.adapter.sendTurn({ threadId: "t", text: "hi" });
    for (let i = 0; i < 50 && !completed; i++) await new Promise((r) => setTimeout(r, 5));
    const call = (fetch as any).mock.calls[0];
    expect(call[1].headers.authorization).toBe("Bearer the-key");
  });
});
