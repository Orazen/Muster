import { z } from "zod";

// Durable send intents, client side: the composer's "did my words arrive?"
// ledger. On send, one immutable id and the exact words are parked BEFORE
// the request leaves; the server's receipt (or a reconnect replay) folds
// the SAME message back into the transcript and retires the record. A lost
// response is therefore a lookup on reconnect, never an automatic resend —
// and a record the server cannot confirm reads as "checking delivery",
// with the words preserved, until the user decides.
//
// Records are per account + thread (never per tab) and bounded: newest
// intent wins per thread, older unresolved records age out after a day.

export interface PendingSend {
  /** Client intent id (8–128 of [\w.-]); generated once per send. */
  intentId: string;
  threadId: string;
  botId: string;
  text: string;
  /** Enqueued epoch ms — also the server-side acceptedAt expectation. */
  createdAt: number;
  /** The signed-in account that parked this send (W0). The reconnect sweep
   * replays only the CURRENT account's records — a shared browser profile
   * must never carry one account's parked words into another's session.
   * Records written before this field existed stay parked and never
   * enter automatic account-scoped recovery. */
  accountId?: string;
}

const KEY = "muster:message-intents:v1";
const MAX_PER_THREAD = 4;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

type Values = Record<string, PendingSend[]>;
type Store = Pick<Storage, "getItem" | "setItem"> | undefined;

function read(store: Store): Values {
  try {
    const raw = store?.getItem(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!(parsed instanceof Object) || Array.isArray(parsed)) return {};
    // SAFETY: this file is written only by park()/retire() below, so an
    // object payload maps thread ids to pending-send arrays; readers take
    // only the fields the PendingSend type names.
    return parsed as Values;
  } catch {
    return {};
  }
}

function write(store: Store, values: Values): void {
  try {
    store?.setItem(KEY, JSON.stringify(values));
  } catch {
    // Storage is best-effort: an unavailable store must never block a send.
    // The in-memory call site still tracks the in-flight intent for this
    // session; only reload recovery is unavailable, and callers say so.
  }
}

function prune(threads: PendingSend[], now: number): PendingSend[] {
  const fresh = threads.filter((entry) => now - entry.createdAt < MAX_AGE_MS);
  return fresh.slice(-MAX_PER_THREAD);
}

/** Persist one send before its request leaves the tab. Replaces the value
 * on retry so the id survives, never regenerates. The cap counts the new
 * record too, so the ledger can never exceed MAX_PER_THREAD per thread. */
export function parkSend(store: Store, pending: PendingSend): void {
  const values = read(store);
  const threads = (values[pending.threadId] ?? [])
    .filter((entry) => Date.now() - entry.createdAt < MAX_AGE_MS && entry.intentId !== pending.intentId);
  threads.push(pending);
  values[pending.threadId] = threads.slice(-MAX_PER_THREAD);
  write(store, values);
}

/** The send reached the server (receipt or fold): stop tracking it. */
export function retireSend(store: Store, threadId: string, intentId: string): void {
  const values = read(store);
  const threads = (values[threadId] ?? []).filter((entry) => entry.intentId !== intentId);
  if (threads.length) values[threadId] = threads;
  else delete values[threadId];
  write(store, values);
}

/** The shape a caller uses to surface an unresolved record in the UI while
 * it stays parked (same key fields, no storage round-trip). */
export type CheckingPending = Pick<PendingSend, "intentId" | "threadId" | "text">;

/** One replay response: the receipt always; the echoed original message
 * (for folding into the transcript) when the endpoint includes it. */
export interface ReplayBody {
  message?: { id?: unknown };
  intent?: { messageId?: string; threadId?: string; state?: string };
}

/** The wire's id contract: only a primitive string is an id. */
const isText = <T,>(value: T): value is T & string => String(value) === value;

/** The receipt names where admission happened. Older or malformed replies
 * fall back to the send's captured destination, never the currently open task. */
const receiptThreadSchema = z.string().refine(value => value.trim().length > 0);

export function receiptThreadId(body: ReplayBody, originalThreadId: string): string {
  const destination = receiptThreadSchema.safeParse(body.intent?.threadId);
  return destination.success ? destination.data : originalThreadId;
}

const messageIdOf = (body: ReplayBody): string | undefined => {
  if (body.intent?.messageId !== undefined) return body.intent.messageId;
  const id = body.message?.id;
  return isText(id) ? id : undefined;
};

/** Reconnect reconciliation: replay every still-pending intent for a
 * thread against the endpoint. The server answers a replayed id with the
 * ORIGINAL message and its durable receipt — a lookup, never a resend — or
 * keeps the record parked (transport/context failure). Local-only records
 * (a server that never received the request) surface as `unresolved` so the
 * caller can offer an explicit retry instead of guessing.
 *
 * The replay always carries `lookup: true` (W0): a reconnect must never
 * CREATE. An id the server cannot place in this account answers a blank 404
 * and the record stays parked here. The receipt's OWN destination wins: a
 * record parked under a thread that has since moved on (task switch) folds
 * into the thread it was originally accepted for. */
export interface RecoveredReceiptItem {
  pending: PendingSend;
  /** Terminal receipt; `threadId` is where the words ACTUALLY went. */
  receipt: { messageId: string; threadId: string; state: string };
}

export interface AcceptedReceiptItem {
  pending: PendingSend;
  /** Durable receipt; `threadId` is where the words ACTUALLY went. */
  receipt: { messageId: string; threadId: string; state: string };
  /** The echoed original message, when the endpoint includes it. */
  message?: unknown;
}

export async function reconcileThread(
  store: Store,
  threadId: string,
  send: (pending: PendingSend, lookup: boolean) => Promise<ReplayBody>,
  onReceipt?: (item: RecoveredReceiptItem | AcceptedReceiptItem) => void,
  isEligible?: (pending: PendingSend) => boolean,
): Promise<PendingSend[]> {
  const now = Date.now();
  const values = read(store);
  const pendingList = prune(values[threadId] ?? [], now);
  if (pendingList.length) values[threadId] = pendingList;
  else delete values[threadId];
  write(store, values);
  const unresolved: PendingSend[] = [];
  for (const pending of pendingList) {
    // A thread can contain another account's parked row or a request still
    // in flight. Recheck at the actual lookup boundary, including after a
    // previous asynchronous lookup; skipped records stay parked untouched.
    if (isEligible && !isEligible(pending)) continue;
    try {
      const body = await send(pending, true);
      const messageId = messageIdOf(body);
      const state = body.intent?.state;
      // The receipt's destination outranks the record's: the parked words
      // stay bound to the thread they were first accepted for.
      const destination = receiptThreadId(body, threadId);
      // Only a TERMINAL receipt retires the record. "accepted" means the
      // words are durable but still waiting to send (a busy bot's in-memory
      // queue): keep replaying on every reconnect until the send is
      // dispatched, lost, or confirmed — never assume "sent".
      if (messageId && state !== "accepted") {
        onReceipt?.({ pending, receipt: { messageId, threadId: destination, state: state ?? "sent" } });
        retireSend(store, threadId, pending.intentId);
      } else if (messageId) {
        onReceipt?.({ pending, receipt: { messageId, threadId: destination, state: state ?? "accepted" }, message: body.message });
      } else {
        unresolved.push(pending);
      }
    } catch {
      unresolved.push(pending);
    }
  }
  return unresolved;
}

/** Every thread's still-parked records (pruned first), for the account-
 * scoped reconnect sweep. With `accountId` set, only records that account
 * parked are returned — shared-storage records from another signed-in
 * account stay parked and invisible to this session. Records written before
 * per-record accounts existed are likewise excluded from account-scoped
 * automatic recovery. */
export function allPendingSends(store: Store, accountId?: string): PendingSend[] {
  const now = Date.now();
  const values = read(store);
  const result: PendingSend[] = [];
  for (const threadId of Object.keys(values)) {
    const list = prune(values[threadId] ?? [], now);
    if (list.length) values[threadId] = list;
    else delete values[threadId];
    for (const entry of list) {
      if (accountId !== undefined && entry.accountId !== accountId) continue;
      result.push(entry);
    }
  }
  write(store, values);
  return result;
}

/** One id per send: UUID with separators swapped for the wire's [\w.-]
 * charset, and a prefix short enough to survive the 128 cap everywhere. */
export function newIntentId(): string {
  return `snd-${crypto.randomUUID().replaceAll("-", "")}`;
}
