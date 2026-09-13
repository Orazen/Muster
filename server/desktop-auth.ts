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

import { randomBytes, timingSafeEqual } from "node:crypto";

interface PendingGrant {
  /** loopback redirect the desktop asked us to return to */
  redirect: string;
  /** optional path to return to after the browser window finishes OAuth */
  returnTo?: string;
  expiresAt: number;
}

const GRANT_TTL_MS = 10 * 60_000;
const CODE_TTL_MS = 90_000;

/** Better Auth returns delay-seconds in X-Retry-After. Only whole seconds
 * reach our response header and page; malformed values use its social window. */
export function desktopSignInRetrySeconds(value: string | null): number {
  if (value === null || !/^\d{1,6}$/.test(value.trim())) return 10;
  const seconds = Number(value.trim());
  return seconds <= 3600 ? Math.max(1, seconds) : 10;
}

const grants = new Map<string, PendingGrant>();
const codes = new Map<string, { userId: string; email: string; name: string; expiresAt: number }>();

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
  sweep(now);
  const id = randomBytes(16).toString("base64url");
  grants.set(id, { redirect, returnTo: sanitizeReturnTo(returnTo ?? ""), expiresAt: now + GRANT_TTL_MS });
  return id;
}

/** Step 2 (cloud, authenticated browser): trade a spent grant for a one-time
 * code carrying THIS browser session's identity. Single-use both ways. */
export function issueHandoffCode(
  grantId: string,
  identity: { userId: string; email: string; name: string },
  now = Date.now(),
): { redirect: string; code: string; returnTo?: string } | null {
  sweep(now);
  const grant = grants.get(grantId);
  if (!grant || grant.expiresAt <= now) {
    grants.delete(grantId);
    return null;
  }
  grants.delete(grantId); // grant burns even if the code is never redeemed
  const code = randomBytes(32).toString("base64url");
  codes.set(code, { ...identity, expiresAt: now + CODE_TTL_MS });
  return { redirect: grant.redirect, code, returnTo: grant.returnTo };
}

/** Step 3 (desktop server, server-to-server): burn the code for identity. */
export function redeemHandoffCode(
  code: string,
  now = Date.now(),
): { userId: string; email: string; name: string } | null {
  sweep(now);
  const entry = codes.get(code);
  if (!entry || entry.expiresAt <= now) {
    codes.delete(code);
    return null;
  }
  codes.delete(code);
  return { userId: entry.userId, email: entry.email, name: entry.name };
}

/** Constant-time token compare shared by any endpoint accepting secrets. */
export function secretsMatch(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
