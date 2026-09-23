// Queue-and-steer for busy 1:1 bots.
//
// A message sent to a bot mid-turn used to bounce with a 409. Now it lands
// in the thread immediately — visible, persisted, marked `queued` — and
// waits here until the bot settles. On settle, every queued message for
// the thread drains into ONE follow-up turn whose prompt is the queued
// texts joined with newlines, so a burst of steering notes costs one turn.
//
// The queue itself is memory-only on purpose: each queued message is
// already an ordinary persisted thread message, so a restart loses only
// the "auto-run on settle" intent, never the words — the same honesty as
// delegations and provider approvals, which also die with the process.
// (The client renders the queued affordance only while the bot is busy, so
// a flag stranded by a restart is invisible rather than a false promise.)
//
// Unlike the delegation drain, an interrupted or failed turn does NOT
// discard this queue: delegations are a bot's fan-out (dropping them on
// Stop is a safety property), but these are the user's own words —
// stop-then-steer (queue a correction, hit Stop, the correction runs) is
// the feature.
//
// The user can also HOLD that queue from the composer strip (pause and
// explicit "resume queued messages"): a held entry is skipped by drain —
// the words wait, visibly, until resumed. Hold is opt-in; the default
// stays the stop-then-steer above, unchanged.

import type { QueuedSendMessage, SteerQueueSnapshot } from "./contracts.ts";
import type { BotRecord, Message } from "./store.ts";

/** The slice of Store this module needs — narrow so tests can fake it. */
export interface SteerStore {
  bot(id: string): BotRecord | null;
  appendMessage(threadId: string, message: Omit<Message, "id" | "at">): Message;
  patchMessage(threadId: string, messageId: string, patch: Partial<Message>): Message | null;
}

interface QueueEntry {
  /** Kept beside the threadId because the settle that frees the bot can
   * happen on a DIFFERENT thread (a room turn) — drain matches on "this
   * queue's bot is idle now", which needs the bot, not the settling thread. */
  botId: string;
  items: Array<{ messageId: string; text: string }>;
  /** The user's hold (composer strip's pause): while true, drain skips
   * this entry even when the bot is idle — the words wait for an explicit
   * resume instead of spending themselves on a turn the user held them
   * back from. */
  paused?: boolean;
  /** Failed dispatches already spent on this entry (see MAX_REQUEUES). */
  attempts?: number;
}

const queues = new Map<string, QueueEntry>(); // threadId → waiting sends

/** An error surfaced from a dispatch: engine/turn failures stamp a numeric
 * HTTP `status` on the Error they throw; every other rejection is a plain
 * Error or a string, carrying no status. */
type PossiblyHttpError = { status?: number } | Error | string;

/** True only when the rejection carries the HTTP status stamped by dispatch. */
function isHttpError(error: PossiblyHttpError): error is { status?: number } {
  return error instanceof Object && "status" in error;
}

/** A drained dispatch that fails because the bot went busy again (a goal
 * round or routine claimed it between the settle and the dispatch) is
 * transient: the words go back on the queue for the NEXT settle, up to this
 * many times. Anything else — a 402 budget, an engine refusal — is final and
 * goes straight to onGiveUp, never a silent drop. */
const MAX_REQUEUES = 3;

/** Land a message in the busy bot's active thread now; it auto-sends when
 * the turn settles. The `queued` flag is the transcript's "will send when
 * this turn finishes" affordance — drain clears it when consumed. */
export function queueSteeredMessage(store: SteerStore, bot: BotRecord, text: string): Message {
  const threadId = bot.threadId;
  const message = store.appendMessage(threadId, { role: "user", kind: "text", text, queued: true });
  const entry = queues.get(threadId) ?? { botId: bot.id, items: [] };
  entry.items.push({ messageId: message.id, text });
  queues.set(threadId, entry);
  return message;
}

/** Every queue entry this bot owns — a bot can hold entries across a
 * thread switch, so the queue controls address the BOT, not one thread. */
function entriesFor(botId: string): Array<[string, QueueEntry]> {
  return [...queues.entries()].filter(([, entry]) => entry.botId === botId);
}

function snapshotOf(botId: string): SteerQueueSnapshot | null {
  const entries = entriesFor(botId);
  if (!entries.length) return null;
  const items: QueuedSendMessage[] = entries.flatMap(([threadId, entry]) =>
    entry.items.map((item) => ({ messageId: item.messageId, threadId, text: item.text })),
  );
  // Held only when every entry waits: a mixed state self-heals through the
  // strip (the next hold/release applies to all of them).
  return { botId, paused: entries.every(([, entry]) => entry.paused === true), items };
}

/** Everything this bot has waiting, as the composer strip renders it.
 * null when nothing waits: a queue that drained — or died with a restart —
 * shows NO strip, the same honesty as a stranded `queued` flag. */
export function steerQueueSnapshot(botId: string): SteerQueueSnapshot | null {
  return snapshotOf(botId);
}

/** Per-item remove: take ONE send off the queue. The words stay in the
 * transcript — removing cancels the auto-run intent, never the record (the
 * durability rule this module's header already promises). `removed:false`
 * means the queue already moved on, so a double-click can never remove
 * twice or remove someone else's message. */
/** Result of removing one queued send: whether it was found, plus the
 * post-removal snapshot so the caller can re-render without a refetch. */
export interface RemoveQueuedSendResult {
  removed: boolean;
  queue: SteerQueueSnapshot | null;
}

export function removeQueuedSend(
  store: SteerStore,
  botId: string,
  messageId: string,
): RemoveQueuedSendResult {
  for (const [threadId, entry] of entriesFor(botId)) {
    const at = entry.items.findIndex((item) => item.messageId === messageId);
    if (at === -1) continue;
    entry.items.splice(at, 1);
    // the transcript's "will send" affordance leaves with the queue item
    store.patchMessage(threadId, messageId, { queued: undefined });
    if (!entry.items.length) queues.delete(threadId); // no empty shells behind
    return { removed: true, queue: snapshotOf(botId) };
  }
  return { removed: false, queue: snapshotOf(botId) };
}

/** Hold (or release) every queue entry for a bot. A held entry is skipped
 * by drain — even while the bot is idle — until an explicit resume. False
 * when this bot has nothing waiting: there is no queue to hold. */
export function setSteerQueuePaused(botId: string, paused: boolean): boolean {
  const entries = entriesFor(botId);
  if (!entries.length) return false;
  for (const [, entry] of entries) entry.paused = paused;
  return true;
}

/** Drain every queue whose bot is idle: one run per thread, prompt = the
 * queued texts joined with newlines. `userMessage` is the last queued
 * message so the caller's startTurn appends nothing new — the messages are
 * already in the transcript. Entries are removed BEFORE running so a
 * settle racing another settle can never fire the same queue twice.
 * `run` may reject: a transient busy refusal (status 409) puts the entry
 * back for the next settle (max MAX_REQUEUES times, affordance restored);
 * every other failure — and the requeue budget running out — reaches
 * `onGiveUp` so the caller can say so in the thread. Nothing is ever
 * dropped silently. */
export function drainSteeredMessages(
  store: SteerStore,
  run: (botId: string, threadId: string, prompt: string, userMessage: Message) => void | Promise<void>,
  onGiveUp: (threadId: string, error: PossiblyHttpError) => void = () => {},
): void {
  // deleting only the entry being visited is safe under Map iteration
  for (const [threadId, entry] of queues) {
    const bot = store.bot(entry.botId);
    if (!bot) {
      // the bot was deleted while messages waited — nothing left to steer
      queues.delete(threadId);
      continue;
    }
    // held by the user: wait for an explicit resume — even an idle bot
    // must not spend words the strip is still promising to send later
    if (entry.paused) continue;
    if (bot.busy) continue; // still working — the next settle tries again
    // committed to draining: the entry leaves the map before anything runs,
    // so a settle racing another settle can never fire the same queue twice
    queues.delete(threadId);
    // clear the affordance before dispatch, so the user never sees
    // "queued" on a message the bot is already answering
    let last: Message | null = null;
    for (const item of entry.items) {
      last = store.patchMessage(threadId, item.messageId, { queued: undefined }) ?? last;
    }
    // every queued message gone from the store = the thread itself was
    // deleted out from under the queue; there is nothing to run against
    if (!last) continue;
    const prompt = entry.items.map((item) => item.text).join("\n");
    // A synchronous throw from run is folded into the same rejection path.
    let settled: void | Promise<void>;
    try {
      settled = run(entry.botId, threadId, prompt, last);
    } catch (error) {
      settled = Promise.reject(error);
    }
    void Promise.resolve(settled).catch((error: PossiblyHttpError) => {
      const transient = isHttpError(error) && error.status === 409;
      if (transient && (entry.attempts ?? 0) < MAX_REQUEUES) {
        // The bot went busy again between this settle and the dispatch —
        // the user's words wait for the next settle, in front of anything
        // queued since, with the affordance restored so the promise is
        // visible again.
        entry.attempts = (entry.attempts ?? 0) + 1;
        const waiting = queues.get(threadId);
        if (waiting) {
          waiting.items = [...entry.items, ...waiting.items];
          waiting.attempts = entry.attempts;
        } else {
          queues.set(threadId, entry);
        }
        for (const item of entry.items) {
          store.patchMessage(threadId, item.messageId, { queued: true });
        }
        return;
      }
      onGiveUp(threadId, error);
    });
  }
}

/** Test helper: how many messages remain queued for a thread. */
export function _queuedCount(threadId: string): number {
  return queues.get(threadId)?.items.length ?? 0;
}
