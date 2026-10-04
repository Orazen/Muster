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

const {
  redeemReferral,
  requestCapabilities,
  stashReferral,
  peekStashedReferral,
  takeStashedReferral,
  clearStashedReferral,
  REFERRAL_DEADLINE_MS,
  REFERRAL_STASH_TTL_MS,
} = await import("./auth");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  clearStashedReferral();
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
    clearStashedReferral();
    expect(takeStashedReferral()).toBeNull();
  });

  it("holds nothing when there was no referral to carry", () => {
    expect(takeStashedReferral()).toBeNull();
  });
});

// Regression 1. The OAuth failure route rewrites the return down to `authError=<code>`, so the URL
// the retry renders from carries neither the referral nor the destination. Both were stashed by the
// attempt that redirected, so both have to come back — and stashing again with no URL ref must not
// overwrite what is already held. That overwrite was the defect: it dropped the referral and sent
// the retry to the default destination.
describe("an OAuth failure does not lose the referral or the destination", () => {
  it("restores both from the stash when the error URL has neither", () => {
    stashReferral("REF-9", "/w/42/board", "attempt-1");
    // What LoginPage reads after the rewrite: no `ref`, no `next` in the query string.
    expect(peekStashedReferral()).toEqual({
      ref: "REF-9",
      next: "/w/42/board",
      attempt: "attempt-1",
    });
  });

  it("keeps a live referral when the retry stashes a null over it", () => {
    stashReferral("REF-9", "/w/42/board", "attempt-1");
    // The retry computes no URL ref, so it writes null — which must leave the held value alone.
    stashReferral(null, null, "attempt-2");
    expect(takeStashedReferral()).toBe("REF-9");
    expect(peekStashedReferral()).toBeNull();
  });

  it("rebinds to the newest attempt instead of leaving a superseded one named", () => {
    stashReferral("REF-9", "/w/42/board", "attempt-1");
    // The retry carries the restored code, so it writes a fresh record naming its own attempt.
    stashReferral("REF-9", "/w/42/board", "attempt-2");
    expect(peekStashedReferral()?.attempt).toBe("attempt-2");
  });

  it("restores without spending, so the retry can still redeem it", () => {
    stashReferral("REF-9", "/w/42/board", "attempt-1");
    expect(peekStashedReferral()).toEqual({
      ref: "REF-9",
      next: "/w/42/board",
      attempt: "attempt-1",
    });
    // A restore must leave the code in place: consuming it here would leave the retry with a
    // destination and nothing to redeem when the session finally confirms.
    expect(takeStashedReferral()).toBe("REF-9");
  });
});

// Regression 2. A desktop handoff the visitor abandoned used to leave a live stash in this tab, so
// an unrelated later session that confirmed one would spend a code nobody in that session had seen.
// Both bounds close it: an explicit cancel drops it, and one whose window passed never reads back.
describe("an abandoned attempt's referral cannot be spent by a later session", () => {
  it("is gone the moment the attempt is cancelled", () => {
    stashReferral("REF-9", "/w/42/board", "attempt-1");
    clearStashedReferral();
    expect(peekStashedReferral()).toBeNull();
    expect(takeStashedReferral()).toBeNull();
  });

  it("is cleared when an attempt times out or is abandoned", () => {
    stashReferral("REF-9", "/pair", "attempt-1");
    expect(peekStashedReferral()?.next).toBe("/pair");
    // Explicit timeout / unrecoverable failure cleanup clears the held referral
    clearStashedReferral();
    expect(takeStashedReferral()).toBeNull();
  });

  it("never reads back after its bounded lifetime has passed", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    stashReferral("REF-9", "/w/42/board", "attempt-1");
    vi.setSystemTime(Date.now() + REFERRAL_STASH_TTL_MS + 1000);
    expect(peekStashedReferral()).toBeNull();
    expect(takeStashedReferral()).toBeNull();
  });

  it("is still live inside its bounded lifetime", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    stashReferral("REF-9", "/w/42/board", "attempt-1");
    vi.setSystemTime(Date.now() + REFERRAL_STASH_TTL_MS - 1000);
    expect(takeStashedReferral()).toBe("REF-9");
  });
});
