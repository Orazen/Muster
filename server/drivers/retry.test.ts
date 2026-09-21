// Retry policy tests — v2 plan item 3.4. The classifier and backoff are
// pure; the driver behaviors run against the scripted fake CLI: a simulated
// 529 retries and completes, an invalid key fails fast, and an attempt that
// already streamed text never retries (a retry would duplicate the output).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chmodSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDirs } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { ClaudeDriver } from "./claude.ts";
import { GrokDriver } from "./grok.ts";
import { MAX_RETRIES, retryDelayMs, transientReason } from "./retry.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-claude-cli.ts");

describe("transientReason", () => {
  it("confidently matches capacity, rate-limit, and connection failures", () => {
    for (const message of [
      "API Error: 529 overloaded_error",
      "xAI HTTP 429: rate limit exceeded",
      "HTTP 502 Bad Gateway",
      "Error: socket hang up",
      "fetch failed: ECONNRESET",
      "request timed out after 60000ms",
      "500 Internal Server Error",
    ]) {
      expect(transientReason(message), message).not.toBeNull();
    }
  });

  it("never classifies auth, quota, model, or empty failures as transient", () => {
    for (const message of [
      "",
      "Invalid API key · please run /login",
      "unauthorized",
      "quota exceeded for this project",
      "invalid model: claude-nope",
      "fake-claude: simulated crash before result",
    ]) {
      expect(transientReason(message), message || "(empty)").toBeNull();
    }
  });
});

describe("retryDelayMs", () => {
  it("backs off exponentially with jitter inside a hard ceiling", () => {
    process.env.MUSTER_RETRY_BASE_MS = "1000";
    try {
      const first = retryDelayMs(1);
      expect(first).toBeGreaterThanOrEqual(1000);
      expect(first).toBeLessThan(1401);
      const third = retryDelayMs(3);
      // 4s base + jitter, still far under the 10s cap at this attempt
      expect(third).toBeGreaterThanOrEqual(4000);
      expect(third).toBeLessThan(4401);
      // deep attempts cap at MAX_DELAY_MS + jitter no matter how many retries
      const deep = retryDelayMs(30);
      expect(deep).toBeLessThanOrEqual(10_400);
    } finally {
      delete process.env.MUSTER_RETRY_BASE_MS;
    }
  });
});

describe("ClaudeDriver auto-retry (fake CLI)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let scratch: string;

  const create = async (mode: string) => {
    process.env.FAKE_CLAUDE_MODE = mode;
    instance = await ClaudeDriver.create({
      instanceId: "claude-retry-test",
      displayName: "Claude Retry Test",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, permissionMode: "acceptEdits" },
    });
    recorder = recordEvents(instance.adapter);
  };

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "omb-claude-retry-"));
    process.env.MUSTER_RETRY_BASE_MS = "10"; // keep backoff out of test time
  });

  afterEach(async () => {
    delete process.env.FAKE_CLAUDE_MODE;
    delete process.env.FAKE_CLAUDE_FLAKY_FILE;
    delete process.env.MUSTER_RETRY_BASE_MS;
    recorder?.stop();
    await instance?.dispose();
    await removeTempDir(scratch);
    vi.restoreAllMocks();
  });

  it("retries a clean transient failure and completes the turn", async () => {
    process.env.FAKE_CLAUDE_MODE = "flaky";
    process.env.FAKE_CLAUDE_FLAKY_FILE = join(scratch, "attempted");
    await create("flaky");
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-flaky", text: "hi" });
    const done = await recorder.until((e) => e.type === "turn.completed");

    expect(done).toMatchObject({ ok: true, turnId });
    const retrying = recorder.events.find((e) => e.type === "turn.retrying");
    expect(retrying).toMatchObject({ type: "turn.retrying", attempt: 1, maxAttempts: MAX_RETRIES });
    // SAFETY: turn.retrying always carries the matched transient reason.
    expect((retrying as { reason?: string }).reason).toContain("529");
    // a retry is not an error: exactly one turn.started, zero runtime.error
    expect(recorder.events.filter((e) => e.type === "turn.started")).toHaveLength(1);
    expect(recorder.events.filter((e) => e.type === "runtime.error")).toHaveLength(0);
  }, 20_000);

  it("fails immediately on an auth-shaped error without retrying", async () => {
    await create("auth-error");
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-auth", text: "hi" });
    const done = await recorder.until((e) => e.type === "turn.completed");

    expect(done).toMatchObject({ ok: false, stopReason: "auth_required", turnId });
    expect(recorder.events.some((e) => e.type === "turn.retrying")).toBe(false);
    expect(recorder.events.filter((e) => e.type === "runtime.error")).toHaveLength(1);
  }, 20_000);

  it("does not retry an attempt that already streamed partial output", async () => {
    await create("die-after-delta");
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-dirty", text: "hi" });
    const done = await recorder.until((e) => e.type === "turn.completed");

    expect(done).toMatchObject({ ok: false, stopReason: "exit_before_result", turnId });
    expect(recorder.events.some((e) => e.type === "turn.retrying")).toBe(false);
    // the partial delta reached the chat exactly once — no duplicate
    const deltas = recorder.events.filter((e) => e.type === "content.delta");
    expect(deltas).toHaveLength(1);
  }, 20_000);

  it("stops retrying once the attempt cap is exhausted", async () => {
    await create("always-overloaded");
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-cap", text: "hi" });
    const done = await recorder.until((e) => e.type === "turn.completed");

    expect(done).toMatchObject({ ok: false, stopReason: "exit_before_result", turnId });
    // initial try + exactly MAX_RETRIES retries, then the turn fails
    const retrying = recorder.events.filter((e) => e.type === "turn.retrying");
    expect(retrying).toHaveLength(MAX_RETRIES);
    // SAFETY: turn.retrying carries the 1-based number of the failed attempt.
    expect(retrying.map((e) => (e as { attempt: number }).attempt)).toEqual([1, MAX_RETRIES]);
    // one error chip at the end, not one per attempt
    expect(recorder.events.filter((e) => e.type === "runtime.error")).toHaveLength(1);
  }, 20_000);
});

describe("GrokDriver auto-retry (mocked fetch)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.MUSTER_RETRY_BASE_MS = "10"; // keep backoff out of test time
    global.fetch = vi.fn();
  });

  afterEach(async () => {
    delete process.env.MUSTER_RETRY_BASE_MS;
    global.fetch = originalFetch;
    vi.restoreAllMocks();
    recorder?.stop();
    await instance?.dispose();
  });

  const create = async () => {
    instance = await GrokDriver.create({
      instanceId: "grok-retry-test",
      displayName: undefined,
      environment: { XAI_API_KEY: "xai-test" },
      enabled: true,
      config: GrokDriver.decodeConfig({}),
    });
    recorder = recordEvents(instance.adapter);
  };

  const sseResponse = (text: string) =>
    new Response(
      new Blob([
        `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
        "data: [DONE]\n\n",
      ]),
      { status: 200 },
    );

  it("retries a 429 and completes, but fails fast on an invalid key", async () => {
    await create();
    // SAFETY: the suite swaps in a jest-fetch mock; only its mock methods are used.
    (global.fetch as any).mockRejectedValueOnce(new Error("xAI HTTP 429: rate limit exceeded"));
    // SAFETY: same jest-fetch mock; only mockResolvedValueOnce is used here.
    (global.fetch as any).mockResolvedValueOnce(sseResponse("hello"));

    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-grok-ok", text: "hi" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true, turnId });
    expect(recorder.events.find((e) => e.type === "turn.retrying")).toMatchObject({ attempt: 1 });
    expect(fetch).toHaveBeenCalledTimes(2);

    // terminal failure: an auth error never retries
    recorder.events.length = 0;
    // SAFETY: same jest-fetch mock as above.
    (global.fetch as any).mockRejectedValue(new Error("xAI HTTP 401: invalid api key"));
    await instance.adapter.sendTurn({ threadId: "t-grok-auth", text: "hi" });
    const failed = await recorder.until((e) => e.type === "turn.completed");
    expect(failed).toMatchObject({ ok: false, stopReason: "error" });
    expect(recorder.events.some((e) => e.type === "turn.retrying")).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(3);
  }, 20_000);

  it("exhausts the retry cap on persistent rate limits", async () => {
    await create();
    // SAFETY: same jest-fetch mock as above.
    (global.fetch as any).mockRejectedValue(new Error("xAI HTTP 429: rate limit exceeded"));

    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-grok-cap", text: "hi" });
    const done = await recorder.until((e) => e.type === "turn.completed");

    expect(done).toMatchObject({ ok: false, stopReason: "error", turnId });
    // initial try + exactly MAX_RETRIES retries, then the turn fails
    expect(fetch).toHaveBeenCalledTimes(MAX_RETRIES + 1);
    const retrying = recorder.events.filter((e) => e.type === "turn.retrying");
    expect(retrying).toHaveLength(MAX_RETRIES);
    // SAFETY: turn.retrying carries the 1-based number of the failed attempt.
    expect(retrying.map((e) => (e as { attempt: number }).attempt)).toEqual([1, MAX_RETRIES]);
    expect(recorder.events.filter((e) => e.type === "runtime.error")).toHaveLength(1);
  }, 20_000);
});
