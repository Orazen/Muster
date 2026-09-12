import { mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeMessageDb } from "./message-db.ts";
import { Store, type BotRecord } from "./store.ts";
import type { CommsBus } from "./comms-visibility.ts";
import { _resetPending, _pendingCount, _loadPending, queueDelegation, snapshotDelegations, discardDelegations, discardDelegationSnapshot, drainDelegations } from "./delegations.ts";
import { StopCleanupRegistry } from "./stop-cleanup.ts";

const queueFile = join(DATA_DIR, "delegations.json");
let store: Store;
let from: BotRecord;
let target: BotRecord;
let bus: CommsBus;
function queue(message: string, threadId = from.threadId): void {
  expect(queueDelegation(bus, from, { toBotId: target.id, message, depth: 0 }, 1, {
    ownerId: "local", fromBotId: from.id, sourceThreadId: threadId, taskId: threadId, depth: 0, operation: "delegate_bot",
  })).toBe("ok");
}
function obstruct(): () => void {
  renameSync(queueFile, `${queueFile}.preserved`);
  mkdirSync(queueFile);
  return () => {
    rmSync(queueFile, { recursive: true });
    renameSync(`${queueFile}.preserved`, queueFile);
  };
}
beforeEach(() => {
  closeMessageDb(); _resetPending();
  rmSync(DATA_DIR, { recursive: true, force: true });
  store = new Store(() => ({ instanceId: "fake", model: "fake" }));
  from = store.createBot(); target = store.createBot();
  bus = { store, broadcast: () => {} };
});
afterEach(() => { closeMessageDb(); _resetPending(); vi.restoreAllMocks(); });

describe("exact original queue cleanup with real durable storage", () => {
  it("retains the failed disk removal, retries only its IDs, and survives a queue reload", () => {
    queue("original");
    const original = snapshotDelegations(from.threadId);
    const restore = obstruct();
    try {
      expect(discardDelegations(bus, from.threadId)).toBe(false);
      expect(discardDelegationSnapshot(original)).toBe(false);
      expect(_pendingCount(from.threadId)).toBe(1);
    } finally { restore(); }
    expect(discardDelegationSnapshot(original)).toBe(true);
    _resetPending(); _loadPending();
    expect(_pendingCount(from.threadId)).toBe(0);
    expect(readFileSync(queueFile, "utf8")).toBe("{}");
  });

  it("preserves later arrivals on the same thread and unrelated detached queues", () => {
    queue("original");
    const original = snapshotDelegations(from.threadId);
    const restore = obstruct();
    try { expect(discardDelegations(bus, from.threadId)).toBe(false); } finally { restore(); }
    queue("later");
    const detached = store.createTask(from.id, "Detached", false)!;
    queue("detached", detached.threadId);
    expect(discardDelegationSnapshot(original)).toBe(true);
    _resetPending(); _loadPending();
    expect(_pendingCount(from.threadId)).toBe(1);
    expect(_pendingCount(detached.threadId)).toBe(1);
    const remaining = JSON.parse(readFileSync(queueFile, "utf8"));
    expect(remaining[from.threadId][0].message).toBe("later");
    expect(remaining[detached.threadId][0].message).toBe("detached");
  });

  it("already removed IDs need no disk write even when the destination is obstructed", () => {
    queue("original");
    const original = snapshotDelegations(from.threadId);
    expect(discardDelegations(bus, from.threadId)).toBe(true);
    const restore = obstruct();
    try { expect(discardDelegationSnapshot(original)).toBe(true); } finally { restore(); }
  });

  it("a stale receipt cannot remove later work, even if it carries the same source task", () => {
    const receipts = new StopCleanupRegistry();
    receipts.begin(from.id, "local");
    queue("original");
    const original = snapshotDelegations(from.threadId);
    const restore = obstruct();
    try { expect(discardDelegations(bus, from.threadId)).toBe(false); } finally { restore(); }
    const token = receipts.issue(from.id, "local", [original]);
    receipts.begin(from.id, "local");
    queue("later");
    const before = readFileSync(queueFile, "utf8");
    const cleanup = vi.fn(discardDelegationSnapshot);
    expect(receipts.retry(from.id, "local", token, () => true, cleanup)).toBe("stale");
    expect(cleanup).not.toHaveBeenCalled();
    expect(readFileSync(queueFile, "utf8")).toBe(before);
  });

  it("exact cleanup does not invalidate a later handoff already awaiting target setup", async () => {
    queue("old");
    const old = snapshotDelegations(from.threadId);
    expect(discardDelegations(bus, from.threadId)).toBe(true);
    queue("new setup");
    let validate: (() => boolean) | undefined;
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    drainDelegations(bus, { store, broadcast: () => {} }, from.threadId, async (_id, _text, _depth, _thread, _channel, guard) => {
      validate = guard;
      await held;
    });
    await vi.waitFor(() => expect(validate).toBeTypeOf("function"));
    try {
      expect(validate!()).toBe(true);
      expect(discardDelegationSnapshot(old)).toBe(true);
      expect(validate!()).toBe(true);
    } finally { release!(); }
    await vi.waitFor(() => expect(_pendingCount(from.threadId)).toBe(0));
  });

  it("failed original cleanup keeps the canceled work from dispatching in this process", async () => {
    queue("must stay canceled");
    const original = snapshotDelegations(from.threadId);
    const restore = obstruct();
    try {
      expect(discardDelegations(bus, from.threadId)).toBe(false);
      expect(discardDelegationSnapshot(original)).toBe(false);
      const run = vi.fn();
      drainDelegations(bus, { store, broadcast: () => {} }, from.threadId, run);
      // The canceled row reaches only the failed acknowledgement path; no turn
      // can run. Allow the async drain to finish before lifting the obstruction.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(run).not.toHaveBeenCalled();
      expect(_pendingCount(from.threadId)).toBe(1);
    } finally { restore(); }
  });
});
