// S1 change journal (DESIGN §10) — the local, per-object change queue that
// per-object incremental sync (S2) drains: append {objectId, rev, checksum},
// debounced drain, exponential retry, idempotent at every edge.
//
// One row per object (objectId is the primary key): a newer rev supersedes
// the queued work rather than stacking behind it, because the upload unit is
// "<objectId>-<rev>.enc" — only the newest rev is ever worth sending. The
// edges this file exists to survive, all pinned by tests:
//   - a change arrives while its row is in flight → the row re-pends at the
//     new rev, and the old upload's completion (success OR failure) becomes
//     a no-op instead of clobbering newer work (rev-guarded callbacks);
//   - a process dies mid-flight → the stale window reclaims the row as a
//     counted attempt, dead-letters at the cap instead of retrying forever;
//   - producers re-notify the same change → duplicate is a no-op.
//
// Producers (which local writes enqueue) and the real transport (encrypted
// per-object upload) arrive with S2's object model — same scoping K1's
// format half used before its routes. createSyncChangeDrainer ships the
// debounced loop now so S2 only has to wire a transport and call notify().

import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import { recordSyncEvent } from "./sync-events.ts";

/** Attempts (claims that failed or crashed rows counted as) before a row is
 * dead-lettered — visible in syncChangeRows, never silently dropped. */
export const SYNC_CHANGE_MAX_ATTEMPTS = 12;
const DEFAULT_DRAIN_LIMIT = 32;
const DEFAULT_STALE_MS = 60_000;
const DEFAULT_DEBOUNCE_MS = 250;

/** Backoff before retry number `attempts`: 5s doubling to a 5-minute cap. */
export function syncRetryDelayMs(attempts: number): number {
  const n = attempts < 1 ? 1 : attempts;
  return Math.min(5_000 * 2 ** (n - 1), 300_000);
}

const printable = (value: string): boolean =>
  [...value].every((char) => {
    const code = char.charCodeAt(0);
    return code >= 32 && code !== 127;
  });

const changeInputSchema = z
  .object({
    objectId: z.string().min(1).max(256).refine(printable),
    objectType: z.string().min(1).max(64).refine(printable),
    rev: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    checksum: z.string().regex(/^[0-9a-f]{8,128}$/i),
    /** P5a: a producer that knows its enqueue is a deletion says so here, so
     * the typed receipt can say `deleted` rather than guessing from a rev.
     * Absent means "not a tombstone" — the pre-P5 behavior, unchanged. */
    tombstone: z.boolean().optional(),
  })
  .strict();

export type SyncChangeInput = z.infer<typeof changeInputSchema>;

const rowSchema = z.object({
  objectId: z.string(),
  objectType: z.string(),
  rev: z.number().int(),
  checksum: z.string(),
  state: z.enum(["pending", "inflight", "dead"]),
  attempts: z.number().int(),
  enqueuedAt: z.number().int(),
  nextAttemptAt: z.number().int(),
  claimedAt: z.number().int().nullable(),
});

export type SyncJournalRow = z.infer<typeof rowSchema>;

export type EnqueueOutcome = "enqueued" | "duplicate" | "stale";
export type FailureOutcome = "failed" | "dead" | "superseded";
export interface DrainResult {
  claimed: number;
  drained: number;
  failed: number;
  dead: number;
}
/** The upload unit S2 implements; S1 only sequences calls against it. */
export type SyncTransport = (row: SyncJournalRow) => Promise<void> | void;

const initialized = new WeakSet<DatabaseSync>();
function initialize(db: DatabaseSync): void {
  if (initialized.has(db)) return;
  db.exec(`CREATE TABLE IF NOT EXISTS sync_journal (
    objectId TEXT PRIMARY KEY,
    objectType TEXT NOT NULL,
    rev INTEGER NOT NULL,
    checksum TEXT NOT NULL,
    state TEXT NOT NULL,
    attempts INTEGER NOT NULL,
    enqueuedAt INTEGER NOT NULL,
    nextAttemptAt INTEGER NOT NULL,
    claimedAt INTEGER
  ); CREATE INDEX IF NOT EXISTS sync_journal_due ON sync_journal(state, nextAttemptAt)`);
  initialized.add(db);
}

function readRow(db: DatabaseSync, objectId: string): SyncJournalRow | null {
  const stmt = db.prepare(
    `SELECT objectId, objectType, rev, checksum, state, attempts, enqueuedAt, nextAttemptAt, claimedAt
     FROM sync_journal WHERE objectId = ?`,
  );
  const row = stmt.get(objectId);
  if (!row) return null;
  return rowSchema.parse(row);
}

/** Queue one local change. A higher rev supersedes queued work (resetting its
 * retry state); the same rev+checksum is a duplicate no-op; anything else —
 * an out-of-order rev, or a same-rev checksum that disagrees — is stale and
 * never touches the row. */
export function enqueueSyncChange(
  db: DatabaseSync,
  entry: SyncChangeInput,
  now: number,
): EnqueueOutcome {
  const input = changeInputSchema.parse(entry);
  initialize(db);
  const existing = readRow(db, input.objectId);
  if (!existing) {
    db.prepare(
      `INSERT INTO sync_journal (objectId, objectType, rev, checksum, state, attempts, enqueuedAt, nextAttemptAt, claimedAt)
       VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, NULL)`,
    ).run(input.objectId, input.objectType, input.rev, input.checksum, now, now);
    // P5a: the receipt view of the queue. Only a row that was really
    // queued earns an event — a duplicate or stale enqueue is not a change.
    recordSyncEvent({
      objectId: input.objectId,
      objectType: input.objectType,
      rev: input.rev,
      tombstone: input.tombstone === true,
      at: now,
    });
    return "enqueued";
  }
  if (input.rev === existing.rev) {
    return input.checksum === existing.checksum ? "duplicate" : "stale";
  }
  if (input.rev < existing.rev) return "stale";
  // Loop200 fix: this UPDATE's first bound value feeds `objectType`, and it
  // was bound to `objectId` — so the second and every later push of an
  // object overwrote its type with its id, the P4 dispatcher then routed it
  // to the wrong producer, and the push retried to a dead letter. One
  // argument order, silent for every object after its first rev.
  db.prepare(
    `UPDATE sync_journal SET objectType = ?, rev = ?, checksum = ?, state = 'pending',
       attempts = 0, enqueuedAt = ?, nextAttemptAt = ?, claimedAt = NULL
     WHERE objectId = ?`,
  ).run(input.objectType, input.rev, input.checksum, now, now, input.objectId);
  recordSyncEvent({
    objectId: input.objectId,
    objectType: input.objectType,
    rev: input.rev,
    tombstone: input.tombstone === true,
    at: now,
  });
  return "enqueued";
}

/** Due pending rows, oldest delay first, marked in flight — after reclaiming
 * rows whose claimant died (stale window): each such crash counts as an
 * attempt and, at the cap, dead-letters instead of looping. */
export function claimSyncChanges(
  db: DatabaseSync,
  opts: { limit: number; now: number; staleMs: number },
): SyncJournalRow[] {
  initialize(db);
  const { limit, now, staleMs } = opts;
  const stale = db
    .prepare(
      `SELECT objectId, objectType, rev, checksum, state, attempts, enqueuedAt, nextAttemptAt, claimedAt
       FROM sync_journal WHERE state = 'inflight' AND claimedAt IS NOT NULL AND claimedAt < ?`,
    )
    .all(now - staleMs);
  for (const raw of stale) {
    const row = rowSchema.parse(raw);
    const attempts = row.attempts + 1;
    if (attempts >= SYNC_CHANGE_MAX_ATTEMPTS) {
      db.prepare(
        `UPDATE sync_journal SET state = 'dead', attempts = ?, claimedAt = NULL WHERE objectId = ? AND rev = ?`,
      ).run(attempts, row.objectId, row.rev);
    } else {
      db.prepare(
        `UPDATE sync_journal SET state = 'pending', attempts = ?, claimedAt = NULL, nextAttemptAt = ?
         WHERE objectId = ? AND rev = ?`,
      ).run(attempts, now, row.objectId, row.rev);
    }
  }
  const due = db
    .prepare(
      `SELECT objectId, objectType, rev, checksum, state, attempts, enqueuedAt, nextAttemptAt, claimedAt
       FROM sync_journal WHERE state = 'pending' AND nextAttemptAt <= ?
       ORDER BY nextAttemptAt ASC, enqueuedAt ASC LIMIT ?`,
    )
    .all(now, limit);
  const claimed: SyncJournalRow[] = [];
  for (const raw of due) {
    const row = rowSchema.parse(raw);
    const result = db
      .prepare(
        `UPDATE sync_journal SET state = 'inflight', claimedAt = ? WHERE objectId = ? AND rev = ? AND state = 'pending'`,
      )
      .run(now, row.objectId, row.rev);
    if (Number(result.changes) === 0) continue;
    claimed.push({ ...row, state: "inflight", claimedAt: now });
  }
  return claimed;
}

/** Rev-guarded completion: deletes only the revision that actually drained,
 * so a slow upload finishing after newer work re-pended the row is a no-op. */
export function markSyncChangeDrained(db: DatabaseSync, objectId: string, rev: number): boolean {
  initialize(db);
  const result = db
    .prepare(`DELETE FROM sync_journal WHERE objectId = ? AND rev = ?`)
    .run(objectId, rev);
  return Number(result.changes) > 0;
}

/** Rev-guarded failure: backs the row off exponentially (dead at the cap).
 * A row the queue has moved on from reports "superseded" untouched. */
export function markSyncChangeFailed(
  db: DatabaseSync,
  objectId: string,
  rev: number,
  now: number,
): FailureOutcome {
  initialize(db);
  const existing = readRow(db, objectId);
  if (!existing || existing.state !== "inflight" || existing.rev !== rev) return "superseded";
  const attempts = existing.attempts + 1;
  if (attempts >= SYNC_CHANGE_MAX_ATTEMPTS) {
    db.prepare(
      `UPDATE sync_journal SET state = 'dead', attempts = ?, claimedAt = NULL WHERE objectId = ? AND rev = ?`,
    ).run(attempts, objectId, rev);
    return "dead";
  }
  db.prepare(
    `UPDATE sync_journal SET state = 'pending', attempts = ?, claimedAt = NULL, nextAttemptAt = ?
     WHERE objectId = ? AND rev = ?`,
  ).run(attempts, now + syncRetryDelayMs(attempts), objectId, rev);
  return "failed";
}

/** Claim → transport → rev-guarded completion, in one pass. Safe to call
 * concurrently: a second call joins the in-flight pass rather than racing it. */
export async function drainSyncChanges(
  db: DatabaseSync,
  opts: { transport: SyncTransport; now?: number; limit?: number; staleMs?: number },
): Promise<DrainResult> {
  const now = opts.now ?? Date.now();
  const claimed = claimSyncChanges(db, {
    limit: opts.limit ?? DEFAULT_DRAIN_LIMIT,
    now,
    staleMs: opts.staleMs ?? DEFAULT_STALE_MS,
  });
  const result: DrainResult = { claimed: claimed.length, drained: 0, failed: 0, dead: 0 };
  for (const row of claimed) {
    try {
      await opts.transport(row);
      markSyncChangeDrained(db, row.objectId, row.rev);
      result.drained += 1;
    } catch {
      const outcome = markSyncChangeFailed(db, row.objectId, row.rev, now);
      if (outcome === "dead") result.dead += 1;
      else result.failed += 1;
    }
  }
  return result;
}

export interface SyncChangeDrainer {
  /** Call after enqueueing; repeats coalesce into one debounce window. */
  notify(): void;
  /** Drain now (clearing any pending debounce). Inert after stop(). */
  flush(): Promise<DrainResult>;
  /** Cancel the pending debounce. An in-flight pass completes on its own. */
  stop(): void;
}

/** Debounced background drain. The timer callback joins an in-flight pass
 * rather than starting a second one; producers that enqueue during a pass
 * should notify again (their change is already durable in the queue). */
export function createSyncChangeDrainer(opts: {
  db: DatabaseSync;
  transport: SyncTransport;
  debounceMs?: number;
  staleMs?: number;
  limit?: number;
  now?: () => number;
}): SyncChangeDrainer {
  const now = opts.now ?? Date.now;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let inflight: Promise<DrainResult> | null = null;
  const zero: DrainResult = { claimed: 0, drained: 0, failed: 0, dead: 0 };
  const run = (): Promise<DrainResult> => {
    if (inflight) return inflight;
    inflight = drainSyncChanges(opts.db, {
      transport: opts.transport,
      now: now(),
      limit: opts.limit,
      staleMs: opts.staleMs,
    }).finally(() => {
      inflight = null;
    });
    return inflight;
  };
  return {
    notify(): void {
      if (stopped) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void run();
      }, opts.debounceMs ?? DEFAULT_DEBOUNCE_MS);
      timer.unref?.();
    },
    async flush(): Promise<DrainResult> {
      if (stopped) return zero;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      return run();
    },
    stop(): void {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

/** Current queue state — pending, in flight, and dead-lettered rows alike —
 * oldest first. Read surface for tests and the eventual S2 surfacing UI. */
export function syncChangeRows(db: DatabaseSync): SyncJournalRow[] {
  initialize(db);
  const rows = db
    .prepare(
      `SELECT objectId, objectType, rev, checksum, state, attempts, enqueuedAt, nextAttemptAt, claimedAt
       FROM sync_journal ORDER BY enqueuedAt ASC, objectId ASC`,
    )
    .all();
  return rows.map((raw) => rowSchema.parse(raw));
}
