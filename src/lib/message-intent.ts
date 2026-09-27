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
  intent?: { messageId?: string; state?: string };
}

/** The wire's id contract: only a primitive string is an id. */
const isText = <T,>(value: T): value is T & string => String(value) === value;

const messageIdOf = (body: ReplayBody): string | undefined => {
  if (body.intent?.messageId !== undefined) return body.intent.messageId;
  const id = body.message?.id;
  return isText(id) ? id : undefined;
};

/** Reconnect reconciliation: replay every still-pending intent for a
 * thread against the endpoint. The server answers with the original
 * message and its durable receipt — a lookup, never a resend — or keeps
 * the record parked (transport/context failure). Local-only records (a
 * server that never received the request) surface as `unresolved` so the
 * caller can offer an explicit retry instead of guessing. */
export interface ReconcileResult {
  /** Terminal receipts the server confirmed (dispatched or lost). */
  recovered: Array<{ pending: PendingSend; receipt: { messageId: string; state: string } }>;
  /** Durable but NOT yet dispatched (state "accepted"): the words are
   * stored server-side and queued behind a busy turn, so resending would
   * duplicate them. The record stays parked and replays on the next
   * reconnect until a terminal receipt retires it. */
  accepted: Array<{ pending: PendingSend; receipt: { messageId: string; state: string }; message?: unknown }>;
  /** Server never heard of this intent (or no server answered). */
  unresolved: PendingSend[];
}

export async function reconcileThread(
  store: Store,
  threadId: string,
  send: (pending: PendingSend) => Promise<ReplayBody>,
): Promise<ReconcileResult> {
  const now = Date.now();
  const values = read(store);
  const pendingList = prune(values[threadId] ?? [], now);
  if (pendingList.length) values[threadId] = pendingList;
  else delete values[threadId];
  write(store, values);
  const result: ReconcileResult = { recovered: [], accepted: [], unresolved: [] };
  for (const pending of pendingList) {
    try {
      const body = await send(pending);
      const messageId = messageIdOf(body);
      const state = body.intent?.state;
      // Only a TERMINAL receipt retires the record. "accepted" means the
      // words are durable but still waiting to send (a busy bot's in-memory
      // queue): keep replaying on every reconnect until the send is
      // dispatched, lost, or confirmed — never assume "sent".
      if (messageId && state !== "accepted") {
        result.recovered.push({ pending, receipt: { messageId, state: state ?? "sent" } });
        retireSend(store, threadId, pending.intentId);
      } else if (messageId) {
        result.accepted.push({ pending, receipt: { messageId, state: state ?? "accepted" }, message: body.message });
      } else {
        result.unresolved.push(pending);
      }
    } catch {
      result.unresolved.push(pending);
    }
  }
  return result;
}

/** One id per send: UUID with separators swapped for the wire's [\w.-]
 * charset, and a prefix short enough to survive the 128 cap everywhere. */
export function newIntentId(): string {
  return `snd-${crypto.randomUUID().replaceAll("-", "")}`;
}
