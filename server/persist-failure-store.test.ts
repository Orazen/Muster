import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import { closeMessageDb, deleteThread, readThread } from "./message-db.ts";
import { Store } from "./store.ts";

const selection = () => ({ instanceId: "owned-offline", model: "test-model" });
const legacyFile = (threadId: string) => join(DATA_DIR, `messages-${threadId}.json`);
const rows = (threadId: string) => readThread(threadId, legacyFile(threadId));
function setup() {
  const store = new Store(selection);
  const bot = store.createBot({ name: "Durability probe" });
  return { store, bot, threadId: bot.threadId };
}
/** Raw second connection on the same file: triggers RAISE(ABORT) inside the
 * store's own transaction, so every failure below is a real SQLite failure. */
function openProbeConnection() {
  return new DatabaseSync(join(DATA_DIR, "messages.db"));
}

beforeEach(() => { closeMessageDb(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => closeMessageDb());

describe("durable transcript write failures", () => {
  it("appendMessage propagates a failed write and leaves memory, leaf and disk untouched", () => {
    const f = setup();
    const before = f.store.messagesFor(f.threadId).slice();
    const leafBefore = f.store.activeLeaf(f.threadId);
    const connection = openProbeConnection();
    try {
      connection.exec("CREATE TRIGGER persist_fail BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'persist fail'); END");
      expect(() => f.store.appendMessage(f.threadId, { role: "user", kind: "text", text: "lost" })).toThrow(/persist fail/);
      expect(f.store.messagesFor(f.threadId)).toEqual(before);
      expect(f.store.activeLeaf(f.threadId)).toBe(leafBefore);
      expect(rows(f.threadId).messages).toEqual(before);
      connection.exec("DROP TRIGGER persist_fail");
      const kept = f.store.appendMessage(f.threadId, { role: "user", kind: "text", text: "kept" });
      expect(f.store.messagesFor(f.threadId).at(-1)?.id).toBe(kept.id);
      expect(rows(f.threadId).messages.at(-1)?.id).toBe(kept.id);
      expect(f.store.activeLeaf(f.threadId)).toBe(kept.id);
    } finally { connection.close(); }
  });

  it("appendMessage bestEffort keeps the message in memory only and logs loudly", () => {
    const f = setup();
    const durableCount = f.store.messagesFor(f.threadId).length;
    const connection = openProbeConnection();
    try {
      connection.exec("CREATE TRIGGER persist_fail BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'persist fail'); END");
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const onlyMemory = f.store.appendMessage(f.threadId, { role: "user", kind: "text", text: "unpersisted" }, { bestEffort: true });
        expect(f.store.messagesFor(f.threadId).at(-1)?.id).toBe(onlyMemory.id);
        expect(f.store.activeLeaf(f.threadId)).toBe(onlyMemory.id);
        expect(rows(f.threadId).messages).toHaveLength(durableCount);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(String(spy.mock.calls[0][0])).toContain("memory only");
      } finally { spy.mockRestore(); }
      connection.exec("DROP TRIGGER persist_fail");
      const kept = f.store.appendMessage(f.threadId, { role: "user", kind: "text", text: "kept after recovery" });
      expect(rows(f.threadId).messages.at(-1)?.id).toBe(kept.id);
    } finally { connection.close(); }
    // the honest cost of the degradation: a restart loses memory-only messages
    closeMessageDb();
    const restored = new Store(selection);
    expect(restored.messagesFor(f.threadId)).toHaveLength(durableCount + 1);
  });

  it("patchMessage propagates by default and degrades to memory-only under bestEffort", () => {
    const f = setup();
    const target = f.store.appendMessage(f.threadId, { role: "user", kind: "text", text: "original" });
    const connection = openProbeConnection();
    try {
      connection.exec("CREATE TRIGGER persist_fail BEFORE UPDATE ON messages BEGIN SELECT RAISE(ABORT, 'persist fail'); END");
      expect(() => f.store.patchMessage(f.threadId, target.id, { text: "edited" })).toThrow(/persist fail/);
      expect(f.store.messagesFor(f.threadId).find((m) => m.id === target.id)?.text).toBe("original");
      expect(rows(f.threadId).messages.find((m) => m.id === target.id)?.text).toBe("original");
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const merged = f.store.patchMessage(f.threadId, target.id, { text: "edited" }, { bestEffort: true });
        expect(merged?.text).toBe("edited");
        expect(f.store.messagesFor(f.threadId).find((m) => m.id === target.id)?.text).toBe("edited");
        expect(rows(f.threadId).messages.find((m) => m.id === target.id)?.text).toBe("original");
        expect(String(spy.mock.calls[0][0])).toContain("memory only");
      } finally { spy.mockRestore(); }
      connection.exec("DROP TRIGGER persist_fail");
      f.store.patchMessage(f.threadId, target.id, { text: "edited" });
      expect(rows(f.threadId).messages.find((m) => m.id === target.id)?.text).toBe("edited");
    } finally { connection.close(); }
  });

  it("branchMessage and setActiveLeaf propagate failed writes without forking memory", () => {
    const f = setup();
    const source = f.store.appendMessage(f.threadId, { role: "user", kind: "text", text: "fork point" });
    const messagesBefore = f.store.messagesFor(f.threadId).slice();
    const leafBefore = f.store.activeLeaf(f.threadId);
    const connection = openProbeConnection();
    try {
      connection.exec("CREATE TRIGGER persist_fail_insert BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'branch fail'); END");
      expect(() => f.store.branchMessage(f.threadId, source.id, "branched")).toThrow(/branch fail/);
      expect(f.store.messagesFor(f.threadId)).toEqual(messagesBefore);
      expect(f.store.activeLeaf(f.threadId)).toBe(leafBefore);
      // the same append is one mutation covering the leaf head too — block it separately
      connection.exec("DROP TRIGGER persist_fail_insert");
      connection.exec("CREATE TRIGGER persist_fail_leaf BEFORE UPDATE ON thread_state BEGIN SELECT RAISE(ABORT, 'leaf fail'); END");
      expect(() => f.store.branchMessage(f.threadId, source.id, "branched")).toThrow(/leaf fail/);
      expect(f.store.messagesFor(f.threadId)).toEqual(messagesBefore);
      connection.exec("DROP TRIGGER persist_fail_leaf");
      const branch = f.store.branchMessage(f.threadId, source.id, "branched");
      expect(branch?.id).toBe(f.store.activeLeaf(f.threadId));
      expect(f.store.messagesFor(f.threadId)).toHaveLength(messagesBefore.length + 1);
      connection.exec("CREATE TRIGGER persist_fail_leaf BEFORE UPDATE ON thread_state BEGIN SELECT RAISE(ABORT, 'leaf fail'); END");
      expect(() => f.store.setActiveLeaf(f.threadId, source.id)).toThrow(/leaf fail/);
      expect(f.store.activeLeaf(f.threadId)).toBe(branch!.id);
      connection.exec("DROP TRIGGER persist_fail_leaf");
      expect(f.store.setActiveLeaf(f.threadId, source.id)).toBe(source.id);
      expect(f.store.activeLeaf(f.threadId)).toBe(source.id);
    } finally { connection.close(); }
  });

  it("deleteThread is one mutation — a failed delete leaves the transcript on disk", () => {
    const f = setup();
    f.store.appendMessage(f.threadId, { role: "user", kind: "text", text: "survivor" });
    const before = rows(f.threadId);
    const connection = openProbeConnection();
    try {
      connection.exec("CREATE TRIGGER persist_fail BEFORE DELETE ON thread_state BEGIN SELECT RAISE(ABORT, 'delete fail'); END");
      expect(() => deleteThread(f.threadId)).toThrow(/delete fail/);
      expect(rows(f.threadId)).toEqual(before);
      connection.exec("DROP TRIGGER persist_fail");
      deleteThread(f.threadId);
      expect(rows(f.threadId).messages).toHaveLength(0);
    } finally { connection.close(); }
  });
});
