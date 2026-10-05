// Exclusive-restore boundary for the shared data directory. The claim marker
// lives NEXT TO the data directory (not inside it) so it survives the rename
// window and a boot during an apply can refuse instead of creating a fresh
// directory under a running restore. The claim is the cooperating marker; the
// writer barrier (mode freeze + directory rename window) is the part that
// stops writers which never check anything: while the old tree is frozen and
// renamed away, non-cooperating writers fail with EACCES or ENOENT instead of
// silently interleaving with a restore. Writers holding already-open file
// descriptors keep writing to the orphaned inode; those bytes diverge onto the
// detached tree and never mix into the live one. A root process or Windows
// cannot be excluded by mode bits, so the barrier refuses to run there rather
// than pretending to be exclusive.
import { randomUUID } from "node:crypto";
import { accessSync, chmodSync, closeSync, constants, existsSync, fsyncSync, fstatSync, ftruncateSync, lstatSync,
  openSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

const MAX_CLAIM_BYTES = 4096;
const missing = z.object({ code: z.literal("ENOENT") });
const claimSchema = z.object({
  version: z.literal(1),
  kind: z.literal("data-dir-exclusivity"),
  pid: z.number().int().positive(),
  nonce: z.string().uuid(),
  reason: z.string().min(1).max(200),
  acquiredAt: z.string().min(1).max(40),
  dataDir: z.string().min(1).max(1024),
  dataDirDev: z.number().int().nonnegative(),
  dataDirIno: z.number().int().nonnegative(),
  originalMode: z.number().int().min(0).max(0o777),
  // Set durably BEFORE the old tree is renamed away, so a crash between the
  // two swap renames leaves enough evidence on disk to restore the tree.
  backupPath: z.string().max(1024).optional(),
}).strict();

export type ExclusiveClaimRecord = z.infer<typeof claimSchema>;
export type ClaimIdentity = { dev: number; ino: number };

export class DataDirExclusivityError extends Error {
  code: "occupied" | "corrupt" | "unsafe" | "barrier-unsupported" | "barrier-ineffective" | "changed";
  owner?: ExclusiveClaimRecord;
  constructor(code: DataDirExclusivityError["code"], message: string, owner?: ExclusiveClaimRecord) {
    super(message);
    this.code = code;
    this.owner = owner;
  }
}

// Fail-closed when the uid primitive is unavailable: without it we cannot
// prove mode bits exclude this process, so the barrier reports unsupported.
export const writerBarrierSupported = (): boolean => process.platform !== "win32" && (process.getuid?.() ?? 0) !== 0;

/** The marker is a sibling of the data directory: a swap renames the data
 * directory itself, which must never take the crash evidence with it. */
export const exclusiveClaimPath = (dataDir: string): string =>
  join(dirname(resolve(dataDir)), ".muster-restore-exclusivity.json");

function assertRealDirectory(dataDir: string) {
  const stat = lstatSync(dataDir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || resolve(dataDir) !== resolve(realpathSync(dataDir))) {
    throw new DataDirExclusivityError("unsafe", "Exclusive restore requires a real, non-symlink data directory");
  }
  return { dev: stat.dev, ino: stat.ino, mode: stat.mode & 0o777 };
}

// Bounded no-follow read with open/inode identity, same discipline as the
// recovery journal: a concurrently replaced or growing file is refused.
function readClaimFile(path: string): { bytes: Buffer; identity: ClaimIdentity } | { absent: true } {
  let stat;
  try { stat = lstatSync(path); }
  catch (error) { if (missing.safeParse(error).success) return { absent: true }; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new DataDirExclusivityError("corrupt", "Restore-exclusivity claim is not a plain file; reconcile it manually");
  }
  if (stat.size > MAX_CLAIM_BYTES) {
    throw new DataDirExclusivityError("corrupt", "Restore-exclusivity claim exceeds the pinned size; reconcile it manually");
  }
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const actual = fstatSync(fd);
    if (actual.dev !== stat.dev || actual.ino !== stat.ino) {
      throw new DataDirExclusivityError("corrupt", "Restore-exclusivity claim changed while being read");
    }
    const buffer = Buffer.alloc(stat.size);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    return { bytes: buffer.subarray(0, length), identity: { dev: stat.dev, ino: stat.ino } };
  } finally { closeSync(fd); }
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return !z.object({ code: z.literal("ESRCH") }).safeParse(error).success; }
}

export type ClaimInspection =
  | { status: "absent" }
  | { status: "live" | "stale" | "abandoned"; record: ExclusiveClaimRecord | null; identity: ClaimIdentity }
  | { status: "corrupt"; reason: string };

export function inspectExclusiveRestoreClaim(dataDir: string): ClaimInspection {
  const read = readClaimFile(exclusiveClaimPath(dataDir));
  if ("absent" in read) return { status: "absent" };
  if (read.bytes.length === 0) return { status: "abandoned", record: null, identity: read.identity };
  let record: ExclusiveClaimRecord;
  try { record = claimSchema.parse(JSON.parse(read.bytes.toString("utf8"))); }
  catch {
    return { status: "corrupt", reason: "Restore-exclusivity claim is present but unparseable; reconcile it manually (no writer may be trusted while its owner is unknown)" };
  }
  return { status: pidAlive(record.pid) ? "live" : "stale", record, identity: read.identity };
}

function fsyncDirectory(path: string): void {
  const dir = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { fsyncSync(dir); } catch (error) {
    // Windows cannot fsync directories with this primitive; renames and
    // unlinks remain ordered by the handle table for process-lifetime needs.
    if (process.platform === "win32") return;
    throw error;
  } finally { closeSync(dir); }
}

function durableUnlink(path: string): void {
  unlinkSync(path);
  fsyncDirectory(dirname(path));
}

export class ExclusiveRestoreClaim {
  readonly dataDir: string;
  readonly path: string;
  readonly nonce: string;
  readonly originalMode: number;
  readonly record: ExclusiveClaimRecord;
  readonly identity: ClaimIdentity;
  private frozen = false;
  private expectedBytes: Buffer;

  constructor(dataDir: string, record: ExclusiveClaimRecord, bytes: Buffer, identity: ClaimIdentity) {
    this.dataDir = dataDir;
    this.path = exclusiveClaimPath(dataDir);
    this.nonce = record.nonce;
    this.originalMode = record.originalMode;
    this.record = record;
    this.identity = identity;
    this.expectedBytes = bytes;
  }

  /** Re-proves the claim marker is exactly as last written by this holder.
   * Throws once it has been removed, replaced or rewritten underneath us. */
  assert(): void {
    const current = readClaimFile(this.path);
    if ("absent" in current || !current.bytes.equals(this.expectedBytes)
      || current.identity.dev !== this.identity.dev || current.identity.ino !== this.identity.ino) {
      throw new DataDirExclusivityError("changed", "Exclusive-restore claim was removed or replaced mid-operation; failing closed");
    }
  }

  /** Persist swap evidence into the marker in place (same inode, so asserts
   * keep working) BEFORE the destructive rename, so a crash between the two
   * renames leaves the backup path on disk for boot-time recovery. */
  recordBackupPath(backupPath: string): void {
    const next: ExclusiveClaimRecord = { ...this.record, backupPath: resolve(backupPath) };
    const bytes = Buffer.from(JSON.stringify(next), "utf8");
    const fd = openSync(this.path, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      fstatSync(fd);
      writeFileSync(fd, bytes);
      ftruncateSync(fd, bytes.length);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    fsyncDirectory(dirname(this.path));
    this.record.backupPath = next.backupPath;
    this.expectedBytes = bytes;
    this.assert();
  }

  markFrozen(): void { this.frozen = true; }
  markUnfrozen(): void { this.frozen = false; }

  release(): void {
    this.assert();
    // Unfreeze before removing the claim: a crash after the unlink but before
    // a needed mode restore would leave the directory unwritable with no
    // claim left to explain it.
    if (this.frozen) chmodSync(this.dataDir, this.originalMode);
    durableUnlink(this.path);
    this.frozen = false;
  }
}

/** Acquire the exclusive-restore claim, refusing a live or corrupt prior claim.
 * A claim whose owner process is provably dead (ESRCH) is adopted only when
 * `recoverDeadOwner` is set; an abandoned zero-byte marker is the crash window
 * between create and write and is adoptable for the same reason. */
export function acquireDataDirExclusivity(
  dataDir: string, reason: string, options: { recoverDeadOwner?: boolean } = {},
): ExclusiveRestoreClaim {
  const root = resolve(dataDir);
  const stat = assertRealDirectory(root);
  const existing = inspectExclusiveRestoreClaim(root);
  if (existing.status === "live") {
    throw new DataDirExclusivityError("occupied",
      `Exclusive restore already claimed by pid ${existing.record?.pid} (${existing.record?.reason}); refusing to start a competing exclusive restore`, existing.record ?? undefined);
  }
  if (existing.status === "corrupt") throw new DataDirExclusivityError("corrupt", existing.reason);
  if (existing.status === "stale" || existing.status === "abandoned") {
    if (!options.recoverDeadOwner) {
      throw new DataDirExclusivityError("occupied",
        existing.status === "stale"
          ? `Stale exclusive-restore claim from dead pid ${existing.record?.pid}; recovery was not requested`
          : "Abandoned empty restore-exclusivity claim; recovery was not requested");
    }
    durableUnlink(exclusiveClaimPath(root));
  }
  const record: ExclusiveClaimRecord = {
    version: 1, kind: "data-dir-exclusivity", pid: process.pid, nonce: randomUUID(),
    reason: z.string().min(1).max(200).parse(reason),
    acquiredAt: new Date().toISOString(),
    dataDir: root, dataDirDev: stat.dev, dataDirIno: stat.ino, originalMode: stat.mode,
  };
  const bytes = Buffer.from(JSON.stringify(record), "utf8");
  const path = exclusiveClaimPath(root);
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  fsyncDirectory(dirname(path));
  const identity = lstatSync(path);
  return new ExclusiveRestoreClaim(root, record, bytes, { dev: identity.dev, ino: identity.ino });
}

export type WriterSwap = {
  /** The freeze is active; rename the live tree to the backup path. */
  beginSwap(backupPath: string): void;
  /** Move the fully staged replacement into place under the same claim. */
  completeSwap(stagingPath: string): void;
};

type BarrierState = { phase: "frozen" | "old-away" | "new-in"; backupPath: string | null };

/** Run `perform` under the writer barrier. The mode freeze is applied before
 * perform starts and held across every await inside it; the swap itself is a
 * pair of parent-directory renames, so non-cooperating writers see EACCES on
 * the frozen tree and then ENOENT during the rename window instead of writing
 * into a tree that is being replaced. Any failure restores the previous tree
 * best-effort and rethrows; a rollback failure is reported as `changed` so a
 * silently half-restored tree can never look like success. */
export async function runWithWriterBarrier(
  dataDir: string, claim: ExclusiveRestoreClaim,
  perform: (swap: WriterSwap) => void | Promise<void>,
): Promise<void> {
  const root = resolve(dataDir);
  if (root !== claim.record.dataDir) throw new DataDirExclusivityError("unsafe", "Claim does not belong to this data directory");
  if (!writerBarrierSupported()) {
    throw new DataDirExclusivityError("barrier-unsupported",
      "Writer barrier requires POSIX mode bits and a non-root process; refusing to run an exclusive restore that cannot exclude writers");
  }
  claim.assert();
  chmodSync(root, 0o555);
  claim.markFrozen();
  // Self-probe: the freeze must actually exclude THIS process too, otherwise
  // mode bits are meaningless here (root, capabilities) and exclusivity would
  // be an unverified assumption rather than an enforced boundary.
  try {
    accessSync(root, constants.W_OK);
    throw new DataDirExclusivityError("barrier-ineffective",
      "Write-freeze probe succeeded; mode bits do not exclude this process, so no real writer exclusion is possible");
  } catch (error) {
    if (error instanceof DataDirExclusivityError) throw error;
    // Expected: W_OK refused on the frozen directory. The barrier is live.
  }
  // A named state contract rather than a plain let: the swap closures below
  // mutate these between awaits, and control-flow narrowing on a captured let
  // does not survive the async call boundary.
  const state: BarrierState = { phase: "frozen", backupPath: null };
  const restore = (): Error | null => {
    try {
      if (state.phase === "old-away" && state.backupPath !== null) renameSync(state.backupPath, root);
      chmodSync(root, claim.originalMode);
      return null;
    } catch (rollbackError) { return rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError)); }
  };
  const outside = (candidate: string, label: string): string => {
    if (!isAbsolute(candidate) || resolve(candidate) === root || resolve(candidate).startsWith(root + "/")) {
      throw new DataDirExclusivityError("unsafe", `Restore ${label} path must be outside the data directory`);
    }
    return resolve(candidate);
  };
  const swap: WriterSwap = {
    beginSwap(backup: string): void {
      claim.assert();
      const target = outside(backup, "backup");
      // Evidence lands on disk before the tree moves, never after.
      claim.recordBackupPath(target);
      renameSync(root, target);
      state.backupPath = target;
      state.phase = "old-away";
    },
    completeSwap(staging: string): void {
      claim.assert();
      if (state.phase !== "old-away") throw new DataDirExclusivityError("changed", "completeSwap requires beginSwap first");
      const target = outside(staging, "staging");
      renameSync(target, root);
      state.phase = "new-in";
    },
  };
  try {
    await perform(swap);
    // A perform that returns without driving the swap to completion is a
    // caller bug, not a success: roll the tree back like any other failure
    // instead of leaving it renamed away behind a live claim.
    if (state.phase === "old-away") {
      throw new DataDirExclusivityError("changed", "Swap stopped after beginSwap; the restore did not complete");
    }
  } catch (error) {
    const rollbackError = restore();
    claim.markUnfrozen();
    if (rollbackError) {
      throw new DataDirExclusivityError("changed",
        `Exclusive restore failed and rollback also failed (${rollbackError.message}); manual reconciliation required`);
    }
    throw error;
  }
  claim.assert();
  chmodSync(root, claim.originalMode);
  if (state.phase === "new-in" && state.backupPath !== null) {
    // The detached old tree must not stay frozen: after the swap it is an
    // ordinary backup directory, and the restore flow (or an operator) has to
    // be able to clean it up. Path-based writers cannot reach it (it is only
    // named inside the claim record), so thawing it weakens nothing.
    chmodSync(state.backupPath, claim.originalMode);
  }
  claim.markUnfrozen();
}

/** Boot guard: refuse startup while another process holds the exclusive-restore
 * claim (including the rename window, when the data directory itself is
 * missing), recover the provable crash states of a dead owner, and refuse the
 * boot anyway after touching recovery, mirroring the recovery-journal posture.
 * Fail-closed rule: a state that cannot be proven either way is a refusal with
 * reconciliation instructions, never a silent fresh boot. */
export function assertNoLiveExclusiveRestoreClaim(dataDir: string): void {
  const root = resolve(dataDir);
  const marker = exclusiveClaimPath(root);
  const inspection = inspectExclusiveRestoreClaim(root);
  if (inspection.status === "absent") return;
  if (inspection.status === "live") {
    throw new Error(`Exclusive restore is in progress by pid ${inspection.record?.pid} (${inspection.record?.reason}); server startup refused before initialization.`);
  }
  if (inspection.status === "corrupt") {
    throw new Error(`Restore-exclusivity claim is unreadable (${inspection.reason}); server startup refused before initialization.`);
  }
  if (inspection.status === "abandoned" && !existsSync(root)) {
    // Zero-byte marker with no data directory: the owner died during claim
    // creation. Clearing it is provable (nothing was claimed yet).
    durableUnlink(marker);
    return;
  }
  if (inspection.status === "abandoned" || inspection.status === "stale") {
    const record = inspection.record;
    const directoryPresent = existsSync(root);
    const backupPresent = record?.backupPath !== undefined && existsSync(record.backupPath);
    if (!directoryPresent && record?.backupPath !== undefined && backupPresent) {
      // Crash between the two swap renames: the old tree is at the recorded
      // backup path. Restore it, then refuse this boot — recovery changed
      // state, so the next boot must observe a clean directory.
      renameSync(record.backupPath, root);
      chmodSync(root, record?.originalMode ?? 0o755);
      durableUnlink(marker);
      throw new Error("A previous exclusive restore was interrupted between its swap steps; the previous data directory was restored from its recorded backup path. Server startup refused once; restart to continue.");
    }
    if (!directoryPresent) {
      throw new Error(`Restore-exclusivity claim names data directory ${record?.dataDir ?? root} which is missing without a recoverable backup path; reconcile manually. Server startup refused before initialization.`);
    }
    if (backupPresent && directoryPresent) {
      throw new Error(`Restore-exclusivity claim from dead pid ${record?.pid} has both its data directory and its recorded backup path present; reconcile manually. Server startup refused before initialization.`);
    }
    let writable = true;
    try { accessSync(root, constants.W_OK); } catch { writable = false; }
    if (!writable) {
      // Crash while the tree was frozen. Restore the mode, clear the dead
      // claim, and refuse this boot once.
      chmodSync(root, record?.originalMode ?? 0o755);
      durableUnlink(marker);
      throw new Error("A previous exclusive restore was interrupted while the data directory was frozen; the directory was restored and the stale claim removed. Server startup refused once; restart to continue.");
    }
    durableUnlink(marker);
  }
}
