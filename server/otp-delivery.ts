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
// So the outcome is recorded here at the moment it is known — inside the
// sender, next to the transport call that produced it — and read back by
// server/email-otp-login.ts after the delegation returns. Keyed by the same
// normalized mailbox the send policy uses, because that is the only identity
// both sides share: the plugin lowercases the address, the wrapper lowercases
// it, and neither knows the other's request object.
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

/** How long a recorded outcome stays readable. Generous next to the
 * transport's own timeout (see RESEND_TIMEOUT_MS in email.ts) so a slow but
 * answered send is still attributed correctly, and short enough that a request
 * which died between storing the code and recording the outcome cannot leave a
 * stale verdict for an unrelated later send. */
const OUTCOME_TTL_MS = 60_000;

const outcomes = new Map<string, { outcome: DeliveryOutcome; at: number }>();

/** The mailbox key both sides agree on. */
export function deliveryKey(email: string): string {
  return email.trim().toLowerCase();
}

export function recordDelivery(email: string, outcome: DeliveryOutcome): void {
  const key = deliveryKey(email);
  // One mailbox has one send in flight: the per-mailbox cooldown admits no
  // second attempt, so the newest verdict is the only one that can be read.
  outcomes.set(key, { outcome, at: Date.now() });
}

/** The recorded outcome for a mailbox, or undefined when none is live.
 * Reading does NOT consume it — the caller decides, and a send that is
 * rejected twice must report the same reason both times. */
export function deliveryOutcome(email: string): DeliveryOutcome | undefined {
  const key = deliveryKey(email);
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
  outcomes.delete(deliveryKey(email));
}

/** Test seam: drop every recorded outcome. */
export function resetDeliveries(): void {
  outcomes.clear();
}

export function deliverySlotCount(): number {
  return outcomes.size;
}
