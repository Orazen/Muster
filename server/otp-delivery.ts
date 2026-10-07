import { AsyncLocalStorage } from "node:async_hooks";

// Did the sign-in code actually LEAVE the building?
//
// This module exists because better-auth cannot answer that question. The
// emailOTP plugin stores the code, then hands it to `sendVerificationOTP`
// through `runInBackgroundOrAwait`, which catches a rejection, logs it, and
// still resolves (node_modules/better-auth/dist/context/create-context.mjs:215
// — `catch { logger.error(...) }`). The send route therefore answers
// {success:true} whether the mail went out, was refused by the provider, or
// never left. The plugin's success IS the only signal the HTTP layer gets.
//
// The sender records the verdict inside the async context of the delegated
// send request. The wrapper reads only that context, so an unwrapped reset
// for the same mailbox cannot consume or overwrite its delivery evidence.
// Standalone sign-in callers retain the bounded legacy mailbox bookkeeping.
//
// Absent means "no delivery was attempted", which is NOT the same as
// "delivery failed": the plugin short-circuits the send route for an unknown
// address when sign-up-on-verify is disabled, returning success without ever
// calling the sender. Callers must treat undefined as "nothing to report"
// rather than as a failure, or that path would start answering 503.
//
// One coupling to keep in mind if better-auth's config ever changes: the
// record is only in place because runInBackgroundOrAwait AWAITS the promise
// when no `advanced.backgroundTasks.handler` is configured, which is the
// current configuration. Configure a background handler and the send becomes
// fire-and-forget, the wrapper will read undefined, and it will fall back to
// the old optimistic behavior — degraded, not broken, and silently so. The
// sign-in send's own test fails if that ever happens, because a refused send
// would stop answering 503.

/** Why a message did not go out. Never carries the code or the address.
 *
 * `unconfigured` is a real answer for the verification and reset mail, whose
 * callers have no transport at all. It is deliberately NOT what the sign-in
 * code path reports when no mailer exists: there the code is delivered through
 * the local dev console channel, which is a success, and the send policy must
 * keep treating it as one. */
export type DeliveryFailure =
  /** The provider answered, and the answer was no. `status` is its HTTP code. */
  | { ok: false; reason: "rejected"; status: number }
  /** The provider never answered: DNS, TLS, socket, or the request timed out. */
  | { ok: false; reason: "transport" }
  /** No transport is configured, so no request was ever attempted. */
  | { ok: false; reason: "unconfigured" };

export type DeliveryOutcome = { ok: true } | DeliveryFailure;

/** The code kinds the plugin can ask the sender to deliver. Mirrors its own
 * `sendVerificationOTP` payload so a new kind is a compile error here rather
 * than a silent leak. */
export type OtpCodeType = "sign-in" | "email-verification" | "forget-password" | "change-email";

/** Whether a delivery of this kind is one the send policy will come back for.
 *
 * Only the sign-in send is reconciled, so only the sign-in send may be
 * recorded. The plugin's other kinds matter here because their routes are not
 * all wrapped: `/email-otp/request-password-reset` and
 * `/email-otp/request-email-change` call this same sender while sitting
 * outside the send policy entirely, and the `/sign-up` after-hook can too. A
 * record written on those paths has no reader, so recording them grows a Map
 * by one entry per address ever mailed such a code — silently, on a
 * long-lived server, which is exactly the kind of defect no test announces.
 *
 * This is a retention rule, not an attribution one. A stale record cannot be
 * mistaken for a later send's verdict either way, because the send policy only
 * reads after delegating, and delegating always invokes the sender first.
 */
export function shouldRecordDelivery(type: OtpCodeType): boolean {
  return type === "sign-in";
}

interface OtpDeliveryCapture {
  mailbox: string;
  outcome: DeliveryOutcome | undefined;
  active: boolean;
}

const otpDeliveryContext = new AsyncLocalStorage<OtpDeliveryCapture>();

/** Capture only deliveries made by this awaited auth delegation. There is no
 * mailbox-global pending marker: unrelated requests have separate async
 * contexts, even when both target the same mailbox. No sender means undefined.
 * Closing the frame also prevents detached work from changing a finished
 * request's receipt; Better Auth must continue awaiting its sender. */
export async function withOtpDeliveryCapture<T>(
  email: string,
  operation: () => Promise<T>,
): Promise<{ value: T; outcome: DeliveryOutcome | undefined }> {
  const frame: OtpDeliveryCapture = { mailbox: deliveryKey(email), outcome: undefined, active: true };
  try {
    const value = await otpDeliveryContext.run(frame, operation);
    return { value, outcome: frame.outcome };
  } finally {
    frame.active = false;
  }
}

/** Non-sign-in senders record only into their own active request frame. */
export function recordDeliveryIfPending(email: string, outcome: DeliveryOutcome): boolean {
  const frame = otpDeliveryContext.getStore();
  if (!frame?.active || frame.mailbox !== deliveryKey(email)) return false;
  recordDelivery(email, outcome);
  return true;
}

/** How long a recorded outcome stays readable. Generous next to the
 * transport's own timeout (see RESEND_TIMEOUT_MS in email.ts) so a slow but
 * answered send is still attributed correctly, and short enough that a request
 * which died between storing the code and recording the outcome cannot leave a
 * stale verdict for an unrelated later send. */
const OUTCOME_TTL_MS = 60_000;

/** Hard ceiling on retained entries, as defence in depth. Every write today is
 * paired with a read-and-clear on the send path, and only the sign-in type is
 * recorded at all, so this should never be reached. It exists because the
 * failure it guards against is silent: an unbounded Map in a server that runs
 * for weeks is a slow leak that no test announces, and a future caller that
 * records without clearing would otherwise leak one entry per address mailed.
 * Oldest-first eviction matches the TTL: the entry most likely to be stale is
 * the one dropped. */
const MAX_TRACKED = 1_000;

const outcomes = new Map<string, { outcome: DeliveryOutcome; at: number }>();

/** The most recent delivery verdict, held on its own rather than in a map:
 * there is only ever a latest one, and it is keyed by nothing. See
 * mailTransportFailing() for why this is not a per-mailbox question. */
let transportVerdict: { failed: boolean; at: number } | undefined;

/** The mailbox key both sides agree on. */
export function deliveryKey(email: string): string {
  return email.trim().toLowerCase();
}

export type DeliveryChannel = "otp" | "password-reset";

/** Two routes, one map. The channel is part of the key so a password-reset
 * verdict can never be read back as a sign-in code's, and vice versa — the
 * sign-in send policy consumes-and-clears by mailbox, and the reset wrapper
 * does the same for a different route, so a shared bare key would let one
 * route's answer decide the other's. `otp` is the bare mailbox, unchanged,
 * so every existing reader and every existing test keeps its exact key. */
function slotKey(channel: DeliveryChannel, email: string): string {
  const mailbox = deliveryKey(email);
  return channel === "otp" ? mailbox : `reset-password ${mailbox}`;
}

export function recordDelivery(email: string, outcome: DeliveryOutcome): void {
  recordDeliveryFor("otp", email, outcome);
}

export function recordDeliveryFor(channel: DeliveryChannel, email: string, outcome: DeliveryOutcome): void {
  const key = slotKey(channel, email);
  const frame = otpDeliveryContext.getStore();
  if (channel === "otp" && frame?.active && frame.mailbox === deliveryKey(email)) {
    frame.outcome = outcome;
  }
  // Legacy standalone readers retain bounded mailbox slots. The send wrapper
  // uses its request frame instead, so unrelated deliveries cannot decide it.
  outcomes.set(key, { outcome, at: Date.now() });
  // The transport's health is a property of the DEPLOYMENT, not of one
  // mailbox, and it is tracked apart from the slots because the reset route
  // must be able to answer about a broken transport without knowing whether
  // the address that asked even has an account.
  transportVerdict = { failed: !outcome.ok, at: Date.now() };
  // Map preserves insertion order, so the first key is the oldest write.
  while (outcomes.size > MAX_TRACKED) {
    const oldest = outcomes.keys().next();
    if (oldest.done) break;
    outcomes.delete(oldest.value);
  }
}

/** The recorded outcome for a mailbox, or undefined when none is live.
 * Reading does NOT consume it — the caller decides, and a send that is
 * rejected twice must report the same reason both times. */
export function deliveryOutcome(email: string): DeliveryOutcome | undefined {
  return deliveryOutcomeFor("otp", email);
}

export function deliveryOutcomeFor(channel: DeliveryChannel, email: string): DeliveryOutcome | undefined {
  const key = slotKey(channel, email);
  const entry = outcomes.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.at > OUTCOME_TTL_MS) {
    outcomes.delete(key);
    return undefined;
  }
  return entry.outcome;
}

/** Forget a mailbox's outcome. Called once a send has been accounted for, so a
 * long-lived process does not accumulate one entry per address ever mailed. */
export function clearDelivery(email: string): void {
  clearDeliveryFor("otp", email);
}

export function clearDeliveryFor(channel: DeliveryChannel, email: string): void {
  outcomes.delete(slotKey(channel, email));
}

/** True when this server's last outbound message did not go out.
 *
 * Deliberately address-free. The password-reset route has to tell a person
 * that no mail was sent, but the ONLY way it learns that is by attempting a
 * send, and better-auth never attempts one for an address with no account — so
 * a per-mailbox verdict answers a different status for a registered address
 * than for an unregistered one, which is precisely the account-existence
 * oracle src/pages/ForgotPasswordPage.tsx documents refusing to build.
 *
 * Reading it here instead makes the answer a function of the deployment's
 * mail transport rather than of the address: once anything has failed, every
 * reset request gets the same refusal until a send succeeds again, and the
 * request that first observed the failure is the only one whose status could
 * say anything about the address behind it. A successful send clears it. */
export function mailTransportFailing(now = Date.now()): boolean {
  if (!transportVerdict) return false;
  if (now - transportVerdict.at > OUTCOME_TTL_MS) {
    transportVerdict = undefined;
    return false;
  }
  return transportVerdict.failed;
}

/** Test seam: drop every recorded outcome and the transport verdict. */
export function resetDeliveries(): void {
  outcomes.clear();
  transportVerdict = undefined;
}

export function deliverySlotCount(): number {
  return outcomes.size;
}
