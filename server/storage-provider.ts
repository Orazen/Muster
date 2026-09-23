// P1 (docs/plans/local-first-architecture-plan-2026-09-23.md, §13 R1 / P1) —
// StorageProvider: the provider-neutral storage seam extracted AT the existing
// SyncTransportDeps injection point (server/sync-pass.ts:45), so sync is no
// longer hard-wired to Google Drive and every later provider (plan §4.1's
// WebDAV/S3/OneDrive/Dropbox) implements one contract.
//
// The contract carries the plan's §13 vocabulary AND the engine's seam names —
// two name sets, one bijection, no adapter at the call site:
//
//   §13 name                        seam alias (server/sync-pass.ts)
//   ------------------------------  -------------------------------------
//   write(fileName, bytes)          upload(fileName, bytes)
//   read(fileName)                  download(fileName)
//   getManifest()                   loadRemoteManifest()
//   saveManifest(bytes, guard)      saveRemoteManifest(bytes, guard)
//
// Declaring the seam members here — with exactly the signatures sync-pass.ts
// already declares — makes every StorageProvider structurally satisfy
// SyncTransportDeps: an implementation injects into runSyncPass /
// startSyncEngine unchanged. That is what "extract the interface at the
// existing seam" means concretely, and it is why sync-pass.ts itself needs no
// signature change.
//
// Guard semantics every provider keeps (plan P1 risks: "transport guard
// semantics must carry over verbatim"): the guard from getManifest PREDATES
// the bytes it returns; saveManifest with a null guard creates only if absent,
// with a non-null guard refuses when the target vanished or the guard no
// longer matches; the load → save flow treats the guard as opaque and passes
// it through untouched. The guard's FORMAT is a provider detail (Drive:
// modifiedTime; local: mtime) — the pass never parses it.
//
// P1 narrowing (the plan permits it — R1 lists the full §13 shape): delete,
// list, sync, putEvent, getEvents, createSnapshot and restoreSnapshot are NOT
// part of P1. Nothing in this phase calls them, the injected Drive seam has no
// primitive for them (inventing one would be the new transport behavior P1
// forbids), and each lands with the phase that consumes it (events/snapshots
// per the plan's R-list) instead of being stubbed here.
//
// LocalStorageProvider writes ONLY under the caller-provided directory: the
// factory takes it explicitly and has NO default, so it can never resolve to
// the live ~/.muster data root by accident. Tests pass mkdtemp temp dirs.
import { mkdirSync, readFileSync, statSync, type Stats } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import type { SyncTransportDeps } from "./sync-pass.ts";
import { SYNC_MANIFEST_FILE_NAME } from "./sync-objects.ts";

/** Byte-level storage under canonical file names plus one guarded manifest
 * publish — the P1-narrowed §13 contract (see the module header for the
 * deferred methods and the alias bijection). */
export interface StorageProvider {
  /** §13 write — store `bytes` under `fileName`, replacing any prior file. */
  write(fileName: string, bytes: Buffer): Promise<void>;
  /** §13 read — the file's bytes, or null when it does not exist. */
  read(fileName: string): Promise<Buffer | null>;
  /** §13 getManifest — the sealed manifest plus its opaque guard (the guard
   *  must predate the bytes returned), or null on honest first-run absence. */
  getManifest(): Promise<{ bytes: Buffer; guard: string | null } | null>;
  /** Guard-checked publish: expectedGuard null = create-if-absent only;
   *  non-null = refuse unless the manifest still carries that guard. */
  saveManifest(bytes: Buffer, expectedGuard: string | null): Promise<void>;

  // The sync pass's own seam (SyncTransportDeps in server/sync-pass.ts),
  // byte-for-byte the same four operations under the names the engine
  // already speaks — declared so a StorageProvider IS a SyncTransportDeps.
  upload(fileName: string, bytes: Buffer): Promise<void>;
  download(fileName: string): Promise<Buffer | null>;
  loadRemoteManifest(): Promise<{ bytes: Buffer; guard: string | null } | null>;
  saveRemoteManifest(bytes: Buffer, expectedGuard: string | null): Promise<void>;
}

/** The seam adapter: a transport built under the engine's names viewed through
 * the full provider contract. Every §13 name delegates 1:1 to the seam method
 * beside it — same closure, same arguments, same result — so wrapping is
 * behavior-neutral by construction (each pair shares one implementation; the
 * arrows also preserve `this` for any seam implementation that binds it). */
export function asStorageProvider(transport: SyncTransportDeps): StorageProvider {
  return {
    write: (fileName, bytes) => transport.upload(fileName, bytes),
    read: (fileName) => transport.download(fileName),
    getManifest: () => transport.loadRemoteManifest(),
    saveManifest: (bytes, expectedGuard) => transport.saveRemoteManifest(bytes, expectedGuard),
    upload: (fileName, bytes) => transport.upload(fileName, bytes),
    download: (fileName) => transport.download(fileName),
    loadRemoteManifest: () => transport.loadRemoteManifest(),
    saveRemoteManifest: (bytes, expectedGuard) => transport.saveRemoteManifest(bytes, expectedGuard),
  };
}

const MANIFEST_MODE = 0o600;
const DIRECTORY_MODE = 0o700;

/** node:fs failures are NodeJS.ErrnoException — `code` names the errno, and
 * ENOENT is "the path does not exist". A caught value that is not an Error
 * has no errno code, so it is not ENOENT and keeps propagating. */
const isEnoent = (fsError: NodeJS.ErrnoException): boolean => fsError.code === "ENOENT";

const statOrNull = (path: string): Stats | null => {
  try {
    return statSync(path);
  } catch (caught) {
    if (caught instanceof Error && isEnoent(caught)) return null;
    throw caught;
  }
};

/** The local guard: the manifest's modified time, same ISO-string shape the
 * Drive transport uses so the pass sees one opaque guard format either way. */
const guardOf = (stat: Stats): string => new Date(stat.mtimeMs).toISOString();

/** Path confinement: names arrive canonical from the engine
 * (muster-manifest.json, muster-<object>-<rev>.enc — encodeURIComponent never
 * emits a separator); refuse anything that could leave the directory. */
const safePath = (directory: string, fileName: string): string => {
  if (
    fileName === "" ||
    fileName === "." ||
    fileName === ".." ||
    fileName.includes("/") ||
    fileName.includes("\\") ||
    fileName.includes("\0")
  ) {
    throw new Error(`unsafe storage file name: ${JSON.stringify(fileName)}`);
  }
  return join(directory, fileName);
};

/** LocalStorageProvider — a filesystem mirror of the transport contract under
 * a caller-provided directory (no default; never the live data root). The
 * byte IO is raw — the base64 bridge stays a Drive-only detail inside its own
 * provider, as P1's risk notes require. The manifest load is statSync +
 * readFileSync back to back with no interleaving point on this thread, so the
 * guard provably predates the bytes returned — the local counterpart of
 * Drive's stat-before-download rule. The residual stat→write window on save
 * matches the Drive transport's documented one: same contract, same honesty. */
export function localStorageProvider(directory: string): StorageProvider {
  if (directory === "") {
    throw new Error("localStorageProvider requires an explicit directory — it never defaults to the live data root");
  }
  const transport: SyncTransportDeps = {
    async upload(fileName: string, bytes: Buffer): Promise<void> {
      const path = safePath(directory, fileName);
      mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE });
      writeFileAtomic(path, bytes, { mode: MANIFEST_MODE });
    },
    async download(fileName: string): Promise<Buffer | null> {
      const path = safePath(directory, fileName);
      try {
        return readFileSync(path);
      } catch (caught) {
        if (caught instanceof Error && isEnoent(caught)) return null;
        throw caught;
      }
    },
    async loadRemoteManifest(): Promise<{ bytes: Buffer; guard: string | null } | null> {
      const path = safePath(directory, SYNC_MANIFEST_FILE_NAME);
      const stat = statOrNull(path);
      if (stat === null) return null;
      try {
        return { bytes: readFileSync(path), guard: guardOf(stat) };
      } catch (caught) {
        // vanished between stat and read: honest first-run absence again
        if (caught instanceof Error && isEnoent(caught)) return null;
        throw caught;
      }
    },
    async saveRemoteManifest(bytes: Buffer, expectedGuard: string | null): Promise<void> {
      const path = safePath(directory, SYNC_MANIFEST_FILE_NAME);
      const stat = statOrNull(path);
      if (expectedGuard === null) {
        if (stat !== null) {
          throw new Error("the remote manifest already exists — refusing a first-run create over it");
        }
      } else {
        if (stat === null) {
          throw new Error("the remote manifest vanished under a non-null guard");
        }
        if (guardOf(stat) !== expectedGuard) {
          throw new Error("the remote manifest changed since it was loaded");
        }
      }
      // mkdir only on the write path: a refused save creates nothing
      mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE });
      writeFileAtomic(path, bytes, { mode: MANIFEST_MODE });
    },
  };
  return asStorageProvider(transport);
}
