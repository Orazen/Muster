import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeEvent, SendTurnInput } from "../contracts.ts";
import { createOpenAICompatibleDriver } from "./openai-compatible.ts";
import { DeepSeekDriver } from "./deepseek.ts";
import { MistralDriver } from "./mistral.ts";
import { GroqDriver } from "./groq.ts";
import { TogetherDriver } from "./together.ts";
import { FireworksDriver } from "./fireworks.ts";
import { OpenRouterDriver } from "./openrouter.ts";

interface BrowserFixtureMessage {
  content: string | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
}

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
    vi.mocked(global.fetch).mockResolvedValue(streamResponse([sseChunk("hi "), sseChunk("there")]));
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
      if (e.type === "content.delta" && "delta" in e) text += String(e.delta);
      if (e.type === "turn.completed") completed = e;
    });
    await instance.adapter.sendTurn({ threadId: "t1", text: "hi" });
    for (let i = 0; i < 50 && !completed; i++) await new Promise((r) => setTimeout(r, 5));

    expect(text).toBe("hi there");
    expect(completed?.ok).toBe(true);
    const call = vi.mocked(fetch).mock.calls[0];
    expect(call[0]).toBe("https://api.test-provider.example/v1/chat/completions");
    expect(new Headers(call[1]?.headers).get("authorization")).toBe("Bearer key-123");
  });

  it("admits an OpenRouter browser mount, executes its MCP navigation and answers from the result", async () => {
    const directory = mkdtempSync(join(tmpdir(), "muster-browser-tools-"));
    const fixture = join(directory, "browser.mjs");
    const called = join(directory, "called.json");
    const exited = join(directory, "exited");
    // An owned real stdio process, with no network or browser profile. Its
    // recorded arguments prove the model's requested tool actually ran.
    writeFileSync(fixture, `
      import { createInterface } from "node:readline";
      import { writeFileSync } from "node:fs";
      process.on("SIGTERM", () => process.exit(0));
      process.on("exit", () => writeFileSync(${JSON.stringify(exited)}, "exited"));
      createInterface({ input: process.stdin }).on("line", line => {
        const message = JSON.parse(line);
        if (message.id === undefined) return;
        let result;
        if (message.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "owned-browser", version: "1" } };
        else if (message.method === "tools/list") result = { tools: [{ name: "browser_navigate", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } }] };
        else if (message.method === "tools/call") {
          writeFileSync(${JSON.stringify(called)}, JSON.stringify(message.params));
          result = { content: [{ type: "text", text: "Fixture page title: Example Domain" }], isError: false };
        }
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
      });
    `);
    const jsonResponse = (message: BrowserFixtureMessage) => new Response(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 5, completion_tokens: 2 } }),
      { status: 200, headers: { "content-type": "application/json" } });
    const fetchMock = vi.mocked(global.fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse({ content: null, tool_calls: [
      { id: "navigation", type: "function", function: { name: "browser__browser_navigate", arguments: JSON.stringify({ url: "https://example.com" }) } },
    ] })).mockResolvedValueOnce(jsonResponse({ content: "The page title is Example Domain." }));
    const instance = await OpenRouterDriver.create({ instanceId: "owned-browser-router", displayName: undefined, enabled: true,
      environment: { OPENROUTER_API_KEY: "fixture-only" }, config: OpenRouterDriver.decodeConfig({}) });
    const events: RuntimeEvent[] = [];
    instance.adapter.onEvent(event => events.push(event));
    try {
      // Match dispatch admission: a browser toggle alone cannot mount tools
      // when this advertised capability is absent. This failed before the fix.
      const integrations: SendTurnInput["integrations"] = instance.adapter.capabilities.customMcp === true
        ? { custom: [{ name: "browser", command: process.execPath, args: [fixture], env: { HOME: directory, TMPDIR: directory } }] }
        : undefined;
      await instance.adapter.sendTurn({ threadId: "owned-browser-turn", text: "Open example.com and tell me its title", integrations });
      await vi.waitFor(() => expect(events.some(event => event.type === "turn.completed")).toBe(true), { timeout: 10_000 });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const first = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
      expect(first.tools).toContainEqual(expect.objectContaining({ function: expect.objectContaining({ name: "browser__browser_navigate" }) }));
      expect(JSON.parse(readFileSync(called, "utf8"))).toEqual({ name: "browser_navigate", arguments: { url: "https://example.com" } });
      const second = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
      expect(second.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "navigation", content: "Fixture page title: Example Domain" });
      expect(events).toContainEqual(expect.objectContaining({ type: "item.completed", text: "The page title is Example Domain." }));
      expect(events).toContainEqual(expect.objectContaining({ type: "turn.completed", ok: true }));
      await vi.waitFor(() => expect(existsSync(exited)).toBe(true), { timeout: 5_000 });
    } finally {
      await instance.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("text-only turns keep string content even on a vision driver", async () => {
    const visionDriver = createOpenAICompatibleDriver({
      driverKind: "vision-provider",
      displayName: "Vision Provider",
      defaultUrl: "https://api.vision.example/v1",
      defaultApiKeyEnv: "VISION_API_KEY",
      models: { default: "v-model", options: [{ id: "v-model", label: "V" }] },
      quickModel: "v-model",
      vision: true,
    });
    expect(
      (await (await visionDriver.create({
        instanceId: "x",
        displayName: undefined,
        environment: { VISION_API_KEY: "k" },
        enabled: true,
        config: visionDriver.decodeConfig({}),
      })).adapter.capabilities).visionParts,
    ).toBe(true);
    // One switch, two flags: the attach affordance unlocks with it.
    expect(
      (await (await visionDriver.create({
        instanceId: "x2",
        displayName: undefined,
        environment: { VISION_API_KEY: "k" },
        enabled: true,
        config: visionDriver.decodeConfig({}),
      })).adapter.capabilities).images,
    ).toBe(true);

    vi.mocked(global.fetch).mockResolvedValue(streamResponse([sseChunk("ok")]));
    const instance = await visionDriver.create({
      instanceId: "y",
      displayName: undefined,
      environment: { VISION_API_KEY: "k" },
      enabled: true,
      config: visionDriver.decodeConfig({}),
    });
    let done = false;
    instance.adapter.onEvent((e) => {
      if (e.type === "turn.completed") done = true;
    });
    await instance.adapter.sendTurn({ threadId: "t-v", text: "plain words" });
    for (let i = 0; i < 50 && !done; i++) await new Promise((r) => setTimeout(r, 5));
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls.at(-1)?.[1]?.body));
    expect(body.messages.at(-1)).toEqual({ role: "user", content: "plain words" });
  });

  it("vision drivers send turn.images as image_url parts after the text", async () => {
    const visionDriver = createOpenAICompatibleDriver({
      driverKind: "vision-provider",
      displayName: "Vision Provider",
      defaultUrl: "https://api.vision.example/v1",
      defaultApiKeyEnv: "VISION_API_KEY",
      models: { default: "v-model", options: [{ id: "v-model", label: "V" }] },
      quickModel: "v-model",
      vision: true,
    });
    vi.mocked(global.fetch).mockResolvedValue(streamResponse([sseChunk("seen")]));
    const instance = await visionDriver.create({
      instanceId: "z",
      displayName: undefined,
      environment: { VISION_API_KEY: "k" },
      enabled: true,
      config: visionDriver.decodeConfig({}),
    });
    let done = false;
    instance.adapter.onEvent((e) => {
      if (e.type === "turn.completed") done = true;
    });
    const png = Buffer.from("89504e47", "hex").toString("base64");
    await instance.adapter.sendTurn({
      threadId: "t-img",
      text: "what is this?",
      images: [{ mediaType: "image/png", dataBase64: png }],
    });
    for (let i = 0; i < 50 && !done; i++) await new Promise((r) => setTimeout(r, 5));
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls.at(-1)?.[1]?.body));
    const content = body.messages.at(-1).content;
    expect(Array.isArray(content)).toBe(true);
    // SAFETY: the Array.isArray guard above narrows the union before the
    // positional assertions.
    if (!Array.isArray(content)) throw new Error("unreachable");
    expect(content[0]).toEqual({ type: "text", text: "what is this?" });
    expect(content[1]).toEqual({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${png}` },
    });

    // The same turn to a NON-vision twin never carries parts: dispatch
    // gates on visionParts === true, so the factory must say false.
    expect(
      (await (await testDriver.create({
        instanceId: "w",
        displayName: undefined,
        environment: { TEST_PROVIDER_API_KEY: "k" },
        enabled: true,
        config: testDriver.decodeConfig({}),
      })).adapter.capabilities).visionParts,
    ).toBe(false);
    // ...and the composer affordance stays locked alongside it.
    expect(
      (await (await testDriver.create({
        instanceId: "w",
        displayName: undefined,
        environment: { TEST_PROVIDER_API_KEY: "k" },
        enabled: true,
        config: testDriver.decodeConfig({}),
      })).adapter.capabilities).images,
    ).toBe(false);
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
    vi.mocked(global.fetch).mockResolvedValue(
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
    const call = vi.mocked(fetch).mock.calls[0];
    expect(new Headers(call[1]?.headers).get("authorization")).toBe("Bearer the-key");
  });
});
