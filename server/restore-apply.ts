// Pending-restore apply — the boot-time half of the portable backup story.
//
// A v2 restore is staged while the server runs (decrypt + verify + a hashed
// copy into a staging tree, live installation untouched) and COMMITTED at
// boot, before the Store or the message database ever open the files the
// commit is about to replace. Committing into a running installation would
// leave the in-memory store authoritative and silently overwrite the restore
// on its next save — the same reason the benchmark product applies its
// restores before config/store load.
//
// The commit is followed by DE-WEAPONIZATION: routines restored from a backup
// never fire until a human re-enables them, and goals never resume on their
// own. A restored workspace must not act.
//
// The v2 commit guard requires staging and backup trees OUTSIDE the data
// directory (a backup inside the live tree could be swept by the next export
// or wedge the swap), so both live as siblings of DATA_DIR.
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { z } from "zod";

import { capturePreMigrationSnapshot } from "./snapshot-runner.ts";
import { commitRestoreV2, RESTORE_BACKUPS_DIR, stagingManifestConsumed, type CommitRestoreResult, type ReconsentEntry } from "./workspace-bundle-v2.ts";

const PENDING_FILE = "pending-restore.json";
const RECEIPT_FILE = "last-restore.json";

export const PENDING_RESTORE_FORMAT = "muster-pending-restore" as const;

const pendingSchema = z.object({
  version: z.literal(1),
  format: z.literal(PENDING_RESTORE_FORMAT),
  stagingDir: z.string(),
  createdAt: z.number(),
  source: z.string(),
  counts: z.unknown().optional(),
  reconsentRequired: z.array(
    z.object({ botId: z.string(), restoredId: z.string(), reason: z.string() }),
  ).default([]),
});

export type PendingRestore = z.infer<typeof pendingSchema>;

export interface Receipt {
  appliedAt: number;
  status: "committed" | "failed" | "rolled-back" | "refused";
  createdAt: number;
  source: string;
  counts?: unknown;
  reconsentRequired: ReconsentEntry[];
  error?: string;
  blocked?: { path: string; detail: string }[];
  backupDir?: string;
}

const receiptSchema = z.object({
  appliedAt: z.number(),
  status: z.enum(["committed", "failed", "rolled-back", "refused"]),
  createdAt: z.number(),
  source: z.string(),
  counts: z.unknown().optional(),
  reconsentRequired: z.array(z.unknown()).default([]),
  error: z.string().optional(),
  blocked: z.array(z.object({ path: z.string(), detail: z.string() })).optional(),
  backupDir: z.string().optional(),
});

function write0600(path: string, text: string): void {
  writeFileSync(path, text, { mode: 0o600 });
}

/** The conventional staging path for a data directory — a sibling, never
 * inside: the v2 commit guard refuses a staging tree it contains. */
export function stagingPathFor(dataDir: string): string {
  return `${dataDir}.restore-staging`;
}

/** Root for per-restore safety copies. Kept INSIDE the data dir, in the one
 * namespace commitRestoreV2 reserves for exactly this: the safety copy must
 * travel with the workspace it protects — a portable bundle, a Drive pull,
 * or a machine move otherwise leaves the pre-restore state behind on the old
 * device, and a sibling path shares that fate. Exported so the boot-wedge
 * suite can pin the same root the implementation uses. */
export function backupsRootFor(dataDir: string): string {
  return join(dataDir, RESTORE_BACKUPS_DIR);
}

/** Record a staged restore for the next boot to apply. Throws if a restore is
 * already pending — the caller must resolve it (apply or discard) first. */
export function writePendingRestore(dataDir: string, pending: PendingRestore): void {
  if (readPendingRestore(dataDir)) {
    throw new Error("a staged restore is already waiting for restart — apply or discard it first");
  }
  // the boot apply trusts the conventional path only; refuse anything else at
  // write time so a stale or hand-edited pending file can never point the
  // swap at an arbitrary tree.
  if (pending.stagingDir !== stagingPathFor(dataDir)) {
    throw new Error("staging directory must be the conventional sibling staging path");
  }
  write0600(join(dataDir, PENDING_FILE), JSON.stringify(pending, null, 2));
}

export function readPendingRestore(dataDir: string): PendingRestore | null {
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, PENDING_FILE), "utf8"));
    return pendingSchema.parse(raw);
  } catch {
    return null;
  }
}

export function clearPendingRestore(dataDir: string): void {
  try {
    rmSync(join(dataDir, PENDING_FILE), { force: true });
  } catch {
    /* already gone */
  }
}

export function readLastReceipt(dataDir: string): Receipt | null {
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, RECEIPT_FILE), "utf8"));
    // SAFETY: receiptSchema.parse establishes the Receipt shape; the cast only
    // restates the interface the schema was written against.
    return receiptSchema.parse(raw) as Receipt;
  } catch {
    return null;
  }
}

/** Routines restored from a backup are switched off and goals stopped, before
 * any manager reads them. Written temp-then-rename so a crash can never leave
 * a half-rewritten file. The restored files are untrusted bytes, so the shape
 * is parsed at this boundary; anything else is left for the managers' own
 * loaders to report. */
const routinesDocSchema = z.object({ routines: z.array(z.record(z.string(), z.unknown())) });
const goalsDocSchema = z.object({ goals: z.array(z.record(z.string(), z.unknown())) });

/** Returns null on success, the reason on failure. The reason is NOT
 * swallowed: a rewrite that could not land means the restored file still has
 * its routines armed, which is the one outcome the module header forbids, so
 * the caller has to be able to say the disarm did not happen. */
function rewriteIfChanged<T>(file: string, doc: T): string | null {
  try {
    write0600(`${file}.tmp`, JSON.stringify(doc, null, 2));
    renameSync(`${file}.tmp`, file);
    return null;
  } catch (error) {
    try {
      rmSync(`${file}.tmp`, { force: true });
    } catch {
      /* the rename path is the contract; debris is cosmetic */
    }
    return error instanceof Error ? error.message : String(error);
  }
}

interface DeWeaponizeResult {
  /** files whose disarmed content actually reached disk */
  changed: string[];
  /** one line per file that still needs disarming but could not be written */
  failures: string[];
}

function deWeaponize(dataDir: string): DeWeaponizeResult {
  const changed: string[] = [];
  const failures: string[] = [];
  const routinesFile = join(dataDir, "routines.json");
  try {
    if (existsSync(routinesFile)) {
      const parsed = routinesDocSchema.safeParse(JSON.parse(readFileSync(routinesFile, "utf8")));
      if (parsed.success) {
        let n = 0;
        for (const r of parsed.data.routines) {
          if (r.enabled !== false) { r.enabled = false; n += 1; }
          if (r.nextRunAt !== null) { r.nextRunAt = null; n += 1; }
        }
        if (n > 0) {
          const failure = rewriteIfChanged(routinesFile, parsed.data);
          if (failure === null) changed.push("routines");
          else failures.push(`routines.json could not be rewritten (${failure}) — restored routines may still be enabled`);
        }
      }
    }
  } catch {
    /* malformed restored file — the manager's own loader reports it */
  }
  const goalsFile = join(dataDir, "goals.json");
  try {
    if (existsSync(goalsFile)) {
      const parsed = goalsDocSchema.safeParse(JSON.parse(readFileSync(goalsFile, "utf8")));
      if (parsed.success) {
        let n = 0;
        for (const g of parsed.data.goals) {
          if (g.status === "active") { g.status = "stopped"; n += 1; }
        }
        if (n > 0) {
          const failure = rewriteIfChanged(goalsFile, parsed.data);
          if (failure === null) changed.push("goals");
          else failures.push(`goals.json could not be rewritten (${failure}) — restored goals may still be active`);
        }
      }
    }
  } catch {
    /* see above */
  }
  return { changed, failures };
}

/** A previous process can die with the write-ahead log uncheckpointed, and
 * the v2 commit guard then (correctly) refuses to replace a live messages.db
 * that has sidecars. At boot this process is the only one that can hold the
 * database, so fold the WAL into the main file and clear the sidecars before
 * the swap. If that fails the commit guard still refuses, honestly. */
function checkpointLiveDb(dataDir: string): void {
  const dbPath = join(dataDir, "messages.db");
  if (!existsSync(dbPath)) return;
  if (!existsSync(`${dbPath}-wal`) && !existsSync(`${dbPath}-shm`)) return;
  try {
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      db.close();
    }
  } catch {
    /* the commit guard reports it */
  }
}

export interface ApplyResult {
  status: "committed" | "failed" | "rolled-back" | "refused" | "nothing-pending";
  pending?: PendingRestore;
  commit?: CommitRestoreResult;
  deWeaponized?: string[];
  error?: string;
}

/** A safety copy is never overwritten, so commitRestoreV2 refusing an existing
 * backup directory is a real guard and stays. What cannot stay is a name that
 * is derived from `pending.createdAt` alone: a commit that throws mid-write
 * rolls back but LEAVES its backup tree, the pending file survives a
 * non-committed outcome, and the next boot recomputes the same stamp and hits
 * the same refusal — forever, wedging a restore the operator may no longer be
 * able to re-stage. The retry therefore takes the next free name under the same
 * backups root: every safety copy is preserved, and only the NAME moves. */
const MAX_BACKUP_ATTEMPTS = 64;

function freeBackupDir(dataDir: string, stamp: string): string {
  const root = backupsRootFor(dataDir);
  let candidate = join(root, stamp);
  for (let attempt = 1; attempt <= MAX_BACKUP_ATTEMPTS && existsSync(candidate); attempt += 1) {
    candidate = join(root, `${stamp}-retry-${attempt}`);
  }
  return candidate;
}

/** Retry ONLY the de-weaponization of an already-committed restore: the
 * staging manifest is consumed, so the words are on disk and the commit is
 * done. The fresh receipt carries the ORIGINAL safety-copy location forward;
 * the pending file clears only when the disarm actually landed. */
function finishDisarmOnly(dataDir: string, pending: PendingRestore): ApplyResult {
  const deWeapon = deWeaponize(dataDir);
  const armed = deWeapon.failures.length > 0;
  const previous = readLastReceipt(dataDir);
  const disarmError = armed
    ? `the restore was written but de-weaponization did not complete: ${deWeapon.failures.join("; ")}`
    : undefined;
  const receipt: Receipt = {
    appliedAt: Date.now(),
    status: armed ? "failed" : "committed",
    createdAt: pending.createdAt,
    source: pending.source,
    reconsentRequired: pending.reconsentRequired,
  };
  if (pending.counts !== undefined) receipt.counts = pending.counts;
  if (disarmError !== undefined) receipt.error = disarmError;
  if (previous?.backupDir !== undefined) receipt.backupDir = previous.backupDir;
  try {
    write0600(join(dataDir, RECEIPT_FILE), JSON.stringify(receipt, null, 2));
  } catch {
    /* receipt is best-effort; the restore itself is the contract */
  }
  if (!armed) {
    clearPendingRestore(dataDir);
    pruneStaging(pending.stagingDir);
    return { status: "committed", pending, deWeaponized: deWeapon.changed };
  }
  return { status: "failed", pending, deWeaponized: deWeapon.changed, error: disarmError };
}

/** The boot hook: run BEFORE the Store is constructed. A commit that fails,
 * rolls back, or is refused keeps the pending file so the next boot retries,
 * and records the outcome in the receipt so the UI can say so honestly. A
 * commit that lands but whose de-weaponization could not be written is
 * `failed`, not `committed`, and keeps the pending file for the same reason:
 * the staging manifest stays unconsumed, so a later boot retries ONLY the
 * disarm via finishDisarmOnly — the commit itself never re-runs. */
export function applyPendingRestore(dataDir: string): ApplyResult {
  const pending = readPendingRestore(dataDir);
  if (!pending) return { status: "nothing-pending" };
  // B1 pre-restore capture: the commit below REPLACES the live tree, so the
  // pre-mutation state is sealed SYNCHRONOUSLY here, before checkpointLiveDb
  // writes anything. Two-phase inside the runner: sync seal, detached ship;
  // a closed gate is a silent observation and a ship failure never blocks
  // the restore. Guarded OUT of the test harness deliberately: the
  // workspace-drive fixture records any outbound attempt (its Drive has no
  // DELETE branch for retention) and no test may reach a real Keychain —
  // boot environments are clean, the same rule
  // snapshot-scheduler.startSnapshotScheduler documents.
  if (!process.env.VITEST && process.env.NODE_ENV !== "test") {
    capturePreMigrationSnapshot(dataDir, "pre-restore");
  }
  const stamp = new Date(pending.createdAt).toISOString().replace(/[:.]/g, "-");
  if (stagingManifestConsumed(pending.stagingDir)) {
    return finishDisarmOnly(dataDir, pending);
  }
  const backupDir = freeBackupDir(dataDir, stamp);
  checkpointLiveDb(dataDir);
  let commit: CommitRestoreResult;
  try {
    commit = commitRestoreV2({
      stagingDir: pending.stagingDir,
      dataDir,
      backupDir,
      confirm: true,
    });
  } catch (e) {
    commit = {
      status: "refused",
      moved: [],
      written: [],
      backupDir,
      blocked: [{ path: "-", detail: e instanceof Error ? e.message : String(e) }],
      error: e instanceof Error ? e.message : String(e),
    };
  }
  // De-weaponization runs BEFORE the receipt is written, because a disarm that
  // could not land is part of this run's outcome: a restored workspace that
  // still has armed routines must never be filed under "committed".
  const deWeapon = commit.status === "committed" ? deWeaponize(dataDir) : { changed: [], failures: [] };
  const armed = deWeapon.failures.length > 0;
  const disarmError = armed
    ? `the restore was written but de-weaponization did not complete: ${deWeapon.failures.join("; ")}`
    : undefined;
  const receipt: Receipt = {
    appliedAt: Date.now(),
    status: armed ? "failed" : commit.status,
    createdAt: pending.createdAt,
    source: pending.source,
    reconsentRequired: pending.reconsentRequired,
  };
  if (pending.counts !== undefined) receipt.counts = pending.counts;
  if (receipt.status !== "committed") {
    if (disarmError !== undefined) receipt.error = disarmError;
    else if (commit.error !== undefined) receipt.error = commit.error;
  }
  if (commit.status !== "committed" && commit.blocked.length > 0) receipt.blocked = commit.blocked;
  if (commit.status === "committed") receipt.backupDir = backupDir;
  try {
    write0600(join(dataDir, RECEIPT_FILE), JSON.stringify(receipt, null, 2));
  } catch {
    /* receipt is best-effort; the restore itself is the contract */
  }
  if (commit.status !== "committed") {
    return { status: receipt.status, pending, commit, error: commit.error };
  }
  if (!armed) {
    clearPendingRestore(dataDir);
    pruneStaging(pending.stagingDir);
    return { status: "committed", pending, commit, deWeaponized: deWeapon.changed };
  }
  // The commit landed and the staging tree is still unconsumed, so the pending
  // file and the staging tree both stay: the next boot re-applies under a fresh
  // safety-copy name and re-tries the disarm. Clearing them here would leave
  // armed routines behind with nothing left to retry from.
  return { status: "failed", pending, commit, deWeaponized: deWeapon.changed, error: disarmError };
}

/** The rename-swap consumes the staged files, leaving only the staging
 * manifest behind. Delete the whole tree so a later stage (which refuses a
 * non-empty directory) is not blocked by the consumed one's debris. */
function pruneStaging(stagingDir: string): void {
  try {
    rmSync(stagingDir, { recursive: true, force: true });
  } catch {
    /* debris is cosmetic */
  }
}
