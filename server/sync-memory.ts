// S2c (DESIGN §10) — the first REAL producer and the pass's memory-side
// deps. The choke point is workspace.ts's writeMemoryFile (the only
// production writer of MEMORY.md): it fires the leaf hook, and this
// module's producer turns that into one journal row + one local-manifest
// entry:
//
//   rev source = the LOCAL manifest entry (saved BEFORE enqueue), so a
//   write after a remote apply takes the applied rev + 1, and two
//   installs that both write past a shared rev surface as the
//   equal-rev/different-checksum conflict §10 says must not auto-resolve.
//   Byte-identical rewrites are skipped (no rev burn, no notify).
//
// readObject recomputes the checksum from CURRENT file bytes — S2b's
// pass compares it against the journal row and retries/dead-letters on
// disagreement, so this function never has to guess what the row means.
//
// applyObject writes through applyMemoryFile, which deliberately does
// NOT fire the producer hook: applying install B's rev from install A
// must not enqueue a push-back, or the two would ping-pong revs forever.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { enqueueSyncChange, type SyncJournalRow } from "./sync-journal.ts";
import { withManifestEntry, type SyncPassDeps } from "./sync-pass.ts";
import { syncObjectFileName, type SyncManifestEntry, type SyncObject } from "./sync-objects.ts";
import type { LocalManifestStore } from "./sync-wiring.ts";
import { applyMemoryFile, workspaceDir } from "./workspace.ts";

export const MEMORY_OBJECT_PREFIX = "memory:";
const MEMORY_FILE = "MEMORY.md";
/** The route charset for bot ids — also the path-escape guard: the bot id
 * joins the workspaces root to form a file path, so anything outside
 * [\w-] never reaches the filesystem. */
const SAFE_BOT_ID = /^[\w-]+$/u;

export function memoryObjectId(botId: string): string {
  return `${MEMORY_OBJECT_PREFIX}${botId}`;
}

function botIdOf(objectId: string): string {
  if (!objectId.startsWith(MEMORY_OBJECT_PREFIX)) throw new Error(`not a memory object: ${objectId}`);
  const botId = objectId.slice(MEMORY_OBJECT_PREFIX.length);
  // SAFETY: botId is about to be joined under WORKSPACES_DIR (read or
  // write) — reject traversal or absolute segments before any path math.
  if (!SAFE_BOT_ID.test(botId)) throw new Error(`refusing a memory object with an unsafe bot id: ${objectId}`);
  return botId;
}

const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

// Loop200 (P5a): this install's device_id now lives in sync-events.ts, the
// module that owns device identity and the typed receipt stream. Re-exported
// here so every existing importer — and the S2c tests — keep working.
export { syncInstallId } from "./sync-events.ts";
import { syncInstallId } from "./sync-events.ts";

export interface MemoryProducerOptions {
  db: DatabaseSync;
  local: LocalManifestStore;
  notify(): void;
  now?: () => number;
}

/** The listener body for setMemoryWriteListener: journal row + local
 * entry + engine notify, one memory write at a time. */
export function createMemoryProducer(options: MemoryProducerOptions): (botId: string, text: string) => void {
  const now = options.now ?? Date.now;
  return (botId: string, text: string): void => {
    // A write that already succeeded must not fail its route because of
    // sync bookkeeping; ids the envelope could not carry are simply not
    // tracked (workspace has already path-checked the actual write).
    if (!SAFE_BOT_ID.test(botId)) return;
    const objectId = memoryObjectId(botId);
    const checksum = sha256Hex(text);
    const at = now();
    const doc = options.local.load();
    const previous = doc === null ? undefined : doc.entries.find((entry) => entry.objectId === objectId);
    if (previous?.checksum === checksum) return; // byte-identical rewrite: nothing new to push
    const rev = (previous?.rev ?? 0) + 1;
    const entry: SyncManifestEntry = {
      objectId,
      objectType: "memory",
      rev,
      checksum,
      fileName: syncObjectFileName(objectId, rev),
      updatedAt: at,
      tombstone: false,
    };
    options.local.save(
      doc === null ? { schema: 1, updatedAt: at, entries: [entry] } : withManifestEntry(doc, entry, at),
    );
    enqueueSyncChange(options.db, { objectId, objectType: "memory", rev, checksum }, at);
    options.notify();
  };
}

/** Serialize the CURRENT file for the row being pushed. Agreement with
 * the row is the pass's check (S2b) — a file that moved on since the
 * enqueue reads as a checksum mismatch there and retries, never lies. */
export function readMemoryObject(): SyncPassDeps["readObject"] {
  return (row: SyncJournalRow): SyncObject => {
    const botId = botIdOf(row.objectId);
    const file = join(workspaceDir(botId), MEMORY_FILE);
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      throw new Error(`the memory file for ${row.objectId} is gone — cannot publish a row for it`);
    }
    const stats = statSync(file);
    return {
      objectId: row.objectId,
      objectType: "memory",
      ownerId: botId,
      rev: row.rev,
      createdAt: Math.trunc(stats.birthtimeMs),
      updatedAt: Math.trunc(stats.mtimeMs),
      deviceId: syncInstallId(),
      checksum: sha256Hex(raw),
      tombstone: false,
      schemaVersion: 1,
      payload: raw,
    };
  };
}

/** Install another install's verified memory object. No producer hook, no
 * history snapshot — the prompt baseline still tracks the new bytes so
 * the next turn loads what the manifest says is current. */
export function applyMemoryObject(): SyncPassDeps["applyObject"] {
  return (object: SyncObject): void => {
    const botId = botIdOf(object.objectId); // throws → the pass reports "applier rejected"
    applyMemoryFile(botId, object.payload);
  };
}
