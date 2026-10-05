// Persisted restart fence for the enrollment contract.
//
// What this is. The enrollment contract fences a client key whenever custody
// of a written credential could not be confirmed (`custody-unresolved`).
// That fence was an in-memory Set, so a restart — the exact event the fence
// exists to survive, because the record it guards against is itself durable
// across one — silently lifted it. This module is the durable half: a tiny
// port plus one file-backed implementation, and nothing else.
//
// Deliberate limits, stated rather than implied:
//   - NO work at import time. Importing this module performs no I/O, resolves
//     no path and reads no file; a constructed instance touches nothing until
//     its first API call, and the file is then read once and cached.
//   - Synchronous API only. The contract's fence reads sit in synchronous
//     tails between awaits (see the LATE-FENCE / COMMIT-WINDOW notes in the
//     contract); an async store would reopen those windows.
//   - Single-writer, no watching. The file is a whole-snapshot JSON object
//     with no locking and no change notification: a write by ANOTHER process
//     becomes visible to an instance only when that instance is constructed
//     (i.e. after a restart). Within one process, one shared instance is the
//     writer and its cache is authoritative for what it persisted.
//   - Fail CLOSED on ambiguity. A file that exists but cannot be parsed,
//     validated, or safely read leaves the store `degraded`: its contents
//     are UNKNOWN, every key must be treated as fenced, and the store
//     accepts no writes — rewriting a known-fenced set over unknown contents
//     would lift fences nobody can see. Only the explicit owner action
//     (`clear()`, the contract's `resetEnrollmentFences`) rewrites a valid,
//     empty file and heals the store. A MISSING file is unambiguous and
//     healthy-empty; it is not a failure.

import { randomUUID } from "node:crypto";
import { constants, closeSync, existsSync, fsyncSync, fstatSync, lstatSync, mkdirSync,
  openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { z } from "zod";

import { DATA_DIR } from "./data-root-path.ts";

/** One persisted fence row. */
export interface FenceRecord {
  key: string;
  /** Unix ms when the fence was established. Provenance, not ordering —
   * fences have no "newer winner"; they are lifted only by an explicit reset. */
  fencedAt: number;
  /** Why the key was fenced, when the caller named a reason. */
  reason?: string;
}

/** The durable half of the enrollment fence.
 *
 * The contract keeps its in-memory Set as the fast path and consults this
 * store so a fence survives the process that wrote it. Every method is
 * synchronous: `add` returns only after the write has been fsynced and
 * renamed into place (or has thrown), which is what makes the contract's
 * "persist before returning" property hold without introducing an await
 * into a fence path that must not have one. */
export interface FencePersistence {
  /** Keys currently persisted. Order is not significant. */
  read(): string[];
  /** Persist one more fenced key. */
  add(key: string, options?: { reason?: string }): void;
  /** Remove every persisted fence. The explicit owner action; also the only
   * operation that heals a degraded store. */
  clear(): void;
  /** True when the store's contents are UNKNOWN (present but corrupt or
   * unreadable). While degraded, callers must treat every key as fenced and
   * the store refuses writes; `clear()` heals. */
  readonly degraded: boolean;
}

/** Wire shape of the fence file: one JSON object, whole-file snapshot. */
const FENCE_FILE_VERSION = 1;
/** A fence list is bounded by distinct client keys; a file beyond either
 * bound is not a fence file this build wrote, so it is treated as corrupt. */
const MAX_FENCE_FILE_BYTES = 256 * 1024;
const MAX_FENCES = 1024;

const fenceRecordWire = z.object({
  key: z.string().min(1).max(256),
  fencedAt: z.number().refine(Number.isFinite),
  reason: z.string().max(256).optional(),
});

const fenceFileWire = z.object({
  version: z.literal(FENCE_FILE_VERSION),
  fences: z.array(fenceRecordWire).max(MAX_FENCES),
});

/** Where the default fence file lives. A flat file under the data dir, named
 * the way `registryPathFor` names the installation registry — one deployable
 * owns one data dir, so no subdirectory is needed. */
export function defaultEnrollmentFencePath(): string {
  return join(DATA_DIR, "enrollment-fence.json");
}

export interface FileFencePersistenceOptions {
  path: string;
  /** Clock for `fencedAt`. Injectable for determinism; defaults to Date.now. */
  now?: () => number;
}

/** The file-backed `FencePersistence`.
 *
 * Crash safety follows the house pattern (drive-visible-account-restore-
 * journal `durable()`): write a sibling temp file created O_EXCL|O_NOFOLLOW,
 * fsync it, rename over the target, fsync the directory. A reader therefore
 * always sees either the complete previous contents or the complete new ones,
 * never a truncated file. Reads refuse symlinks and verify the opened inode
 * is the one that was stat'd, the same discipline the recovery journal uses. */
export class FileFencePersistence implements FencePersistence {
  private path: string;
  private now: () => number;
  private loaded = false;
  private isDegraded = false;
  private records = new Map<string, FenceRecord>();

  constructor(options: FileFencePersistenceOptions) {
    this.path = options.path;
    this.now = options.now ?? Date.now;
  }

  /** The file this store persists to. Exposed so a caller (and a test) can
   * construct a fresh instance over the SAME file — the restart seam. */
  get filePath(): string {
    return this.path;
  }

  get degraded(): boolean {
    this.ensureLoaded();
    return this.isDegraded;
  }

  read(): string[] {
    this.ensureLoaded();
    return [...this.records.keys()];
  }

  add(key: string, options?: { reason?: string }): void {
    this.ensureLoaded();
    // A degraded store's contents are unknown; adopting a known-fenced set
    // over them would silently lift fences nobody can see. Refuse instead.
    if (this.isDegraded) return;
    const next = new Map(this.records);
    const record: FenceRecord = { key, fencedAt: this.now() };
    if (options?.reason !== undefined) record.reason = options.reason;
    next.set(key, record);
    // Build → write → adopt. If the write throws, nothing is adopted, so the
    // cache never disagrees with the file about what was persisted.
    this.write(next);
    this.records = next;
  }

  clear(): void {
    this.ensureLoaded();
    // Clear is the owner action: it deliberately discards whatever the file
    // held (including a degraded file nobody could parse) and writes a valid
    // empty snapshot, which is what heals the store.
    const next = new Map<string, FenceRecord>();
    this.write(next);
    this.records = next;
    this.isDegraded = false;
  }

  /** Lazy, once. Absent file = healthy and empty; anything else unreadable
   * or unparseable = degraded. */
  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    let bytes: Buffer;
    try {
      const stat = lstatSync(this.path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FENCE_FILE_BYTES) {
        this.isDegraded = true;
        return;
      }
      const fd = openSync(this.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        // The opened inode must be the one that was stat'd, or the contents
        // read are not the contents that were checked.
        const actual = fstatSync(fd);
        if (actual.dev !== stat.dev || actual.ino !== stat.ino) {
          this.isDegraded = true;
          return;
        }
        bytes = readFileSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      // SAFETY: a thrown value from fs is not statically an ErrnoException;
      // narrowing through zod accepts ONLY the one shape this branch acts on
      // (a missing file, which is healthy-empty) and degrades on all others.
      if (z.object({ code: z.literal("ENOENT") }).safeParse(error).success) return;
      this.isDegraded = true;
      return;
    }
    try {
      const file = fenceFileWire.parse(JSON.parse(bytes.toString("utf8")));
      this.records = new Map(file.fences.map((record) => [record.key, record]));
    } catch {
      this.isDegraded = true;
    }
  }

  private write(records: Map<string, FenceRecord>): void {
    const file = { version: FENCE_FILE_VERSION, fences: [...records.values()] };
    durableWrite(this.path, JSON.stringify(file, null, 2));
  }
}

/** In-memory `FencePersistence`, for tests. Same caveat as the contract's
 * synthetic stores: not a conforming durable store, and it says so. */
export class MemoryFencePersistence implements FencePersistence {
  conformsToDurableFence = false;
  private records = new Map<string, FenceRecord>();

  get degraded(): boolean {
    return false;
  }

  read(): string[] {
    return [...this.records.keys()];
  }

  add(key: string, options?: { reason?: string }): void {
    const record: FenceRecord = { key, fencedAt: Date.now() };
    if (options?.reason !== undefined) record.reason = options.reason;
    this.records.set(key, record);
  }

  clear(): void {
    this.records.clear();
  }
}

function syncDirectory(path: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } catch (error) {
    // Windows cannot open directories using this portable Node primitive.
    // The API promises process-restart handling, never power-loss durability.
    if (process.platform !== "win32") throw error;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function durableWrite(path: string, bytes: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temporary, path);
    syncDirectory(dirname(path));
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}
