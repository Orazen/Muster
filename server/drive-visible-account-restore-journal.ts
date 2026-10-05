// Owned synthetic offline roots only. This lock excludes cooperating recovery
// processes; it is not a writer barrier for a running product installation.
import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, existsSync, fsyncSync, fstatSync, lstatSync, mkdirSync, mkdtempSync,
  openSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

const MAX_JOURNAL_BYTES = 96 * 1024 * 1024;
const id = z.string().min(1).max(200).regex(/^[\w-]+$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const ownerSchema = z.object({ version: z.literal(1), kind: z.literal("synthetic-account-recovery"),
  root: z.string(), nonce: z.string().uuid(), dev: z.number(), ino: z.number() }).strict();
const relative = z.string().max(512).refine(path => /^(bots\.json|groups\.json|task-plans\.json)$/.test(path)
  || /^workspaces\/[\w-]{1,200}\/(MEMORY\.md|memory\/[\w][\w .-]{0,199}\.md)$/.test(path));
const changeSchema = z.object({ path: relative, before: z.string().max(MAX_JOURNAL_BYTES).nullable(),
  after: z.string().max(MAX_JOURNAL_BYTES), mode: z.number().int().min(0).max(0o777) }).strict();
const mappingSchema = z.object({ bot: z.record(id,id), group: z.record(id,id), thread: z.record(id,id), plan: z.record(id,id) }).strict();
const immutableSchema = z.object({ version: z.literal(1), operationId: id, sourceDigest: hash, archiveHash: hash,
  account: z.object({ userId: id, workspaceId: id, googleSub: z.string().min(1).max(1024) }).strict(),
  mapping: mappingSchema, changes: z.array(changeSchema).max(16_384), threadPayload: z.string().max(MAX_JOURNAL_BYTES),
  inertHistory: z.string().max(MAX_JOURNAL_BYTES), createdDirs: z.array(z.string().max(512)).max(16_384) }).strict();
const receiptSchema = z.object({ version: z.literal(1), operationId: id, immutableHash: hash,
  status: z.enum(["pending","committed","rolled-back","rollback-failed"]), phase: z.string().max(100) }).strict();
export type OwnedOfflineRecoveryRoot = { root: string; nonce: string };
export type RecoveryJournal = z.infer<typeof immutableSchema>;
export type RecoveryReceipt = z.infer<typeof receiptSchema>;
export const recoveryByteHash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export function syncRecoveryDirectory(path: string): void {
  let fd: number | null = null;
  try { fd = openSync(path, "r"); fsyncSync(fd); }
  catch (error) {
    // Windows cannot open directories using this portable Node primitive.
    // The API promises process-restart handling, never power-loss durability.
    if (process.platform !== "win32") throw error;
  } finally { if (fd !== null) closeSync(fd); }
}
function regular(path: string, limit = MAX_JOURNAL_BYTES): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > limit) throw new Error("Unsafe recovery file");
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const actual = fstatSync(fd);
    if (actual.dev !== stat.dev || actual.ino !== stat.ino) throw new Error("Recovery file changed");
    return readFileSync(fd);
  } finally { closeSync(fd); }
}
function durable(path: string, bytes: string | Buffer, mode = 0o600): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), mode);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(temporary, path); syncRecoveryDirectory(dirname(path)); }
  catch (error) { if (existsSync(temporary)) unlinkSync(temporary); throw error; }
}
/** Creates a NEW private owned fixture, never adopts an existing data root. */
export function createOwnedOfflineRecoveryRoot(): OwnedOfflineRecoveryRoot {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "muster-account-recovery-")));
  const stat = lstatSync(root), nonce = randomUUID();
  durable(join(root, ".account-recovery-owner.json"), JSON.stringify({ version: 1, kind: "synthetic-account-recovery", root, nonce, dev: stat.dev, ino: stat.ino }));
  return { root, nonce };
}
export function assertOwnedOfflineRecoveryRoot(owned: OwnedOfflineRecoveryRoot): void {
  const stat = lstatSync(owned.root);
  const owner = ownerSchema.parse(JSON.parse(regular(join(owned.root, ".account-recovery-owner.json"), 4096).toString("utf8")));
  if (!stat.isDirectory() || stat.isSymbolicLink() || resolve(owned.root) !== realpathSync(owned.root)
    || owner.root !== owned.root || owner.nonce !== owned.nonce || owner.dev !== stat.dev || owner.ino !== stat.ino
    || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) throw new Error("Not an owned offline recovery root");
}
const journalDir = (owned: OwnedOfflineRecoveryRoot) => join(owned.root, "account-recovery-journal");
function confined(owned: OwnedOfflineRecoveryRoot, relativePath: string): string {
  relative.parse(relativePath); assertOwnedOfflineRecoveryRoot(owned);
  const path = join(owned.root, relativePath);
  let parent = dirname(path);
  while (parent !== owned.root) {
    if (existsSync(parent)) {
      const stat = lstatSync(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe recovery parent");
    }
    parent = dirname(parent);
  }
  return path;
}
export function readRecoveryTarget(owned: OwnedOfflineRecoveryRoot, path: string): { bytes: string | null; mode: number } {
  const full = confined(owned,path);
  return existsSync(full) ? { bytes: regular(full).toString("utf8"), mode: lstatSync(full).mode & 0o777 } : { bytes: null, mode: 0o600 };
}
export interface OfflineRecoveryLease { owned: OwnedOfflineRecoveryRoot; assert(): void; release(): void }
export function acquireOfflineRecoveryLease(owned: OwnedOfflineRecoveryRoot, recoverDeadOwner = false): OfflineRecoveryLease {
  assertOwnedOfflineRecoveryRoot(owned);
  const directory = journalDir(owned);
  if (!existsSync(directory)) { mkdirSync(directory, { mode: 0o700 }); syncRecoveryDirectory(owned.root); }
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error("Unsafe journal directory");
  const path = join(directory,"writer.lock");
  if (existsSync(path)) {
    const lock = z.object({ pid: z.number().int().positive(), token: z.string().uuid(), nonce: z.string().uuid() }).strict()
      .parse(JSON.parse(regular(path,4096).toString("utf8")));
    if (!recoverDeadOwner || lock.nonce !== owned.nonce) throw new Error("Offline recovery writer occupied");
    let dead = false;
    try { process.kill(lock.pid,0); } catch (error) { dead = z.object({ code: z.literal("ESRCH") }).safeParse(error).success; }
    if (!dead) throw new Error("Offline recovery writer occupied");
    unlinkSync(path); syncRecoveryDirectory(directory);
  }
  const token = randomUUID(), bytes = JSON.stringify({ pid: process.pid,token,nonce: owned.nonce });
  const fd = openSync(path,constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),0o600);
  try { writeFileSync(fd,bytes); fsyncSync(fd); } finally { closeSync(fd); }
  syncRecoveryDirectory(directory);
  const identity = lstatSync(path);
  const assert = () => {
    assertOwnedOfflineRecoveryRoot(owned);
    const current = lstatSync(path);
    if (current.dev !== identity.dev || current.ino !== identity.ino || regular(path,4096).toString("utf8") !== bytes) throw new Error("Recovery lease changed");
  };
  return { owned, assert, release: () => { assert(); unlinkSync(path); syncRecoveryDirectory(directory); } };
}
function operationDir(lease: OfflineRecoveryLease, operationId: string): string {
  id.parse(operationId); lease.assert();
  const directory = join(journalDir(lease.owned),operationId);
  if (existsSync(directory) && (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink())) throw new Error("Unsafe recovery operation");
  return directory;
}
export function loadRecoveryOperation(lease: OfflineRecoveryLease, operationId: string): { journal: RecoveryJournal; receipt: RecoveryReceipt } | null {
  const directory = operationDir(lease,operationId);
  if (!existsSync(directory)) return null;
  const bytes = regular(join(directory,"immutable.json"));
  const journal = immutableSchema.parse(JSON.parse(bytes.toString("utf8")));
  const receipt = receiptSchema.parse(JSON.parse(regular(join(directory,"receipt.json"),4096).toString("utf8")));
  if (journal.operationId !== operationId || receipt.operationId !== operationId || receipt.immutableHash !== recoveryByteHash(bytes)
    || recoveryByteHash(regular(join(directory,"archive.bin"))) !== journal.archiveHash) throw new Error("Recovery operation integrity unavailable");
  return { journal,receipt };
}
export function listRecoveryOperations(lease: OfflineRecoveryLease): string[] {
  lease.assert();
  // An intention becomes visible atomically only when all immutable bytes and
  // its initial receipt exist. Interrupted private staging is preserved as
  // evidence, and can never authorize account writes or block a fresh retry.
  return readdirSync(journalDir(lease.owned)).filter(name => name !== "writer.lock" && !/^\.preparing-[a-f0-9-]{36}$/.test(name));
}
export function beginRecoveryOperation(lease: OfflineRecoveryLease, offered: RecoveryJournal, archive: Buffer): RecoveryReceipt {
  lease.assert(); const journal = immutableSchema.parse(offered);
  const directory = operationDir(lease,journal.operationId);
  if (existsSync(directory) || recoveryByteHash(archive) !== journal.archiveHash) throw new Error("Recovery operation collision");
  if (new Set(journal.changes.map(change => change.path)).size !== journal.changes.length) throw new Error("Duplicate recovery target");
  if(journal.changes.some(change=>readRecoveryTarget(lease.owned,change.path).bytes!==change.before)
    || JSON.stringify(journal.createdDirs)!==JSON.stringify(absentRecoveryDirectories(lease.owned,journal.changes)))throw new Error("Recovery before-image or directory inventory changed");
  const bytes = JSON.stringify(journal);
  if (Buffer.byteLength(bytes) > MAX_JOURNAL_BYTES) throw new Error("Recovery journal too large");
  const preparing=join(journalDir(lease.owned),`.preparing-${randomUUID()}`);
  mkdirSync(preparing,{mode:0o700}); syncRecoveryDirectory(journalDir(lease.owned));
  durable(join(preparing,"archive.bin"),archive);
  durable(join(preparing,"immutable.json"),bytes);
  const receipt: RecoveryReceipt = { version:1,operationId:journal.operationId,immutableHash:recoveryByteHash(bytes),status:"pending",phase:"intent" };
  durable(join(preparing,"receipt.json"),JSON.stringify(receipt));
  renameSync(preparing,directory);syncRecoveryDirectory(journalDir(lease.owned));return receipt;
}
export function markRecoveryOperation(lease: OfflineRecoveryLease, receipt: RecoveryReceipt, status: RecoveryReceipt["status"], phase: string): RecoveryReceipt {
  lease.assert(); const next = receiptSchema.parse({...receipt,status,phase});
  durable(join(operationDir(lease,receipt.operationId),"receipt.json"),JSON.stringify(next)); return next;
}
export function absentRecoveryDirectories(owned: OwnedOfflineRecoveryRoot, changes: RecoveryJournal["changes"]): string[] {
  const result = new Set<string>();
  for (const change of changes) {
    let full = dirname(confined(owned,change.path));
    while (full !== owned.root) {
      if (!existsSync(full)) result.add(full.slice(owned.root.length+1));
      full = dirname(full);
    }
  }
  return [...result].sort((a,b) => a.split("/").length-b.split("/").length);
}
export function writeFreshRecoveryTarget(lease: OfflineRecoveryLease, change: RecoveryJournal["changes"][number]): void {
  lease.assert();
  const current = readRecoveryTarget(lease.owned,change.path);
  if (current.bytes !== change.before) throw new Error("Recovery target changed");
  const full = confined(lease.owned,change.path);
  const parents: string[] = []; let parent = dirname(full);
  while (parent !== lease.owned.root && !existsSync(parent)) { parents.unshift(parent); parent=dirname(parent); }
  for (const directory of parents) { mkdirSync(directory,{mode:0o700}); syncRecoveryDirectory(dirname(directory)); }
  durable(full,change.after,change.mode);
}
export function recoveryTargetsMatch(lease: OfflineRecoveryLease, journal: RecoveryJournal): boolean {
  lease.assert(); return journal.changes.every(change => readRecoveryTarget(lease.owned,change.path).bytes === change.after);
}
export function compensateRecoveryFiles(lease: OfflineRecoveryLease, journal: RecoveryJournal, compensateThreads: () => void): void {
  lease.assert();
  // Preflight ALL targets before deleting any owned SQL rows or file bytes.
  for (const change of journal.changes) {
    const actual = readRecoveryTarget(lease.owned,change.path).bytes;
    if (actual !== change.before && actual !== change.after) throw new Error("Recovery rollback target changed");
  }
  compensateThreads();
  for (const change of [...journal.changes].reverse()) {
    lease.assert();
    const actual = readRecoveryTarget(lease.owned,change.path).bytes;
    if (actual === change.before) continue;
    if (actual !== change.after) throw new Error("Recovery rollback target changed");
    const full = confined(lease.owned,change.path);
    if (change.before === null) { unlinkSync(full); syncRecoveryDirectory(dirname(full)); }
    else durable(full,change.before,change.mode);
  }
  for (const path of [...journal.createdDirs].reverse()) {
    if (!/^workspaces(?:\/[\w-]{1,200})?(?:\/memory)?$/.test(path)) throw new Error("Invalid recovery directory inventory");
    const full = join(lease.owned.root,path);
    if (!existsSync(full)) continue;
    const stat=lstatSync(full);
    if (!stat.isDirectory() || stat.isSymbolicLink() || readdirSync(full).length) throw new Error("Recovery directory changed");
    rmdirSync(full); syncRecoveryDirectory(dirname(full));
  }
}
