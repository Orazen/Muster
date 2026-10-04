import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `auth.tsx` reads `window.location.origin` at module scope to build its client, so the global has
 * to exist before the import evaluates - `vi.hoisted` runs ahead of the import list, which is the
 * only ordering that works in a file whose test environment is node.
 *
 * Declared `.ts` rather than `.tsx` for a reason worth recording: vite.config.ts's test include
 * pattern only collects `.test.ts` beneath `src`, so a `.tsx` test file there is never run at all.
 * Every existing src test is `.ts` for that same reason, and JSX is written with `createElement`
 * where it is needed.
 */
vi.hoisted(() => {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "window", {
    value: { location: { origin: "http://127.0.0.1:5199" } },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
    },
    configurable: true,
    writable: true,
  });
});

const { redeemReferral, requestCapabilities, stashReferral, takeStashedReferral, REFERRAL_DEADLINE_MS } =
  await import("./auth");

afterEach(() => {
  vi.unstubAllGlobals();
  stashReferral(null);
});

function stubFetch(resolve: () => Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(resolve));
}

describe("referral redemption cannot strand an authenticated user", () => {
  it("gives up on a request that never settles instead of awaiting it forever", async () => {
    // The regression: redemption was awaited with no bound, so a request that was accepted but
    // never settled left a user who had just signed in stuck on the auth page. A rejection at
    // least returned; silence did not.
    stubFetch(() => new Promise<Response>(() => { /* never settles */ }));
    const started = Date.now();
    const outcome = await redeemReferral("REF-1", { deadlineMs: 25 });
    expect(outcome).toBe("unreachable");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("is bounded by default as well, without an injected deadline", () => {
    expect(REFERRAL_DEADLINE_MS).toBeGreaterThan(0);
    expect(REFERRAL_DEADLINE_MS).toBeLessThanOrEqual(5000);
  });

  it("still reports the outcomes it does receive", async () => {
    stubFetch(async () => new Response(null, { status: 200 }));
    expect(await redeemReferral("REF-1", { deadlineMs: 500 })).toBe("redeemed");

    stubFetch(async () => new Response(null, { status: 409 }));
    expect(await redeemReferral("REF-1", { deadlineMs: 500 })).toBe("rejected");
  });

  it("treats a transport failure as unreachable rather than as a rejection", async () => {
    stubFetch(async () => { throw new Error("offline"); });
    expect(await redeemReferral("REF-1", { deadlineMs: 500 })).toBe("unreachable");
  });

  it("does nothing, and makes no request, without a referral", async () => {
    stubFetch(async () => new Response(null, { status: 200 }));
    expect(await redeemReferral(null)).toBe("skipped");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("never posts the code before the caller says a session exists", async () => {
    // Ordering is the caller's to guarantee; what this pins is that redemption itself never
    // retries or repeats a submission, so a code cannot be spent twice by one call.
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => { calls += 1; return new Response(null, { status: 200 }); }));
    await redeemReferral("REF-2", { deadlineMs: 500 });
    await redeemReferral("REF-2", { deadlineMs: 500 });
    expect(calls).toBe(2);
  });
});

describe("capability reads distinguish failure from absence", () => {
  const respond = (body: string, status: number) => async () =>
    new Response(body, { status, headers: { "content-type": "application/json" } });

  it("returns the methods the server advertises", async () => {
    const caps = await requestCapabilities(
      "http://127.0.0.1:5199",
      respond(JSON.stringify({ socialProviders: ["google"], emailOtp: true, passwordReset: true }), 200),
    );
    expect(caps?.socialProviders).toEqual(["google"]);
    expect(caps?.emailOtp).toBe(true);
    expect(caps?.passwordReset).toBe(true);
  });

  it("reports a server that answers with no optional flows as a fact, not an error", async () => {
    const caps = await requestCapabilities("http://127.0.0.1:5199", respond(JSON.stringify({}), 200));
    expect(caps).not.toBeNull();
    expect(caps?.socialProviders).toEqual([]);
    expect(caps?.emailOtp).toBe(false);
  });

  it("reports a non-2xx answer as a failure so the page can offer a retry", async () => {
    expect(await requestCapabilities("http://127.0.0.1:5199", respond("upstream sad", 503))).toBeNull();
    expect(await requestCapabilities("http://127.0.0.1:5199", respond("not found", 404))).toBeNull();
  });

  it("reports a request that never reaches the server the same way", async () => {
    const offline = async () => { throw new Error("network down"); };
    expect(await requestCapabilities("http://127.0.0.1:5199", offline)).toBeNull();
  });

  it("coerces each field so one odd value cannot break the whole sign-in page", async () => {
    const caps = await requestCapabilities(
      "http://127.0.0.1:5199",
      respond(JSON.stringify({ socialProviders: "google", emailOtp: 1, passwordReset: null }), 200),
    );
    expect(caps?.socialProviders).toEqual([]);
    expect(caps?.emailOtp).toBe(true);
    expect(caps?.passwordReset).toBe(false);
  });
});

describe("a referral survives exactly one OAuth redirect", () => {
  it("is consumed on first read", () => {
    stashReferral("REF-9");
    expect(takeStashedReferral()).toBe("REF-9");
    expect(takeStashedReferral()).toBeNull();
  });

  it("is dropped, not reused, when the caller clears it", () => {
    stashReferral("REF-9");
    stashReferral(null);
    expect(takeStashedReferral()).toBeNull();
  });

  it("holds nothing when there was no referral to carry", () => {
    expect(takeStashedReferral()).toBeNull();
  });
});
