// S1 change journal (DESIGN §10): the local, per-object change queue —
// append {objectId, rev, checksum}, drain debounced, retry with backoff,
// idempotent at every edge. These tests pin the QUEUE SEMANTICS; the real
// transport (per-object encrypted upload) and the producer wiring arrive
// with S2's object model, exactly as K1's format half preceded its routes.
//
// The interesting edges are concurrency-shaped even though node is
// single-threaded: a change can arrive while its row is in flight, a
// completion can arrive for a revision the queue has already superseded,
// and a process can die mid-flight. Each must not lose a newer change.

import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  SYNC_CHANGE_MAX_ATTEMPTS,
  claimSyncChanges,
  createSyncChangeDrainer,
  drainSyncChanges,
  enqueueSyncChange,
  markSyncChangeDrained,
  markSyncChangeFailed,
  syncChangeRows,
  syncRetryDelayMs,
  type SyncChangeInput,
  type SyncTransport,
} from "./sync-journal.ts";

const T0 = 1_760_000_000_000;
const dbs: DatabaseSync[] = [];
const freshDb = (): DatabaseSync => {
  const db = new DatabaseSync(":memory:");
  dbs.push(db);
  return db;
};
afterEach(() => {
  while (dbs.length) dbs.pop()?.close();
});

const change = (over: Partial<SyncChangeInput> = {}): SyncChangeInput => ({
  objectId: "memory:bot_alpha",
  objectType: "memory",
  rev: 1,
  checksum: "a".repeat(64),
  ...over,
});

const rowOf = (db: DatabaseSync, objectId: string) =>
  syncChangeRows(db).find((row) => row.objectId === objectId);

describe("enqueueSyncChange", () => {
  it("appends a new change as a pending row", () => {
    const db = freshDb();
    expect(enqueueSyncChange(db, change(), T0)).toBe("enqueued");
    const row = rowOf(db, "memory:bot_alpha");
    expect(row).toMatchObject({
      objectId: "memory:bot_alpha",
      objectType: "memory",
      rev: 1,
      checksum: "a".repeat(64),
      state: "pending",
      attempts: 0,
      enqueuedAt: T0,
      nextAttemptAt: T0,
      claimedAt: null,
    });
  });

  it("treats the same rev and checksum as a duplicate, not a new change", () => {
    const db = freshDb();
    enqueueSyncChange(db, change(), T0);
    expect(enqueueSyncChange(db, change(), T0 + 5_000)).toBe("duplicate");
    const row = rowOf(db, "memory:bot_alpha")!;
    expect(row.enqueuedAt).toBe(T0); // nothing moved
    expect(row.state).toBe("pending");
  });

  it("supersedes with a higher rev and re-pends an in-flight row", () => {
    const db = freshDb();
    enqueueSyncChange(db, change(), T0);
    claimSyncChanges(db, { limit: 10, now: T0, staleMs: 60_000 });
    expect(rowOf(db, "memory:bot_alpha")!.state).toBe("inflight");
    expect(
      enqueueSyncChange(db, change({ rev: 2, checksum: "b".repeat(64) }), T0 + 1_000),
    ).toBe("enqueued");
    const row = rowOf(db, "memory:bot_alpha")!;
    expect(row).toMatchObject({ rev: 2, checksum: "b".repeat(64), state: "pending", claimedAt: null });
  });

  it("refuses a lower rev — an out-of-order write never rewinds the queue", () => {
    const db = freshDb();
    enqueueSyncChange(db, change({ rev: 5 }), T0);
    expect(enqueueSyncChange(db, change({ rev: 4 }), T0 + 1)).toBe("stale");
    expect(rowOf(db, "memory:bot_alpha")!.rev).toBe(5);
  });

  it("refuses a same-rev checksum mismatch — version without content identity is a bug, not a change", () => {
    const db = freshDb();
    enqueueSyncChange(db, change({ rev: 3, checksum: "c".repeat(64) }), T0);
    expect(enqueueSyncChange(db, change({ rev: 3, checksum: "d".repeat(64) }), T0 + 1)).toBe("stale");
    expect(rowOf(db, "memory:bot_alpha")!.checksum).toBe("c".repeat(64));
  });

  it("revives a dead row when a fresh rev arrives", () => {
    const db = freshDb();
    enqueueSyncChange(db, change(), T0);
    for (let i = 0; i < SYNC_CHANGE_MAX_ATTEMPTS; i += 1) {
      claimSyncChanges(db, { limit: 1, now: T0 + i * 600_000, staleMs: 60_000 });
      markSyncChangeFailed(db, "memory:bot_alpha", 1, T0 + i * 600_000);
    }
    expect(rowOf(db, "memory:bot_alpha")!.state).toBe("dead");
    enqueueSyncChange(db, change({ rev: 2, checksum: "e".repeat(64) }), T0 + 9_000_000);
    expect(rowOf(db, "memory:bot_alpha")!.state).toBe("pending");
  });
});

describe("claimSyncChanges", () => {
  it("claims only rows whose backoff has elapsed, oldest delay first", () => {
    const db = freshDb();
    enqueueSyncChange(db, change({ objectId: "a", rev: 1, checksum: "1".repeat(64) }), T0);
    enqueueSyncChange(db, change({ objectId: "b", rev: 1, checksum: "2".repeat(64) }), T0 + 1);
    const first = claimSyncChanges(db, { limit: 1, now: T0, staleMs: 60_000 });
    expect(first.map((row) => row.objectId)).toEqual(["a"]); // b's nextAttemptAt is 1ms in the future
    expect(markSyncChangeFailed(db, "a", 1, T0)).toBe("failed"); // a backs off to T0 + 5s
    const soon = claimSyncChanges(db, { limit: 10, now: T0 + 1_000, staleMs: 60_000 });
    expect(soon.map((row) => row.objectId)).toEqual(["b"]); // b due, a still backing off
    const later = claimSyncChanges(db, { limit: 10, now: T0 + 6_000, staleMs: 60_000 });
    expect(later.map((row) => row.objectId)).toEqual(["a"]); // a's backoff elapsed; b is in flight
    expect(later[0]!.state).toBe("inflight");
    expect(later[0]!.claimedAt).toBe(T0 + 6_000);
  });

  it("excludes rows already in flight and honors the limit", () => {
    const db = freshDb();
    enqueueSyncChange(db, change({ objectId: "a", rev: 1, checksum: "1".repeat(64) }), T0);
    enqueueSyncChange(db, change({ objectId: "b", rev: 1, checksum: "2".repeat(64) }), T0);
    enqueueSyncChange(db, change({ objectId: "c", rev: 1, checksum: "3".repeat(64) }), T0);
    const first = claimSyncChanges(db, { limit: 2, now: T0, staleMs: 60_000 });
    expect(first).toHaveLength(2);
    const second = claimSyncChanges(db, { limit: 5, now: T0, staleMs: 60_000 });
    expect(second).toHaveLength(1); // the one left, not the two claimed
  });

  it("reclaims a crashed in-flight row as a counted attempt, dead at the cap", () => {
    const db = freshDb();
    enqueueSyncChange(db, change(), T0);
    claimSyncChanges(db, { limit: 1, now: T0, staleMs: 60_000 });
    // stale window not yet passed — still in flight
    expect(claimSyncChanges(db, { limit: 5, now: T0 + 30_000, staleMs: 60_000 })).toHaveLength(0);
    const reclaimed = claimSyncChanges(db, { limit: 5, now: T0 + 61_000, staleMs: 60_000 });
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]!.attempts).toBe(1);
    expect(rowOf(db, "memory:bot_alpha")!.state).toBe("inflight");
  });
});

describe("markSyncChangeDrained", () => {
  it("deletes only the revision that actually drained", () => {
    const db = freshDb();
    enqueueSyncChange(db, change({ rev: 1 }), T0);
    claimSyncChanges(db, { limit: 1, now: T0, staleMs: 60_000 });
    enqueueSyncChange(db, change({ rev: 2, checksum: "b".repeat(64) }), T0 + 1);
    // the in-flight upload of rev 1 finishes AFTER rev 2 re-pended the row
    expect(markSyncChangeDrained(db, "memory:bot_alpha", 1)).toBe(false);
    expect(rowOf(db, "memory:bot_alpha")).toMatchObject({ rev: 2, state: "pending" });
    claimSyncChanges(db, { limit: 1, now: T0 + 2, staleMs: 60_000 });
    expect(markSyncChangeDrained(db, "memory:bot_alpha", 2)).toBe(true);
    expect(rowOf(db, "memory:bot_alpha")).toBeUndefined();
  });
});

describe("markSyncChangeFailed", () => {
  it("backs off exponentially and reports dead at the cap", () => {
    const db = freshDb();
    expect(syncRetryDelayMs(1)).toBe(5_000);
    expect(syncRetryDelayMs(2)).toBe(10_000);
    expect(syncRetryDelayMs(9)).toBe(300_000); // capped at five minutes
    enqueueSyncChange(db, change(), T0);
    claimSyncChanges(db, { limit: 1, now: T0, staleMs: 60_000 });
    expect(markSyncChangeFailed(db, "memory:bot_alpha", 1, T0)).toBe("failed");
    expect(rowOf(db, "memory:bot_alpha")).toMatchObject({
      state: "pending",
      attempts: 1,
      nextAttemptAt: T0 + 5_000,
      claimedAt: null,
    });
  });

  it("ignores a completion for a revision the queue no longer tracks", () => {
    const db = freshDb();
    enqueueSyncChange(db, change({ rev: 1 }), T0);
    claimSyncChanges(db, { limit: 1, now: T0, staleMs: 60_000 });
    enqueueSyncChange(db, change({ rev: 2, checksum: "b".repeat(64) }), T0 + 1);
    expect(markSyncChangeFailed(db, "memory:bot_alpha", 1, T0 + 2)).toBe("superseded");
    const row = rowOf(db, "memory:bot_alpha")!;
    expect(row).toMatchObject({ rev: 2, state: "pending", attempts: 0 });
  });
});

describe("drainSyncChanges", () => {
  it("drains successes, retries failures, and never redelivers a drained row", async () => {
    const db = freshDb();
    enqueueSyncChange(db, change(), T0);
    const seen: number[] = [];
    const flaky: SyncTransport = () => {
      seen.push(1);
      if (seen.length === 1) throw new Error("transport down");
    };
    const first = await drainSyncChanges(db, { transport: flaky, now: T0 });
    expect(first).toEqual({ claimed: 1, drained: 0, failed: 1, dead: 0 });
    expect(rowOf(db, "memory:bot_alpha")).toMatchObject({ state: "pending", attempts: 1 });
    // inside the backoff: nothing to claim
    const second = await drainSyncChanges(db, { transport: flaky, now: T0 + 1_000 });
    expect(second.claimed).toBe(0);
    // after the backoff: retried once, then gone for good
    const third = await drainSyncChanges(db, { transport: flaky, now: T0 + 6_000 });
    expect(third).toEqual({ claimed: 1, drained: 1, failed: 0, dead: 0 });
    expect(seen).toHaveLength(2);
    const fourth = await drainSyncChanges(db, { transport: flaky, now: T0 + 600_000 });
    expect(fourth.claimed).toBe(0); // idempotent: no ghost redelivery
  });

  it("moves a persistently failing row to dead instead of retrying forever", async () => {
    const db = freshDb();
    enqueueSyncChange(db, change(), T0);
    const failing: SyncTransport = () => {
      throw new Error("always down");
    };
    let now = T0;
    let last: Awaited<ReturnType<typeof drainSyncChanges>> = {
      claimed: 0,
      drained: 0,
      failed: 0,
      dead: 0,
    };
    for (let i = 0; i < SYNC_CHANGE_MAX_ATTEMPTS; i += 1) {
      last = await drainSyncChanges(db, { transport: failing, now });
      now += 400_000; // step past any backoff
    }
    expect(last.dead).toBe(1);
    expect(rowOf(db, "memory:bot_alpha")!.state).toBe("dead");
    const after = await drainSyncChanges(db, { transport: failing, now: now + 600_000 });
    expect(after.claimed).toBe(0); // dead rows are never claimed again
  });
});

describe("createSyncChangeDrainer", () => {
  it("coalesces a burst of change notifications into one debounced drain", async () => {
    const db = freshDb();
    const calls: number[] = [];
    const drainer = createSyncChangeDrainer({
      db,
      transport: () => {
        calls.push(Date.now());
      },
      debounceMs: 50,
      now: () => T0,
    });
    enqueueSyncChange(db, change({ objectId: "x", rev: 1, checksum: "1".repeat(64) }), T0);
    drainer.notify();
    enqueueSyncChange(db, change({ objectId: "y", rev: 1, checksum: "2".repeat(64) }), T0);
    drainer.notify();
    enqueueSyncChange(db, change({ objectId: "z", rev: 1, checksum: "3".repeat(64) }), T0);
    drainer.notify();
    const flushed = await drainer.flush();
    expect(flushed.claimed).toBe(3); // all three arrived before the window closed
    expect(calls).toHaveLength(3); // one drain pass, not three
    expect(syncChangeRows(db)).toHaveLength(0);
  });

  it("stop() cancels a pending debounce so no drain fires afterward", async () => {
    const db = freshDb();
    const calls: number[] = [];
    const drainer = createSyncChangeDrainer({
      db,
      transport: () => {
        calls.push(1);
      },
      debounceMs: 50,
      now: () => T0,
    });
    enqueueSyncChange(db, change(), T0);
    drainer.notify();
    drainer.stop();
    drainer.notify(); // a notify after stop is inert
    const flushed = await drainer.flush();
    expect(flushed.claimed).toBe(0);
    expect(calls).toHaveLength(0);
    expect(syncChangeRows(db)).toHaveLength(1); // the change survives for S2
  });
});

describe("input validation", () => {
  it("refuses malformed changes at the boundary", () => {
    const db = freshDb();
    expect(() => enqueueSyncChange(db, change({ objectId: "" }), T0)).toThrow();
    expect(() => enqueueSyncChange(db, change({ objectType: "" }), T0)).toThrow();
    expect(() => enqueueSyncChange(db, change({ rev: 0 }), T0)).toThrow();
    expect(() => enqueueSyncChange(db, change({ rev: 1.5 }), T0)).toThrow();
    expect(() => enqueueSyncChange(db, change({ checksum: "not-hex" }), T0)).toThrow();
    expect(() => enqueueSyncChange(db, change({ objectId: "x".repeat(300) }), T0)).toThrow();
    expect(syncChangeRows(db)).toHaveLength(0); // nothing partial landed
  });
});
