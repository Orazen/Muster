// SQLite persistence for thread transcripts.
//
// messages-<threadId>.json rewrote the WHOLE thread file on every append —
// a long computer-use thread reaches megabytes, so each new message cost
// more disk than the last. This store writes deltas instead: one INSERT
// per message, one UPDATE per patch, and reads a thread once into the
// Store's in-memory cache. node:sqlite (built into Node ≥23.4) keeps it
// dependency-free — nothing new to bundle for the packaged app.
//
// Legacy JSON thread files import lazily: the first read of a thread with
// no rows pulls the old file in, after which the DB is the source of
// truth (the JSON file is left behind as a one-time backup).
import { chmodSync, closeSync, existsSync, openSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";

import { DATA_DIR } from "./config.ts";
import { SeedAnswerError } from "./seed-card.ts";
import type { DelegationSnapshot } from "./delegations.ts";
import type { StopCleanupDurableState, StopCleanupJournal, StopCleanupReceiptRecord } from "./stop-cleanup.ts";
import { stopCleanupSnapshotsSchema } from "./stop-cleanup.ts";
import type { Message } from "./store.ts";

const DB_FILE = () => join(DATA_DIR, "messages.db");

let handle: DatabaseSync | null = null;
let handlePath: string | null = null;

function open(): DatabaseSync {
  const file = DB_FILE();
  // Transcripts can contain private conversations and tool output. Create
  // the database with owner-only permissions and also repair an existing
  // file that may have inherited a permissive umask.
  closeSync(openSync(file, "a", 0o600));
  try {
    chmodSync(file, 0o600);
  } catch {}
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      thread_id TEXT NOT NULL,
      id TEXT NOT NULL,
      at INTEGER NOT NULL,
      role TEXT NOT NULL,
      kind TEXT NOT NULL,
      text TEXT,
      json TEXT NOT NULL,
      PRIMARY KEY (thread_id, id)
    );
    CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id);
    CREATE TABLE IF NOT EXISTS thread_state (
      thread_id TEXT PRIMARY KEY,
      active_leaf_id TEXT
    );
    CREATE TABLE IF NOT EXISTS stop_cleanup_receipts (
      bot_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      generation_id TEXT NOT NULL,
      token TEXT NOT NULL,
      snapshots TEXT NOT NULL,
      failed_at INTEGER NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL,
      settled_at INTEGER
    );
  `);
  return db;
}

/** The live handle — reopened when the file was removed out from under us
 * (tests wipe DATA_DIR between cases; a fresh Store must get a fresh DB,
 * not a handle onto an unlinked inode). */
function db(): DatabaseSync {
  if (handle && handlePath === DB_FILE() && existsSync(DB_FILE())) return handle;
  try {
    handle?.close();
  } catch {}
  handle = open();
  handlePath = DB_FILE();
  return handle;
}

// SAFETY: each messages row stores exactly one serialized Message in its json cell
const rowToMessage = (row: { json: string }): Message => JSON.parse(row.json) as Message;

export interface ThreadRows {
  messages: Message[];
  activeLeafId: string | null;
}

/** Read one thread, importing its legacy JSON file on first touch. */
export function readThread(threadId: string, legacyFile: string): ThreadRows {
  // SAFETY: the select lists only the json TEXT column of the messages table
  const rows = db()
    .prepare("SELECT json FROM messages WHERE thread_id = ? ORDER BY rowid")
    .all(threadId) as Array<{ json: string }>;
  if (rows.length) {
    // SAFETY: thread_state rows carry a single active_leaf_id column
    const state = db()
      .prepare("SELECT active_leaf_id FROM thread_state WHERE thread_id = ?")
      .get(threadId) as { active_leaf_id: string | null } | undefined;
    return { messages: rows.map(rowToMessage), activeLeafId: state?.active_leaf_id ?? null };
  }
  return importLegacy(threadId, legacyFile);
}

/** Legacy JSON thread file: a flat Message array or a {messages, activeLeafId} wrapper. */
interface LegacyThreadFile {
  messages?: Message[];
  activeLeafId?: string | null;
}

function importLegacy(threadId: string, legacyFile: string): ThreadRows {
  let messages: Message[] = [];
  let activeLeafId: string | null = null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(legacyFile, "utf8"));
  } catch {
    return { messages, activeLeafId }; // fresh thread
  }
  // SAFETY: legacy thread files are flat Message arrays or wrapped objects
  const decoded = raw as LegacyThreadFile | Message[] | null | undefined;
  if (Array.isArray(decoded)) messages = decoded; // pre-branching flat file
  else if (decoded instanceof Object) {
    messages = decoded.messages ?? [];
    activeLeafId = decoded.activeLeafId ?? null;
  }
  const insert = db().prepare(
    "INSERT OR REPLACE INTO messages (thread_id, id, at, role, kind, text, json) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  db().exec("BEGIN");
  try {
    for (const message of messages) {
      insert.run(threadId, message.id, message.at, message.role, message.kind, message.text ?? null, JSON.stringify(message));
    }
    setActiveLeaf(threadId, activeLeafId);
    db().exec("COMMIT");
  } catch (error) {
    db().exec("ROLLBACK");
    throw error;
  }
  // left beside the DB as a one-time backup, renamed so the import never
  // runs twice against a thread whose rows were later deleted
  try {
    renameSync(legacyFile, `${legacyFile}.imported`);
    try {
      chmodSync(`${legacyFile}.imported`, 0o600);
    } catch {}
  } catch {}
  return { messages, activeLeafId };
}

export function insertMessage(threadId: string, message: Message): void {
  db()
    .prepare("INSERT OR REPLACE INTO messages (thread_id, id, at, role, kind, text, json) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(threadId, message.id, message.at, message.role, message.kind, message.text ?? null, JSON.stringify(message));
}

/** Persist a new message and the branch head as one crash-safe mutation. */
export function appendMessage(threadId: string, message: Message): void {
  const database = db();
  database.exec("BEGIN IMMEDIATE");
  try {
    insertMessage(threadId, message);
    setActiveLeaf(threadId, message.id);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

/** Recover missing ancestors and their selected leaf as one mutation.
 * Callers supply the required segment in parent-first order. The durable
 * attachment is checked in this thread; unrelated durable history is not
 * walked or rewritten. Existing append/seed transactions remain separate.
 */
export function persistMessagePath(threadId: string, ancestors: Message[], leafId: string, message?: Message): void {
  const database = db();
  database.exec("BEGIN IMMEDIATE");
  try {
    const select = database.prepare("SELECT rowid, json FROM messages WHERE thread_id = ? AND id = ?");
    const previous = database.prepare("SELECT id FROM messages WHERE thread_id = ? AND rowid < ? ORDER BY rowid DESC LIMIT 1");
    const last = database.prepare("SELECT id FROM messages WHERE thread_id = ? ORDER BY rowid DESC LIMIT 1");
    const insert = database.prepare("INSERT INTO messages (thread_id, id, at, role, kind, text, json) VALUES (?, ?, ?, ?, ?, ?, ?)");
    const candidates = message ? [...ancestors, message] : ancestors;
    const supplied = new Set(candidates.map((candidate) => candidate.id));
    const processed = new Set<string>();
    const storedRow = (id: string) => {
      // SAFETY: this query selects SQLite's integer rowid and the serialized Message JSON cell.
      return select.get(threadId, id) as { rowid: number; json: string } | undefined;
    };
    const inferredParent = (rowid?: number): string | null => {
      // SAFETY: both queries select the id TEXT column, restricted to this thread.
      const row = (rowid === undefined ? last.get(threadId) : previous.get(threadId, rowid)) as { id: string } | undefined;
      return row?.id ?? null;
    };
    const checkParent = (id: string, parentId: string | null | undefined) => {
      if (parentId === undefined) throw new Error("Message recovery requires a resolved parent");
      if (parentId === null) return;
      if (parentId === id) throw new Error("Message recovery cannot reference itself");
      if (supplied.has(parentId) && !processed.has(parentId)) throw new Error("Message recovery requires parent-first ancestors");
      if (!storedRow(parentId)) throw new Error("Message recovery parent is missing from this thread");
    };
    for (const candidate of candidates) {
      const json = JSON.stringify(candidate);
      const incoming = rowToMessage({ json });
      const row = storedRow(candidate.id);
      if (row) {
        const current = rowToMessage(row);
        if (current.parentId === undefined) {
          // Store infers old flat transcripts from row order. Accept that
          // equivalent explicit parent without rewriting/reordering the row.
          current.parentId = inferredParent(row.rowid);
          if (incoming.parentId === undefined) incoming.parentId = current.parentId;
        }
        if (!isDeepStrictEqual(current, incoming)) throw new Error("Message recovery conflicts with an existing durable row");
      } else if (incoming.parentId === undefined) {
        // A newly supplied legacy-shaped row follows the prior stored row,
        // exactly as Store will infer it after reopening the thread.
        incoming.parentId = inferredParent();
      }
      checkParent(candidate.id, incoming.parentId);
      if (!row) insert.run(threadId, candidate.id, candidate.at, candidate.role, candidate.kind, candidate.text ?? null, json);
      processed.add(candidate.id);
    }
    const leafRow = storedRow(leafId);
    if (!leafRow) throw new Error("Message recovery leaf is missing from this thread");
    const leaf = rowToMessage(leafRow);
    checkParent(leafId, leaf.parentId === undefined ? inferredParent(leafRow.rowid) : leaf.parentId);
    setActiveLeaf(threadId, leafId);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function updateMessage(threadId: string, message: Message): void {
  db()
    .prepare("UPDATE messages SET at = ?, role = ?, kind = ?, text = ?, json = ? WHERE thread_id = ? AND id = ?")
    .run(message.at, message.role, message.kind, message.text ?? null, JSON.stringify(message), threadId, message.id);
}

/** Seed recording/dispatch receipts have stricter durability than ordinary turn folding. */
export function commitSeedAnswer(
  threadId: string,
  expected: Message,
  next: Message,
  userMessage?: Message,
  expectedActiveLeaf?: string | null,
): void {
  const database = db();
  database.exec("BEGIN IMMEDIATE");
  try {
    // SAFETY: the query selects exactly the serialized Message JSON column.
    const row = database.prepare("SELECT json FROM messages WHERE thread_id = ? AND id = ?")
      .get(threadId, expected.id) as { json: string } | undefined;
    if (!row) throw new SeedAnswerError(409, "the seed card changed; refresh this conversation");
    const current = rowToMessage(row);
    // Store supplies parent links for pre-branching legacy rows on read.
    if (current.parentId === undefined) current.parentId = expected.parentId;
    if (!isDeepStrictEqual(current, JSON.parse(JSON.stringify(expected)))) throw new SeedAnswerError(409, "the seed card changed; refresh this conversation");
    if (expectedActiveLeaf !== undefined) {
      // SAFETY: these queries select their single named TEXT columns.
      const state = database.prepare("SELECT active_leaf_id FROM thread_state WHERE thread_id = ?")
        .get(threadId) as { active_leaf_id: string | null } | undefined;
      // SAFETY: the fallback query selects the last Message's id column.
      const last = database.prepare("SELECT id FROM messages WHERE thread_id = ? ORDER BY rowid DESC LIMIT 1")
        .get(threadId) as { id: string } | undefined;
      if ((state?.active_leaf_id ?? last?.id ?? null) !== expectedActiveLeaf) {
        throw new SeedAnswerError(409, "the conversation branch changed; refresh before answering");
      }
    }
    const updated = database.prepare("UPDATE messages SET json = ? WHERE thread_id = ? AND id = ? AND json = ?")
      .run(JSON.stringify(next), threadId, expected.id, row.json);
    if (updated.changes !== 1) throw new SeedAnswerError(409, "the seed card changed; refresh this conversation");
    if (userMessage) {
      database.prepare("INSERT INTO messages (thread_id, id, at, role, kind, text, json) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(threadId, userMessage.id, userMessage.at, userMessage.role, userMessage.kind, userMessage.text ?? null, JSON.stringify(userMessage));
      setActiveLeaf(threadId, userMessage.id);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

/** Only interrupted seed dispatch receipts need transcript loading at startup. */
export function startingSeedCards(threadId: string): Message[] {
  // SAFETY: the query selects serialized Message JSON from known transcript rows.
  const rows = db().prepare("SELECT json FROM messages WHERE thread_id = ? AND json_extract(json, '$.card.purpose') = 'onboarding-v1' AND json_extract(json, '$.card.seedAnswer.status') = 'starting'")
    .all(threadId) as Array<{ json: string }>;
  return rows.map(rowToMessage);
}

// ── failed-Stop receipts ──────────────────────────────────────────────
// A Stop that could not write the handoff queue has to outlive the process
// that failed it: otherwise a reload lets the next boot's queue drain run the
// very work the user stopped. These rows are the durable half of that receipt
// and share this database (and its transaction/file discipline) with the
// seed-answer receipt rather than adding a second store. One row per bot,
// replaced by that bot's next failed Stop, never swept by another bot's work.

/** Decode captured snapshots defensively: a corrupt row must not break boot. */
function decodeStopCleanupSnapshots(raw: string): DelegationSnapshot[] | undefined {
  try {
    const parsed = stopCleanupSnapshotsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Record the failed Stop, replacing any earlier row for this bot. */
export function recordStopCleanupReceipt(record: StopCleanupReceiptRecord): void {
  db()
    .prepare(
      "INSERT OR REPLACE INTO stop_cleanup_receipts (bot_id, owner_id, generation_id, token, snapshots, failed_at, reason, status, settled_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL)",
    )
    .run(record.botId, record.ownerId, record.generationId, record.token, JSON.stringify(record.snapshots), record.failedAt, record.reason);
}

/** Receipts a previous process could not finish; a settled row is never reapplied. */
export function pendingStopCleanupReceipts(): StopCleanupReceiptRecord[] {
  // SAFETY: the select lists this table's own columns, and snapshots is decoded below.
  const rows = db()
    .prepare("SELECT bot_id, owner_id, generation_id, token, snapshots, failed_at, reason FROM stop_cleanup_receipts WHERE status = 'pending' ORDER BY failed_at")
    .all() as Array<{ bot_id: string; owner_id: string; generation_id: string; token: string; snapshots: string; failed_at: number; reason: string }>;
  const records: StopCleanupReceiptRecord[] = [];
  for (const row of rows) {
    const snapshots = decodeStopCleanupSnapshots(row.snapshots);
    if (!snapshots) {
      console.error("stop-cleanup: a durable receipt held no readable queue capture and was skipped");
      continue;
    }
    records.push({
      botId: row.bot_id, ownerId: row.owner_id, generationId: row.generation_id,
      token: row.token, snapshots, failedAt: row.failed_at, reason: row.reason,
    });
  }
  return records;
}

/** Consume one receipt exactly once. The boot that finds the row pending wins;
 * every later boot or process sees zero changed rows and applies nothing. */
export function settleStopCleanupReceipt(botId: string, token: string, settledAt: number): boolean {
  const updated = db()
    .prepare("UPDATE stop_cleanup_receipts SET status = 'settled', settled_at = ? WHERE bot_id = ? AND token = ? AND status = 'pending'")
    .run(settledAt, botId, token);
  return updated.changes === 1;
}

/** What a reload can still be told about a receipt it holds but this process
 * never issued — the same failure, after the restart that ended its memory. */
export function stopCleanupReceiptState(botId: string, token: string): StopCleanupDurableState | undefined {
  // SAFETY: the select lists this table's own columns.
  const row = db()
    .prepare("SELECT status, failed_at, reason FROM stop_cleanup_receipts WHERE bot_id = ? AND token = ?")
    .get(botId, token) as { status: string; failed_at: number; reason: string } | undefined;
  if (!row) return undefined;
  return { status: row.status === "settled" ? "settled" : "pending", failedAt: row.failed_at, reason: row.reason };
}

/** Retire a bot's receipt once nothing is left to resume (a completed retry,
 * a new turn, an expiry or a deletion). */
export function clearStopCleanupReceipt(botId: string): void {
  db().prepare("DELETE FROM stop_cleanup_receipts WHERE bot_id = ?").run(botId);
}

/** The registry's durable half, wired by the server at boot. */
export function stopCleanupJournal(): StopCleanupJournal {
  return {
    record: recordStopCleanupReceipt,
    clear: clearStopCleanupReceipt,
    pending: pendingStopCleanupReceipts,
    settle: settleStopCleanupReceipt,
    state: stopCleanupReceiptState,
  };
}

export function setActiveLeaf(threadId: string, leafId: string | null): void {
  db()
    .prepare(
      "INSERT INTO thread_state (thread_id, active_leaf_id) VALUES (?, ?) " +
        "ON CONFLICT(thread_id) DO UPDATE SET active_leaf_id = excluded.active_leaf_id",
    )
    .run(threadId, leafId);
}

export function deleteThread(threadId: string): void {
  // Both deletes are one mutation: a thread whose rows died but whose
  // branch head survived would resurrect an empty transcript on the next
  // read instead of disappearing cleanly.
  const database = db();
  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare("DELETE FROM messages WHERE thread_id = ?").run(threadId);
    database.prepare("DELETE FROM thread_state WHERE thread_id = ?").run(threadId);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export interface SearchHit {
  threadId: string;
  messageId: string;
  at: number;
  role: string;
  kind: string;
  /** the matched text, trimmed to a window around the first hit */
  snippet: string;
  /** where the match sits inside `snippet`, for highlighting */
  matchStart: number;
  matchLength: number;
  /** room messages: which member said it */
  from?: string;
}

/** Case-insensitive substring search over text messages, newest first.
 * A LIKE scan, deliberately: local transcripts are megabytes at most, a
 * scan is milliseconds, and it needs no FTS extension to exist. */
export function searchMessages(query: string, limit = 40): SearchHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  // escape LIKE wildcards so a literal % or _ in the query stays literal
  const pattern = `%${needle.replace(/([\\%_])/g, "\\$1")}%`;
  // text messages by their text; activity chips by the tool name — "which
  // bot ran that migration" is a tool-name question. The chip's name lives
  // in the row's json; a JSON1 extract keeps this one query.
  // SAFETY: the SELECT aliases every column this mapping reads
  const rows = db()
    .prepare(
      "SELECT thread_id, id, at, role, kind, text, json_extract(json, '$.tool.name') AS tool_name, json_extract(json, '$.from.name') AS from_name FROM messages " +
        "WHERE (kind = 'text' AND text IS NOT NULL AND lower(text) LIKE ? ESCAPE '\\') " +
        "   OR (kind = 'activity' AND tool_name IS NOT NULL AND lower(tool_name) LIKE ? ESCAPE '\\') " +
        "ORDER BY at DESC LIMIT ?",
    )
    .all(pattern, pattern, limit) as Array<{
    thread_id: string;
    id: string;
    at: number;
    role: string;
    kind: string;
    text: string | null;
    tool_name: string | null;
    from_name: string | null;
  }>;
  return rows.map((row) => {
    const haystack = row.kind === "activity" ? (row.tool_name ?? "") : (row.text ?? "");
    const hitAt = Math.max(0, haystack.toLowerCase().indexOf(needle));
    const start = Math.max(0, hitAt - 60);
    const end = Math.min(haystack.length, hitAt + needle.length + 90);
    const head = start > 0 ? "…" : "";
    const body = haystack.slice(start, end).replace(/\s+/g, " ").trim();
    const snippet = head + body + (end < haystack.length ? "…" : "");
    // whitespace folding can shift the offset; find the match again inside
    const folded = needle.replace(/\s+/g, " ");
    const matchStart = snippet.toLowerCase().indexOf(folded);
    const hit: SearchHit = {
      threadId: row.thread_id,
      messageId: row.id,
      at: row.at,
      role: row.role,
      kind: row.kind,
      snippet,
      matchStart: matchStart < 0 ? head.length : matchStart,
      // A defensive fallback must not mark arbitrary snippet text as the hit.
      matchLength: matchStart < 0 ? 0 : folded.length,
    };
    if (row.from_name) hit.from = row.from_name;
    return hit;
  });
}

/** Test/shutdown hook — closes the handle so a wiped DATA_DIR starts clean. */
export function closeMessageDb(): void {
  try {
    handle?.close();
  } catch {}
  handle = null;
  handlePath = null;
}
