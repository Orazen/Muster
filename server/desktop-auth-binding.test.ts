// A2: the hosted-account exchange binds a finished sign-in to the client that
// started it.
//
// The 1.20 handoff issued a BEARER code: whoever held it could redeem it, and it
// travels to the desktop in a URL fragment over a loopback port — a channel any
// other local process can race. These cases pin the three things that close
// that, plus the property that matters most in practice: a client that sends
// none of them keeps working exactly as before, because a cloud and a desktop
// ship independently and either may be older.
//
// The deliberate omission is a `state` mismatch test that pretends to stop a
// user being walked through someone else's sign-in. It does not, and no test
// here claims it does: `state` catches a stale or replayed callback, not a
// victim whose browser completes a real one. That is a product decision about
// showing people what they sign into, and it is recorded as open in
// server/desktop-auth.ts.
import { createHash, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import {
  cancelDesktopGrant,
  CHALLENGE_MAX,
  exchangeState,
  EXCHANGE_VERSION,
  issueBoundDesktopGrant,
  issueDesktopGrant,
  issueHandoffCode,
  normalizeChallenge,
  normalizeState,
  redeemBoundHandoffCode,
  redeemHandoffCode,
  STATE_MAX,
  STATE_MIN,
  VERIFIER_MAX,
  VERIFIER_MIN,
  verifyPkceChallenge,
} from "./desktop-auth.ts";

const REDIRECT = "http://127.0.0.1:8799";
const IDENTITY = { userId: "u-1", email: "person@example.test", name: "Person" };

/** A verifier and its S256 challenge, the pair a real client generates. */
function pkcePair() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier, "ascii").digest("base64url") };
}

/** Grant -> code, the two steps a browser walk-through performs. */
function mintCode(binding: Parameters<typeof issueBoundDesktopGrant>[0]) {
  const grant = issueBoundDesktopGrant(binding);
  const handoff = issueHandoffCode(grant, IDENTITY);
  if (!handoff) throw new Error("grant did not mint a code");
  return handoff;
}

afterEach(() => exchangeState.reset());

describe("client-supplied values are normalized, not trusted", () => {
  it("keeps a well-formed state and refuses one too short to mean anything", () => {
    const good = "a".repeat(STATE_MIN);
    expect(normalizeState(good)).toBe(good);
    // A 15-character state is guessable, so accepting it would be theatre.
    expect(normalizeState("a".repeat(STATE_MIN - 1))).toBeUndefined();
    expect(normalizeState("")).toBeUndefined();
    expect(normalizeState(null)).toBeUndefined();
    expect(normalizeState(undefined)).toBeUndefined();
  });

  it("caps an over-long state instead of storing it", () => {
    // These arrive in a URL, so an unbounded value is a way to push megabytes
    // into a map that has no other bound.
    expect(normalizeState("a".repeat(STATE_MAX + 1))).toBeUndefined();
    expect(normalizeState("a".repeat(STATE_MAX))).toHaveLength(STATE_MAX);
  });

  it("refuses a state carrying characters outside the URL-safe alphabet", () => {
    expect(normalizeState("a".repeat(20) + " " + "b".repeat(20))).toBeUndefined();
    expect(normalizeState("a".repeat(20) + "<script>" + "b".repeat(8))).toBeUndefined();
  });

  it("requires a recognised method alongside a challenge", () => {
    const { challenge } = pkcePair();
    expect(normalizeChallenge(challenge, "S256")).toEqual({ codeChallenge: challenge, codeChallengeMethod: "S256" });
    // A challenge with an unknown method is not a challenge: accepting it
    // would mean guessing, and guessing means silently no binding at all.
    expect(normalizeChallenge(challenge, "sha1")).toBeUndefined();
    expect(normalizeChallenge(challenge, "")).toBeUndefined();
    expect(normalizeChallenge(challenge, null)).toBeUndefined();
    expect(normalizeChallenge("short", "S256")).toBeUndefined();
    expect(normalizeChallenge("c".repeat(CHALLENGE_MAX + 1), "S256")).toBeUndefined();
  });

  it("measures an S256 verifier the way RFC 7636 does", () => {
    const { verifier, challenge } = pkcePair();
    expect(verifyPkceChallenge(challenge, "S256", verifier)).toBe(true);
    expect(verifyPkceChallenge(challenge, "S256", `${verifier}x`)).toBe(false);
    expect(verifyPkceChallenge(challenge, "S256", "")).toBe(false);
    expect(verifyPkceChallenge(challenge, "S256", undefined)).toBe(false);
    expect(verifyPkceChallenge(challenge, "S256", "a".repeat(VERIFIER_MAX + 1))).toBe(false);
    expect(verifyPkceChallenge(challenge, "S256", "a".repeat(VERIFIER_MIN - 1))).toBe(false);
  });

  it("supports plain only when the challenge says plain", () => {
    const { verifier } = pkcePair();
    expect(verifyPkceChallenge(verifier, "plain", verifier)).toBe(true);
    // The same verifier hashed is NOT the plain challenge: a client must not
    // be able to satisfy an S256 grant with a plain comparison.
    expect(verifyPkceChallenge(verifier, "S256", verifier)).toBe(false);
  });
});

describe("a stolen code is useless without the verifier", () => {
  it("refuses redemption with no verifier and burns the code", () => {
    const { verifier, challenge } = pkcePair();
    const handoff = mintCode({ redirect: REDIRECT, codeChallenge: challenge, codeChallengeMethod: "S256" });
    // The attacker has the code — it came through the loopback port.
    const stolen = redeemBoundHandoffCode(handoff.code, null);
    expect(stolen).toEqual({ ok: false, reason: "verifier" });
    // Burned, so the real client cannot keep trying against a guess either.
    expect(redeemBoundHandoffCode(handoff.code, verifier)).toEqual({ ok: false, reason: "unknown" });
    expect(exchangeState.codes()).toBe(0);
  });

  it("refuses the wrong verifier and burns the code", () => {
    const { challenge } = pkcePair();
    const handoff = mintCode({ redirect: REDIRECT, codeChallenge: challenge, codeChallengeMethod: "S256" });
    const wrong = randomBytes(32).toString("base64url");
    expect(redeemBoundHandoffCode(handoff.code, wrong)).toEqual({ ok: false, reason: "verifier" });
    expect(exchangeState.codes()).toBe(0);
  });

  it("lets the holder of the verifier through exactly once", () => {
    const { verifier, challenge } = pkcePair();
    const handoff = mintCode({ redirect: REDIRECT, codeChallenge: challenge, codeChallengeMethod: "S256" });
    const first = redeemBoundHandoffCode(handoff.code, verifier);
    expect(first).toMatchObject({ ok: true, identity: IDENTITY, version: EXCHANGE_VERSION });
    // Replay of the same code, even with the right verifier, is refused.
    expect(redeemBoundHandoffCode(handoff.code, verifier)).toEqual({ ok: false, reason: "unknown" });
  });
});

describe("the client can tell its own callback from a stale one", () => {
  it("echoes the state back so the client can compare it", () => {
    const state = "client-held-state-value-1234";
    const handoff = mintCode({ redirect: REDIRECT, state });
    expect(handoff.state).toBe(state);
    expect(handoff.version).toBe(EXCHANGE_VERSION);
  });

  it("omits state entirely for a client that sent none", () => {
    const handoff = mintCode({ redirect: REDIRECT });
    expect(handoff.state).toBeUndefined();
    // A malformed state is treated as no state, not as a broken grant: the
    // client degrades to the flow it already had.
    const typo = mintCode({ redirect: REDIRECT, state: "too-short" });
    expect(typo.state).toBeUndefined();
  });

  it("never puts a verifier anywhere in the handoff", () => {
    const { verifier, challenge } = pkcePair();
    const handoff = mintCode({ redirect: REDIRECT, codeChallenge: challenge, codeChallengeMethod: "S256" });
    // The challenge may travel; the verifier must not, or intercepting the
    // fragment would be enough.
    expect(JSON.stringify(handoff)).not.toContain(verifier);
  });
});

describe("a client that participates in none of this is unaffected", () => {
  it("redeems an unbound code through the original 1.20 signature", () => {
    const grant = issueDesktopGrant(REDIRECT);
    const handoff = issueHandoffCode(grant, IDENTITY);
    expect(handoff?.state).toBeUndefined();
    // `redeemHandoffCode(code, now)` — the old positional `now` is intact, which
    // is the whole reason the bound variant is a separate function.
    expect(redeemHandoffCode(handoff!.code)).toEqual(IDENTITY);
    expect(redeemHandoffCode(handoff!.code)).toBeNull();
  });

  it("binds nothing when a challenge is present but unusable", () => {
    const handoff = mintCode({ redirect: REDIRECT, codeChallenge: "nope", codeChallengeMethod: "S256" });
    // Redeemable without a verifier, because nothing was ever bound.
    expect(redeemBoundHandoffCode(handoff.code)).toMatchObject({ ok: true, identity: IDENTITY });
  });
});

describe("walking away leaves nothing redeemable", () => {
  it("withdraws a cancelled grant so it can never mint a code", () => {
    const grant = issueBoundDesktopGrant({ redirect: REDIRECT, state: "cancelled-flow-state-1" });
    expect(cancelDesktopGrant(grant)).toBe(true);
    expect(issueHandoffCode(grant, IDENTITY)).toBeNull();
    expect(exchangeState.grants()).toBe(0);
  });

  it("reports honestly when there was no grant to cancel", () => {
    expect(cancelDesktopGrant("never-issued")).toBe(false);
  });

  it("does not disturb another flow's grant", () => {
    const keep = issueBoundDesktopGrant({ redirect: REDIRECT });
    const drop = issueBoundDesktopGrant({ redirect: REDIRECT });
    expect(cancelDesktopGrant(drop)).toBe(true);
    expect(cancelDesktopGrant(keep)).toBe(true);
    expect(exchangeState.grants()).toBe(0);
  });
});

describe("two accounts, two flows, no bleed", () => {
  it("keeps each flow's binding and identity to itself", () => {
    const first = pkcePair();
    const second = pkcePair();
    const a = mintCode({
      redirect: REDIRECT,
      state: "account-a-state-value",
      codeChallenge: first.challenge,
      codeChallengeMethod: "S256",
    });
    const b = mintCode({
      redirect: REDIRECT,
      state: "account-b-state-value",
      codeChallenge: second.challenge,
      codeChallengeMethod: "S256",
    });
    expect(a.state).not.toBe(b.state);

    // Each code answers to its own verifier and no other.
    expect(redeemBoundHandoffCode(a.code, second.verifier)).toEqual({ ok: false, reason: "verifier" });
    // B is untouched by A's failed attempt — its own verifier still works.
    const redeemed = redeemBoundHandoffCode(b.code, second.verifier);
    expect(redeemed).toMatchObject({ ok: true, identity: IDENTITY });
    // Both codes are now gone: A burned on the wrong verifier (the documented
    // cost), B burned on success. Nothing is left to replay.
    expect(exchangeState.codes()).toBe(0);
    expect(redeemBoundHandoffCode(a.code, first.verifier)).toEqual({ ok: false, reason: "unknown" });
  });
});

describe("a restart drops the exchange, and that is the safe direction", () => {
  it("cannot redeem a code minted before the process restarted", () => {
    const { verifier, challenge } = pkcePair();
    const handoff = mintCode({ redirect: REDIRECT, codeChallenge: challenge, codeChallengeMethod: "S256" });
    // In-memory only, by design: a leaked log or a heap dump can never carry a
    // live code across a restart.
    exchangeState.reset();
    expect(redeemBoundHandoffCode(handoff.code, verifier)).toEqual({ ok: false, reason: "unknown" });
  });
});
