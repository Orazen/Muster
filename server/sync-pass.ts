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
//   - the pull phase IGNORES plan.upload: the journal owns push, so nothing
//     is uploaded twice or outside retry semantics;
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
 * one optimistic-concurrency guard that comes back from the load. */
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
  const pushedEntries: SyncManifestEntry[] = [];
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
      pushedEntries.push(entry);
      result.pushed.push({ objectId: row.objectId, rev: row.rev, fileName });
    },
  });

  // --- publish: merge pushed entries into remote's index, guard intact ---
  if (pushedEntries.length > 0) {
    let merged = remoteDoc;
    for (const entry of pushedEntries) merged = withManifestEntry(merged, entry, now());
    try {
      await deps.transport.saveRemoteManifest(packSyncManifest(merged, envelope), guard);
      remoteDoc = merged;
      result.manifestPublished = true;
    } catch (error) {
      // objects are already on the wire; the next pass re-pushes by name
      result.errors.push(`manifest publish failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // --- pull: reconcile, download the remote-er, verify, apply, commit ----
  const localDoc = deps.local.load() ?? emptyDoc(now());
  const plan = reconcileSyncObjects(localDoc.entries, remoteDoc.entries);
  // plan.upload is deliberately ignored: the journal owns push.
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
