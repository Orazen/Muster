// S2b (DESIGN §10) — the sync pass: one full cycle of §10's sequence
// diagram, over INJECTED dependencies so the engine is testable without
// Drive, the routes file, or any producer:
//
//   load remote manifest → journal claim (S1 drain) → read local object →
//   pack (S2a envelope) → upload → local manifest commit → publish the
//   merged remote manifest → reconcile (S2a) → download → unpack → VERIFY
//   against the manifest entry → applier → local manifest commit.
//
// Two invariants the tests pin hard:
//   - the pull phase IGNORES plan.upload as WORK: the journal owns push, so
//     nothing is uploaded twice or outside retry semantics. It does REPORT an
//     upload the journal can no longer produce, so a stranded local entry
//     never shows up as a clean pass;
//   - nothing is applied whose bytes disagree with the manifest entry that
//     named it (§10's "download → verify → decrypt → merge → commit" — the
//     verify is rev + checksum + tombstone identity, not just "it opened").
// A remote manifest that will not open HALTS the pass before anything is
// claimed: without a trustworthy index, merging risks clobbering entries
// this install has never seen.
//
// The opaque manifest guard (ETag-style ifMatch) flows load → save
// untouched; whether the Drive transport can honor it is an S2c decision —
// this layer only promises not to drop it.
//
// THE SHARED-INDEX PROBLEM, and what this layer owes it. The index is one
// document every install rewrites, and Drive v3 has no If-Match: the
// transport's re-stat-and-refuse-before-write closes a stale guard but leaves
// a stat→write window, so two installs can both find the guard valid and
// both write. The second write erases the first install's entries and the
// first install is told the publish succeeded. A single-writer rule is not
// available (there is no primitive to lease the index with) and immutable
// publication is not either (naming every publication separately needs a
// list, which the provider seam deliberately has not). So the engine's rule
// is instead:
//
//   1. a PUBLISH only ever moves the index forward — mergePublishedEntry
//      refuses to regress a newer rev (a stale install can no longer
//      un-delete an object another install tombstoned) and refuses to
//      decide an equal-rev conflict by writing last;
//   2. a LOSS IS NOT PERMANENT. The install that lost holds the whole
//      durable truth — its local manifest still names the entry, its
//      journal row was already drained, and the object it uploaded is still
//      on the wire under its canonical name. The pull half ACTS on that:
//      it names the entry again when the bytes verifiably verify, and
//      otherwise hands the row back to the journal. Before this, the same
//      evidence was only REPORTED, which left a stranded install printing
//      the same orphan error on every pass forever with no way out — the
//      exact shape a process death between the upload and the publish
//      leaves, since a dead process runs no catch.
// The residual is documented rather than hidden: the install whose write
// landed LAST cannot learn that it erased the other's entries, so recovery
// runs on the loser's next pass, not inside the winner's.

import type { DatabaseSync } from "node:sqlite";

import {
  claimSyncChanges,
  enqueueSyncChange,
  markSyncChangeDrained,
  markSyncChangeFailed,
  syncChangeRows,
  type DrainResult,
  type SyncJournalRow,
} from "./sync-journal.ts";
import { forgetSyncConflict, readSyncConflicts, recordSyncConflict } from "./sync-conflicts.ts";
import {
  mergePublishedEntry,
  packSyncManifest,
  packSyncObject,
  reconcileSyncObjects,
  syncObjectFileName,
  unpackSyncManifest,
  unpackSyncObject,
  withManifestEntry,
  type SyncManifestDoc,
  type SyncManifestEntry,
  type SyncObject,
} from "./sync-objects.ts";

/** The remote side, opaque to the engine: file bytes by canonical name and
 * one optimistic-concurrency guard that comes back from the load.
 * P1 (local-first plan §13/R1): StorageProvider (server/storage-provider.ts)
 * is the provider-neutral superset of exactly this shape — a StorageProvider
 * satisfies SyncTransportDeps structurally, so implementations (Drive's
 * googleDriveStorageProvider, the filesystem localStorageProvider) inject
 * here with no adapter. */
export interface SyncTransportDeps {
  upload(fileName: string, bytes: Buffer): Promise<void>;
  download(fileName: string): Promise<Buffer | null>;
  loadRemoteManifest(): Promise<{ bytes: Buffer; guard: string | null } | null>;
  saveRemoteManifest(bytes: Buffer, expectedGuard: string | null): Promise<void>;
}

export interface SyncPassDeps {
  db: DatabaseSync;
  transport: SyncTransportDeps;
  /** This install's view of what remote holds — persisted by the caller. */
  local: {
    load(): SyncManifestDoc | null;
    save(doc: SyncManifestDoc): void;
  };
  /** Serialize one queued object. Its checksum must equal the journal row's. */
  readObject(row: SyncJournalRow): SyncObject | Promise<SyncObject>;
  /** Hand a verified object (tombstones included) to the local writer. */
  applyObject(object: SyncObject): void | Promise<void>;
  passphrase: string;
  appVersion: string;
  now?: () => number;
}

export interface SyncPassResult {
  /** S1's claim outcome — retry/dead-letter bookkeeping, not re-derived. */
  journal: DrainResult;
  pushed: Array<{ objectId: string; rev: number; fileName: string }>;
  pullApplied: Array<{ objectId: string; rev: number }>;
  /** Equal rev, different bytes. Carries BOTH sides whole, because a
   * conflict nobody can judge is a conflict nobody resolves: which side is
   * newer, whether either is a delete, and what each one's bytes hash to.
   * The same record is persisted (sync-conflicts.ts) so it survives a
   * restart and can be resolved by name — never by a pass. */
  conflicts: Array<{
    objectId: string;
    objectType: string;
    localRev: number;
    remoteRev: number;
    localChecksum: string;
    remoteChecksum: string;
    localUpdatedAt: number;
    remoteUpdatedAt: number;
    localTombstone: boolean;
    remoteTombstone: boolean;
  }>;
  pullProblems: string[];
  manifestPublished: boolean;
  errors: string[];
}

const emptyDoc = (now: number): SyncManifestDoc => ({ schema: 1, updatedAt: now, entries: [] });

/** Cancellation and lifecycle invalidation are not transport failures. They
 * must unwind a claimed journal row without charging an attempt or allowing a
 * retry/dead-letter transition. */
export class SyncPassInvalidatedError extends Error {
  constructor(message = "sync pass was cancelled or its Drive lifecycle changed") {
    super(message);
    this.name = "SyncPassInvalidatedError";
  }
}

// Keep aligned with sync-journal's bounded drain defaults. S2 owns the
// transport-aware drain here because it must distinguish terminal lifecycle
// invalidation from an ordinary failed upload before updating journal state.
const SYNC_PASS_DRAIN_LIMIT = 32;
const SYNC_PASS_STALE_CLAIM_MS = 60_000;

function releaseUnfinishedClaims(db: DatabaseSync, claims: readonly SyncJournalRow[]): void {
  const release = db.prepare(`UPDATE sync_journal SET state = 'pending', claimedAt = NULL
    WHERE objectId = ? AND rev = ? AND state = 'inflight' AND claimedAt = ?`);
  for (const row of claims) {
    if (row.claimedAt === null) continue;
    release.run(row.objectId, row.rev, row.claimedAt);
  }
}

async function drainSyncChangesForPass(
  db: DatabaseSync,
  options: { transport(row: SyncJournalRow): Promise<void> | void; now: number },
): Promise<DrainResult> {
  const claims = claimSyncChanges(db, {
    limit: SYNC_PASS_DRAIN_LIMIT,
    now: options.now,
    staleMs: SYNC_PASS_STALE_CLAIM_MS,
  });
  const result: DrainResult = { claimed: claims.length, drained: 0, failed: 0, dead: 0 };
  for (const row of claims) {
    try {
      await options.transport(row);
      markSyncChangeDrained(db, row.objectId, row.rev);
      result.drained += 1;
    } catch (error) {
      if (error instanceof SyncPassInvalidatedError) {
        releaseUnfinishedClaims(db, claims);
        throw error;
      }
      const outcome = markSyncChangeFailed(db, row.objectId, row.rev, options.now);
      if (outcome === "dead") result.dead += 1;
      else result.failed += 1;
    }
  }
  return result;
}

/** Re-exported from sync-objects, where it now lives beside the manifest
 * schema and reconcileSyncObjects. The S2c producers import it from here and
 * are untouched; there is still exactly one merge implementation. */
export { withManifestEntry };

/** Bytes fetched for a manifest entry, verified against that entry — or the
 * named reason they were refused. One implementation of "the bytes have to
 * agree with the index entry that named them", shared by the two callers
 * that must never act on bytes that do not. */
type VerifiedFetch =
  | { ok: true; object: SyncObject }
  | { ok: false; problem: string };

export async function runSyncPass(deps: SyncPassDeps): Promise<SyncPassResult> {
  const now = deps.now ?? Date.now;
  const envelope = { passphrase: deps.passphrase, appVersion: deps.appVersion };
  const result: SyncPassResult = {
    journal: { claimed: 0, drained: 0, failed: 0, dead: 0 },
    pushed: [],
    pullApplied: [],
    conflicts: [],
    pullProblems: [],
    manifestPublished: false,
    errors: [],
  };

  // --- load the remote index; an unopenable one halts the whole pass -----
  let remoteDoc: SyncManifestDoc;
  let guard: string | null;
  const loaded = await deps.transport.loadRemoteManifest();
  if (loaded === null) {
    remoteDoc = emptyDoc(now());
    guard = null;
  } else {
    const opened = unpackSyncManifest(loaded.bytes, envelope);
    if (opened.status !== "ok" || opened.doc === undefined) {
      result.errors.push(
        `remote manifest will not open: ${opened.status}${opened.error !== undefined ? ` (${opened.error})` : ""}`,
      );
      return result;
    }
    remoteDoc = opened.doc;
    guard = loaded.guard;
  }
  // False once this pass has written the index itself: the guard belongs to
  // the write, and a second save in the same pass would be refused by its own
  // provider. The recovery below has to know before it tries.
  let guardCurrent = true;

  /** One fetch, verified: the bytes have to agree with the index entry that
   * named them before anything acts on them — applies them, or republishes
   * them. The two callers below are the only ones allowed to act on bytes. */
  const fetchVerified = async (entry: SyncManifestEntry): Promise<VerifiedFetch> => {
    let bytes: Buffer | null;
    try {
      bytes = await deps.transport.download(entry.fileName);
    } catch (error) {
      if (error instanceof SyncPassInvalidatedError) throw error;
      return { ok: false, problem: `download failed (${error instanceof Error ? error.message : String(error)})` };
    }
    if (bytes === null) return { ok: false, problem: "the file named by the manifest was not found" };
    const opened = unpackSyncObject(bytes, envelope);
    if (opened.status !== "ok" || opened.object === undefined) {
      return {
        ok: false,
        problem: `will not open (${opened.status}${opened.error !== undefined ? `: ${opened.error}` : ""})`,
      };
    }
    const object = opened.object;
    if (
      object.objectId !== entry.objectId ||
      object.rev !== entry.rev ||
      object.checksum !== entry.checksum ||
      object.tombstone !== entry.tombstone
    ) {
      return { ok: false, problem: "the bytes disagree with the manifest entry that named them" };
    }
    return { ok: true, object };
  };

  // --- push: the journal's own drain supplies claim/retry/dead-letter ----
  // The journal row that owns each push, kept beside its entry: the drain
  // DELETEs the row on success, and if the manifest publish then fails the
  // object is on the wire with no queue row behind it — see below.
  const pushedRows: Array<{ row: SyncJournalRow; entry: SyncManifestEntry }> = [];
  result.journal = await drainSyncChangesForPass(deps.db, {
    now: now(),
    transport: async (row) => {
      const object = await deps.readObject(row);
      if (
        object.objectId !== row.objectId ||
        object.rev !== row.rev ||
        object.checksum !== row.checksum
      ) {
        // publishing content the manifest would misdescribe — retry until the
        // producer agrees with itself, dead-letter if it never does
        throw new Error(`readObject returned content that disagrees with the journal row for ${row.objectId}`);
      }
      const fileName = syncObjectFileName(row.objectId, row.rev);
      await deps.transport.upload(fileName, packSyncObject(object, envelope));
      const entry: SyncManifestEntry = {
        objectId: row.objectId,
        objectType: row.objectType,
        rev: row.rev,
        checksum: row.checksum,
        fileName,
        updatedAt: object.updatedAt,
        tombstone: object.tombstone,
      };
      // save local per push: a crash mid-pass re-pushes (idempotent by name)
      // instead of losing the local commit
      deps.local.save(withManifestEntry(deps.local.load() ?? emptyDoc(now()), entry, now()));
      pushedRows.push({ row, entry });
      result.pushed.push({ objectId: row.objectId, rev: row.rev, fileName });
    },
  });

  // --- publish: merge pushed entries into remote's index, guard intact ---
  // A publish only ever moves the index FORWARD (see the module header): a
  // push the index already names at this rev or a newer one adds nothing, so
  // writing it would advance the guard over identical content and turn a
  // settled install into a writer in the very race that loses entries.
  if (pushedRows.length > 0) {
    let merged = remoteDoc;
    let names = false;
    for (const pushed of pushedRows) {
      const outcome = mergePublishedEntry(merged, pushed.entry, now());
      merged = outcome.doc;
      if (outcome.kind === "applied") names = true;
    }
    if (!names) {
      // Every push is already named by the index — at this rev, or at a newer
      // one this install does not hold. A superseded push converges inside
      // this same pass: the pull half sees the index as newer and downloads
      // it. An equal-rev disagreement is §10's conflict, and the pull half
      // reports it from the same reconcile — writing here would only pick a
      // side by arriving last.
      result.manifestPublished = false;
    } else {
      try {
        await deps.transport.saveRemoteManifest(packSyncManifest(merged, envelope), guard);
        remoteDoc = merged;
        // the guard moved with our own write: any further save this pass would
        // be refused, which the recovery below needs to know
        guardCurrent = false;
        result.manifestPublished = true;
      } catch (error) {
        if (error instanceof SyncPassInvalidatedError) throw error;
        // The objects are on the wire but the remote index does not name them,
        // and the drain has already DELETEd their journal rows — so nothing
        // would ever re-push them and the local manifest's claim would sit
        // orphaned forever while every later pass reported itself clean. Re-queue
        // the drained rows so a later pass retries them (the upload is idempotent
        // by name). The upload itself did not fail, so the re-queue starts a
        // fresh retry budget rather than charging this pass's outcome to the
        // row's attempt counter: a guard mismatch is the DESIGNED outcome of two
        // devices syncing one account, and the next pass merges onto the newer
        // manifest it loads. A newer producer change meanwhile returns
        // "stale"/"duplicate" and supersedes this one, never regressing the row.
        let requeued = 0;
        for (const pushed of pushedRows) {
          const outcome = enqueueSyncChange(
            deps.db,
            {
              objectId: pushed.row.objectId,
              objectType: pushed.row.objectType,
              rev: pushed.row.rev,
              checksum: pushed.row.checksum,
              tombstone: pushed.entry.tombstone,
            },
            now(),
          );
          if (outcome === "enqueued") requeued += 1;
        }
        result.errors.push(
          `manifest publish failed: ${error instanceof Error ? error.message : String(error)}` +
            (requeued === pushedRows.length
              ? ` — ${requeued} pushed change(s) re-queued for the next pass`
              : requeued > 0
                ? ` — ${requeued} of ${pushedRows.length} pushed changes re-queued; the rest are superseded by newer local work`
                : ` — no pushed change could be re-queued; the local manifest now claims revs the remote index does not`),
        );
      }
    }
  }

  // --- pull: reconcile, download the remote-er, verify, apply, commit ----
  const localDoc = deps.local.load() ?? emptyDoc(now());
  const plan = reconcileSyncObjects(localDoc.entries, remoteDoc.entries);
  // plan.upload is deliberately ignored as WORK: the journal owns push, and a
  // row still waiting on its backoff is not this pass's business. It is not
  // ignored as EVIDENCE though — a local entry the remote index does not
  // name, with no queued row that will ever push it, is precisely the shape
  // an orphaned push takes: a concurrent writer's publish erased it in the
  // stat→write window, or this install's process died between the upload and
  // the publish. Both are recoverable from what this install already holds,
  // and both must be ACTED on. Reporting it — which is all this used to do —
  // left a stranded install printing the same orphan on every pass forever
  // with no way out, and no recovery is possible from a report.
  const queued = new Set(syncChangeRows(deps.db).map((row) => row.objectId));
  const orphans = plan.upload.filter((entry) => !queued.has(entry.objectId));
  // Name an orphan again when its bytes are verifiably still on the wire —
  // that is the whole recovery for a DELETE, whose content exists nowhere
  // but the object it was already uploaded as. The index is never allowed to
  // name bytes that are not there, so fetch and verify first, exactly as the
  // download half below does before it applies anything.
  const onWire: SyncManifestEntry[] = [];
  const missing: SyncManifestEntry[] = [];
  for (const entry of orphans) {
    if ((await fetchVerified(entry)).ok) onWire.push(entry);
    else missing.push(entry);
  }
  const renamed = new Set<string>();
  if (onWire.length > 0 && guardCurrent) {
    let merged = remoteDoc;
    let names = false;
    for (const entry of onWire) {
      const outcome = mergePublishedEntry(merged, entry, now());
      merged = outcome.doc;
      if (outcome.kind === "applied") {
        names = true;
        renamed.add(entry.objectId);
      }
    }
    if (names) {
      try {
        await deps.transport.saveRemoteManifest(packSyncManifest(merged, envelope), guard);
        remoteDoc = merged;
        guardCurrent = false;
      } catch (error) {
        if (error instanceof SyncPassInvalidatedError) throw error;
        // Someone else published between our load and now. Not a loss: the
        // journal fallback below owns these now, and the next pass merges
        // onto whatever the index says by then.
        renamed.clear();
      }
    }
  }
  for (const entry of orphans) {
    if (renamed.has(entry.objectId)) continue;
    const outcome = enqueueSyncChange(
      deps.db,
      {
        objectId: entry.objectId,
        objectType: entry.objectType,
        rev: entry.rev,
        checksum: entry.checksum,
        tombstone: entry.tombstone,
      },
      now(),
    );
    // "enqueued" means the journal owns the claim again and the next pass
    // pushes it — that is the recovery, and it says so by doing it. A
    // refusal is the only case left to report: newer local work has already
    // superseded this evidence, which is not a loss.
    if (outcome === "stale") {
      result.errors.push(
        `${entry.objectId}: the remote index does not name rev ${entry.rev}, and the local claim is already behind newer local work`,
      );
    } else if (outcome === "enqueued" && missing.includes(entry)) {
      // Recovered, but from bytes the index no longer points at: the object
      // is not where this pass left it, so it is being re-uploaded from the
      // local content instead. That is worth saying out loud — a quiet pass
      // over a vanished object is the failure mode this whole branch exists
      // to stop.
      result.errors.push(
        `${entry.objectId}: the remote index does not name rev ${entry.rev} and its object is not on the wire; the change is re-queued and will be uploaded again`,
      );
    }
  }
  for (const conflict of plan.conflict) {
    result.conflicts.push({
      objectId: conflict.objectId,
      objectType: conflict.local.objectType,
      localRev: conflict.local.rev,
      remoteRev: conflict.remote.rev,
      localChecksum: conflict.local.checksum,
      remoteChecksum: conflict.remote.checksum,
      localUpdatedAt: conflict.local.updatedAt,
      remoteUpdatedAt: conflict.remote.updatedAt,
      localTombstone: conflict.local.tombstone,
      remoteTombstone: conflict.remote.tombstone,
    });
    recordSyncConflict(deps.db, conflict, now());
  }
  // The table is "unresolved", not a log: an object that stopped disagreeing
  // is no longer a conflict, whoever settled it and whenever.
  const stillConflicting = new Set(plan.conflict.map((conflict) => conflict.objectId));
  for (const record of readSyncConflicts(deps.db)) {
    if (!stillConflicting.has(record.objectId)) forgetSyncConflict(deps.db, record.objectId);
  }
  let pulledLocal = localDoc;
  for (const entry of plan.download) {
    const fetched = await fetchVerified(entry);
    if (!fetched.ok) {
      result.pullProblems.push(`${entry.objectId}: ${fetched.problem}`);
      continue;
    }
    const object = fetched.object;
    try {
      await deps.applyObject(object);
    } catch (error) {
      if (error instanceof SyncPassInvalidatedError) throw error;
      result.pullProblems.push(`${entry.objectId}: applier rejected it (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    result.pullApplied.push({ objectId: entry.objectId, rev: entry.rev });
    pulledLocal = withManifestEntry(pulledLocal, entry, now());
    deps.local.save(pulledLocal);
  }

  return result;
}
