// When a 401 should throw the user out of the app, and when it must not.
//
// Found by using the app: saving a provider API key navigated the browser to
// /sign-in while signed in, and that page then said "Already signed in as
// <email>". Three endpoints cause it on a local install — `/api/user-keys` and
// both `/api/account/merge/*` — because the server only assigns `requestUserId`
// under SELF_HOSTED, so they answer 401 to a valid local session.
//
// The original rule was "any 401 is a dead session", which exists for a real
// reason: an expired session used to 401 every hydrate call into silent
// `.catch()` sinks and left a permanently EMPTY app. So this is not about
// weakening the redirect. It is about redirecting only when the app can say it
// KNOWS the session is gone — `status: "ready"` with no user — and staying
// quiet while it does not know.
//
// `window.location` is stubbed rather than used: the production code assigns
// `window.location.href`, which jsdom cannot observe without replacing the
// whole property, and a test that cannot see the navigation cannot assert it.

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isSessionConfirmedSignedOut, noteKnownSession, resetKnownSession } from "./known-session";

// The suite runs in the `node` environment, so there is no `window` to stub and
// no jsdom navigation to intercept. That turns out to be the better shape: the
// redirect DECISION is expressed as a pure function of (status, pathname) and
// the call sites are pinned separately, by reading them.

/** The redirect decision both 401 handlers make. */
function shouldRedirectToSignIn(status: number, pathname: string): boolean {
  if (status !== 401) return false;
  if (!isSessionConfirmedSignedOut()) return false;
  if (pathname.startsWith("/sign")) return false;
  return pathname !== "/pair";
}

beforeEach(() => resetKnownSession());
afterEach(() => resetKnownSession());

describe("known session", () => {
  it("starts unknown, which is NOT signed out", () => {
    // The default matters more than it looks: defaulting to signed-out would
    // reintroduce the exact bug this replaces, because `api()` runs before
    // AuthProvider has published anything.
    expect(isSessionConfirmedSignedOut()).toBe(false);
  });

  it("is INITIALISED to false, not merely reset to false", () => {
    // The assertion above runs inside beforeEach's resetKnownSession(), so it
    // cannot see the declaration — and the declaration is the dangerous one,
    // because the very first api() call of a cold load happens before any
    // publish. A mutation flipping the literal to `true` left every other test
    // green until this one existed. Read the source rather than the value: a
    // fresh module instance cannot be obtained from a singleton.
    const source = readFileSync(new URL("./known-session.ts", import.meta.url), "utf8");
    expect(source).toMatch(/let confirmedSignedOut = false;/);
    expect(source).not.toMatch(/let confirmedSignedOut = true;/);
  });

  it("is confirmed signed out only when the app says so", () => {
    noteKnownSession(false);
    expect(isSessionConfirmedSignedOut()).toBe(true);
    noteKnownSession(true);
    expect(isSessionConfirmedSignedOut()).toBe(false);
  });

  it("treats 'we do not know' as not signed out", () => {
    // loading and unavailable both publish null. A 502, an HTML proxy page or a
    // network blip must never eject a user whose session is fine.
    noteKnownSession(null);
    expect(isSessionConfirmedSignedOut()).toBe(false);
  });

  it("recovers from a transient unknown without stranding anyone", () => {
    noteKnownSession(false);
    noteKnownSession(null);
    expect(isSessionConfirmedSignedOut()).toBe(false);
    noteKnownSession(true);
    expect(isSessionConfirmedSignedOut()).toBe(false);
  });
});

describe("401 redirect policy", () => {
  it("does NOT redirect a signed-in user", () => {
    // THE regression. `/api/user-keys` answers 401 to a valid local session, and
    // the old rule navigated on the status code alone.
    noteKnownSession(true);
    expect(shouldRedirectToSignIn(401, "/app")).toBe(false);
  });

  it("does NOT redirect while the session is still loading", () => {
    noteKnownSession(null);
    expect(shouldRedirectToSignIn(401, "/app")).toBe(false);
  });

  it("DOES redirect a confirmed signed-out user", () => {
    // The empty-app case the original redirect existed for is preserved: a
    // genuinely expired session still lands on the login page.
    noteKnownSession(false);
    expect(shouldRedirectToSignIn(401, "/app")).toBe(true);
  });

  it("never redirects away from the sign-in or pair pages", () => {
    // Unchanged behaviour, and the reason the old rule had those exclusions.
    noteKnownSession(false);
    for (const path of ["/sign-in", "/sign-up", "/pair"]) {
      expect(shouldRedirectToSignIn(401, path), path).toBe(false);
    }
  });

  it("ignores every status that is not a 401", () => {
    // A 403 or a 500 is a server problem, not a session problem; the eject was
    // never for those and must not quietly become so.
    noteKnownSession(false);
    for (const status of [400, 403, 404, 429, 500, 502, 503]) {
      expect(shouldRedirectToSignIn(status, "/app"), String(status)).toBe(false);
    }
  });
});

describe("the production call sites use this policy", () => {
  it("api() and the stop-cleanup handler both consult the known session", () => {
    // A behavioural test of the policy cannot stop a call site from reverting
    // to a bare `res.status === 401`. This pins that both read the helper.
    const store = readFileSync(new URL("../state/store.tsx", import.meta.url), "utf8");
    const guards = store.match(/isSessionConfirmedSignedOut\(\)/g) ?? [];
    // Once for the import-adjacent use in api(), once in onUnauthorized.
    expect(guards.length, `expected 2 guarded redirects in store.tsx, found ${guards.length}`).toBe(2);
    // And neither may sit behind a bare status check that ignores the helper.
    expect(store).not.toMatch(/if \(res\.status === 401 && !window\.location/);
    expect(store).not.toMatch(/onUnauthorized: \(\) => \{\s*window\.location/);
  });
});
