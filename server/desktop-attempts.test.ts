// Unit coverage for the attempt-custody seams the HTTP suite cannot reach:
// TTL expiry (injected clock), the size cap, and redirect binding. The wire
// behavior itself is proven in desktop-attempt-flow.test.ts.
import { afterEach, describe, expect, it } from "vitest";

import {
  attemptsState,
  beginDesktopSignInAttempt,
  cancelDesktopSignInAttempt,
  isAttemptRedirect,
  redeemDesktopSignInAttempt,
} from "./desktop-attempts.ts";

const REDIRECT = "http://127.0.0.1:8799";

afterEach(() => attemptsState.reset());

describe("desktop sign-in attempt custody", () => {
  it("redeems a live attempt and releases the verifier exactly once", () => {
    const { state } = beginDesktopSignInAttempt(REDIRECT, 1_000);
    const first = redeemDesktopSignInAttempt({ state, redirect: REDIRECT }, 2_000);
    expect(first).toEqual({ ok: true, verifier: expect.stringMatching(/^[A-Za-z0-9_-]{43,128}$/) });
    expect(attemptsState.count()).toBe(0);
    const replay = redeemDesktopSignInAttempt({ state, redirect: REDIRECT }, 2_000);
    expect(replay).toEqual({ ok: false, reason: "unknown" });
  });

  it("binds the redemption to the loopback origin the attempt began on", () => {
    const { state } = beginDesktopSignInAttempt(REDIRECT, 1_000);
    const other = redeemDesktopSignInAttempt({ state, redirect: "http://127.0.0.1:9999" }, 2_000);
    expect(other).toEqual({ ok: false, reason: "redirect" });
    expect(attemptsState.count()).toBe(0);
  });

  it("refuses a redemption after the TTL, even without a cancel", () => {
    beginDesktopSignInAttempt(REDIRECT, 1_000);
    const late = redeemDesktopSignInAttempt({ state: "irrelevant", redirect: REDIRECT }, 1_000 + 10 * 60_000 + 1);
    expect(late).toEqual({ ok: false, reason: "unknown" });
    expect(attemptsState.count()).toBe(0);
  });

  it("cancel removes exactly the named attempt and answers false the second time", () => {
    const first = beginDesktopSignInAttempt(REDIRECT, 1_000);
    const second = beginDesktopSignInAttempt("http://localhost:8799", 1_000);
    expect(attemptsState.count()).toBe(1); // begin supersedes
    expect(cancelDesktopSignInAttempt(second.state, 2_000)).toBe(true);
    expect(cancelDesktopSignInAttempt(second.state, 2_000)).toBe(false);
    expect(cancelDesktopSignInAttempt(first.state, 2_000)).toBe(false);
    expect(attemptsState.count()).toBe(0);
  });

  it("treats unknown, cancelled and never-minted states identically", () => {
    beginDesktopSignInAttempt(REDIRECT, 1_000);
    for (const state of [undefined, "", "never-minted"]) {
      const result = redeemDesktopSignInAttempt({ state, redirect: REDIRECT }, 2_000);
      expect(result.ok).toBe(false);
    }
  });

  it("keeps the attempt table bounded under a begin loop", () => {
    for (let index = 0; index < 200; index += 1) beginDesktopSignInAttempt(REDIRECT, index * 1_000);
    expect(attemptsState.count()).toBeLessThanOrEqual(64);
  });

  it("accepts only loopback redirects for an attempt", () => {
    expect(isAttemptRedirect("http://127.0.0.1:8799")).toBe(true);
    expect(isAttemptRedirect("http://localhost:8799/")).toBe(true);
    expect(isAttemptRedirect("http://[::1]:8799")).toBe(true);
    expect(isAttemptRedirect("https://muster.today")).toBe(false);
    expect(isAttemptRedirect("http://192.168.1.10:8799")).toBe(false);
  });
});
