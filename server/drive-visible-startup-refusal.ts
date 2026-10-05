// Synchronous refusal before the remaining server dependency graph evaluates.
// This is a read-only observation, not a lock, restore authority or compensation
// runner. Old processes/external writers and pre-Node launchers remain separate.
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync, type Stats } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { DATA_DIR } from "./data-root-path.ts";

const MAX_FILE = 96 * 1024 * 1024;
const MAX_TOTAL = 128 * 1024 * 1024;
const MAX_OPERATIONS = 1024;
const id = z.string().min(1).max(200).regex(/^[\w-]+$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const relative = z.string().max(512).refine(path => /^(bots\.json|groups\.json|task-plans\.json)$/.test(path)
  || /^workspaces\/[\w-]{1,200}\/(MEMORY\.md|memory\/[\w][\w .-]{0,199}\.md)$/.test(path));
// These are the persisted journal v1 shapes, not account/import authority.
// Unknown versions or fields refuse startup until their owner reconciles them.
const immutable = z.object({
  version: z.literal(1), operationId: id, sourceDigest: hash, archiveHash: hash,
  account: z.object({ userId: id, workspaceId: id, googleSub: z.string().min(1).max(1024) }).strict(),
  mapping: z.object({ bot: z.record(id, id), group: z.record(id, id), thread: z.record(id, id), plan: z.record(id, id) }).strict(),
  changes: z.array(z.object({ path: relative, before: z.string().max(MAX_FILE).nullable(),
    after: z.string().max(MAX_FILE), mode: z.number().int().min(0).max(0o777) }).strict()).max(16_384),
  threadPayload: z.string().max(MAX_FILE), inertHistory: z.string().max(MAX_FILE),
  createdDirs: z.array(z.string().max(512)).max(16_384),
}).strict();
const receipt = z.object({ version: z.literal(1), operationId: id, immutableHash: hash,
  status: z.enum(["pending", "committed", "rolled-back", "rollback-failed"]), phase: z.string().max(100) }).strict();
const missing = z.object({ code: z.literal("ENOENT") });
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const refusal = () => new Error("Account recovery evidence requires offline reconciliation; server startup refused before initialization. No restore or cleanup was performed.");

function entries(path: string, limit: number): string[] {
  const directory = opendirSync(path), names: string[] = [];
  try {
    for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
      if (names.length >= limit) throw refusal();
      names.push(entry.name);
    }
  } finally { directory.closeSync(); }
  return names.sort();
}
function directory(path: string) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw refusal();
  return stat;
}
function sameFile(path: string, previous: Stats): void {
  const now = lstatSync(path);
  if (now.dev !== previous.dev || now.ino !== previous.ino || now.size !== previous.size
    || now.mtimeMs !== previous.mtimeMs || now.ctimeMs !== previous.ctimeMs || now.nlink !== previous.nlink) throw refusal();
}
/** Refuse unresolved or ambiguous journals without creating/changing anything.
 * Closed receipt hashes establish only complete persisted evidence. They do not
 * authorize account writes or prove exclusion of a concurrent external writer. */
export function assertAccountRecoveryStartupReady(dataDir: string): void {
  const root = resolve(dataDir), journalPath = join(root, "account-recovery-journal");
  try { lstatSync(journalPath); }
  catch (error) { if (missing.safeParse(error).success) return; throw refusal(); }
  try {
    // Refuse linked ancestors before reading any operation content.
    for (let parent = journalPath;; parent = dirname(parent)) {
      directory(parent);
      if (dirname(parent) === parent) break;
    }
    const journalStat = directory(journalPath), names = entries(journalPath, MAX_OPERATIONS);
    let remaining = MAX_TOTAL;
    const read = (path: string, limit: number) => {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > limit || stat.size > remaining) throw refusal();
      const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const actual = fstatSync(fd);
        if (actual.dev !== stat.dev || actual.ino !== stat.ino || actual.size !== stat.size) throw refusal();
        // Read at most the pinned size plus one byte. readFileSync(fd) could
        // otherwise follow a concurrently growing file beyond the budget.
        const buffer = Buffer.alloc(stat.size + 1);
        let length = 0;
        while (length < buffer.length) {
          const count = readSync(fd, buffer, length, buffer.length - length, null);
          if (count === 0) break;
          length += count;
        }
        if (length !== stat.size) throw refusal();
        const bytes = buffer.subarray(0, length);
        remaining -= bytes.length;
        sameFile(path, stat);
        return { bytes, stat };
      } finally { closeSync(fd); }
    };
    for (const operationId of names) {
      // A lock or interrupted private staging is unresolved evidence. Never
      // infer its owner died, remove it, or adopt a synthetic marker.
      id.parse(operationId);
      if (operationId === "writer.lock") throw refusal();
      const operationPath = join(journalPath, operationId), operationStat = directory(operationPath);
      if (JSON.stringify(entries(operationPath, 3)) !== JSON.stringify(["archive.bin", "immutable.json", "receipt.json"])) throw refusal();
      const statusFile = read(join(operationPath, "receipt.json"), 4096);
      const status = receipt.parse(JSON.parse(statusFile.bytes.toString("utf8")));
      if (status.operationId !== operationId || !((status.status === "committed" && status.phase === "committed")
        || (status.status === "rolled-back" && status.phase === "compensated"))) throw refusal();
      const sourceFile = read(join(operationPath, "immutable.json"), MAX_FILE);
      const source = immutable.parse(JSON.parse(sourceFile.bytes.toString("utf8")));
      const archiveFile = read(join(operationPath, "archive.bin"), MAX_FILE);
      if (source.operationId !== operationId || digest(sourceFile.bytes) !== status.immutableHash
        || digest(archiveFile.bytes) !== source.archiveHash || new Set(source.changes.map(change => change.path)).size !== source.changes.length) throw refusal();
      for (const [name, file] of [["receipt.json", statusFile], ["immutable.json", sourceFile], ["archive.bin", archiveFile]] as const) {
        sameFile(join(operationPath, name), file.stat);
      }
      sameFile(operationPath, operationStat);
    }
    if (JSON.stringify(entries(journalPath, MAX_OPERATIONS)) !== JSON.stringify(names)) throw refusal();
    sameFile(journalPath, journalStat);
  } catch { throw refusal(); }
}

// No await: throwing here stops dependency evaluation before auth/database,
// provider construction, sync flush or any server-body startup statements.
assertAccountRecoveryStartupReady(DATA_DIR);
