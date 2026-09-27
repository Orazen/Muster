// Durable send intents for ordinary messages (the researched "one request
// survives a disconnect" slice).
//
// Message send v1 is an in-process acknowledgement: a lost HTTP response or
// SSE frame leaves the sender unsure whether their words were accepted, and
// a naive auto-retry could dispatch the same request twice. This module adds
// an OPT-IN receipt capability beside that contract: a sender that carries
// `clientIntentId` gets a durable, per-intent receipt that survives restarts.
// The guarantee is creation-only — a replayed id is a lookup, never a resend —
// while dispatch retries stay governed by the existing attempts/lease/idempotency
// rules. Senders that omit the field keep the exact v1 behavior and receive
// no durability promise; messageSendVersion stays 1 and the native client is
// untouched.
//
// A receipt is not an approval, and no external action is ever retried here:
// after an executor crash a receipt may honestly read "unknown", and the
// client shows uncertainty instead of resending.

/** Client intent ids: 8–128 chars of letters, digits, dot, dash or underscore
 * — the same shape the task-plan delivery ledger already accepts, so the two
 * contracts never disagree about what an intent id is. */
export const INTENT_ID_PATTERN = /^[\w.-]{8,128}$/;

/** Fingerprint of one intent's payload: the exact text and the exact
 * destination it was first accepted for. A replayed id with a DIFFERENT
 * payload is a client bug (or a collision) — refused as a conflict, never
 * silently re-bound to new words or a new conversation. */
export function messageIntentFingerprint(text: string, threadId: string): string {
  return `${Buffer.byteLength(text, "utf8")}:${text}:${threadId}`;
}

/** Valid raw intent id? Exact length and charset, no normalization: a
 * truncated or padded id must collide with nothing. */
export function isValidMessageIntentId(value: string): boolean {
  return INTENT_ID_PATTERN.test(value);
}

export type MessageIntentAdmission =
  | { outcome: "accepted"; intentId: string }
  | { outcome: "duplicate"; intentId: string; messageId: string; state: "accepted" | "dispatched" | "unknown"; acceptedAt: number }
  | { outcome: "conflict"; intentId: string; messageId: string };

/** One accepted intent = one receipt the client can fold back into its
 * transcript. `state` is the server's honest belief: `accepted` means the
 * words are durable but dispatch has not been observed; `dispatched` means
 * a turn carrying them started; `unknown` means a previous process died
 * after dispatch began and nobody can prove the outcome. */
export interface MessageIntentReceipt {
  intentId: string;
  messageId: string;
  threadId: string;
  state: "accepted" | "dispatched" | "unknown";
  acceptedAt: number;
}
