// Host-owned additive transactions. This module intentionally imports no
// config, auth, Store, task engine or provider. Production observes only;
// an owned pre-import harness may compensate pending intent before writers.
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readSync, readdirSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { inspectExclusiveRestoreClaim } from "./data-dir-exclusivity.ts";

const MAX = 96 * 1024 * 1024;
const id = z.string().regex(/^[\w-]{1,200}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const mapping = z.object({ bot: z.record(id, id), group: z.record(id, id), thread: z.record(id, id), plan: z.record(id, id) }).strict();
const relative = z.string().refine(path => /^(bots\.json|groups\.json|task-plans\.json)$/.test(path)
  || /^workspaces\/[\w-]{1,200}\/(MEMORY\.md|memory\/[\w][\w .-]{0,199}\.md)$/.test(path));
const thread = z.object({ threadId: id, activeLeafId: z.string().nullable(), messages: z.array(z.object({
  id: z.string(), at: z.number().finite(), role: z.enum(["user", "bot"]), kind: z.string(), text: z.string().optional(),
}).passthrough()).max(100_000) }).strict();
const intentSchema = z.object({ version: z.literal(1), kind: z.literal("account-live-additive"), operationId: z.string().uuid(),
  userId: id, workspaceId: id, googleSub: z.string().min(1).max(1024), archiveHash: hash, sourceDigest: hash, mapping,
  targetCopy: z.object({ sha256: hash, sourceDigest: hash, keyMode: z.literal("provided-secret-as-passphrase") }).strict(),
  changes: z.array(z.object({ path: relative, before: z.string().nullable(), after: z.string(), mode: z.number().int().min(0).max(0o777) }).strict()).max(16_384),
  threads: z.array(thread).max(8192), inertHistory: z.string().max(MAX), createdDirs: z.array(z.string()).max(16_384),
}).strict();
export type LiveIntent = z.infer<typeof intentSchema>;
const receiptSchema = z.object({ version: z.literal(1), operationId: z.string().uuid(), intentHash: hash,
  status: z.enum(["pending", "committed", "rolled-back", "rollback-failed"]), phase: z.string().max(100) }).strict();
export type LiveReceipt = z.infer<typeof receiptSchema>;
const rootSchema = z.object({ version: z.literal(1), kind: z.literal("account-live-root"), root: z.string(),
  dev: z.number(), ino: z.number(), key: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const lockSchema = z.object({ pid: z.number().int().positive(), nonce: z.string().uuid() }).strict();
export const liveHash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const missing = z.object({ code: z.literal("ENOENT") });
function directory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe account transaction directory");
}
/** ENOENT is absence only after every existing ancestor is verified. A
 * dangling symlink or non-directory parent must never turn into no evidence. */
function journalAbsent(path: string): boolean {
  try { lstatSync(path); return false; }
  catch (error) { if (!missing.safeParse(error).success) throw error; }
  for (let parent = dirname(path);; parent = dirname(parent)) {
    try { lstatSync(parent); }
    catch (error) {
      if (!missing.safeParse(error).success) throw error;
      if (dirname(parent) === parent) throw error;
      continue;
    }
    // A real nearest ancestor may arrive through the supported OS temporary
    // prefix (/var -> /private/var). Its own name must still be a directory,
    // never a link; canonicalize only after that no-follow identity check.
    stableRealRoot(parent); return true;
  }
}
function stableRealRoot(dataDir: string): string {
  const offered = resolve(dataDir), before = lstatSync(offered);
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error("Unsafe account transaction directory");
  const root = realpathSync(offered); rootCheck(root);
  const physical = lstatSync(root), after = lstatSync(offered);
  if (!after.isDirectory() || after.isSymbolicLink() || physical.dev !== before.dev || physical.ino !== before.ino
    || after.dev !== before.dev || after.ino !== before.ino) throw new Error("Account transaction root changed");
  return root;
}
function rootCheck(root: string): void {
  for (let path = root;; path = dirname(path)) { directory(path); if (dirname(path) === path) break; }
}
interface BinaryFileRead { bytes: Buffer | null; mode: number }
export interface LiveFileRead { bytes: string | null; mode: number }
function readBinary(path: string, max = MAX): BinaryFileRead {
  try {
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > max) throw new Error("Unsafe account transaction file");
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fstatSync(fd);
      if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("Account transaction file changed");
      const bytes = Buffer.alloc(before.size + 1); let count = 0;
      while (count < bytes.length) { const n = readSync(fd, bytes, count, bytes.length - count, null); if (!n) break; count += n; }
      const after = lstatSync(path), end = fstatSync(fd);
      if (count !== before.size || end.size !== before.size || after.dev !== before.dev || after.ino !== before.ino
        || end.mtimeMs !== before.mtimeMs || end.ctimeMs !== before.ctimeMs) throw new Error("Account transaction file changed");
      return { bytes: bytes.subarray(0, count), mode: before.mode & 0o777 };
    } finally { closeSync(fd); }
  } catch (error) { if (missing.safeParse(error).success && !existsSync(path)) return { bytes: null, mode: 0o600 }; throw error; }
}
export function liveRead(path: string, max = MAX): LiveFileRead {
  const value = readBinary(path, max);
  return { bytes: value.bytes === null ? null : new TextDecoder("utf-8", { fatal: true }).decode(value.bytes), mode: value.mode };
}
function syncDirectory(path: string) {
  if (process.platform === "win32") return; // Process restart durability; no power-loss promise.
  const fd = openSync(path, constants.O_RDONLY); try { fsyncSync(fd); } finally { closeSync(fd); }
}
function write(path: string, bytes: string | Buffer, mode = 0o600): void {
  directory(dirname(path));
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), mode);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(temp, path); syncDirectory(dirname(path)); } catch (error) { try { unlinkSync(temp); } catch {} throw error; }
}
export interface LiveJournal {
  root: string;
  assert(): void;
  load(operationId: string): { intent: LiveIntent; receipt: LiveReceipt } | null;
  list(): string[];
  begin(intent: LiveIntent, targetCopy: Buffer): LiveReceipt;
  targetCopy(operationId: string): Buffer;
  mark(receipt: LiveReceipt, status: LiveReceipt["status"], phase: string): LiveReceipt;
  writeFresh(change: LiveIntent["changes"][number]): void;
  compensate(intent: LiveIntent): void;
  release(): void;
}
/** No marker is an account authority. The private host key binds persisted
 * transaction evidence to this directory incarnation, not to a new session. */
export function openLiveJournal(dataDir: string, recoverDead = false): LiveJournal {
  const root = resolve(dataDir); rootCheck(root);
  if (inspectExclusiveRestoreClaim(root).status !== "absent") throw new Error("Installation restore evidence requires reconciliation");
  const folder = join(root, "account-live-restore-journal");
  if (!existsSync(folder)) { mkdirSync(folder, { mode: 0o700 }); syncDirectory(root); }
  directory(folder);
  const stat = lstatSync(root), ownerPath = join(folder, "owner.json");
  const lock = join(folder, "writer.lock");
  if (existsSync(lock)) {
    const before = liveRead(lock, 4096).bytes;
    const previous = lockSchema.parse(JSON.parse(before!));
    let dead = false;
    try { process.kill(previous.pid, 0); } catch (error) { dead = z.object({ code: z.literal("ESRCH") }).safeParse(error).success; }
    if (!recoverDead || !dead || liveRead(lock, 4096).bytes !== before) throw new Error("Account transaction occupied");
    unlinkSync(lock); syncDirectory(folder);
  }
  const lockBytes = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
  const fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { writeFileSync(fd, lockBytes); fsyncSync(fd); } finally { closeSync(fd); }
  syncDirectory(folder); const lockStat = lstatSync(lock); let released = false;
  let ownerBytes: string | null, owner: z.infer<typeof rootSchema>;
  try {
  if (!existsSync(ownerPath)) {
    if (readdirSync(folder).some(name => name !== "writer.lock")) throw new Error("Account journal ownership unavailable");
    write(ownerPath, JSON.stringify({ version: 1, kind: "account-live-root", root, dev: stat.dev, ino: stat.ino, key: randomBytes(32).toString("hex") }));
  }
  ownerBytes = liveRead(ownerPath, 4096).bytes;
  owner = rootSchema.parse(JSON.parse(ownerBytes!));
  if (owner.root !== root || owner.dev !== stat.dev || owner.ino !== stat.ino) throw new Error("Account journal root changed");
  } catch (error) {
    if (liveRead(lock, 4096).bytes === lockBytes) { unlinkSync(lock); syncDirectory(folder); }
    throw error;
  }

  const assert = () => {
    rootCheck(root); directory(folder);
    const current = lstatSync(root), held = lstatSync(lock);
    if (released || current.dev !== owner.dev || current.ino !== owner.ino || held.dev !== lockStat.dev || held.ino !== lockStat.ino
      || liveRead(lock, 4096).bytes !== lockBytes || liveRead(ownerPath, 4096).bytes !== ownerBytes) throw new Error("Account transaction ownership changed");
  };
  const signed = (value: LiveIntent | LiveReceipt) => {
    const body = JSON.stringify(value);
    return JSON.stringify({ body, mac: createHmac("sha256", Buffer.from(owner.key, "hex")).update(body).digest("hex") });
  };
  let remaining = 512 * 1024 * 1024;
  const verified = <T>(path: string, schema: z.ZodType<T>, max = MAX): T => {
    const raw = liveRead(path, Math.min(max, remaining)).bytes;
    if (raw === null) throw new Error("Account evidence missing"); remaining -= Buffer.byteLength(raw);
    const wrapped = z.object({ body: z.string().max(max), mac: hash }).strict().parse(JSON.parse(raw));
    const expected = createHmac("sha256", Buffer.from(owner.key, "hex")).update(wrapped.body).digest();
    if (!timingSafeEqual(expected, Buffer.from(wrapped.mac, "hex"))) throw new Error("Account evidence changed");
    return schema.parse(JSON.parse(wrapped.body));
  };
  const target = (path: string) => {
    relative.parse(path);
    const full = join(root, path);
    for (let parent = dirname(full); parent !== root; parent = dirname(parent)) { if (existsSync(parent)) directory(parent); }
    return full;
  };
  const load = (operationId: string) => {
    assert(); z.string().uuid().parse(operationId); const path = join(folder, operationId);
    if (!existsSync(path)) return null; directory(path);
    if (JSON.stringify(readdirSync(path).sort()) !== JSON.stringify(["intent.json", "receipt.json", "target-before.bin"])) throw new Error("Unknown account operation evidence");
    const intent = verified(join(path, "intent.json"), intentSchema);
    const receipt = verified(join(path, "receipt.json"), receiptSchema, 8192);
    const targetBytes = readBinary(join(path, "target-before.bin"), Math.min(48 * 1024 * 1024, remaining)).bytes;
    if (targetBytes !== null) remaining -= targetBytes.length;
    if (targetBytes === null || liveHash(targetBytes) !== intent.targetCopy.sha256) throw new Error("Target recovery copy changed");
    if (intent.operationId !== operationId || receipt.operationId !== operationId || receipt.intentHash !== liveHash(JSON.stringify(intent))
      || new Set(intent.changes.map(change => change.path)).size !== intent.changes.length
      || (receipt.status === "committed" && receipt.phase !== "committed") || (receipt.status === "rolled-back" && receipt.phase !== "compensated")) throw new Error("Account operation binding changed");
    const allowedDirs = new Set(intent.changes.filter(change => change.path.startsWith("workspaces/")).flatMap(change => {
      const dirs = [dirname(change.path)]; if (dirs[0]!.includes("/memory")) dirs.push(dirname(dirs[0]!)); dirs.push("workspaces"); return dirs;
    }));
    if (intent.createdDirs.some(path => !allowedDirs.has(path))) throw new Error("Unsafe account compensation directory");
    return { intent, receipt };
  };
  const mark = (receipt: LiveReceipt, status: LiveReceipt["status"], phase: string) => {
    assert(); const next = receiptSchema.parse({ ...receipt, status, phase });
    write(join(folder, next.operationId, "receipt.json"), signed(next)); return next;
  };
  return { root, assert, load, mark,
    list() {
      assert(); const names = readdirSync(folder); if (names.length > 1026) throw new Error("Account operation limit");
      const operations = names.filter(name => !["owner.json", "writer.lock"].includes(name));
      for (const name of operations) z.string().uuid().parse(name); return operations.sort();
    },
    targetCopy(operationId) {
      const operation = load(operationId); if (!operation) throw new Error("Account operation missing");
      const bytes = readBinary(join(folder, operationId, "target-before.bin"), Math.min(48 * 1024 * 1024, remaining)).bytes;
      if (bytes !== null) remaining -= bytes.length;
      if (!bytes || liveHash(bytes) !== operation.intent.targetCopy.sha256) throw new Error("Target recovery copy changed"); return bytes;
    },
    begin(offered, targetCopy) {
      assert(); const intent = intentSchema.parse(offered); if (Buffer.byteLength(JSON.stringify(intent)) > MAX / 2) throw new Error("Account intent limit");
      if (this.list().length >= 1024 || this.load(intent.operationId)) throw new Error("Account operation occupied");
      if (!Buffer.isBuffer(targetCopy) || targetCopy.length > 48 * 1024 * 1024 || liveHash(targetCopy) !== intent.targetCopy.sha256) throw new Error("Target recovery copy unavailable");
      const receipt: LiveReceipt = { version: 1, operationId: intent.operationId, intentHash: liveHash(JSON.stringify(intent)), status: "pending", phase: "intent" };
      // A newly committed operation must remain readable by the production
      // closed-evidence observer. Refuse capacity BEFORE preparing/data writes.
      let total = Buffer.byteLength(signed(intent)) + Buffer.byteLength(signed(receipt)) + targetCopy.length;
      for (const operation of this.list()) {
        const path = join(folder, operation); directory(path);
        if (JSON.stringify(readdirSync(path).sort()) !== JSON.stringify(["intent.json", "receipt.json", "target-before.bin"])) throw new Error("Unknown account operation evidence");
        for (const name of ["intent.json", "receipt.json", "target-before.bin"]) {
          const stat = lstatSync(join(path, name));
          if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Unsafe account evidence"); total += stat.size;
        }
      }
      if (total > 128 * 1024 * 1024 - 4096) throw new Error("Account evidence limit");
      const preparing = join(folder, `.preparing-${randomUUID()}`); mkdirSync(preparing, { mode: 0o700 });
      write(join(preparing, "target-before.bin"), targetCopy);
      if (!readBinary(join(preparing, "target-before.bin"), 48 * 1024 * 1024).bytes?.equals(targetCopy)) throw new Error("Target recovery copy readback failed");
      write(join(preparing, "intent.json"), signed(intent)); write(join(preparing, "receipt.json"), signed(receipt));
      renameSync(preparing, join(folder, intent.operationId)); syncDirectory(folder); return receipt;
    },
    writeFresh(change) {
      assert(); if (change.before !== null) throw new Error("Memory target must be fresh");
      const path = target(change.path); if (existsSync(path)) throw new Error("Account memory collision");
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); directory(dirname(path)); write(path, change.after, change.mode);
    },
    compensate(intent) {
      assert();
      for (const change of intent.changes) {
        const bytes = liveRead(target(change.path)).bytes;
        if (bytes !== change.before && bytes !== change.after) throw new Error("Account postimage changed");
      }
      compensateSql(root, intent);
      for (const change of [...intent.changes].reverse()) {
        const path = target(change.path), current = liveRead(path).bytes;
        if (current === change.before) continue;
        if (current !== change.after) throw new Error("Account postimage changed before compensation write");
        if (change.before === null) { unlinkSync(path); syncDirectory(dirname(path)); } else write(path, change.before, change.mode);
      }
      for (const path of [...intent.createdDirs].sort((a, b) => b.length - a.length)) {
        const full = join(root, path); if (existsSync(full)) { directory(full); rmdirSync(full); syncDirectory(dirname(full)); }
      }
    },
    release() { if (released) return; assert(); unlinkSync(lock); syncDirectory(folder); released = true; },
  };
}
function compensateSql(root: string, intent: LiveIntent): void {
  const file = join(root, "messages.db");
  if (!existsSync(file)) { if (intent.threads.length) throw new Error("Account message database unavailable"); return; }
  for (const candidate of [file, `${file}-wal`, `${file}-shm`]) {
    if (!existsSync(candidate)) continue; const stat = lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Unsafe account message database");
  }
  const db = new DatabaseSync(file);
  try {
    db.exec("BEGIN IMMEDIATE");
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='account_recovery_operations'").get();
    const marker = table ? db.prepare("SELECT fingerprint,payload FROM account_recovery_operations WHERE operation_id=?").get(intent.operationId) : undefined;
    const payload = JSON.stringify(intent.threads);
    if (marker && (marker.payload !== payload || marker.fingerprint !== liveHash(payload))) throw new Error("Account SQL marker changed");
    for (const thread of intent.threads) {
      const rows = db.prepare("SELECT id,at,role,kind,text,json FROM messages WHERE thread_id=? ORDER BY rowid").all(thread.threadId);
      const head = db.prepare("SELECT active_leaf_id FROM thread_state WHERE thread_id=?").get(thread.threadId);
      if (!marker) { if (rows.length || head) throw new Error("Account SQL ownership missing"); continue; }
      if (!head || head.active_leaf_id !== thread.activeLeafId || rows.length !== thread.messages.length
        || rows.some((row, i) => { const expected = thread.messages[i]!; return row.id !== expected.id || row.at !== expected.at
          || row.role !== expected.role || row.kind !== expected.kind || row.text !== (expected.text ?? null) || row.json !== JSON.stringify(expected); })
        || db.prepare("SELECT 1 FROM message_intents WHERE thread_id=?").get(thread.threadId)) throw new Error("Account SQL postimage changed");
    }
    if (marker) {
      for (const thread of intent.threads) { db.prepare("DELETE FROM messages WHERE thread_id=?").run(thread.threadId); db.prepare("DELETE FROM thread_state WHERE thread_id=?").run(thread.threadId); }
      db.prepare("DELETE FROM account_recovery_operations WHERE operation_id=?").run(intent.operationId);
    }
    db.exec("COMMIT");
  } catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; } finally { db.close(); }
}
/** No new import or session adoption at boot. Compensate only pending private
 * host intent, before any cache/auth/provider writer starts; ambiguity refuses. */
export function recoverPendingLiveRestores(dataDir: string): void {
  const folder = join(resolve(dataDir), "account-live-restore-journal"); if (journalAbsent(folder)) return;
  const journal = openLiveJournal(stableRealRoot(dataDir), true);
  try {
    for (const id of journal.list()) {
      const operation = journal.load(id)!;
      if (operation.receipt.status === "committed" || operation.receipt.status === "rolled-back") continue;
      if (operation.receipt.phase === "cache-postimage-changed") throw new Error("Account cache evidence requires reconciliation");
      try { journal.compensate(operation.intent); journal.mark(operation.receipt, "rolled-back", "compensated"); }
      catch { journal.mark(operation.receipt, "rollback-failed", "compensation-unavailable"); throw new Error("Account transaction requires reconciliation before startup"); }
    }
  } finally { journal.release(); }
}

/** Production has no lifetime writer/boot capability yet. Observe closed
 * evidence only; never adopt a journal as permission to mutate at startup. */
export function assertLiveRestoreStartupReady(dataDir: string): void {
  const offeredFolder = join(resolve(dataDir), "account-live-restore-journal");
  if (journalAbsent(offeredFolder)) return;
  const root = stableRealRoot(dataDir), folder = join(root, "account-live-restore-journal");
  directory(folder);
  const names = readdirSync(folder).sort();
  if (names.length > 1025 || names.includes("writer.lock")) throw new Error("Live account recovery requires reconciliation before startup");
  const stat = lstatSync(root), owner = rootSchema.parse(JSON.parse(liveRead(join(folder, "owner.json"), 4096).bytes!));
  if (owner.root !== root || owner.dev !== stat.dev || owner.ino !== stat.ino) throw new Error("Live account journal root changed");
  let remaining = 128 * 1024 * 1024;
  const verify = <T>(path: string, limit: number, schema: z.ZodType<T>): T => {
    const raw = liveRead(path, Math.min(limit, remaining)).bytes;
    if (raw === null) throw new Error("Live account evidence missing"); remaining -= Buffer.byteLength(raw);
    const envelope = z.object({ body: z.string().max(limit), mac: hash }).strict().parse(JSON.parse(raw));
    if (!timingSafeEqual(createHmac("sha256", Buffer.from(owner.key, "hex")).update(envelope.body).digest(), Buffer.from(envelope.mac, "hex"))) throw new Error("Live account evidence changed");
    return schema.parse(JSON.parse(envelope.body));
  };
  for (const name of names) {
    if (name === "owner.json") continue;
    z.string().uuid().parse(name); const path = join(folder, name); directory(path);
    if (JSON.stringify(readdirSync(path).sort()) !== JSON.stringify(["intent.json", "receipt.json", "target-before.bin"])) throw new Error("Unknown live account evidence");
    const receipt = verify(join(path, "receipt.json"), 8192, receiptSchema);
    if (!((receipt.status === "committed" && receipt.phase === "committed") || (receipt.status === "rolled-back" && receipt.phase === "compensated"))) throw new Error("Live account recovery requires reconciliation before startup");
    const intent = verify(join(path, "intent.json"), MAX, intentSchema);
    const targetBytes = readBinary(join(path, "target-before.bin"), Math.min(48 * 1024 * 1024, remaining)).bytes;
    if (!targetBytes || liveHash(targetBytes) !== intent.targetCopy.sha256) throw new Error("Target recovery copy changed"); remaining -= targetBytes.length;
    if (name !== receipt.operationId || name !== intent.operationId || receipt.intentHash !== liveHash(JSON.stringify(intent))) throw new Error("Live account operation binding changed");
  }
  if (JSON.stringify(readdirSync(folder).sort()) !== JSON.stringify(names)) throw new Error("Live account journal changed");
}
