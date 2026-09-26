// Desktop OAuth handoff — how the packaged app gets a REAL Google sign-in.
//
// Why. The desktop has no Google client secret (it ships to everyone's
// machines), and pairing codes made users do data entry to log in. Real
// desktop products (gh CLI, Cursor, Linear) solve this the same way: the
// CLOUD owns the OAuth handshake; the desktop receives the finished
// identity over a loopback redirect with a one-time code.
//
// Flow:
//   desktop browser-window -> cloud /desktop-auth/start?redirect=&nonce
//                           -> 302 into Google (better-auth, callbackURL=/desktop-auth/done?grant=..)
//   Google -----------------> cloud /api/auth/callback/google
//                           -> 302 /desktop-auth/done?grant=..
//   cloud (user now signed in on cloud session) -> 302 ${redirect}#code=<one-time>
//   desktop server GET /oauth/finish?code -> POST /api/desktop-auth/exchange
//                          <- { email, name }  -> bridged local session
//
// Codes are 128-bit random, single-use, 90-second TTL, held in memory only
// — a leaked log line can never mint a session.
//
// ## Client binding (added after the 1.20 handoff audit)
//
// The one-time code above is a BEARER: whoever holds it can redeem it. It
// travels to the desktop in a URL fragment over a loopback socket, and a loopback
// port is a channel any other local process can race, sniff, or simply receive
// first. So a code that reaches the wrong program was a finished account
// takeover, with no secret anywhere in the flow to stop it.
//
// Three things close that, all optional per client so an older desktop paired
// against a newer cloud (or the reverse) keeps working unchanged:
//
//   state          — client-generated, echoed back on the fragment. The client
//                    compares it with what it sent before exchanging.
//   code_challenge — PKCE (RFC 7636). The client keeps the verifier; a stolen
//                    code is useless without it.
//   v              — the exchange version, so a future shape is refused
//                    cleanly instead of being misread.
//
// `cancelDesktopGrant` exists because a flow the user walked away from should
// not leave a live grant sitting in memory for its full TTL.
//
// NOT closed here, and worth being explicit: a `state` mismatch stops a stale
// or replayed callback, not a user who is walked through a real sign-in. A
// victim whose browser completes someone else's flow still yields that
// browser's identity to the redirect the initiator chose. Only showing the
// person what they are signing into stops that, and that is a product decision
// beyond this module.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

interface PendingGrant {
  /** loopback redirect the desktop asked us to return to */
  redirect: string;
  /** optional path to return to after the browser window finishes OAuth */
  returnTo?: string;
  expiresAt: number;
  /** client-generated value echoed back so the client can detect a stale or
   * replayed callback. Absent for a client that predates it. */
  state?: string;
  /** PKCE challenge the code is bound to. Absent means "no binding". */
  codeChallenge?: string;
  codeChallengeMethod?: PkceMethod;
  /** exchange protocol version this grant was minted under */
  version: number;
}

const GRANT_TTL_MS = 10 * 60_000;
const CODE_TTL_MS = 90_000;

/** The exchange shape this build speaks. Bumped only with a migration. */
export const EXCHANGE_VERSION = 1;

/** PKCE methods, RFC 7636 §4.2. `plain` exists for clients that cannot hash;
 * it is only as strong as the verifier, which is why S256 is the default ask. */
export type PkceMethod = "S256" | "plain";

/** The client-supplied half of the binding, all fields optional. The method is
 * a plain `string` because it arrives from a query parameter; it is narrowed by
 * `normalizeChallenge` before anything is stored. */
export interface GrantBinding {
  state?: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
}

/** Bounds for client-supplied values. A `state` too short to be unguessable is
 * worse than none, and these arrive in a URL, so they are capped as well as
 * floored: an over-long state is a way to push megabytes into the map. */
export const STATE_MIN = 16;
export const STATE_MAX = 256;
export const CHALLENGE_MIN = 43; // base64url(sha256("")) — 32 bytes, unpadded
export const CHALLENGE_MAX = 128;
export const VERIFIER_MIN = 43;
export const VERIFIER_MAX = 128;

const BASE64URL = /^[A-Za-z0-9\-._~]+$/;

/** Trim, treating absent as absent. These values arrive from query parameters
 * and JSON bodies, and the routes settle "is this text?" with `isText` at the
 * boundary before calling in — so from here on the domain is a string and only
 * its content is in question. */
function trimmed(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  return value.trim();
}

/** A usable `state`, or undefined. Anything malformed is treated as absent
 * rather than as an error, so a broken client degrades to the unbound flow it
 * already had instead of failing closed on a typo. */
export function normalizeState(raw: string | null | undefined): string | undefined {
  const value = trimmed(raw);
  if (value === undefined) return undefined;
  if (value.length < STATE_MIN || value.length > STATE_MAX) return undefined;
  if (!BASE64URL.test(value)) return undefined;
  return value;
}

/** A usable PKCE challenge + method pair, or undefined. A challenge without a
 * recognised method is not a challenge: guessing the method would silently
 * downgrade the binding. */
export function normalizeChallenge(
  raw: string | null | undefined,
  method: string | null | undefined,
): { codeChallenge: string; codeChallengeMethod: PkceMethod } | undefined {
  const value = trimmed(raw);
  const verb = trimmed(method);
  if (value === undefined || verb === undefined) return undefined;
  if (value.length < CHALLENGE_MIN || value.length > CHALLENGE_MAX) return undefined;
  if (!BASE64URL.test(value)) return undefined;
  if (verb !== "S256" && verb !== "plain") return undefined;
  return { codeChallenge: value, codeChallengeMethod: verb };
}

/** RFC 7636 §4.6: S256 is BASE64URL(SHA256(ASCII(verifier))), unpadded. */
export function verifyPkceChallenge(
  challenge: string,
  method: PkceMethod,
  verifier: string | null | undefined,
): boolean {
  const value = trimmed(verifier);
  if (value === undefined) return false;
  if (value.length < VERIFIER_MIN || value.length > VERIFIER_MAX) return false;
  if (!BASE64URL.test(value)) return false;
  if (method === "plain") return secretsMatch(value, challenge);
  const digest = createHash("sha256").update(value, "ascii").digest("base64url");
  return secretsMatch(digest, challenge);
}

/** Better Auth returns delay-seconds in X-Retry-After. Only whole seconds
 * reach our response header and page; malformed values use its social window. */
export function desktopSignInRetrySeconds(value: string | null): number {
  if (value === null || !/^\d{1,6}$/.test(value.trim())) return 10;
  const seconds = Number(value.trim());
  return seconds <= 3600 ? Math.max(1, seconds) : 10;
}

const grants = new Map<string, PendingGrant>();

/** One minted code, carrying the identity plus whatever the client bound it
 * to. A code with no `codeChallenge` is a bare bearer, exactly as in 1.20. */
interface CodeEntry {
  userId: string;
  email: string;
  name: string;
  expiresAt: number;
  state?: string;
  codeChallenge?: string;
  codeChallengeMethod?: PkceMethod;
  version: number;
}

const codes = new Map<string, CodeEntry>();

function sanitizeReturnTo(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = new URL(trimmed, "https://muster.invalid");
    if (parsed.origin !== "https://muster.invalid") return undefined;
    if (!parsed.pathname || parsed.pathname.startsWith("//")) return undefined;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return undefined;
  }
}

function sweep(now = Date.now()): void {
  for (const [k, g] of grants) if (g.expiresAt <= now) grants.delete(k);
  for (const [k, c] of codes) if (c.expiresAt <= now) codes.delete(k);
}

function grantCount(): number {
  return grants.size;
}

function codeCount(): number {
  return codes.size;
}

export function isLoopbackRedirect(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:") return false;
    // WHATWG URL.hostname keeps brackets on IPv6 hosts ("[::1]"), so both
    // spellings are needed.
    const h = u.hostname;
    return h === "127.0.0.1" || h === "localhost" || h === "[::1]" || h === "::1";
  } catch {
    return false;
  }
}

/** The iOS companion's OAuth finish target. A phone cannot host a loopback
 * listener, so it registers the `muster` URL scheme and finishes the
 * handoff in its own process: the cloud bounces to this exact URL with the
 * one-time code in the fragment, the app catches it in onOpenURL and
 * exchanges the code against the cloud's /api/desktop-auth/exchange
 * directly. Fixed allowlist — never an arbitrary scheme, which would let
 * any web page fish the code into an app of its choosing. */
export const COMPANION_OAUTH_REDIRECT = "muster://oauth/finish";

export function isCompanionRedirect(url: string): boolean {
  return url === COMPANION_OAUTH_REDIRECT;
}

/** Any redirect a handoff grant may carry. */
export function isHandoffRedirect(url: string): boolean {
  return isLoopbackRedirect(url) || isCompanionRedirect(url);
}

/** Where /desktop-auth/done sends the browser at the end of the handshake.
 * Loopback targets get the finish page appended (the desktop serves it);
 * the companion's scheme URL is already the finish endpoint. */
export function handoffFinishURL(redirect: string): string {
  return isLoopbackRedirect(redirect) ? `${redirect.replace(/\/$/, "")}/oauth/finish` : redirect;
}

/** Step 1: a desktop asks for a handshake. Returns the grant id that must
 * ride through the Google callback round-trip. */
export function issueDesktopGrant(redirect: string, now = Date.now()): string {
  return issueDesktopGrantWithReturn(redirect, undefined, now);
}

export function issueDesktopGrantWithReturn(
  redirect: string,
  returnTo: string | undefined,
  now = Date.now(),
): string {
  return issueBoundDesktopGrant({ redirect, returnTo }, now);
}

/** Step 1 with the client's binding. `binding` is normalized rather than
 * trusted, so a caller cannot store a challenge that can never be satisfied
 * or a state too short to mean anything. */
export function issueBoundDesktopGrant(
  input: { redirect: string; returnTo?: string } & GrantBinding,
  now = Date.now(),
): string {
  sweep(now);
  const id = randomBytes(16).toString("base64url");
  const grant: PendingGrant = {
    redirect: input.redirect,
    returnTo: sanitizeReturnTo(input.returnTo ?? ""),
    expiresAt: now + GRANT_TTL_MS,
    version: EXCHANGE_VERSION,
  };
  const state = normalizeState(input.state);
  if (state) grant.state = state;
  const challenge = normalizeChallenge(input.codeChallenge, input.codeChallengeMethod);
  if (challenge) {
    grant.codeChallenge = challenge.codeChallenge;
    grant.codeChallengeMethod = challenge.codeChallengeMethod;
  }
  grants.set(id, grant);
  return id;
}

/** Withdraw a grant the user abandoned. The desktop calls this when its own
 * window is dismissed, so a walk-away does not leave a redeemable grant
 * alive for the rest of its TTL. Returns whether there was one to withdraw. */
export function cancelDesktopGrant(grantId: string, now = Date.now()): boolean {
  sweep(now);
  return grants.delete(grantId);
}

/** What the cloud hands back to the client: where to send the browser, the
 * one-time code, and — when the client asked for them — the state it must
 * check and the protocol version it is speaking. */
export interface HandoffCode {
  redirect: string;
  code: string;
  returnTo?: string;
  state?: string;
  version: number;
}

/** Step 2 (cloud, authenticated browser): trade a spent grant for a one-time
 * code carrying THIS browser session's identity. Single-use both ways. */
export function issueHandoffCode(
  grantId: string,
  identity: { userId: string; email: string; name: string },
  now = Date.now(),
): HandoffCode | null {
  sweep(now);
  const grant = grants.get(grantId);
  if (!grant || grant.expiresAt <= now) {
    grants.delete(grantId);
    return null;
  }
  grants.delete(grantId); // grant burns even if the code is never redeemed
  const code = randomBytes(32).toString("base64url");
  const entry: CodeEntry = { ...identity, expiresAt: now + CODE_TTL_MS, version: grant.version };
  if (grant.state) entry.state = grant.state;
  if (grant.codeChallenge && grant.codeChallengeMethod) {
    entry.codeChallenge = grant.codeChallenge;
    entry.codeChallengeMethod = grant.codeChallengeMethod;
  }
  codes.set(code, entry);
  const handoff: HandoffCode = { redirect: grant.redirect, code, version: grant.version };
  if (grant.returnTo) handoff.returnTo = grant.returnTo;
  if (grant.state) handoff.state = grant.state;
  return handoff;
}

/** Why a redemption was refused, so the route can answer truthfully instead of
 * collapsing every failure into "expired or already used". `expired` covers a
 * code that is gone or past its TTL; `version` means the client speaks a
 * protocol this build does not; `verifier` means the code was presented
 * without the PKCE verifier it is bound to, or with the wrong one. */
export type RedeemFailure = "unknown" | "expired" | "version" | "verifier";

export type RedeemResult =
  | { ok: true; identity: { userId: string; email: string; name: string }; version: number }
  | { ok: false; reason: RedeemFailure };

/** Step 3 (desktop server, server-to-server): burn the code for identity.
 *
 * Signature unchanged from the 1.20 flow — `now` is still the second argument —
 * because a cloud and a desktop ship independently and an older caller must
 * keep working. A code with no PKCE binding redeems exactly as it always did.
 * Use `redeemBoundHandoffCode` where the caller can present a verifier. */
export function redeemHandoffCode(
  code: string,
  now = Date.now(),
): { userId: string; email: string; name: string } | null {
  const result = redeemBoundHandoffCode(code, undefined, now);
  return result.ok ? result.identity : null;
}

/** Step 3 for a client participating in the bound exchange.
 *
 * A code minted against a PKCE challenge is destroyed by a failed verifier
 * too. The alternative — leaving it live — lets anyone holding a stolen code
 * keep guessing, and the honest cost is that a client which fat-fingers its own
 * verifier restarts the sign-in, exactly as an expired code already does. */
export function redeemBoundHandoffCode(
  code: string,
  verifier?: string | null,
  now = Date.now(),
): RedeemResult {
  sweep(now);
  const entry = codes.get(code);
  if (!entry) return { ok: false, reason: "unknown" };
  if (entry.expiresAt <= now) {
    codes.delete(code);
    return { ok: false, reason: "expired" };
  }
  // Refuse a protocol this build does not speak, rather than redeeming a code
  // minted under rules we are no longer enforcing.
  if (entry.version !== EXCHANGE_VERSION) {
    codes.delete(code);
    return { ok: false, reason: "version" };
  }
  if (entry.codeChallenge && !verifyPkceChallenge(entry.codeChallenge, entry.codeChallengeMethod!, verifier)) {
    codes.delete(code);
    return { ok: false, reason: "verifier" };
  }
  codes.delete(code);
  return { ok: true, identity: { userId: entry.userId, email: entry.email, name: entry.name }, version: entry.version };
}

/** Constant-time token compare shared by any endpoint accepting secrets. */
export function secretsMatch(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Test seam: the in-memory exchange state, so a suite can assert that a flow
 * left nothing behind rather than inferring it from behaviour. */
export const exchangeState = {
  grants: grantCount,
  codes: codeCount,
  reset() {
    grants.clear();
    codes.clear();
  },
};
