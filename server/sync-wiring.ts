// S2c (DESIGN §10) — the real wiring around the pass, still with every
// external edge injectable so the logic is testable without Drive or a
// passphrase store:
//
//   1. googleDriveStorageProvider — StorageProvider implementation #1 (P1,
//      local-first plan §13): the SyncTransportDeps the pass expects, over
//      Drive's uploadBundle/downloadBundle/statBundleFile; the boot path's
//      driveSyncTransport delegates to it. Two decisions
//      are load-bearing and deliberate:
//        - BYTE BRIDGE: the envelope is binary, Drive's multipart body is
//          a UTF-8 string, so objects ride base64. Decoding is strict
//          (re-encode must equal the text); anything else is handed
//          downstream as raw bytes and the pack's own gates decide
//          whether it opens — one rule for objects and the manifest.
//        - GUARD: Drive v3 has no If-Match, so the opaque guard the pass
//          carries untouched is the file's modifiedTime. The load stats
//          BEFORE it downloads (the guard must predate the bytes held,
//          or a save verified against a newer stat could destroy content
//          the load never saw); the save re-stats and refuses any
//          mismatch before writing. The stat→write window that remains
//          after that is real: documented here, not hidden behind a
//          header the API does not have.
//
//   2. localSyncManifestStore — this install's view of remote, persisted
//      as plain JSON and validated by the SAME schema as the sealed
//      document. A corrupt file fails LOUDLY: silently starting at zero
//      would re-derive stale revs and manufacture conflicts.
//
//   3. startSyncEngine — the debounced trigger, single-flight. The pass
//      is deliberately the ONLY claimant of the journal: S1's drainer
//      transport would have to BE a whole pass (each row needs the merged
//      manifest published), and a drainer claiming row A while its
//      transport's inner pass claims the rest would either mark A drained
//      without pushing it or burn A's attempts on rows the inner pass
//      already moved. One queue, one consumer — the engine debounces and
//      the pass claims. Without a passphrase the engine HELDS the queue
//      (the passphrase-store decision is §11's flagged gate) instead of
//      packing anything.

import { existsSync, readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

import { writeFileAtomic } from "./atomic.ts";
import * as driveSync from "./drive-sync.ts";
import { startSnapshotScheduler } from "./snapshot-scheduler.ts";
import { asStorageProvider, type StorageProvider } from "./storage-provider.ts";
import { runSyncPass, type SyncPassDeps, type SyncPassResult, type SyncTransportDeps } from "./sync-pass.ts";
import { SYNC_MANIFEST_FILE_NAME, manifestDocSchema, type SyncManifestDoc } from "./sync-objects.ts";

/** The Drive functions this transport needs, spelled out so tests can
 * hand in an in-memory fake that satisfies the same contract the real
 * module does. */
export interface DriveTransportFns {
  uploadBundle(
    accessToken: string,
    payload: string,
    fileName?: string,
    guard?: () => Promise<void>,
  ): Promise<{ id: string }>;
  downloadBundle(
    accessToken: string,
    fileName?: string,
    guard?: () => Promise<void>,
  ): Promise<string | null>;
  statBundleFile(
    accessToken: string,
    fileName?: string,
    guard?: () => Promise<void>,
  ): Promise<{ id: string; modifiedTime: string } | null>;
}

export interface DriveTransportOptions {
  getAccessToken(): Promise<string>;
  drive?: DriveTransportFns;
}

/** Strict where it can be, honest where it cannot: exactly-our-base64
 * decodes to its bytes; any other text passes through as utf8 so the
 * envelope's own authenticate-then-parse gates issue the verdict. */
const drivePayloadBytes = (text: string): Buffer => {
  const decoded = Buffer.from(text, "base64");
  return decoded.toString("base64") === text ? decoded : Buffer.from(text, "utf8");
};

/** The boot-path factory (server/index.ts:415). P1: delegates to
 * googleDriveStorageProvider — the four seam bodies did not move, and the
 * return type widens from SyncTransportDeps to its structural superset
 * StorageProvider, so the boot path carries implementation #1 with no edit to
 * index.ts. The driveSyncTransport suite below pins this unchanged behavior. */
export function driveSyncTransport(options: DriveTransportOptions): StorageProvider {
  return googleDriveStorageProvider(options);
}

/** Drive as StorageProvider implementation #1 (plan §13/R1) — a pure wrap of
 * the transport this module always built: the four seam methods keep their
 * exact bodies (base64 byte bridge, stat-BEFORE-download modifiedTime guard
 * with its documented residual stat→write window, verify-before-write
 * manifest save), and asStorageProvider aliases the §13 names 1:1 over them —
 * so the object injects at the pass's SyncTransportDeps seam with zero
 * adaptation and zero behavior change. The base64 bridge stays a Drive-only
 * detail inside this provider, as P1's risk notes require. */
export function googleDriveStorageProvider(options: DriveTransportOptions): StorageProvider {
  const drive: DriveTransportFns = options.drive ?? {
    uploadBundle: driveSync.uploadBundle,
    downloadBundle: driveSync.downloadBundle,
    statBundleFile: driveSync.statBundleFile,
  };
  const transport: SyncTransportDeps = {
    async upload(fileName: string, bytes: Buffer): Promise<void> {
      const token = await options.getAccessToken();
      await drive.uploadBundle(token, bytes.toString("base64"), fileName);
    },
    async download(fileName: string): Promise<Buffer | null> {
      const token = await options.getAccessToken();
      const text = await drive.downloadBundle(token, fileName);
      return text === null ? null : drivePayloadBytes(text);
    },
    async loadRemoteManifest(): Promise<{ bytes: Buffer; guard: string | null } | null> {
      const token = await options.getAccessToken();
      // stat BEFORE download — see the header note on guard ordering.
      const meta = await drive.statBundleFile(token, SYNC_MANIFEST_FILE_NAME);
      if (meta === null) return null;
      const text = await drive.downloadBundle(token, SYNC_MANIFEST_FILE_NAME);
      // vanished between stat and read: honest first-run absence again
      if (text === null) return null;
      return { bytes: drivePayloadBytes(text), guard: meta.modifiedTime };
    },
    async saveRemoteManifest(bytes: Buffer, expectedGuard: string | null): Promise<void> {
      const token = await options.getAccessToken();
      const meta = await drive.statBundleFile(token, SYNC_MANIFEST_FILE_NAME);
      if (expectedGuard === null) {
        if (meta !== null) {
          throw new Error("the remote manifest already exists — refusing a first-run create over it");
        }
      } else {
        if (meta === null) {
          throw new Error("the remote manifest vanished under a non-null guard");
        }
        if (meta.modifiedTime !== expectedGuard) {
          throw new Error("the remote manifest changed since it was loaded");
        }
      }
      // verify-before-write; the remaining stat→write window is the
      // documented cost of Drive v3 having no If-Match.
      await drive.uploadBundle(token, bytes.toString("base64"), SYNC_MANIFEST_FILE_NAME);
    },
  };
  return asStorageProvider(transport);
}

export interface LocalManifestStore {
  load(): SyncManifestDoc | null;
  save(doc: SyncManifestDoc): void;
}

export function localSyncManifestStore(path: string): LocalManifestStore {
  return {
    load(): SyncManifestDoc | null {
      if (!existsSync(path)) return null;
      const text = readFileSync(path, "utf8");
      // JSON.parse's throw on corruption is the loud failure we want
      return manifestDocSchema.parse(JSON.parse(text));
    },
    save(doc: SyncManifestDoc): void {
      manifestDocSchema.parse(doc);
      writeFileAtomic(path, `${JSON.stringify(doc)}\n`, { mode: 0o600 });
    },
  };
}

export type SyncEngineResult = SyncPassResult;

export interface SyncEngineOptions {
  db: DatabaseSync;
  transport: SyncTransportDeps;
  local: LocalManifestStore;
  readObject: SyncPassDeps["readObject"];
  applyObject: SyncPassDeps["applyObject"];
  /** null = hold the queue (the flagged passphrase-store gate). */
  passphrase(): string | null;
  appVersion: string;
  debounceMs?: number;
  now?: () => number;
  /** Injection seam for tests; defaults to the real pass. */
  runPass?: (deps: SyncPassDeps) => Promise<SyncPassResult>;
}

export interface SyncEngine {
  /** Call after enqueueing; repeats coalesce into one debounce window. */
  notify(): void;
  /** Run now (clearing any pending debounce). Inert after stop(). */
  flush(): Promise<SyncEngineResult>;
  stop(): void;
}

const zeroDrain = { claimed: 0, drained: 0, failed: 0, dead: 0 };

const zeroResult = (): SyncEngineResult => ({
  journal: { ...zeroDrain },
  pushed: [],
  pullApplied: [],
  conflicts: [],
  pullProblems: [],
  manifestPublished: false,
  errors: [],
});

const heldResult = (reason: string): SyncEngineResult => ({
  ...zeroResult(),
  errors: [reason],
});

// mirrors S1's DEFAULT_DEBOUNCE_MS so producers and the engine agree on
// one coalescing window
const DEFAULT_ENGINE_DEBOUNCE_MS = 250;

export function startSyncEngine(options: SyncEngineOptions): SyncEngine {
  // B1: arm the nightly snapshot scheduler on this boot path — index.ts
  // calls startSyncEngine exactly once. The singleton self-guards (no real
  // timers under tests, no ticking on self-hosted installs), so this is a
  // no-op in both; if the owner prefers the arm OUTSIDE the sync pass, the
  // alternative wiring point is index.ts right at this call (~line 423).
  startSnapshotScheduler();
  const now = options.now ?? Date.now;
  const runPass = options.runPass ?? runSyncPass;
  const debounceMs = options.debounceMs ?? DEFAULT_ENGINE_DEBOUNCE_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let inflight: Promise<SyncEngineResult> | null = null;

  const run = (): Promise<SyncEngineResult> => {
    // single-flight: a timer firing mid-pass joins it rather than
    // starting a second claimer (a producer enqueued during the pass
    // already notified; its row is durable and the next notify retries —
    // the same contract S1's drainer documents)
    if (inflight !== null) return inflight;
    const passphrase = options.passphrase();
    if (passphrase === null) {
      return Promise.resolve(
        heldResult("the sync passphrase is not available — the queue is held until it is"),
      );
    }
    inflight = (async (): Promise<SyncEngineResult> => {
      try {
        return await runPass({
          db: options.db,
          transport: options.transport,
          local: options.local,
          readObject: options.readObject,
          applyObject: options.applyObject,
          passphrase,
          appVersion: options.appVersion,
          now,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return heldResult(`sync pass failed: ${message}`);
      }
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  };

  return {
    notify(): void {
      if (stopped) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void run();
      }, debounceMs);
      timer.unref?.();
    },
    async flush(): Promise<SyncEngineResult> {
      if (stopped) return zeroResult();
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      return run();
    },
    stop(): void {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
