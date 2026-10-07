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
//   2. Send windows priced in seconds. One code per mailbox per 60s
//      (per-email: an office NAT shares one IP, a mailbox does not share
//      with its neighbors) plus a wrapper-tracked per-IP window mirroring
//      Better Auth's own send rule (8 per 60s) — so the per-IP 429 a client
//      used to receive bare from the plugin now arrives with a uniform
//      machine-readable `retryAfterSeconds`, like every other rejection
//      this wrapper answers on the send route (study §5 S2).
//   3. Idempotent send. An accepted (email, Idempotency-Key) pair replays
//      its accepted response for as long as the code it accepted is alive
//      instead of tripping the cooldown — a transport retry of ONE
//      user-initiated attempt neither double-sends nor 429s; a NEW key
//      still pays the windows exactly as before (study §5 S3). Sign-up
//      gates run first: a stored key can never answer for an address the
//      gate closes.
//   4. Custody stays with the plugin on the sign-in route. A pre-existing
//      emailVerified: false user (an address pre-registered with a password
//      by someone who never proved the inbox) is NOT promoted or skipped
//      past the plugin: delegating the sign-in untouched lets Better Auth's
//      revokeUnprovenAccountAccess() run — a database-locked cleanup that
//      deletes every account link (password included) and every standing
//      session for the unproven account, then flips emailVerified. The
//      mailbox owner's successful OTP proof is exactly the event that must
//      END that unproven access, so an earlier wrapper step that validated
//      the code first and pre-marked the account verified — silencing the
//      revocation while keeping the attacker's session and password alive —
//      was removed (reproduced in server/email-otp-custody.test.ts).
//      Consequence, accepted by the owner: on a deployment with no mailer,
//      a password account that completes an OTP sign-in loses its password
//      link — an existing login method does NOT survive unchanged across
//      the mailbox proof; the account itself, its name and its workspace
//      data do.
//
// Everything else flows through untouched: unknown emails hit the plugin's
// own sign-up-on-verify (gated above), and unproven (unverified) accounts
// hit the plugin's own revocation on verify.

import type { IncomingMessage, ServerResponse } from "node:http";
import { auth, forwardedProtoOf, getDb, OTP_TTL_SECONDS } from "./auth.ts";
import { isText, json, readBody } from "./http-helpers.ts";
import { clearDelivery, withOtpDeliveryCapture, type DeliveryFailure } from "./otp-delivery.ts";
import { parseJson, type JsonObject, type JsonValue } from "./schema.ts";

export const OTP_SEND_PATH = "/api/auth/email-otp/send-verification-otp";
export const OTP_SIGN_IN_PATH = "/api/auth/sign-in/email-otp";

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
 * hammerable from rotating IPs either (the per-IP window below bounds that
 * side). Arm only after the plugin actually accepted a send (a gated or
 * rate-limited attempt arms nothing). */
const RESEND_COOLDOWN_MS = 60_000;

/** Per-IP send window — the wrapper-tracked twin of Better Auth's
 * "/email-otp/send-verification-otp" custom rule (window 60s, max 8 in
 * server/auth.ts). Same budget, same window length, spent on the same
 * requests (both count the sends that reach the plugin), so this check
 * always answers first — with machine-readable seconds — exactly where the
 * plugin's bare per-IP 429 used to arrive (study §5 S2). */
const SEND_WINDOW_MS = 60_000;
const SEND_WINDOW_MAX = 8;

/** How long an accepted send keeps replaying for its Idempotency-Key —
 * bounded by the code's own TTL (study §5 S3): once the code is dead there
 * is no double-send left to protect, and a later same-key request is a new
 * attempt that pays the windows like any other. */
const IDEMPOTENCY_TTL_MS = OTP_TTL_SECONDS * 1000;

/** Accepted length bound for a client Idempotency-Key (a UUID is 36). An
 * absent, blank or oversized key is treated as no key at all — additive by
 * construction: a client that never sends the header behaves exactly as
 * before. */
const IDEMPOTENCY_KEY_MAX = 128;

/** How long a client is told to wait after the mail provider refused a code.
 * This is a HINT, not a lock: unlike the resend cooldown it arms no server
 * state, because refusing the request was not the user's fault and must not
 * cost them the attempt. Long enough to spare a struggling provider a burst,
 * short enough that a person who is actually blocked does not sit through a
 * minute of nothing happening. */
const DELIVERY_RETRY_SECONDS = 20;

/** The truthful body for a send the provider did not accept. Deliberately
 * uniform with every other send rejection on this route, and deliberately
 * uninformative about the provider: a member learns that no mail went out and
 * may try again, not which vendor rejected it or why — that detail belongs in
 * the server log, where sendEmail already puts it, and never in a receipt
 * that might reach a mailbox the caller does not control. */
function deliveryRejection(failure: DeliveryFailure): SendRejectionBody {
  return {
    // One message for both provider-side failure kinds on purpose. Whether
    // the provider refused or never answered, the user's next move is
    // identical — try again shortly — and the difference is already in the
    // server log, where sendEmail records the provider's status verbatim.
    // `unconfigured` is unreachable from this route (the code path returns
    // before the sender when no mailer exists) but the branch is written
    // rather than assumed, so a future caller cannot answer it with the
    // wrong sentence.
    message:
      failure.reason === "unconfigured"
        ? "Email is not available on this deployment, so no code was sent."
        : failure.reason === "transport"
          ? "We could not reach the mail service. Please try again in a moment."
          : "We could not send your code. Please try again in a moment.",
    code: "EMAIL_DELIVERY_FAILED",
  };
}

/** What one accepted send stored for replay: the delegated answer itself —
 * status, body, content type and the individually kept set-cookie headers,
 * so a replay answers byte-for-byte like the original relay. */
interface AcceptedSend {
  status: number;
  body: string;
  contentType: string;
  setCookies: string[];
  acceptedAt: number;
}

const lastCodeSentAt = new Map<string, number>();
const sendWindowByIp = new Map<string, { count: number; windowStart: number }>();
const acceptedSends = new Map<string, AcceptedSend>();

/** Delivery bookkeeping is keyed by mailbox, so admission through outcome
 * commit must be exclusive for that mailbox. Keep at most 64 active mailboxes
 * and one queued caller per mailbox: at most 128 requests are retained even
 * when the mail transport is held. The existing sender timeout bounds each
 * active delivery; a single waiter avoids an arbitrarily long send FIFO. */
const MAX_PENDING_MAILBOXES = 64;
interface PendingMailboxSend {
  next: (() => void) | null;
}
const pendingMailboxSends = new Map<string, PendingMailboxSend>();

function releaseMailboxSend(email: string, pending: PendingMailboxSend): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = pending.next;
    if (next) {
      pending.next = null;
      next();
    } else {
      pendingMailboxSends.delete(email);
    }
  };
}

function reserveMailboxSend(email: string): Promise<() => void> | null {
  const pending = pendingMailboxSends.get(email);
  if (pending) {
    if (pending.next) return null;
    return new Promise((resolve) => {
      pending.next = () => resolve(releaseMailboxSend(email, pending));
    });
  }
  if (pendingMailboxSends.size >= MAX_PENDING_MAILBOXES) return null;
  const entry: PendingMailboxSend = { next: null };
  pendingMailboxSends.set(email, entry);
  return Promise.resolve(releaseMailboxSend(email, entry));
}

/** Drop everything past its window/TTL — run on every send so the three
 * maps stay bounded by live windows only. */
function pruneSendState(now: number): void {
  for (const [email, at] of lastCodeSentAt) {
    if (now - at > RESEND_COOLDOWN_MS) lastCodeSentAt.delete(email);
  }
  for (const [ip, window] of sendWindowByIp) {
    if (now - window.windowStart >= SEND_WINDOW_MS) sendWindowByIp.delete(ip);
  }
  for (const [key, entry] of acceptedSends) {
    if (now - entry.acceptedAt > IDEMPOTENCY_TTL_MS) acceptedSends.delete(key);
  }
}

function armCooldown(email: string, now: number): void {
  lastCodeSentAt.set(email, now);
}

function cooldownRemainingMs(email: string, now: number): number {
  const at = lastCodeSentAt.get(email);
  if (at === undefined) return 0;
  const remaining = RESEND_COOLDOWN_MS - (now - at);
  return remaining > 0 ? remaining : 0;
}

/** Milliseconds this source IP must still wait for the send window to have
 * room again: 0 = room available (or window gone). */
function ipWindowRemainingMs(ip: string, now: number): number {
  const window = sendWindowByIp.get(ip);
  if (!window) return 0;
  if (now - window.windowStart >= SEND_WINDOW_MS) {
    sendWindowByIp.delete(ip);
    return 0;
  }
  if (window.count < SEND_WINDOW_MAX) return 0;
  return window.windowStart + SEND_WINDOW_MS - now;
}

/** Spend one send from this IP's window — called only when the request is
 * about to reach the plugin, which mirrors what the plugin's own limiter
 * counts, so a cooldown/gate/replay rejection above never spends it. */
function spendIpSend(ip: string, now: number): void {
  const window = sendWindowByIp.get(ip);
  if (!window || now - window.windowStart >= SEND_WINDOW_MS) {
    sendWindowByIp.set(ip, { count: 1, windowStart: now });
    return;
  }
  window.count += 1;
}

function replayMapKey(email: string, key: string): string {
  return `${email}\n${key}`;
}

function rememberAcceptedSend(
  email: string,
  key: string,
  status: number,
  responseBody: string,
  contentType: string,
  setCookies: string[],
  now: number,
): void {
  acceptedSends.set(replayMapKey(email, key), {
    status,
    body: responseBody,
    contentType,
    setCookies,
    acceptedAt: now,
  });
}

/** The accepted answer for (email, key), or null: unknown key, another
 * mailbox reusing the key (the pair is scoped — a replay can never answer
 * for an address that never passed the gates), or TTL expiry — which also
 * drops the stale entry. */
function replayOf(email: string, key: string, now: number): AcceptedSend | null {
  const mapKey = replayMapKey(email, key);
  const entry = acceptedSends.get(mapKey);
  if (!entry) return null;
  if (now - entry.acceptedAt > IDEMPOTENCY_TTL_MS) {
    acceptedSends.delete(mapKey);
    return null;
  }
  return entry;
}

function resetSendState(): void {
  lastCodeSentAt.clear();
  sendWindowByIp.clear();
  acceptedSends.clear();
}

// Inferred (not annotated): the object literal's own type is the contract.
function sendStateSizes() {
  return { cooldowns: lastCodeSentAt.size, ipWindows: sendWindowByIp.size, replays: acceptedSends.size };
}

/** Test seam: the S2/S3 send bookkeeping above with an injectable clock —
 * every function takes `now` explicitly (production passes Date.now()), so
 * window boundaries, TTL edges and the keyed independence of the three maps
 * are deterministic under test. `reset()` clears state between cases. */
export const otpSendPolicy = {
  RESEND_COOLDOWN_MS,
  SEND_WINDOW_MS,
  SEND_WINDOW_MAX,
  IDEMPOTENCY_TTL_MS,
  armCooldown,
  cooldownRemainingMs,
  ipWindowRemainingMs,
  spendIpSend,
  rememberAcceptedSend,
  replayOf,
  prune: pruneSendState,
  reset: resetSendState,
  sizes: sendStateSizes,
};

/** Local lookup for the sign-up gate — findUserByEmail() in auth.ts
 * deliberately projects less. The wrapper never mutates verification state
 * itself: the plugin owns both the promotion (sign-up-on-verify) and the
 * unproven-access revocation. */
function findUserForOtp(email: string): { id: string } | null {
  try {
    // SAFETY: the SELECT projects exactly the id column read here
    const row = getDb()
      .prepare('SELECT "id" FROM "user" WHERE lower("email") = lower(?) LIMIT 1')
      .get(email) as { id: string } | undefined;
    return row ?? null;
  } catch {
    return null;
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

/** The body every send-path rejection answers with: message/code pass
 * through from wherever the rejection originated, and `retryAfterSeconds`
 * is added by rejectSend — always present, a machine-priced integer >= 0
 * (0 when no time-based wait applies), so a client can arm its resend
 * countdown from any send rejection without parsing copy (study §5 S2). */
interface SendRejectionBody {
  message?: string;
  code?: string;
}

/** Uniform send-path rejection: the JSON body plus `retry-after` and
 * `x-retry-after` headers whenever the wait is positive. Written directly
 * rather than through json() because the wait headers are the point; the
 * body is far under json()'s gzip threshold, so the wire shape matches
 * what json() would have produced plus the headers. */
function rejectSend(res: ServerResponse, status: number, body: SendRejectionBody, seconds: number): void {
  const retryAfterSeconds = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const data = JSON.stringify({ ...body, retryAfterSeconds });
  const headers: Record<string, string> = {};
  headers["content-type"] = "application/json";
  headers["content-length"] = String(Buffer.byteLength(data));
  if (retryAfterSeconds > 0) {
    headers["retry-after"] = String(retryAfterSeconds);
    headers["x-retry-after"] = String(retryAfterSeconds);
  }
  res.writeHead(status, headers);
  res.end(data);
}

/** parseJson decoded: a JSON object, not null/array/primitive — the same
 * guard computer-proxy.ts uses (instanceof + Array.isArray, never a runtime
 * typeof narrow, per house lint). */
const isJsonObject = (value: JsonValue): value is JsonObject => value instanceof Object && !Array.isArray(value);

/** Serves a recorded accepted send for its Idempotency-Key: the original
 * status, body, content type and cookies, plus replay markers so a client
 * (and the suite) can tell a replay from a fresh acceptance. No window is
 * spent and no cooldown is armed here (study §5 S3). */
function relayReplayedSend(res: ServerResponse, entry: AcceptedSend): void {
  const headers: Record<string, string | string[]> = {};
  headers["content-type"] = entry.contentType;
  headers["content-length"] = String(Buffer.byteLength(entry.body));
  headers["x-otp-replay"] = "1";
  headers["idempotency-replayed"] = "true";
  if (entry.setCookies.length > 0) headers["set-cookie"] = entry.setCookies;
  res.writeHead(entry.status, headers);
  res.end(entry.body);
}

/** Relays a delegated SEND rejection through the uniform shape: a JSON body
 * gets `retryAfterSeconds` injected — the backend's `retry-after` header
 * seconds on a 429, else 0 — with status and cookies kept; a non-JSON body
 * passes through verbatim (never rewrite a shape we do not recognize). */
function relaySendRejection(res: ServerResponse, delegated: DelegatedResponse): void {
  let parsed: JsonValue;
  try {
    parsed = parseJson(delegated.body);
  } catch {
    return relay(res, delegated);
  }
  if (!isJsonObject(parsed)) return relay(res, delegated);
  const headerSeconds = Number(delegated.headers.get("retry-after"));
  const fromHeader = Number.isFinite(headerSeconds) && headerSeconds > 0 ? Math.ceil(headerSeconds) : 0;
  const data = JSON.stringify({ ...parsed, retryAfterSeconds: delegated.status === 429 ? fromHeader : 0 });
  const headers: Record<string, string | string[]> = {};
  delegated.headers.forEach((value, key) => {
    const name = key.toLowerCase();
    if (name === "set-cookie" || name === "content-length" || name === "content-encoding") return;
    headers[name] = value;
  });
  if (delegated.setCookies.length > 0) headers["set-cookie"] = delegated.setCookies;
  headers["content-type"] = "application/json";
  headers["content-length"] = String(Buffer.byteLength(data));
  res.writeHead(delegated.status, headers);
  res.end(data);
}

/** First value of a possibly repeated header, trimmed — Node types header
 * values as string | string[] and repeated arrivals come as arrays. */
function headerFirst(headers: IncomingMessage["headers"], name: string): string {
  const raw = headers[name];
  const value = (Array.isArray(raw) ? raw.at(0) : raw) ?? "";
  return value.trim();
}

/** The source IP for the wrapper's per-IP send window — mirrors
 * clientIpForLimiting in server/index.ts (cloudflare hint, then the first
 * x-forwarded-for hop, then the socket), which this module cannot import
 * back without a cycle. */
function clientIpOf(req: IncomingMessage): string {
  const cf = headerFirst(req.headers, "cf-connecting-ip");
  if (cf) return cf;
  const forwarded = headerFirst(req.headers, "x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.socket.remoteAddress ?? "unknown";
}

/** Normalizes the optional `Idempotency-Key` header: absent, blank or
 * oversized (> IDEMPOTENCY_KEY_MAX) means "no key at all" — never an
 * error, so a client that never sends the header behaves exactly as
 * before (study §5 S3). */
function idempotencyKeyOf(req: IncomingMessage): string | null {
  const key = headerFirst(req.headers, "idempotency-key");
  return key.length > 0 && key.length <= IDEMPOTENCY_KEY_MAX ? key : null;
}

/** Admission order is unchanged, and is repeated after waiting for the
 * mailbox: the preceding send's genuine outcome may have armed cooldown or
 * replay, while a failed send must leave a queued retry free to try again. */
function answerSendPolicy(req: IncomingMessage, res: ServerResponse, email: string, idemKey: string | null): boolean {
  const now = Date.now();
  pruneSendState(now);
  if (idemKey) {
    const replay = replayOf(email, idemKey, now);
    if (replay) {
      relayReplayedSend(res, replay);
      return true;
    }
  }
  const cooldown = cooldownRemainingMs(email, now);
  if (cooldown > 0) {
    const seconds = Math.ceil(cooldown / 1000);
    rejectSend(res, 429, { message: `A code was already sent to this address. Try again in ${seconds} seconds.`, code: "RESEND_COOLDOWN" }, seconds);
    return true;
  }
  const windowMs = ipWindowRemainingMs(clientIpOf(req), now);
  if (windowMs > 0) {
    const seconds = Math.ceil(windowMs / 1000);
    rejectSend(res, 429, { message: "Too many code requests. Please wait and try again.", code: "RATE_LIMITED" }, seconds);
    return true;
  }
  return false;
}

/** Entry point for POST /api/auth/email-otp/send-verification-otp and
 * POST /api/auth/sign-in/email-otp (server/index.ts routes both here before
 * its generic Better Auth delegation). */
export async function handleEmailOtpAuthRequest(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
): Promise<void> {
  const isSend = path === OTP_SEND_PATH;

  // 1. Body — the stream can only be read once; delegation re-serializes it.
  //    Send-path rejections carry the uniform shape (retryAfterSeconds 0: a
  //    malformed body has no time-based wait attached to it).
  let body: EmailOtpRequestBody;
  try {
    body = await readBody(req);
  } catch (error) {
    // SAFETY: readBody rejections carry an HTTP status via Object.assign at
    // its size-limit/parse rejection sites.
    const status = (error as { status?: number }).status ?? 400;
    const message = error instanceof Error ? error.message : String(error);
    if (isSend) return rejectSend(res, status, { message, code: "INVALID_REQUEST" }, 0);
    return json(res, status, { message, code: "INVALID_REQUEST" });
  }

  const email = isText(body?.email) ? String(body.email).trim().toLowerCase() : "";
  if (!email) {
    if (isSend) return rejectSend(res, 400, { message: "email is required", code: "INVALID_EMAIL" }, 0);
    return json(res, 400, { message: "email is required", code: "INVALID_EMAIL" });
  }

  const user = findUserForOtp(email);

  // 2. Sign-up gates — only addresses with no account yet (existing
  //    accounts keep signing in exactly as before, gate or no gate). The
  //    gate runs BEFORE any window bookkeeping: a gated send answers 403 in
  //    the uniform shape, spends no IP window and arms no cooldown — and
  //    since the replay map below is keyed per mailbox, a stored
  //    Idempotency-Key can never answer for an address the gate closes.
  if (!user) {
    const blocked = otpSignUpBlockReason(email);
    if (blocked) {
      if (isSend) return rejectSend(res, 403, blocked, 0);
      return json(res, 403, blocked);
    }
  }

  // 3. Send windows (send only), in cost order: replay first — an accepted
  //    send stays replayable THROUGH the cooldown it armed (that is the
  //    whole point of S3) — then the per-mailbox cooldown, then the
  //    wrapper-tracked per-IP window that Better Auth's send rule used to
  //    answer bare. Every rejection here is uniform; only a request that
  //    proceeds to delegation below spends the IP window.
  let idemKey: string | null = null;
  if (isSend) {
    // The plugin's send schema requires `type`; default it so a bare
    // { email } request behaves as sign-in instead of failing validation.
    if (body.type === undefined) body.type = "sign-in";
    idemKey = idempotencyKeyOf(req);
    if (answerSendPolicy(req, res, email, idemKey)) return;
  }

  const reservation = isSend ? reserveMailboxSend(email) : undefined;
  if (reservation === null) {
    return rejectSend(res, 503, { message: "Code requests are busy. Please try again in a moment.", code: "EMAIL_SEND_BUSY" }, DELIVERY_RETRY_SECONDS);
  }
  const release = reservation ? await reservation : undefined;
  try {
    // A disconnected queued caller needs no new send. An already admitted
    // sender still completes and commits its genuine outcome for retries;
    // the original response socket never controls that shared operation.
    if (isSend && res.destroyed) return;
    if (isSend && answerSendPolicy(req, res, email, idemKey)) return;

    // 4. Delegate the real route. Send stores + emails/logs the code; sign-in
    //    consumes it and mints the session (creating the account first when
    //    the address is new — gated in step 2 above). For a pre-existing
    //    emailVerified: false user the plugin runs its database-locked
    //    revokeUnprovenAccountAccess during this delegation — deleting the
    //    unproven account's links (password included) and standing sessions
    //    before flipping emailVerified — which is the custody contract this
    //    wrapper must not shortcut: see the header note and
    //    server/email-otp-custody.test.ts. The per-IP window is spent at the
    //    point the request reaches the plugin — mirroring what the plugin's
    //    own limiter counts — while cooldown and replay map are armed only for
    //    an accepted send, and delegated send rejections are relayed through
    //    the same uniform shape as the wrapper's own.
    if (isSend) {
      clearDelivery(email);
      spendIpSend(clientIpOf(req), Date.now());
    }
    const captured = isSend
      ? await withOtpDeliveryCapture(email, () => delegateToAuth(req, path, body))
      : { value: await delegateToAuth(req, path, body), outcome: undefined };
    const delegated = captured.value;
    if (isSend && delegated.status >= 200 && delegated.status < 300) {
      // A 2xx here is the PLUGIN's answer, not the mail's. The plugin stores
      // the code and then awaits our sender through runInBackgroundOrAwait,
      // which catches a rejection and still resolves — so this branch used to
      // read as "the provider accepted the message" when it only meant "the
      // plugin was called". A refused or undelivered send therefore armed the
      // 60s cooldown and stored a replayable success: the user was told a code
      // was on its way and then blocked from asking again for a minute. The
      // recorded outcome is the only honest signal (server/otp-delivery.ts).
      const outcome = captured.outcome;
      clearDelivery(email);
      if (outcome && !outcome.ok) {
        // Nothing armed: no cooldown, no replay entry. A failed send must leave
        // the mailbox exactly as able to try again as it was before.
        return rejectSend(res, 503, deliveryRejection(outcome), DELIVERY_RETRY_SECONDS);
      }
      // For ANY code kind, a delivery outcome present after the delegation
      // means the sender ran and a code is now in play; `undefined` means no
      // emails went out because the plugin short-circuited the send route
      // before ever calling the sender (`routes.mjs:104`). `change-email`
      // bounds this enumeration: the plugin rejects it outright with 400
      // "Invalid OTP type", so it can never reach this branch. The plugin's
      // own behaviour under a `disableSignUp: true` config would short-circuit
      // a sign-in send for an unknown address too — and with THAT possibility
      // in mind, the predicate deliberately keys on the sender's actual
      // invocation, so a send that minted no code arms nothing no matter which
      // config produces that outcome (server/otp-delivery.ts records the
      // coupling with `runInBackgroundOrAwait`).
      //
      // What this deliberately reproduces is the bound the older behaviour
      // gave a REGISTERED address: a non-sign-in code request on this route
      // does genuinely mint and email a code, so it arms the same per-mailbox
      // cooldown a sign-in send would, with the recorded verdict deciding
      // rather than the request's own claim about its type.
      if (outcome) {
        armCooldown(email, Date.now());
        if (idemKey) {
          rememberAcceptedSend(
            email,
            idemKey,
            delegated.status,
            delegated.body,
            delegated.headers.get("content-type") ?? "application/json",
            delegated.setCookies,
            Date.now(),
          );
        }
      }
      return relay(res, delegated);
    }
    if (isSend) clearDelivery(email);
    if (isSend && delegated.status >= 400) return relaySendRejection(res, delegated);
    return relay(res, delegated);
  } finally {
    if (isSend) clearDelivery(email);
    release?.();
  }
}
