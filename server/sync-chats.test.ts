// P4 (docs/plans/local-first-architecture-plan-2026-09-23.md, §8 "P4 —
// Conversation sync", R4) — the conversation producer and the pass's chat
// deps, driven against a throwaway DATA_DIR (config resolves DATA_DIR at
// import time, so the modules re-import per test like the memory tests do).
//
// The invariants this pins, each one a P4 gate clause:
//   - one durable transcript change -> exactly one journal row, with the
//     rev from the local manifest and the checksum from the CURRENT thread
//     bytes; a byte-identical rewrite burns neither rev nor notify;
//   - a delete is data: it publishes the canonical tombstone object, and
//     install B's tombstone removes the thread with NO notification back
//     (the no-ping-pong rule, proven on both sides);
//   - round-trip identity: message ids, roles, kinds, text, the loose tail
//     (cards/activity) and the branch head survive A -> destroy -> B as
//     byte-identical payload bytes;
//   - incremental by construction: appending to thread B never touches
//     thread A's rev, checksum or payload — the "changed-thread sync must
//     not move the whole DB" clause, measured per object instead of by
//     claim;
//   - the dispatch seam routes by objectType and refuses everything else.
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { SyncJournalRow } from "./sync-journal.ts";
import { manifestDocSchema, type SyncManifestDoc, type SyncObject } from "./sync-objects.ts";
import type { LocalManifestStore } from "./sync-wiring.ts";

let home: string;
let prevDataDir: string | undefined;

const T0 = 1_760_000_000_000;
const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const TOMBSTONE_CHECKSUM = sha256("");

// SQL results go straight through zod — the house pattern, no casts. The
// journal's columns are camelCase (server/sync-journal.ts:82).
const journalRowSchema = z.object({
  objectId: z.string(),
  objectType: z.string(),
  rev: z.number().int(),
  checksum: z.string(),
  state: z.enum(["pending", "inflight", "dead"]),
});
type JournalRow = z.infer<typeof journalRowSchema>;

/** The one shape the message fixtures extend: the loose tail a transcript
 * row may carry beyond the four columns sync actually reads. */
interface MessageExtra {
  tool?: { name: string; ok?: boolean; spoken?: string };
}

const ROW_SQL = "SELECT objectId, objectType, rev, checksum, state FROM sync_journal";

/** The row the pass consumes, with the bookkeeping columns the SELECT above
 * leaves out pinned to a known state. */
const asJournalRow = (row: JournalRow): SyncJournalRow => ({
  ...row,
  attempts: 0,
  enqueuedAt: T0,
  nextAttemptAt: T0,
  claimedAt: null,
});

const message = (id: string, at: number, text: string, extra: MessageExtra = {}) => ({
  id,
  at,
  role: "bot" as const,
  kind: "text" as const,
  text,
  ...extra,
});

/** The payload exactly as the producer serializes it — the tests compare
 * against the module's own canonical form, never a hand-rolled copy. */
const payloadOf = (threadId: string, activeLeafId: string | null, messages: unknown[]): string =>
  JSON.stringify({ schema: 1, threadId, activeLeafId, messages });

/** The history tests' isolation pattern: resetModules per load so config's
 * DATA_DIR and the sync-hooks registry both re-resolve against `home`. */
async function load() {
  vi.resetModules();
  const [hooks, chats, msgdb, dispatch] = await Promise.all([
    import("./sync-hooks.ts"),
    import("./sync-chats.ts"),
    import("./message-db.ts"),
    import("./sync-dispatch.ts"),
  ]);
  return { hooks, chats, msgdb, dispatch };
}

/** A plain-file local manifest with the same shape the real store has. */
function manifestStore(path: string): LocalManifestStore {
  return {
    load(): SyncManifestDoc | null {
      if (!existsSync(path)) return null;
      return manifestDocSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    },
    save(doc: SyncManifestDoc): void {
      manifestDocSchema.parse(doc);
      writeFileSync(path, JSON.stringify(doc), { mode: 0o600 });
    },
  };
}

/** The producer wired through the REAL hook registry — the same path boot
 * uses, so the tests prove message-db's post-commit fire, not just the
 * producer in isolation. */
async function wire(overrides: { notify?: () => void; now?: () => number } = {}) {
  const modules = await load();
  const db = new DatabaseSync(":memory:");
  const local = manifestStore(join(home, "local.json"));
  const notify = overrides.notify ?? vi.fn();
  const produce = modules.chats.createChatProducer({
    db,
    local,
    notify,
    now: overrides.now ?? (() => T0),
  });
  modules.hooks.setChatChangeListener(produce);
  const rows = (sql: string, ...params: string[]): JournalRow[] => {
    try {
      // Raw driver rows stay `unknown` until zod has named every field —
      // the house pattern, no assertion and no dictionary type.
      const raws: unknown[] = db.prepare(sql).all(...params);
      return raws.map((row) => journalRowSchema.parse(row));
    } catch (error) {
      // The journal's table is created by the first enqueue (S1), so "no
      // table yet" is the honest reading of "nothing was ever tracked".
      if (error instanceof Error && error.message.includes("no such table")) return [];
      throw error;
    }
  };
  return { ...modules, db, local, notify, produce, rows };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sync-chats-"));
  prevDataDir = process.env.OMB_DATA_DIR;
  process.env.OMB_DATA_DIR = home;
});

afterEach(() => {
  if (prevDataDir === undefined) delete process.env.OMB_DATA_DIR;
  else process.env.OMB_DATA_DIR = prevDataDir;
  vi.resetModules();
  rmSync(home, { recursive: true, force: true });
});

describe("createChatProducer", () => {
  it("one durable append enqueues rev 1 with the live checksum and notifies once", async () => {
    const { msgdb, db, local, notify, rows } = await wire();
    msgdb.appendMessage("thread-a", message("m1", T0, "hello"));
    expect(rows(`${ROW_SQL} WHERE objectId = ?`, "chat:thread-a")).toEqual([
      {
        objectId: "chat:thread-a",
        objectType: "chat",
        rev: 1,
        checksum: sha256(payloadOf("thread-a", "m1", [message("m1", T0, "hello")])),
        state: "pending",
      },
    ]);
    expect(local.load()?.entries[0]).toMatchObject({ objectId: "chat:thread-a", rev: 1, tombstone: false });
    expect(notify).toHaveBeenCalledTimes(1);
    db.close();
  });

  it("a byte-identical rewrite burns no rev and does not notify again", async () => {
    const { hooks, msgdb, db, notify, rows } = await wire();
    msgdb.appendMessage("thread-a", message("m1", T0, "same"));
    hooks.chatWasWritten("thread-a"); // the shape a no-op mutation would take
    expect(rows(`${ROW_SQL} WHERE objectId = ?`, "chat:thread-a").map((row) => row.rev)).toEqual([1]);
    expect(notify).toHaveBeenCalledTimes(1);
    db.close();
  });

  it("a second, different append supersedes to rev 2", async () => {
    const { msgdb, db, local, rows } = await wire();
    msgdb.appendMessage("thread-a", message("m1", T0, "one"));
    msgdb.appendMessage("thread-a", message("m2", T0 + 1, "two"));
    expect(rows(`${ROW_SQL} WHERE objectId = ?`, "chat:thread-a").map((row) => row.rev)).toEqual([2]);
    expect(local.load()?.entries[0]?.rev).toBe(2);
    db.close();
  });

  it("a branch-head move on its own is a durable change worth a rev", async () => {
    const { msgdb, db, rows } = await wire();
    msgdb.appendMessage("thread-a", message("m1", T0, "one"));
    msgdb.appendMessage("thread-a", message("m2", T0 + 1, "two"));
    const before = rows(`${ROW_SQL} WHERE objectId = ?`, "chat:thread-a").map((row) => row.rev);
    msgdb.setActiveLeaf("thread-a", "m1");
    const after = rows(`${ROW_SQL} WHERE objectId = ?`, "chat:thread-a").map((row) => row.rev);
    expect(Math.max(...after)).toBeGreaterThan(Math.max(...before));
    db.close();
  });

  it("a delete publishes the canonical tombstone object at the next rev", async () => {
    const { msgdb, db, local, rows } = await wire();
    msgdb.appendMessage("thread-a", message("m1", T0, "one"));
    msgdb.deleteThread("thread-a");
    // The journal keeps ONE row per object (a newer rev supersedes), so the
    // delete is visible as that row moving to rev 2 with the tombstone hash.
    const journal = rows(`${ROW_SQL} WHERE objectId = ?`, "chat:thread-a");
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({ rev: 2, checksum: TOMBSTONE_CHECKSUM, state: "pending" });
    expect(local.load()?.entries[0]).toMatchObject({ rev: 2, tombstone: true });
    db.close();
  });

  it("a thread id the envelope cannot carry is not tracked, and the write still stands", async () => {
    const { msgdb, db, notify, rows } = await wire();
    msgdb.appendMessage("", message("m1", T0, "one"));
    expect(rows(ROW_SQL)).toEqual([]);
    expect(msgdb.readThreadRows("").messages).toHaveLength(1);
    expect(notify).not.toHaveBeenCalled();
    db.close();
  });
});

describe("readChatObject", () => {
  it("agrees with the producer's row and carries the transcript faithfully", async () => {
    const { chats, msgdb, db, rows } = await wire();
    const first = message("m1", T0, "hello");
    const second = message("m2", T0 + 5, "worked", { tool: { name: "read", ok: true } });
    msgdb.appendMessage("thread-a", first);
    msgdb.appendMessage("thread-a", second);
    const row = rows(`${ROW_SQL} WHERE objectId = ?`, "chat:thread-a").at(-1);
    if (row === undefined) throw new Error("the append did not enqueue a row");
    const object = await chats.readChatObject()(asJournalRow(row));
    expect(object.objectId).toBe("chat:thread-a");
    expect(object.objectType).toBe("chat");
    expect(object.tombstone).toBe(false);
    expect(object.checksum).toBe(row.checksum);
    expect(object.payload).toBe(payloadOf("thread-a", "m2", [first, second]));
    expect(object.deviceId).toMatch(/^[0-9a-f-]{36}$/u);
    db.close();
  });

  it("a thread that no longer exists reads back as the tombstone", async () => {
    const { chats, msgdb, db, rows } = await wire();
    msgdb.appendMessage("thread-a", message("m1", T0, "one"));
    msgdb.deleteThread("thread-a");
    const row = rows(`${ROW_SQL} WHERE objectId = ?`, "chat:thread-a").at(-1);
    if (row === undefined) throw new Error("the delete did not enqueue a row");
    const object = await chats.readChatObject()(asJournalRow(row));
    expect(object.tombstone).toBe(true);
    expect(object.payload).toBe("");
    expect(object.checksum).toBe(TOMBSTONE_CHECKSUM);
    db.close();
  });
});

describe("applyChatObject", () => {
  it("installs another install's thread without enqueueing a push-back", async () => {
    const { chats, msgdb, db, local, rows } = await wire();
    const messages = [message("m1", T0, "from A"), message("m2", T0 + 1, "also A")];
    const payload = payloadOf("thread-b", "m2", messages);
    chats.applyChatObject()({
      objectId: "chat:thread-b",
      objectType: "chat",
      ownerId: "thread-b",
      rev: 4,
      createdAt: T0,
      updatedAt: T0 + 1,
      deviceId: "other-install",
      checksum: sha256(payload),
      tombstone: false,
      schemaVersion: 1,
      payload,
    });
    const installed = msgdb.readThreadRows("thread-b");
    expect(installed.activeLeafId).toBe("m2");
    expect(installed.messages.map((entry) => entry.id)).toEqual(["m1", "m2"]);
    expect(rows(ROW_SQL)).toEqual([]);
    expect(local.load()).toBeNull();
    db.close();
  });

  it("round-trips byte-identically: A read -> A destroyed -> B read", async () => {
    const { chats, msgdb, db } = await wire();
    const threadId = "thread-a";
    msgdb.appendMessage(threadId, message("m1", T0, "one"));
    msgdb.appendMessage(threadId, message("m2", T0 + 1, "two", { tool: { name: "read", ok: false } }));
    const before = msgdb.readThreadRows(threadId);
    const payload = payloadOf(threadId, before.activeLeafId, before.messages);
    msgdb.deleteThreadSilently(threadId);
    expect(msgdb.readThreadRows(threadId).messages).toHaveLength(0);
    chats.applyChatObject()({
      objectId: `chat:${threadId}`,
      objectType: "chat",
      ownerId: threadId,
      rev: 1,
      createdAt: T0,
      updatedAt: T0 + 1,
      deviceId: "other-install",
      checksum: sha256(payload),
      tombstone: false,
      schemaVersion: 1,
      payload,
    });
    const after = msgdb.readThreadRows(threadId);
    expect(payloadOf(threadId, after.activeLeafId, after.messages)).toBe(payload);
    db.close();
  });

  it("installs a tombstone silently: the thread goes, nothing new is enqueued", async () => {
    const { chats, msgdb, db, rows } = await wire();
    msgdb.appendMessage("thread-a", message("m1", T0, "one"));
    msgdb.deleteThreadSilently("thread-a");
    const before = rows(ROW_SQL);
    chats.applyChatObject()({
      objectId: "chat:thread-a",
      objectType: "chat",
      ownerId: "thread-a",
      rev: 2,
      createdAt: T0,
      updatedAt: T0,
      deviceId: "other-install",
      checksum: TOMBSTONE_CHECKSUM,
      tombstone: true,
      schemaVersion: 1,
      payload: "",
    });
    // Same rows as before the apply: installing a peer's tombstone never
    // announces anything back, or the two installs ping-pong the deletion.
    expect(rows(ROW_SQL)).toEqual(before);
    expect(msgdb.readThreadRows("thread-a").messages).toEqual([]);
    db.close();
  });

  it("refuses a payload that is not this thread's, not JSON, or a non-canonical tombstone", async () => {
    const { chats } = await wire();
    const base = {
      objectType: "chat",
      ownerId: "thread-a",
      rev: 1,
      createdAt: T0,
      updatedAt: T0,
      deviceId: "other-install",
      tombstone: false,
      schemaVersion: 1,
    };
    expect(() =>
      chats.applyChatObject()({ ...base, objectId: "chat:thread-a", checksum: sha256("x"), payload: "not json" }),
    ).toThrow(/not JSON/u);
    expect(() =>
      chats.applyChatObject()({
        ...base,
        objectId: "chat:thread-a",
        checksum: sha256("x"),
        payload: payloadOf("thread-b", null, []),
      }),
    ).toThrow(/carries thread thread-b/u);
    expect(() =>
      chats.applyChatObject()({
        ...base,
        objectId: "chat:thread-a",
        tombstone: true,
        checksum: sha256("x"),
        payload: "x",
      }),
    ).toThrow(/canonical empty payload/u);
    expect(() =>
      chats.applyChatObject()({ ...base, objectId: "chat:thread-a", checksum: sha256(""), payload: "" }),
    ).toThrow(/without being a tombstone/u);
  });
});

describe("P4 incrementality", () => {
  it("appending to one thread never revs or rewrites another thread's object", async () => {
    const { chats, msgdb, db, local, rows } = await wire();
    msgdb.appendMessage("thread-a", message("a1", T0, "A"));
    const entryA = local.load()?.entries.find((entry) => entry.objectId === "chat:thread-a");
    const payloadA = payloadOf("thread-a", "a1", [message("a1", T0, "A")]);
    msgdb.appendMessage("thread-b", message("b1", T0 + 1, "B"));
    expect(local.load()?.entries.find((entry) => entry.objectId === "chat:thread-b")).toMatchObject({ rev: 1 });
    expect(local.load()?.entries.find((entry) => entry.objectId === "chat:thread-a")).toEqual(entryA);
    const rowA = rows(`${ROW_SQL} WHERE objectId = ?`, "chat:thread-a").at(-1);
    if (rowA === undefined) throw new Error("the append did not enqueue a row");
    const objectA = await chats.readChatObject()(asJournalRow(rowA));
    expect(objectA.payload).toBe(payloadA);
    db.close();
  });
});

describe("createObjectRead / createObjectApply routing", () => {
  it("routes chat objects to the chat side and refuses every other type by name", async () => {
    const { dispatch, msgdb, db, rows } = await wire();
    msgdb.appendMessage("thread-a", message("m1", T0, "one"));
    const read = dispatch.createObjectRead();
    const row = rows(`${ROW_SQL} WHERE objectId = ?`, "chat:thread-a").at(-1);
    if (row === undefined) throw new Error("the append did not enqueue a row");
    const readBack = await read(asJournalRow(row));
    expect(readBack.objectType).toBe("chat");
    expect(() => read({ ...asJournalRow(row), objectType: "preference" })).toThrow(/not a memory object/u);
    const apply = dispatch.createObjectApply();
    const foreign: SyncObject = {
      objectId: "preference:x",
      objectType: "preference",
      ownerId: "x",
      rev: 1,
      createdAt: T0,
      updatedAt: T0,
      deviceId: "x",
      checksum: sha256(""),
      tombstone: false,
      schemaVersion: 1,
      payload: "",
    };
    expect(() => apply(foreign)).toThrow(/not a memory object/u);
    db.close();
  });
});
