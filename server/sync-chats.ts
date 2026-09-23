// P4 (docs/plans/local-first-architecture-plan-2026-09-23.md, §8 "P4 —
// Conversation sync", R4) — conversations as per-thread sync objects, the
// second REAL producer beside memory (server/sync-memory.ts) and the same
// three-part shape that producer established:
//
//   1. the producer (createChatProducer) turns ONE durable transcript change
//      into one journal row + one local-manifest entry, taking rev from the
//      local manifest and checksum from the CURRENT thread bytes, skipping
//      byte-identical rewrites and treating a delete as a tombstone;
//   2. readChatObject re-serializes the thread LIVE at push time, so the
//      pass's own "checksum must equal the journal row" check is the
//      agreement test — a thread that moved on since the enqueue retries
//      there and never lies;
//   3. applyChatObject installs another install's verified object WITHOUT
//      firing the producer (no ping-pong), replacing the thread in ONE
//      transaction so a crash can never leave half a transcript.
//
// Why per-thread and not one whole-DB snapshot: the plan's P4 gate demands
// "changed-thread sync must not move the whole DB" — per-thread objects make
// that structural, and they match the eight selective restore categories: a
// conversation restores identically from a v2 bundle or from the object
// stream because the payload IS the transcript (message ids, roles, kinds,
// text, cards/attachments as stored) plus the branch head.
//
// Attachments ride inside the message objects exactly as they ride inside
// the v2 bundle (the bytes are already in the json cell), so no separate
// attachment object type is invented here; the v2 20 MB per-file ceilings
// are inherited through LIMITS.maxFileBytes on the envelope, unchanged.
//
// Tombstones: sync-objects.ts defines a tombstone as payload "" with the
// canonical hash of the empty string. A deleted thread therefore reads back
// as that tombstone even though the rows are gone, and the apply side
// deletes the thread silently (never re-firing the producer).
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import { deleteThreadSilently, readThreadRows, replaceThreadFromSync } from "./message-db.ts";
import { enqueueSyncChange, type SyncJournalRow } from "./sync-journal.ts";
import { syncInstallId } from "./sync-memory.ts";
import { withManifestEntry, type SyncPassDeps } from "./sync-pass.ts";
import { syncObjectFileName, type SyncManifestEntry, type SyncObject } from "./sync-objects.ts";
import type { LocalManifestStore } from "./sync-wiring.ts";
import type { Message } from "./store.ts";

/** The object namespace: one object per thread, `chat:<threadId>`. */
export const CHAT_OBJECT_PREFIX = "chat:";
export const CHAT_OBJECT_TYPE = "chat";

/** §10's printable rule (sync-objects.ts uses the same guard): the thread id
 * only ever reaches SQLite parameters and the object id — never a path — so
 * the guard exists for envelope integrity, not traversal. */
const printable = (value: string): boolean =>
  [...value].every((char) => {
    const code = char.charCodeAt(0);
    return code >= 32 && code !== 127;
  });

const threadIdSchema = z.string().min(1).max(256).refine(printable);

/** The message envelope inside a chat payload. The identity fields the
 * transcript tables key on are validated; every other stored field (cards,
 * screen pngs, compaction, privacy counts, tool chips) rides through as the
 * loose tail exactly as it was written, so a round trip is byte-identical. */
const chatMessageSchema = z.looseObject({
  id: z.string().min(1).max(256),
  at: z.number().int().nonnegative(),
  role: z.string().min(1).max(64),
  kind: z.string().min(1).max(64),
});

const chatPayloadSchema = z
  .object({
    schema: z.literal(1),
    threadId: threadIdSchema,
    activeLeafId: z.string().min(1).max(256).nullable(),
    messages: z.array(chatMessageSchema).max(20_000),
  })
  .strict();

/** The serialized thread — canonical by construction: fixed key order, row
 * order preserved, every message re-serialized from its stored json. */
const chatPayload = (threadId: string, activeLeafId: string | null, messages: Message[]): string =>
  JSON.stringify({ schema: 1, threadId, activeLeafId, messages });

/** The journal row's enqueue time is the object's fallback clock (a thread
 * with no messages carries no other evidence of when it existed). */
const at = (row: SyncJournalRow): number => row.enqueuedAt;

const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** The canonical tombstone bytes (sync-objects.ts's tombstone rule). */
const TOMBSTONE_PAYLOAD = "";
const TOMBSTONE_CHECKSUM = sha256Hex(TOMBSTONE_PAYLOAD);

export function chatObjectId(threadId: string): string {
  return `${CHAT_OBJECT_PREFIX}${threadId}`;
}

export function threadIdOf(objectId: string): string {
  if (!objectId.startsWith(CHAT_OBJECT_PREFIX)) throw new Error(`not a chat object: ${objectId}`);
  const parsed = threadIdSchema.safeParse(objectId.slice(CHAT_OBJECT_PREFIX.length));
  if (!parsed.success) throw new Error(`refusing a chat object with an unusable thread id: ${objectId}`);
  return parsed.data;
}

export interface ChatProducerOptions {
  db: DatabaseSync;
  local: LocalManifestStore;
  notify(): void;
  now?: () => number;
}

/** The listener body for setChatChangeListener: one journal row + one local
 * manifest entry per durable transcript change. A change the envelope could
 * not describe (an id the schema refuses) is simply not tracked — the
 * transcript write itself already succeeded and must not fail because of
 * sync bookkeeping. */
export function createChatProducer(options: ChatProducerOptions): (threadId: string, kind: "write" | "delete") => void {
  const now = options.now ?? Date.now;
  return (threadId, kind): void => {
    const parsed = threadIdSchema.safeParse(threadId);
    if (!parsed.success) return;
    const objectId = chatObjectId(parsed.data);
    const at = now();
    const deleting = kind === "delete";
    // The checksum is the CURRENT truth: the live payload for a write, the
    // canonical tombstone for a delete. A rewrite that serialized to the
    // same bytes burns no rev (the same rule memory follows).
    let checksum: string;
    if (deleting) {
      checksum = TOMBSTONE_CHECKSUM;
    } else {
      const rows = readThreadRows(parsed.data);
      checksum = sha256Hex(chatPayload(parsed.data, rows.activeLeafId, rows.messages));
    }
    const doc = options.local.load();
    const previous = doc === null ? undefined : doc.entries.find((entry) => entry.objectId === objectId);
    if (previous !== undefined && previous.checksum === checksum && previous.tombstone === deleting) return;
    const rev = (previous?.rev ?? 0) + 1;
    const entry: SyncManifestEntry = {
      objectId,
      objectType: CHAT_OBJECT_TYPE,
      rev,
      checksum,
      fileName: syncObjectFileName(objectId, rev),
      updatedAt: at,
      tombstone: deleting,
    };
    options.local.save(
      doc === null ? { schema: 1, updatedAt: at, entries: [entry] } : withManifestEntry(doc, entry, at),
    );
    enqueueSyncChange(options.db, { objectId, objectType: CHAT_OBJECT_TYPE, rev, checksum }, at);
    options.notify();
  };
}

/** Serialize the CURRENT thread for the row being pushed. Agreement with
 * the row is the pass's check: a thread that moved on reads as a checksum
 * mismatch there and retries, never lies. A thread that no longer exists
 * publishes the tombstone the delete path enqueued. */
export function readChatObject(): SyncPassDeps["readObject"] {
  return (row: SyncJournalRow): SyncObject => {
    const threadId = threadIdOf(row.objectId);
    const rows = readThreadRows(threadId);
    const gone = rows.messages.length === 0 && rows.activeLeafId === null;
    const payload = gone ? TOMBSTONE_PAYLOAD : chatPayload(threadId, rows.activeLeafId, rows.messages);
    const stamps = rows.messages.map((message) => message.at);
    return {
      objectId: row.objectId,
      objectType: CHAT_OBJECT_TYPE,
      // §10's ownerId namespaces by owner; a per-thread object is scoped by
      // its thread, and the install that produced the rev is carried by
      // deviceId below (S2b's install identity, never hardware).
      ownerId: threadId,
      rev: row.rev,
      createdAt: stamps.length > 0 ? Math.min(...stamps) : at(row),
      updatedAt: stamps.length > 0 ? Math.max(...stamps) : at(row),
      deviceId: syncInstallId(),
      checksum: sha256Hex(payload),
      tombstone: gone,
      schemaVersion: 1,
      payload,
    };
  };
}

/** Install another install's verified chat object. No producer hook: a
 * thread written by an apply must not enqueue a push-back, or two installs
 * would ping-pong revs forever. A tombstone deletes the thread silently. */
export function applyChatObject(): SyncPassDeps["applyObject"] {
  return (object: SyncObject): void => {
    const threadId = threadIdOf(object.objectId); // throws -> "applier rejected"
    if (object.tombstone) {
      if (object.payload !== TOMBSTONE_PAYLOAD || object.checksum !== TOMBSTONE_CHECKSUM) {
        throw new Error(`tombstone for ${object.objectId} does not carry the canonical empty payload`);
      }
      deleteThreadSilently(threadId);
      return;
    }
    if (object.payload === TOMBSTONE_PAYLOAD) {
      throw new Error(`chat object ${object.objectId} carries an empty payload without being a tombstone`);
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(object.payload);
    } catch {
      throw new Error(`chat object ${object.objectId} is not JSON`);
    }
    const parsed = chatPayloadSchema.safeParse(parsedJson);
    if (!parsed.success) throw new Error(`chat object ${object.objectId} refused its payload: ${parsed.error.message}`);
    if (parsed.data.threadId !== threadId) {
      throw new Error(`chat object ${object.objectId} carries thread ${parsed.data.threadId}`);
    }
    replaceThreadFromSync(threadId, parsed.data.messages, parsed.data.activeLeafId);
  };
}
