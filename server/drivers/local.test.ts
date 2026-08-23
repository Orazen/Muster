// Local model driver (plan 3.1): one OpenAI-shaped client for Ollama / LM
// Studio / vLLM built on the compatible factory's local-server options —
// keyless bearer, ping-based availability, server-derived model list — plus
// the model-free tool-output pruning pass it motivated in model-context.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LocalDriver } from "./local.ts";
import { createOpenAICompatibleDriver } from "./openai-compatible.ts";
import { messageTokens, pruneStaleToolOutput, renderForModel, estimateTokens } from "../model-context.ts";
import type { Message } from "../store.ts";
import type { JsonValue } from "../schema.ts";

const originalFetch = global.fetch;

// SAFETY: every test replaces global.fetch with a vitest mock; this
// accessor is the single cast site for reaching the mock API off it.
const fetchMock = () => global.fetch as ReturnType<typeof vi.fn>;

/** The established jest-fetch pattern: fresh mock per test, SAFETY note per
 * assertion-bearing stub. */
beforeEach(() => {
  // SAFETY: vi.fn() stands in for global fetch; each test installs its own
  // responses before any code runs.
  global.fetch = vi.fn();
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

function jsonResponse(body: JsonValue, ok = true): Response {
  const payload = JSON.stringify(body);
  // SAFETY: the chat-completions code only reads ok/status/json/text on a
  // response; this stub provides exactly that surface.
  return { ok, status: ok ? 200 : 500, json: async () => body, text: async () => payload } as Response;
}

describe("LocalDriver", () => {
  it("decodes with no config at all and needs no API key", () => {
    const cfg = LocalDriver.decodeConfig(undefined);
    expect(cfg.url).toBe("http://127.0.0.1:11434/v1");
    expect(LocalDriver.metadata.supportsMultipleInstances).toBe(true);
    expect(LocalDriver.install?.signInCommand).toBe("ollama serve");
  });

  it("snapshot reports unavailable with a reason when nothing answers the port", async () => {
    // SAFETY: mocked fetch rejects exactly like a refused localhost socket.
    fetchMock().mockRejectedValue(new Error("connect ECONNREFUSED"));
    const instance = await LocalDriver.create({
      instanceId: "local-1",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: LocalDriver.defaultConfig(),
    });
    const snap = await instance.snapshot();
    expect(snap.state).toBe("unavailable");
    if (snap.state === "unavailable") expect(snap.reason).toContain("isn't reachable");
    await instance.dispose();
  });

  it("snapshot is available once the local server answers", async () => {
    // SAFETY: the stub mimics GET /v1/models from a real Ollama server.
    fetchMock().mockResolvedValue(
      jsonResponse({ data: [{ id: "llama3.2" }, { id: "qwen2.5:7b" }] }),
    );
    const instance = await LocalDriver.create({
      instanceId: "local-1",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: LocalDriver.defaultConfig(),
    });
    const snap = await instance.snapshot();
    expect(snap.state).toBe("available");
    await instance.dispose();
  });

  it("the picker lists only models the server actually serves", async () => {
    // SAFETY: the stub returns two of three pulled models; the third static
    // fallback entry must not survive into the live catalog.
    fetchMock().mockResolvedValue(
      jsonResponse({ data: [{ id: "llama3.2" }, { id: "phi4" }] }),
    );
    const instance = await LocalDriver.create({
      instanceId: "local-1",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: LocalDriver.defaultConfig(),
    });
    expect(instance.models.options.map((o) => o.id)).toEqual(["llama3.2", "phi4"]);
    expect(instance.models.default).toBe("llama3.2");

    // refreshModels re-fetches without a restart
    fetchMock().mockResolvedValue(jsonResponse({ data: [{ id: "mistral" }] }));
    await instance.refreshModels?.();
    expect(instance.models.options.map((o) => o.id)).toEqual(["mistral"]);
    await instance.dispose();
  });

  it("a failed refresh keeps the last known catalog", async () => {
    // SAFETY: first stub answers, second simulates the server going down.
    (global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "llama3.2" }] }))
      .mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const instance = await LocalDriver.create({
      instanceId: "local-1",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: LocalDriver.defaultConfig(),
    });
    await instance.refreshModels?.();
    expect(instance.models.options.map((o) => o.id)).toEqual(["llama3.2"]);
    await instance.dispose();
  });

  it("sends a placeholder bearer so keyless stacks never see a missing header", async () => {
    let seenAuth = "";
    // SAFETY: the stub records the authorization header the factory sent;
    // RequestInit headers are a union by platform contract.
    fetchMock().mockImplementation(async (_url, init) => {
      // Headers parses every HeadersInit variant; no representation casts.
      seenAuth = String(new Headers(init?.headers).get("authorization") ?? "");
      return jsonResponse({ data: [] });
    });
    const instance = await LocalDriver.create({
      instanceId: "local-1",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: LocalDriver.defaultConfig(),
    });
    expect(seenAuth).toBe("Bearer local");
    await instance.dispose();
  });

  it("honestly declares no computer/composio tooling", async () => {
    // SAFETY: empty data array → static fallback catalog, still creatable.
    fetchMock().mockResolvedValue(jsonResponse({ data: [] }));
    const instance = await LocalDriver.create({
      instanceId: "local-1",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: LocalDriver.defaultConfig(),
    });
    expect(instance.adapter.capabilities.computerMcp).toBe(false);
    expect(instance.adapter.capabilities.composioMcp).toBe(false);
    expect(instance.adapter.capabilities.effortLevels).toBeUndefined();
    await instance.dispose();
  });

  it("cloud drivers keep their defaults when the new spec options are absent", () => {
    const cloud = createOpenAICompatibleDriver({
      driverKind: "x",
      displayName: "X",
      defaultUrl: "https://x.example/v1",
      defaultApiKeyEnv: "X_KEY",
      models: { default: "m", options: [{ id: "m", label: "M" }] },
      quickModel: "m",
    });
    expect(cloud.install).toBeUndefined();
  });
});

describe("pruneStaleToolOutput", () => {
  const act = (name: string): Message => ({ id: name, at: 0, role: "bot", kind: "activity", tool: { name, ok: true } });
  const txt = (id: string, text: string): Message => ({ id, at: 0, role: "user", kind: "text", text });

  it("stubs activity older than the recent window, keeps text untouched", () => {
    const messages = [act("a1"), act("a2"), act("a3"), act("a4"), act("a5"), act("a6"), txt("u1", "hello")];
    const pruned = pruneStaleToolOutput(messages);
    // newest four (a6..a3) keep their names; oldest two are stubbed
    expect(pruned[0]!.tool?.name).toContain("omitted");
    expect(pruned[1]!.tool?.name).toContain("omitted");
    expect(pruned[2]!.tool?.name).toBe("a3");
    expect(pruned[5]!.tool?.name).toBe("a6");
    expect(pruned[6]).toBe(messages[6]);
  });

  it("stubbing shrinks what a rebuild charges for old tool output", () => {
    const bigName = `read_file ${"x".repeat(390)}`;
    const big = act(bigName);
    const [pruned] = pruneStaleToolOutput([act("keep1"), act("keep2"), act("keep3"), big]);
    expect(messageTokens(pruned!)).toBeLessThan(messageTokens(big));
    expect(estimateTokens(pruned!.tool!.name)).toBeLessThan(50);
  });

  it("renders the stub as an honest omission line", () => {
    // one activity alone is inside the recent window; five make "old" stale
    const [stale] = pruneStaleToolOutput([act("old"), act("k1"), act("k2"), act("k3"), act("k4")]);
    const turn = renderForModel(stale!);
    expect(turn?.text).toContain("earlier tool activity omitted");
  });
});
