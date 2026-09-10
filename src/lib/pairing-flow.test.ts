import { afterEach, describe, expect, it, vi } from "vitest";
import { PairingFlow, pairingSecondsLeft } from "./pairing-flow";

const now = 100_000;
const pairing = { code: "ABCD2345", expiresAt: now + 60_000 };

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (reason: Error) => void = () => {};
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

type TestPairingResponse = null | {
  code?: string;
  expiresAt?: number | string;
  error?: string | { detail: string };
};

function jsonResponse(body: TestPairingResponse, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  if (vi.isFakeTimers()) vi.clearAllTimers();
  vi.useRealTimers();
});

describe("Cloud pairing code lifecycle", () => {
  it("does not request a code during construction or subscription", () => {
    const transport = vi.fn<typeof fetch>();
    const flow = new PairingFlow(transport, () => now);
    const listener = vi.fn();
    flow.subscribe(listener);
    expect(listener).toHaveBeenCalledExactlyOnceWith({ status: "idle", pairing: null, error: null, copy: "idle" });
    expect(flow.canCopy).toBe(false);
    expect(transport).not.toHaveBeenCalled();
  });

  it("keeps one request across effect cleanup and resubscription, including a settled start", async () => {
    const response = deferred<Response>();
    const transport = vi.fn<typeof fetch>().mockReturnValue(response.promise);
    const flow = new PairingFlow(transport, () => now);
    const firstListener = vi.fn();
    const detach = flow.subscribe(firstListener);
    const firstRequest = flow.start();
    detach();
    const nextListener = vi.fn();
    flow.subscribe(nextListener);
    expect(flow.start()).toBe(firstRequest);
    expect(nextListener).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: "loading", error: null }));
    response.resolve(jsonResponse(pairing));
    await firstRequest;
    await flow.start();
    expect(transport).toHaveBeenCalledExactlyOnceWith("/api/pair/create", { method: "POST", credentials: "same-origin" });
    expect(firstListener.mock.calls.map(([state]) => state.status)).toEqual(["idle", "loading"]);
    expect(nextListener.mock.calls.map(([state]) => state.status)).toEqual(["loading", "ready"]);
    expect(flow.state.pairing).toEqual(pairing);
    expect(flow.canCopy).toBe(true);
  });

  it("waits for an explicit refresh after an initial failure, then recovers", async () => {
    const transport = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("Connection interrupted"))
      .mockResolvedValueOnce(jsonResponse(pairing));
    const flow = new PairingFlow(transport, () => now);
    await flow.start();
    expect(flow.state).toMatchObject({ status: "error", error: "Could not reach Muster. Check your connection and try again.", pairing: null });
    await flow.start();
    expect(transport).toHaveBeenCalledTimes(1);
    await flow.refresh();
    expect(transport).toHaveBeenCalledTimes(2);
    expect(flow.state).toMatchObject({ status: "ready", pairing, error: null });
  });

  it("retains the last code but prevents copying after a failed refresh", async () => {
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(pairing))
      .mockResolvedValueOnce(jsonResponse({ error: "Please sign in again." }, 401));
    const writeText = vi.fn<(code: string) => Promise<void>>();
    const flow = new PairingFlow(transport, () => now, writeText);
    await flow.start();
    await flow.refresh();
    expect(flow.state).toMatchObject({ status: "error", pairing, error: "Please sign in again." });
    expect(flow.canCopy).toBe(false);
    expect(await flow.copy()).toBe("ignored");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("deduplicates overlapping refreshes and accepts an unchanged live server code", async () => {
    const response = deferred<Response>();
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(pairing))
      .mockReturnValueOnce(response.promise);
    const flow = new PairingFlow(transport, () => now);
    await flow.start();
    const refresh = flow.refresh();
    expect(flow.refresh()).toBe(refresh);
    expect(flow.state).toMatchObject({ status: "loading", pairing, error: null });
    expect(flow.canCopy).toBe(false);
    response.resolve(jsonResponse(pairing));
    await refresh;
    expect(transport).toHaveBeenCalledTimes(2);
    expect(flow.state).toMatchObject({ status: "ready", pairing });
  });

  it("finishes an outstanding request without notifying a departed page", async () => {
    const response = deferred<Response>();
    const flow = new PairingFlow(vi.fn<typeof fetch>().mockReturnValue(response.promise), () => now);
    const oldListener = vi.fn();
    const detach = flow.subscribe(oldListener);
    const request = flow.start();
    detach();
    response.resolve(jsonResponse(pairing));
    await request;
    expect(oldListener.mock.calls.map(([state]) => state.status)).toEqual(["idle", "loading"]);
    const resumedListener = vi.fn();
    flow.subscribe(resumedListener);
    expect(resumedListener).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: "ready", pairing }));
  });

  it("does not let an old effect cleanup remove the current subscriber", async () => {
    const flow = new PairingFlow(vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(pairing)), () => now);
    const detachOld = flow.subscribe(vi.fn());
    const listener = vi.fn();
    flow.subscribe(listener);
    detachOld();
    await flow.start();
    expect(listener.mock.calls.map(([state]) => state.status)).toEqual(["idle", "loading", "ready"]);
  });

  it.each([
    null,
    {},
    { code: "ABCD234", expiresAt: pairing.expiresAt },
    { code: "ABCD23456", expiresAt: pairing.expiresAt },
    { code: "ABCD2340", expiresAt: pairing.expiresAt },
    { code: "abcd2345", expiresAt: pairing.expiresAt },
    { code: pairing.code, expiresAt: String(pairing.expiresAt) },
    { code: pairing.code, expiresAt: pairing.expiresAt + 0.5 },
    { code: pairing.code, expiresAt: 8_640_000_000_000_001 },
  ])("rejects incomplete or malformed successful response %j", async (body) => {
    const flow = new PairingFlow(vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(body)), () => now);
    await flow.start();
    expect(flow.state).toMatchObject({ status: "error", pairing: null, error: expect.stringContaining("incomplete") });
    expect(flow.canCopy).toBe(false);
  });

  it.each([200, 502])("offers recovery when HTTP %i contains HTML instead of JSON", async (status) => {
    const flow = new PairingFlow(vi.fn<typeof fetch>().mockResolvedValue(new Response("<html>Proxy error</html>", { status })), () => now);
    await flow.start();
    expect(flow.state).toMatchObject({ status: "error", pairing: null, error: expect.any(String) });
    expect(flow.canCopy).toBe(false);
  });

  it.each([null, {}, { error: "   " }, { error: { detail: "Bad gateway" } }])(
    "provides a usable fallback for malformed server error %j",
    async (body) => {
      const flow = new PairingFlow(vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(body, 503)), () => now);
      await flow.start();
      expect(flow.state.error).toBe("Could not get a pairing code. Try again.");
      expect(flow.canCopy).toBe(false);
    },
  );

  it("keeps validated server retry guidance readable", async () => {
    const flow = new PairingFlow(vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ error: "  Sign in to pair this desktop.  " }, 401)), () => now);
    await flow.start();
    expect(flow.state).toMatchObject({ status: "error", error: "Sign in to pair this desktop." });
  });

  it.each([now - 1, now])("rejects a response already expired at %i", async (expiresAt) => {
    const flow = new PairingFlow(vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ ...pairing, expiresAt })), () => now);
    await flow.start();
    expect(flow.state).toMatchObject({ status: "error", pairing: null, error: expect.stringContaining("expired") });
    expect(flow.canCopy).toBe(false);
  });

  it("checks expiry when the response arrives, rather than when the request began", async () => {
    let clock = now;
    const response = deferred<Response>();
    const flow = new PairingFlow(vi.fn<typeof fetch>().mockReturnValue(response.promise), () => clock);
    const request = flow.start();
    clock = pairing.expiresAt;
    response.resolve(jsonResponse(pairing));
    await request;
    expect(flow.state.status).toBe("error");
    expect(flow.canCopy).toBe(false);
  });
});

describe("Pairing code clipboard feedback", () => {
  it("does not copy before loading, during loading, or at exact expiry", async () => {
    let clock = now;
    const response = deferred<Response>();
    const writeText = vi.fn<(code: string) => Promise<void>>();
    const flow = new PairingFlow(vi.fn<typeof fetch>().mockReturnValue(response.promise), () => clock, writeText);
    expect(await flow.copy()).toBe("ignored");
    const request = flow.start();
    expect(await flow.copy()).toBe("ignored");
    response.resolve(jsonResponse(pairing));
    await request;
    clock = pairing.expiresAt - 1;
    expect(flow.canCopy).toBe(true);
    clock++;
    expect(flow.canCopy).toBe(false);
    expect(await flow.copy()).toBe("ignored");
    expect(writeText).not.toHaveBeenCalled();
  });

  it.each(["rejected", "unavailable"])("offers manual selection when clipboard access is %s", async (failure) => {
    const writeText = vi.fn<(code: string) => Promise<void>>();
    if (failure === "rejected") writeText.mockRejectedValue(new DOMException("Clipboard access denied", "NotAllowedError"));
    else writeText.mockImplementation(() => { throw new TypeError("Clipboard API unavailable"); });
    const flow = new PairingFlow(vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(pairing)), () => now, writeText);
    await flow.start();
    expect(await flow.copy()).toBe("manual");
    expect(flow.state).toMatchObject({ status: "ready", pairing, copy: "manual" });
    expect(flow.canCopy).toBe(true);
    expect(writeText).toHaveBeenCalledExactlyOnceWith(pairing.code);
  });

  it("deduplicates pending clipboard writes and clears copied feedback after 1.5 seconds", async () => {
    vi.useFakeTimers();
    const clipboard = deferred<void>();
    const writeText = vi.fn<(code: string) => Promise<void>>().mockReturnValue(clipboard.promise);
    const flow = new PairingFlow(vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(pairing)), () => now, writeText);
    await flow.start();
    const copy = flow.copy();
    expect(flow.state.copy).toBe("copying");
    expect(await flow.copy()).toBe("ignored");
    clipboard.resolve();
    expect(await copy).toBe("copied");
    expect(writeText).toHaveBeenCalledExactlyOnceWith(pairing.code);
    await vi.advanceTimersByTimeAsync(1499);
    expect(flow.state.copy).toBe("copied");
    await vi.advanceTimersByTimeAsync(1);
    expect(flow.state.copy).toBe("idle");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["success", "failure"])("ignores a late clipboard %s after refreshing, even if the server retains the code", async (outcome) => {
    vi.useFakeTimers();
    const clipboard = deferred<void>();
    const flow = new PairingFlow(
      vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse(pairing)),
      () => now,
      () => clipboard.promise,
    );
    await flow.start();
    const copy = flow.copy();
    await flow.refresh();
    if (outcome === "success") clipboard.resolve();
    else clipboard.reject(new Error("Clipboard denied"));
    expect(await copy).toBe("ignored");
    expect(flow.state).toMatchObject({ status: "ready", pairing, copy: "idle" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not mark an unmounted or subsequently resubscribed page copied", async () => {
    vi.useFakeTimers();
    const clipboard = deferred<void>();
    const flow = new PairingFlow(vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(pairing)), () => now, () => clipboard.promise);
    const oldListener = vi.fn();
    const detach = flow.subscribe(oldListener);
    await flow.start();
    const copy = flow.copy();
    detach();
    const callsAtDetach = oldListener.mock.calls.length;
    const resumedListener = vi.fn();
    flow.subscribe(resumedListener);
    clipboard.resolve();
    expect(await copy).toBe("ignored");
    expect(oldListener).toHaveBeenCalledTimes(callsAtDetach);
    expect(resumedListener).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ copy: "idle" }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["success", "failure"])("clears pending clipboard feedback after %s if the code expired during permission", async (outcome) => {
    vi.useFakeTimers();
    let clock = now;
    const clipboard = deferred<void>();
    const flow = new PairingFlow(vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(pairing)), () => clock, () => clipboard.promise);
    await flow.start();
    const copy = flow.copy();
    clock = pairing.expiresAt;
    if (outcome === "success") clipboard.resolve();
    else clipboard.reject(new Error("Clipboard denied"));
    expect(await copy).toBe("ignored");
    expect(flow.state.copy).toBe("idle");
    expect(flow.canCopy).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["detach", "refresh"])("cleans up copied feedback timers on %s", async (cleanup) => {
    vi.useFakeTimers();
    const flow = new PairingFlow(
      vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse(pairing)),
      () => now,
      async () => {},
    );
    const listener = vi.fn();
    const detach = flow.subscribe(listener);
    await flow.start();
    expect(await flow.copy()).toBe("copied");
    expect(vi.getTimerCount()).toBe(1);
    if (cleanup === "detach") detach();
    else await flow.refresh();
    expect(flow.state.copy).toBe("idle");
    expect(vi.getTimerCount()).toBe(0);
    const callsAfterCleanup = listener.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1500);
    expect(listener).toHaveBeenCalledTimes(callsAfterCleanup);
  });
});

describe("Pairing countdown boundaries", () => {
  it.each([
    { remaining: 1001, seconds: 2 },
    { remaining: 1000, seconds: 1 },
    { remaining: 1, seconds: 1 },
    { remaining: 0, seconds: 0 },
    { remaining: -1, seconds: 0 },
  ])("shows $seconds seconds with $remaining milliseconds remaining", ({ remaining, seconds }) => {
    expect(pairingSecondsLeft(now + remaining, now)).toBe(seconds);
  });
});
