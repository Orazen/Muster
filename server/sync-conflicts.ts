// The equal-rev / different-checksum conflict is the one case DESIGN §10 says
// nothing may auto-resolve: two installs each wrote past the same rev, and
// neither is wrong about its own bytes. Deciding which survives is a human's
// job, so this module's whole job is to make that job POSSIBLE and nothing
// more:
//
//   - hold both sides where they survive a restart (the index is shared, the
//     local manifest is per-install, and the journal is per-install too — so
//     the only place a conflict can be remembered is somewhere durable, and
//     "the pass reported it once over HTTP" is not a place);
//   - carry enough of each side for a person to choose: both checksums, both
//     timestamps, both tombstone flags, both file names and the rev they
//     disagree about. A conflict that says only "objectId" cannot be judged
//     from it, and an unjudgeable conflict is a conflict nobody resolves;
//   - offer exactly TWO resolutions and no default. Nothing here runs without
//     being asked by name, and there is deliberately no newest-wins,
//     last-writer-wins, or local-wins path: the handoff forbids silently
//     choosing a winner, and the cheapest way to guarantee that is for the
//     module to have no way to choose at all.
//
// What this module deliberately does NOT do is fetch either side's content.
// The two sides' bytes share one canonical file name (`<id>-<rev>.enc`), so
// whichever install uploaded last already replaced the other's bytes for that
// rev: a full resolution journey needs the object naming widened or a
// side-channel for the losing side, and neither is a change this module may
// make to the sealed format. Until that exists, the honest resolution here is
// "withdraw this install's claim" (the next pass then applies the remote
// object it can still download) or "re-issue this install's bytes at a rev
// past the disagreement" (the other install pulls them). See the report.

import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import { enqueueSyncChange } from "./sync-journal.ts";
import {
  syncObjectFileName,
  withManifestEntry,
  type SyncManifestDoc,
  type SyncManifestEntry,
} from "./sync-objects.ts";

const HEX64 = /^[a-f0-9]{64}$/u;
const printable = (value: string): boolean =>
  [...value].every((char) => {
    const code = char.charCodeAt(0);
    return code >= 32 && code !== 127;
  });

/** Both sides, verbatim. Every field here exists because a person choosing
 * between them needs it; nothing is derived, so nothing can disagree with
 * the index the conflict was read from. */
export const syncConflictRecordSchema = z
  .object({
    objectId: z.string().min(1).max(256).refine(printable),
    objectType: z.string().min(1).max(64).refine(printable),
    rev: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    localChecksum: z.string().regex(HEX64),
    remoteChecksum: z.string().regex(HEX64),
    localFileName: z.string().min(1).max(512),
    remoteFileName: z.string().min(1).max(512),
    localUpdatedAt: z.number().int().nonnegative(),
    remoteUpdatedAt: z.number().int().nonnegative(),
    localTombstone: z.boolean(),
    remoteTombstone: z.boolean(),
    detectedAt: z.number().int().nonnegative(),
  })
  .strict();

export type SyncConflictRecord = z.infer<typeof syncConflictRecordSchema>;

/** The same shape the pass result carries, so a caller can show what the
 * install currently sees without also reading this table. */
export interface SyncConflictSide {
  objectId: string;
  objectType: string;
  rev: number;
  localChecksum: string;
  remoteChecksum: string;
  localUpdatedAt: number;
  remoteUpdatedAt: number;
  localTombstone: boolean;
  remoteTombstone: boolean;
}

const initialized = new WeakSet<DatabaseSync>();
function initialize(db: DatabaseSync): void {
  if (initialized.has(db)) return;
  db.exec(`CREATE TABLE IF NOT EXISTS sync_conflicts (
    objectId TEXT PRIMARY KEY,
    detectedAt INTEGER NOT NULL,
    record TEXT NOT NULL
  )`);
  initialized.add(db);
}

/** Remember a conflict both sides intact. Best effort by contract, like every
 * other receipt in the sync family: a bookkeeping failure must never fail the
 * pass that found the conflict. Returns whether it was recorded, so a caller
 * that cares can say the conflict was reported but not remembered. */
export function recordSyncConflict(
  db: DatabaseSync,
  sides: { local: SyncManifestEntry; remote: SyncManifestEntry },
  at: number,
): boolean {
  try {
    const record = syncConflictRecordSchema.safeParse({
      objectId: sides.local.objectId,
      objectType: sides.local.objectType,
      rev: sides.local.rev,
      localChecksum: sides.local.checksum,
      remoteChecksum: sides.remote.checksum,
      localFileName: sides.local.fileName,
      remoteFileName: sides.remote.fileName,
      localUpdatedAt: sides.local.updatedAt,
      remoteUpdatedAt: sides.remote.updatedAt,
      localTombstone: sides.local.tombstone,
      remoteTombstone: sides.remote.tombstone,
      detectedAt: at,
    });
    if (!record.success) return false;
    initialize(db);
    db.prepare(
      `INSERT INTO sync_conflicts (objectId, detectedAt, record) VALUES (?, ?, ?)
       ON CONFLICT(objectId) DO UPDATE SET detectedAt = excluded.detectedAt, record = excluded.record`,
    ).run(record.data.objectId, record.data.detectedAt, JSON.stringify(record.data));
    return true;
  } catch {
    return false;
  }
}

const storedRowSchema = z.object({ record: z.string() });

/** Unresolved conflicts, oldest detection first. A damaged row is skipped
 * rather than failing the read: the rest of the list is still a true
 * statement about what is unresolved, and one bad row must not blind it.
 * The stored row is parsed at its I/O boundary the same way the journal
 * parses its own — a row shape is a contract, not an assertion. */
export function readSyncConflicts(db: DatabaseSync): SyncConflictRecord[] {
  initialize(db);
  const rows = db
    .prepare(`SELECT record FROM sync_conflicts ORDER BY detectedAt ASC, objectId ASC`)
    .all();
  const records: SyncConflictRecord[] = [];
  for (const row of rows) {
    const stored = storedRowSchema.safeParse(row);
    if (!stored.success) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(stored.data.record);
    } catch {
      continue;
    }
    const record = syncConflictRecordSchema.safeParse(parsed);
    if (record.success) records.push(record.data);
  }
  return records;
}

/** Drop one remembered conflict. The pass calls this when an object stops
 * disagreeing, so the table is always exactly "unresolved", never a log. */
export function forgetSyncConflict(db: DatabaseSync, objectId: string): void {
  initialize(db);
  db.prepare(`DELETE FROM sync_conflicts WHERE objectId = ?`).run(objectId);
}

export type ConflictSide = "local" | "remote";
export type ConflictResolution = "resolved" | "unknown";

/** The one way out, and the only way a winner is ever chosen: a caller names
 * the side. `remote` withdraws this install's claim, so the next pass's
 * reconcile sees the remote as strictly newer and downloads + applies the
 * object it names. `local` re-issues this install's OWN bytes at a rev past
 * the disagreement, so the next pass publishes them and the other install
 * pulls them. Neither touches the other side's bytes, and neither is
 * reachable by a pass — only by a person or a route they asked. */
export function resolveSyncConflict(
  deps: {
    db: DatabaseSync;
    local: { load(): SyncManifestDoc | null; save(doc: SyncManifestDoc): void };
    record: SyncConflictRecord;
  },
  side: ConflictSide,
  now: number,
): ConflictResolution {
  const { db, local, record } = deps;
  const doc = local.load();
  const existing = doc?.entries.find((entry) => entry.objectId === record.objectId);
  if (doc === null || existing === undefined) {
    // Nothing of ours to withdraw or re-issue: the claim this record was
    // written about is already gone, so the record is stale, not unresolvable.
    forgetSyncConflict(db, record.objectId);
    return "unknown";
  }
  if (side === "remote") {
    local.save({
      schema: 1,
      updatedAt: now,
      entries: doc.entries.filter((entry) => entry.objectId !== record.objectId),
    });
  } else {
    const rev = record.rev + 1;
    const entry: SyncManifestEntry = {
      ...existing,
      // past the disagreement, so the merge is decided by rev rather than by
      // whichever install happened to publish last
      rev,
      fileName: syncObjectFileName(existing.objectId, rev),
      updatedAt: now,
    };
    local.save(withManifestEntry(doc, entry, now));
    enqueueSyncChange(
      db,
      {
        objectId: entry.objectId,
        objectType: entry.objectType,
        rev: entry.rev,
        checksum: entry.checksum,
        tombstone: entry.tombstone,
      },
      now,
    );
  }
  forgetSyncConflict(db, record.objectId);
  return "resolved";
}
