// Per-attempt custody for the desktop's side of the cloud sign-in handoff.
//
// The cloud already binds every grant a client asks it to bind (state echo +
// PKCE challenge, server/desktop-auth.ts) — but until now the desktop never
// asked. Its finish exchange forwarded a bare `{code}`, so the one-time code
// stayed the bearer it was before the binding existed: a stolen fragment was
// a finished sign-in, and a flow the user walked away from stayed redeemable
// for its whole TTL on the cloud.
//
// This module gives the LOCAL server custody of one attempt at a time:
//
//   begin   — mint state + S256 verifier, keep the verifier here (it never
//             reaches the renderer, the browser, or any log), remember the
//             loopback redirect the attempt is bound to
//   cancel  — the user gave up: a late cloud redirect must not install a
//             session, even though its code is still technically valid
//   redeem  — the finish exchange proves the attempt (state + redirect)
//             BEFORE the cloud code is spent, and only then hands over the
//             verifier the cloud exchange requires
//
// A NEW begin supersedes the previous attempt: two overlapping handoffs
// cannot both complete, and a finished-but-unclaimed window cannot swap
// identities with the one the user is actually looking at.
//
// Residual risk, stated honestly (same style as desktop-auth.ts): a foreign
// local process that wins the loopback POST race for the finish exchange AND
// reads the redirect fragment still carries both halves. This shrinks the
// stolen-code surface from "fragment alone" to "fragment + a live local
// attempt + winning a loopback race", makes cancellation authoritative, and
// keeps everything single-use. Closing the rest needs an OS-guarded channel
// to the finish page, which no browser offers.

import { createHash, randomBytes } from "node:crypto";

import { isLoopbackRedirect, secretsMatch } from "./desktop-auth.ts";

/** Matches the cloud grant TTL: an attempt never outlives the handshake it
 * belongs to. */
const ATTEMPT_TTL_MS = 10 * 60_000;

/** A walk-away should not leave rows behind forever even without a cancel;
 * this caps worst-case memory under a begin loop. */
const ATTEMPT_CAP = 64;

interface SignInAttempt {
  state: string;
  verifier: string;
  redirect: string;
  expiresAt: number;
}

const attempts = new Map<string, SignInAttempt>();

function sweep(now = Date.now()): void {
  for (const [key, attempt] of attempts) if (attempt.expiresAt <= now) attempts.delete(key);
}

/** What the finish exchange must prove about the attempt it is redeeming.
 * `unknown` covers cancelled, superseded and never-minted alike — those must
 * be indistinguishable to a late redirect. `redirect` means the exchange did
 * not run on the loopback origin the attempt was started from. `verifier`
 * covers a missing or wrong state: the fragment did not come from this
 * attempt's handshake. */
export type AttemptRedeemFailure = "unknown" | "expired" | "redirect" | "verifier";

export type AttemptRedeem =
  | { ok: true; verifier: string }
  | { ok: false; reason: AttemptRedeemFailure };

function fail(key: string, reason: AttemptRedeemFailure): AttemptRedeem {
  attempts.delete(key);
  return { ok: false, reason };
}

/** Start a desktop sign-in attempt: mint state + verifier, bind them to the
 * loopback redirect, and supersede every earlier attempt. Returns the values
 * the client needs for the cloud start URL — never the verifier itself. */
export interface AttemptBinding {
  state: string;
  codeChallenge: string;
}

export function beginDesktopSignInAttempt(
  redirect: string,
  now = Date.now(),
): AttemptBinding {
  sweep(now);
  // One live attempt per install: the newest begin wins.
  attempts.clear();
  while (attempts.size >= ATTEMPT_CAP) {
    const oldest = attempts.keys().next().value;
    if (oldest === undefined) break;
    attempts.delete(oldest);
  }
  const state = randomBytes(24).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const key = randomBytes(18).toString("base64url");
  attempts.set(key, { state, verifier, redirect, expiresAt: now + ATTEMPT_TTL_MS });
  const codeChallenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
  return { state, codeChallenge };
}

/** The user (or the app) gave up on this attempt. A cloud redirect that
 * arrives later finds no attempt and installs nothing. */
export function cancelDesktopSignInAttempt(state: string, now = Date.now()): boolean {
  sweep(now);
  for (const [key, attempt] of attempts) {
    if (attempt.state === state) {
      attempts.delete(key);
      return true;
    }
  }
  return false;
}

/** The finish exchange proves the attempt before anything is spent. The
 * verifier it returns is what the cloud's `/api/desktop-auth/exchange`
 * requires for a bound code; it must not be logged or echoed to the page. */
export function redeemDesktopSignInAttempt(
  input: { state?: string; redirect?: string },
  now = Date.now(),
): AttemptRedeem {
  sweep(now);
  if (attempts.size === 0) return { ok: false, reason: "unknown" };
  if (!input.state) return { ok: false, reason: "verifier" };
  let key: string | undefined;
  let attempt: SignInAttempt | undefined;
  for (const [candidateKey, candidate] of attempts) {
    if (candidate.state === input.state) {
      key = candidateKey;
      attempt = candidate;
      break;
    }
  }
  if (!key || !attempt) return { ok: false, reason: "unknown" };
  if (attempt.expiresAt <= now) return fail(key, "expired");
  if (!input.redirect || !secretsMatch(attempt.redirect, input.redirect)) {
    return fail(key, "redirect");
  }
  // Single-use: a proven attempt is spent, so a replayed finish cannot pass
  // the proof twice even when its cloud code was never redeemed.
  attempts.delete(key);
  return { ok: true, verifier: attempt.verifier };
}

/** The redirect an attempt may be redeemed from must be the loopback origin
 * the local server itself serves; anything else is rejected at begin. */
export function isAttemptRedirect(url: string): boolean {
  return isLoopbackRedirect(url);
}

/** Test seam: the in-memory attempt rows, so a suite can assert that a flow
 * left nothing behind rather than inferring it from behaviour. */
export const attemptsState = {
  count(): number {
    return attempts.size;
  },
  reset(): void {
    attempts.clear();
  },
};
