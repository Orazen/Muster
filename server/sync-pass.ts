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

import type { DatabaseSync } from "node:sqlite";

import {
  drainSyncChanges,
  enqueueSyncChange,
  syncChangeRows,
  type DrainResult,
  type SyncJournalRow,
} from "./sync-journal.ts";
import {
  packSyncManifest,
  packSyncObject,
  reconcileSyncObjects,
  syncObjectFileName,
  unpackSyncManifest,
  unpackSyncObject,
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
  conflicts: Array<{ objectId: string; localRev: number; remoteRev: number }>;
  pullProblems: string[];
  manifestPublished: boolean;
  errors: string[];
}

const emptyDoc = (now: number): SyncManifestDoc => ({ schema: 1, updatedAt: now, entries: [] });

/** One entry upsert, entries kept in stable id order so identical states
 * serialize to identical bytes. */
/** Exported for S2c's producer: one upsert, stable id order — the local
 * manifest has exactly one merge implementation across the pass and the
 * file-side producer. */
export const withManifestEntry = (base: SyncManifestDoc, entry: SyncManifestEntry, now: number): SyncManifestDoc => ({
  schema: 1,
  updatedAt: now,
  entries: [...base.entries.filter((existing) => existing.objectId !== entry.objectId), entry].sort(
    (a, b) => (a.objectId < b.objectId ? -1 : a.objectId > b.objectId ? 1 : 0),
  ),
});

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

  // --- push: the journal's own drain supplies claim/retry/dead-letter ----
  // The journal row that owns each push, kept beside its entry: the drain
  // DELETEs the row on success, and if the manifest publish then fails the
  // object is on the wire with no queue row behind it — see below.
  const pushedRows: Array<{ row: SyncJournalRow; entry: SyncManifestEntry }> = [];
  result.journal = await drainSyncChanges(deps.db, {
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
  if (pushedRows.length > 0) {
    let merged = remoteDoc;
    for (const pushed of pushedRows) merged = withManifestEntry(merged, pushed.entry, now());
    try {
      await deps.transport.saveRemoteManifest(packSyncManifest(merged, envelope), guard);
      remoteDoc = merged;
      result.manifestPublished = true;
    } catch (error) {
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

  // --- pull: reconcile, download the remote-er, verify, apply, commit ----
  const localDoc = deps.local.load() ?? emptyDoc(now());
  const plan = reconcileSyncObjects(localDoc.entries, remoteDoc.entries);
  // plan.upload is deliberately ignored as WORK: the journal owns push, and a
  // row still waiting on its backoff is not this pass's business. It is not
  // ignored as a REPORT though — a local entry the remote index does not name,
  // with no queued row that will ever push it, is precisely the shape an
  // orphaned push takes. Saying so keeps the pass from reporting clean while
  // one exists, whatever the journal happens to hold.
  const queued = new Set(syncChangeRows(deps.db).map((row) => row.objectId));
  for (const entry of plan.upload) {
    if (queued.has(entry.objectId)) continue;
    result.errors.push(
      `${entry.objectId}: the local manifest claims rev ${entry.rev} which the remote index does not, and no queued change will push it`,
    );
  }
  for (const conflict of plan.conflict) {
    result.conflicts.push({
      objectId: conflict.objectId,
      localRev: conflict.local.rev,
      remoteRev: conflict.remote.rev,
    });
  }
  let pulledLocal = localDoc;
  for (const entry of plan.download) {
    let bytes: Buffer | null;
    try {
      bytes = await deps.transport.download(entry.fileName);
    } catch (error) {
      result.pullProblems.push(`${entry.objectId}: download failed (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    if (bytes === null) {
      result.pullProblems.push(`${entry.objectId}: the file named by the manifest was not found`);
      continue;
    }
    const opened = unpackSyncObject(bytes, envelope);
    if (opened.status !== "ok" || opened.object === undefined) {
      result.pullProblems.push(
        `${entry.objectId}: will not open (${opened.status}${opened.error !== undefined ? `: ${opened.error}` : ""})`,
      );
      continue;
    }
    const object = opened.object;
    if (
      object.objectId !== entry.objectId ||
      object.rev !== entry.rev ||
      object.checksum !== entry.checksum ||
      object.tombstone !== entry.tombstone
    ) {
      result.pullProblems.push(`${entry.objectId}: the bytes disagree with the manifest entry that named them`);
      continue;
    }
    try {
      await deps.applyObject(object);
    } catch (error) {
      result.pullProblems.push(`${entry.objectId}: applier rejected it (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    result.pullApplied.push({ objectId: entry.objectId, rev: entry.rev });
    pulledLocal = withManifestEntry(pulledLocal, entry, now());
    deps.local.save(pulledLocal);
  }

  return result;
}
