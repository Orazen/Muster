// Email + 6-digit one-time-code sign-in — the Muster policy wrapper around
// better-auth's emailOTP plugin routes (plugin config lives in server/auth.ts).
//
// The plugin owns what a plugin should own: code generation, hashing, expiry,
// the attempt budget, and minting the session — the SAME session shape every
// other sign-in path produces. This module owns what only Muster policy can:
//
//   1. Sign-up gates. A verify on an unknown email CREATES the account, so
//      the exact gates standing in front of /api/auth/sign-up/email
//      (server/index.ts) must also stand in front of send + verify here, or
//      a closed deployment would leak new sign-ups through this door.
//   2. Resend cooldown. One code per mailbox per 60s, independent of Better
//      Auth's per-IP window (an office NAT shares one IP; a mailbox does not
//      share with its neighbors).
//   3. The unverified-user promotion — the load-bearing one. The plugin's
//      sign-in route calls revokeUnprovenAccountAccess() for any
//      pre-existing emailVerified: false user: it DELETES every account link
//      (password included) and every standing session, then flips
//      emailVerified. On a deployment with no mailer, every password account
//      is emailVerified: false — so a bare OTP sign-in would silently remove
//      the user's password. An existing login method must keep working
//      unchanged, so for those users we validate the code FIRST through the
//      plugin's non-consuming check route, flip emailVerified ourselves on
//      success, and only then delegate: the plugin then sees a verified user
//      and skips the revocation entirely.
//
// Everything else flows through untouched: unknown emails hit the plugin's
// own sign-up-on-verify (gated above), already-verified users skip the check.

import type { IncomingMessage, ServerResponse } from "node:http";
import { auth, forwardedProtoOf, getDb } from "./auth.ts";
import { isText, json, readBody } from "./http-helpers.ts";

export const OTP_SEND_PATH = "/api/auth/email-otp/send-verification-otp";
export const OTP_SIGN_IN_PATH = "/api/auth/sign-in/email-otp";
const OTP_CHECK_PATH = "/api/auth/email-otp/check-verification-otp";

/** The two plugin routes this wrapper intercepts. Every other auth path —
 * including the plugin's own check route when hit directly — falls through
 * to the normal Better Auth delegation in server/index.ts untouched. */
export function isEmailOtpAuthPath(path: string): boolean {
  return path === OTP_SEND_PATH || path === OTP_SIGN_IN_PATH;
}

/** The sign-up gate decision for an OTP request whose email has no account
 * yet: a mirror of the two gates in front of /api/auth/sign-up/email in
 * server/index.ts — same precedence (Google-only first), same env names,
 * same error codes. Existing accounts always pass; those gates close the
 * door on NEW accounts only, exactly like the originals. */
function otpSignUpBlockReason(email: string): { message: string; code: string } | null {
  if (process.env.OMB_GOOGLE_ONLY_SIGNUP === "true") {
    return {
      message: "Sign up with Google — manual sign-up is turned off on this deployment.",
      code: "GOOGLE_ONLY_SIGNUP",
    };
  }
  if (process.env.OMB_SIGNUPS_CLOSED === "true" && process.env.OMB_DESKTOP_APP !== "true") {
    const allowlist = (process.env.OMB_SIGNUP_ALLOWLIST ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean);
    if (!allowlist.includes(email)) {
      return { message: "Sign-ups are closed on this deployment.", code: "SIGNUPS_CLOSED" };
    }
  }
  return null;
}

/** Per-mailbox resend cooldown. Deliberately per-email, not per-IP: Better
 * Auth's rate limiter already bounds the IP, and one colleague's retry must
 * not lock out the whole office NAT — while one mailbox must not be
 * hammerable from rotating IPs either. Arm only after the plugin actually
 * accepted a send (a gated or rate-limited attempt arms nothing). */
const RESEND_COOLDOWN_MS = 60_000;
const lastCodeSentAt = new Map<string, number>();

function pruneCooldowns(now: number): void {
  for (const [email, at] of lastCodeSentAt) {
    if (now - at > RESEND_COOLDOWN_MS) lastCodeSentAt.delete(email);
  }
}

function cooldownRemainingMs(email: string, now: number): number {
  const at = lastCodeSentAt.get(email);
  if (at === undefined) return 0;
  const remaining = RESEND_COOLDOWN_MS - (now - at);
  return remaining > 0 ? remaining : 0;
}

interface OtpUserRow {
  id: string;
  emailVerified: number | bigint | boolean;
}

/** Local lookup carrying the one column the promotion needs —
 * findUserByEmail() in auth.ts deliberately projects less. */
function findUserForOtp(email: string): OtpUserRow | null {
  try {
    // SAFETY: the SELECT projects exactly the id/emailVerified columns read here
    const row = getDb()
      .prepare('SELECT "id", "emailVerified" FROM "user" WHERE lower("email") = lower(?) LIMIT 1')
      .get(email) as OtpUserRow | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

/** Flip emailVerified for a user whose code just proved mailbox control.
 * "emailVerified" is `integer not null` and timestamps are ISO strings —
 * the exact representations server/auth.ts's migrate() and createBridgedUser
 * write. Idempotent (the guard makes a concurrent promotion a no-op), and a
 * failure is reported rather than thrown: the caller has already validated
 * the code, so it can still delegate safely. */
function markUserVerified(id: string): boolean {
  try {
    const result = getDb()
      .prepare('UPDATE "user" SET "emailVerified" = 1, "updatedAt" = ? WHERE "id" = ? AND "emailVerified" = 0')
      .run(new Date().toISOString(), id);
    return Number(result.changes) > 0;
  } catch {
    return false;
  }
}

interface DelegatedResponse {
  status: number;
  headers: Headers;
  setCookies: string[];
  body: string;
}

/** The request bodies the two intercepted plugin routes accept. readBody's
 * output is assigned here rather than trusted as `any`: these are the only
 * fields this wrapper reads or defaults, and JSON.stringify passes whatever
 * else the caller sent straight through to the plugin at runtime. */
interface EmailOtpRequestBody {
  email?: string;
  otp?: string;
  type?: string;
  name?: string;
  image?: string;
}

/** Replay a parsed body to Better Auth at `targetPath` through the same
 * auth.handler the normal delegation uses — same pattern as the sign-up
 * gate and the cloud bridge in server/index.ts (the original request stream
 * was consumed by readBody, so the body is re-serialized and the original
 * headers — origin, cookie, forwarded IP/proto — are carried over). */
async function delegateToAuth(
  req: IncomingMessage,
  targetPath: string,
  body: EmailOtpRequestBody,
): Promise<DelegatedResponse> {
  const host = req.headers.host ?? "localhost";
  const proto = forwardedProtoOf(req);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  headers.set("content-type", "application/json");
  // Same "Missing or null Origin" trap the cloud-bridge delegation notes:
  // Better Auth's CSRF check requires an Origin and treats absent as
  // untrusted rather than same-origin. A browser always sends one on POST;
  // this backstops non-browser callers (tests, CLI) with the request's own
  // origin, which is exactly what the trustedOrigins self-host rule trusts.
  if (!headers.has("origin")) headers.set("origin", `${proto}://${host}`);
  const authRes = await auth.handler(
    new Request(`${proto}://${host}${targetPath}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body ?? {}),
    }),
  );
  // Headers.forEach folds multiple Set-Cookie values if you read them via
  // get(); getSetCookie() keeps them apart, and cookies must never be
  // comma-joined (a comma can legally appear inside Expires). Optional
  // call for runtimes whose Headers predates getSetCookie.
  const setCookies = authRes.headers.getSetCookie?.() ?? [];
  const text = await authRes.text();
  return { status: authRes.status, headers: authRes.headers, setCookies, body: text };
}

/** Write a delegated response back verbatim — status, headers, body — with
 * the set-cookie headers restored individually. */
function relay(res: ServerResponse, delegated: DelegatedResponse): void {
  const headers: Record<string, string | string[]> = {};
  delegated.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") return;
    headers[key] = value;
  });
  if (delegated.setCookies.length > 0) headers["set-cookie"] = delegated.setCookies;
  res.writeHead(delegated.status, headers);
  res.end(delegated.body);
}

/** Entry point for POST /api/auth/email-otp/send-verification-otp and
 * POST /api/auth/sign-in/email-otp (server/index.ts routes both here before
 * its generic Better Auth delegation). */
export async function handleEmailOtpAuthRequest(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
): Promise<void> {
  // 1. Body — the stream can only be read once; delegation re-serializes it.
  let body: EmailOtpRequestBody;
  try {
    body = await readBody(req);
  } catch (error) {
    // SAFETY: readBody rejections carry an HTTP status via Object.assign at
    // its size-limit/parse rejection sites.
    const status = (error as { status?: number }).status ?? 400;
    return json(res, status, {
      message: error instanceof Error ? error.message : String(error),
      code: "INVALID_REQUEST",
    });
  }

  const email = isText(body?.email) ? String(body.email).trim().toLowerCase() : "";
  if (!email) {
    return json(res, 400, { message: "email is required", code: "INVALID_EMAIL" });
  }

  const user = findUserForOtp(email);

  // 2. Sign-up gates — only addresses with no account yet (existing
  //    accounts keep signing in exactly as before, gate or no gate).
  if (!user) {
    const blocked = otpSignUpBlockReason(email);
    if (blocked) return json(res, 403, blocked);
  }

  const isSend = path === OTP_SEND_PATH;

  // 3. Per-mailbox resend cooldown (send only; wrapper-level, so a cooldown
  //    rejection never spends the per-IP rate-limit budget either).
  if (isSend) {
    // The plugin's send schema requires `type`; default it so a bare
    // { email } request behaves as sign-in instead of failing validation.
    if (body.type === undefined) body.type = "sign-in";
    const now = Date.now();
    pruneCooldowns(now);
    const remaining = cooldownRemainingMs(email, now);
    if (remaining > 0) {
      const seconds = Math.ceil(remaining / 1000);
      return json(res, 429, {
        message: `A code was already sent to this address. Try again in ${seconds} seconds.`,
        code: "RESEND_COOLDOWN",
      });
    }
  }

  // 4. Pre-existing, not-yet-verified user: validate the code FIRST through
  //    the plugin's non-consuming check route (wrong/expired/exhausted
  //    answers relay unchanged, attempts counted as usual), promote the
  //    user on success, and only then let sign-in run — at which point the
  //    plugin skips revokeUnprovenAccountAccess entirely.
  if (!isSend && user && !user.emailVerified) {
    const checked = await delegateToAuth(req, OTP_CHECK_PATH, {
      email,
      type: "sign-in",
      otp: isText(body?.otp) ? String(body.otp) : "",
    });
    if (checked.status < 200 || checked.status >= 300) return relay(res, checked);
    markUserVerified(user.id);
  }

  // 5. Delegate the real route. Send stores + emails/logs the code; sign-in
  //    consumes it and mints the session (creating the account first when
  //    the address is new — gated in step 2 above).
  const delegated = await delegateToAuth(req, path, body);
  if (isSend && delegated.status >= 200 && delegated.status < 300) {
    lastCodeSentAt.set(email, Date.now());
  }
  return relay(res, delegated);
}
