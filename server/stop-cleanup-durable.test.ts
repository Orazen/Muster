// A failed Stop has to survive the process that failed it. These cases use the
// real handoff queue, the real transcript database and a real `Store`, then
// re-initialise them the way a restart does: the receipt is lost from memory,
// the queue file and the database row are not. The boot wiring exercised here is
// the same `settleInterruptedStopCleanups` call the server makes before its queue
// drain; the HTTP boot glue itself is not spawned in this file.
import { mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeMessageDb, pendingStopCleanupReceipts, settleStopCleanupReceipt, stopCleanupJournal, stopCleanupReceiptState } from "./message-db.ts";
import { Store, type BotRecord, type Message } from "./store.ts";
import type { CommsBus } from "./comms-visibility.ts";
import { _loadPending, _pendingCount, _resetPending, discardDelegations, discardDelegationSnapshot, drainDelegations, pendingThreads, queueDelegation, snapshotDelegations } from "./delegations.ts";
import {
  STOP_CLEANUP_PENDING_MESSAGE, STOP_CLEANUP_RESTART_SETTLED, STOP_CLEANUP_RESTART_UNRESOLVED,
  StopCleanupRegistry, settleInterruptedStopCleanups,
} from "./stop-cleanup.ts";

const queueFile = join(DATA_DIR, "delegations.json");
const TTL = 24 * 60 * 60_000;
let store: Store;
let from: BotRecord;
let target: BotRecord;
let bus: CommsBus;

function queue(message: string, threadId = from.threadId): void {
  expect(queueDelegation(bus, from, { toBotId: target.id, message, depth: 0 }, 1, {
    ownerId: "local", fromBotId: from.id, sourceThreadId: threadId, taskId: threadId, depth: 0, operation: "delegate_bot",
  })).toBe("ok");
}

/** Make the queue file unwritable the way a full or read-only disk would. */
function obstruct(): () => void {
  renameSync(queueFile, `${queueFile}.preserved`);
  mkdirSync(queueFile);
  return () => {
    rmSync(queueFile, { recursive: true });
    renameSync(`${queueFile}.preserved`, queueFile);
  };
}

/** A restart: no in-memory registry, no loaded queue, no open database handle —
 * the durable rows, the queue file and the bots are whatever was left behind. */
function restart(): void {
  _resetPending();
  closeMessageDb();
  store = new Store(() => ({ instanceId: "fake", model: "fake" }));
  bus = { store, broadcast: () => {} };
}

/** The server's startup sequence for failed Stops, minus HTTP: load the queue,
 * settle what a previous process could not, report it, and name the threads the
 * drain must leave alone. */
function boot() {
  const queueLoaded = _loadPending();
  const results = settleInterruptedStopCleanups({
    journal: stopCleanupJournal(),
    queueLoaded,
    botOwner: (botId) => {
      const bot = store.bot(botId);
      return bot ? bot.ownerId || "local" : undefined;
    },
    botThread: (botId) => store.bot(botId)?.threadId,
    isLiveTask: (botId, threadId) => Boolean(store.taskByThread(botId, threadId)),
    cancelQueue: discardDelegationSnapshot,
  });
  for (const result of results) {
    if (!result.threadId || !result.note) continue;
    store.appendMessage(result.threadId, { role: "bot", kind: "activity", tool: { name: result.note, ok: false } });
  }
  const blocked = new Set(results.flatMap((result) => result.state === "unresolved" ? result.capturedThreads : []));
  return { queueLoaded, results, leftover: pendingThreads().filter((threadId) => !blocked.has(threadId)) };
}

const notes = (threadId: string, note: string): Message[] =>
  store.messagesFor(threadId).filter((message) => message.tool?.name === note);

/** Issue the receipt a real failed Stop leaves behind. */
function failedStop() {
  const captured = snapshotDelegations(from.threadId);
  const registry = new StopCleanupRegistry(Date.now, TTL, stopCleanupJournal());
  registry.begin(from.id, "local");
  const token = registry.issue(from.id, "local", [captured]);
  return { token, registry };
}

/** Obstruct, fail the Stop, restore — the shape every case below starts from. */
function obstructedStop() {
  const restore = obstruct();
  try {
    expect(discardDelegations(bus, from.threadId)).toBe(false);
    return failedStop();
  } finally { restore(); }
}

beforeEach(() => {
  closeMessageDb();
  _resetPending();
  rmSync(DATA_DIR, { recursive: true, force: true });
  store = new Store(() => ({ instanceId: "fake", model: "fake" }));
  from = store.createBot();
  target = store.createBot();
  bus = { store, broadcast: () => {} };
});
afterEach(() => { closeMessageDb(); _resetPending(); vi.restoreAllMocks(); });

describe("failed Stop receipts that outlive their process", () => {
  it("records the owner, bot, generation and exact captured queue ids in the database", () => {
    queue("original");
    const { token } = obstructedStop();
    const durable = stopCleanupReceiptState(from.id, token);
    expect(durable).toEqual({ status: "pending", failedAt: expect.any(Number), reason: STOP_CLEANUP_PENDING_MESSAGE });
    // Read the row the way another process would: straight from the file, not
    // through the accessors that wrote it.
    const db = new DatabaseSync(join(DATA_DIR, "messages.db"));
    try {
      const row = db.prepare("SELECT owner_id, generation_id, token, snapshots, failed_at, reason, status, settled_at FROM stop_cleanup_receipts WHERE bot_id = ?").get(from.id);
      expect(row).toBeDefined();
      expect(row!.owner_id).toBe("local");
      expect(row!.generation_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(row!.token).toBe(token);
      expect(row!.status).toBe("pending");
      expect(row!.settled_at).toBeNull();
      expect(row!.failed_at).toBe(durable!.failedAt);
      expect(row!.reason).toBe(STOP_CLEANUP_PENDING_MESSAGE);
      expect(JSON.parse(String(row!.snapshots))).toEqual([{ threadId: from.threadId, itemIds: [expect.any(String)] }]);
    } finally { db.close(); }
    expect(pendingStopCleanupReceipts()).toEqual([{
      botId: from.id, ownerId: "local", generationId: expect.any(String), token,
      snapshots: [{ threadId: from.threadId, itemIds: [expect.any(String)] }],
      failedAt: durable!.failedAt, reason: STOP_CLEANUP_PENDING_MESSAGE,
    }]);
  });

  it("cancels the captured handoffs at restart, resumes nothing, and says the Stop is uncertain", async () => {
    queue("must stay canceled");
    const restore = obstruct();
    let token = "";
    try {
      expect(discardDelegations(bus, from.threadId)).toBe(false);
      const stopped = failedStop();
      token = stopped.token;
      // The retry the user was told to make is still the failing one here.
      expect(stopped.registry.retry(from.id, "local", token, () => true, discardDelegationSnapshot)).toBe("pending");
      expect(pendingStopCleanupReceipts()).toHaveLength(1);
    } finally { restore(); }

    restart();
    expect(store.bot(from.id)).toBeDefined();
    expect(notes(from.threadId, STOP_CLEANUP_RESTART_SETTLED)).toEqual([]);
    const started = boot();
    expect(started.queueLoaded).toBe(true);
    expect(started.results).toEqual([{
      botId: from.id, state: "settled", threadId: from.threadId,
      note: STOP_CLEANUP_RESTART_SETTLED, capturedThreads: [from.threadId],
    }]);
    // The queue file no longer holds the stopped handoff, it is not in memory,
    // the boot drain has nothing left to run for it, and the thread says so.
    expect(JSON.parse(readFileSync(queueFile, "utf8"))[from.threadId] ?? []).toEqual([]);
    expect(_pendingCount(from.threadId)).toBe(0);
    expect(started.leftover).toEqual([]);
    const run = vi.fn();
    drainDelegations(bus, { store, broadcast: () => {} }, from.threadId, run);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(run).not.toHaveBeenCalled();
    expect(notes(from.threadId, STOP_CLEANUP_RESTART_SETTLED)).toHaveLength(1);
    expect(stopCleanupReceiptState(from.id, token)).toEqual({ status: "settled", failedAt: expect.any(Number), reason: STOP_CLEANUP_PENDING_MESSAGE });
    expect(pendingStopCleanupReceipts()).toEqual([]);
  });

  it("applies a consumed receipt only once, leaving later handoffs alone", () => {
    queue("must stay canceled");
    const { token } = obstructedStop();
    restart();
    expect(boot().results.map((result) => result.state)).toEqual(["settled"]);
    // A handoff queued after the failed Stop is not covered by its capture.
    queue("later arrival");
    const consumed = stopCleanupReceiptState(from.id, token);
    restart();
    const second = boot();
    expect(second.results).toEqual([]);
    expect(second.leftover).toEqual([from.threadId]);
    expect(settleStopCleanupReceipt(from.id, token, Date.now())).toBe(false);
    expect(stopCleanupReceiptState(from.id, token)).toEqual(consumed);
    expect(notes(from.threadId, STOP_CLEANUP_RESTART_SETTLED)).toHaveLength(1);
    expect(_pendingCount(from.threadId)).toBe(1);
  });

  it("keeps the ordinary path: a cleanup that completes leaves nothing durable behind", () => {
    queue("original");
    const { token, registry } = obstructedStop();
    expect(registry.retry(from.id, "local", token, () => true, discardDelegationSnapshot)).toBe("ok");
    expect(stopCleanupReceiptState(from.id, token)).toBeUndefined();
    expect(pendingStopCleanupReceipts()).toEqual([]);
    restart();
    const started = boot();
    expect(started.results).toEqual([]);
    expect(_pendingCount(from.threadId)).toBe(0);
    expect(notes(from.threadId, STOP_CLEANUP_RESTART_SETTLED)).toEqual([]);
    expect(notes(from.threadId, STOP_CLEANUP_RESTART_UNRESOLVED)).toEqual([]);
  });

  it("keeps the ordinary Stop path: a successful queue removal records no receipt", () => {
    queue("original");
    expect(discardDelegations(bus, from.threadId)).toBe(true);
    expect(pendingStopCleanupReceipts()).toEqual([]);
    restart();
    const started = boot();
    expect(started.results).toEqual([]);
    expect(_pendingCount(from.threadId)).toBe(0);
    expect(notes(from.threadId, STOP_CLEANUP_RESTART_SETTLED)).toEqual([]);
  });

  it("keeps a receipt pending when the queue itself could not be read at boot", () => {
    queue("must stay canceled");
    const { token } = obstructedStop();

    // Restart while the queue file is still unreadable: nothing was loaded, so
    // an absent ID cannot be told from one this process never saw.
    const blocked = obstruct();
    try {
      restart();
      const first = boot();
      expect(first.queueLoaded).toBe(false);
      expect(first.results).toEqual([{
        botId: from.id, state: "unresolved", threadId: from.threadId,
        note: STOP_CLEANUP_RESTART_UNRESOLVED, capturedThreads: [from.threadId],
      }]);
      expect(pendingStopCleanupReceipts()).toHaveLength(1);
      expect(notes(from.threadId, STOP_CLEANUP_RESTART_SETTLED)).toEqual([]);
      expect(notes(from.threadId, STOP_CLEANUP_RESTART_UNRESOLVED)).toHaveLength(1);
    } finally { blocked(); }

    // The next boot can read the queue, so the receipt applies then — once.
    restart();
    const second = boot();
    expect(second.queueLoaded).toBe(true);
    expect(second.results.map((result) => result.state)).toEqual(["settled"]);
    expect(_pendingCount(from.threadId)).toBe(0);
    expect(stopCleanupReceiptState(from.id, token)).toEqual({ status: "settled", failedAt: expect.any(Number), reason: STOP_CLEANUP_PENDING_MESSAGE });
    expect(pendingStopCleanupReceipts()).toEqual([]);
  });

  it("retires a receipt whose bot is gone without touching the queue or the thread", async () => {
    queue("unreachable");
    obstructedStop();
    expect(store.deleteBot(from.id)).toBe(true);
    restart();
    const started = boot();
    // The receipt is consumed, but a bot that no longer exists has no thread to
    // warn and no reachable queue: nothing is canceled and nothing is dispatched.
    expect(started.results).toEqual([{ botId: from.id, state: "retired", capturedThreads: [] }]);
    expect(pendingStopCleanupReceipts()).toEqual([]);
    expect(notes(from.threadId, STOP_CLEANUP_RESTART_SETTLED)).toEqual([]);
    expect(notes(from.threadId, STOP_CLEANUP_RESTART_UNRESOLVED)).toEqual([]);
    expect(_pendingCount(from.threadId)).toBe(1);
    const run = vi.fn();
    drainDelegations(bus, { store, broadcast: () => {} }, from.threadId, run);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(run).not.toHaveBeenCalled();
  });

  it("reports the durable state to a reload that still holds a receipt token", () => {
    queue("original");
    const { token } = obstructedStop();
    // Before any restart the issuing process still owns it; a foreign bot's
    // claim on the same token is not reported as anything.
    const fresh = new StopCleanupRegistry(Date.now, TTL, stopCleanupJournal());
    expect(fresh.current(from.id, "local", token)).toBe(false);
    expect(fresh.durableState(from.id, token)?.status).toBe("pending");
    expect(fresh.durableState(target.id, token)).toBeUndefined();
    restart();
    boot();
    expect(new StopCleanupRegistry(Date.now, TTL, stopCleanupJournal()).durableState(from.id, token)?.status).toBe("settled");
  });
});
