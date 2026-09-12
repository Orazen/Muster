import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import { closeMessageDb, deleteThread, readThread } from "./message-db.ts";
import { Store, type Message, type StoreChange } from "./store.ts";

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

/** Fail only the real inserts; the Store must report each intentional
 * best-effort degradation while retaining the exact messages in memory. */
function appendVolatile(
  f: ReturnType<typeof setup>, connection: DatabaseSync,
  messages: Array<Omit<Message, "id" | "at"> & { at?: number }>,
): Message[] {
  const before = rows(f.threadId);
  connection.exec("CREATE TRIGGER volatile_insert BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'owned volatile insert'); END");
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const result = messages.map((message) => f.store.appendMessage(f.threadId, message, { bestEffort: true }));
    expect(errors).toHaveBeenCalledTimes(messages.length);
    expect(errors.mock.calls.every((call) => String(call[0]).includes("memory only"))).toBe(true);
    expect(rows(f.threadId)).toEqual(before);
    return result;
  } finally {
    errors.mockRestore();
    connection.exec("DROP TRIGGER volatile_insert");
  }
}

function recordEvents(store: Store): StoreChange[] {
  const events: StoreChange[] = [];
  store.onChange((event) => events.push(event));
  return events;
}

beforeEach(() => {
  // The shared test setup owns this home; refuse an inherited data override
  // before any destructive fixture reset.
  expect(basename(homedir())).toMatch(/^omb-test-home-/);
  expect(DATA_DIR).toBe(join(homedir(), ".muster"));
  closeMessageDb();
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });
});
afterEach(() => closeMessageDb());
afterAll(() => {
  closeMessageDb();
  expect(basename(homedir())).toMatch(/^omb-test-home-/);
  expect(DATA_DIR).toBe(join(homedir(), ".muster"));
  rmSync(DATA_DIR, { recursive: true, force: true });
  expect(existsSync(DATA_DIR)).toBe(false);
  console.info(JSON.stringify({ scope: "owned Store SQLite cleanup", dataDirectory: DATA_DIR, removed: true }));
});

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

  it("a later durable append persists its failed bestEffort ancestor and survives reopen", () => {
    const f = setup();
    const a = f.store.appendMessage(f.threadId, { role: "user", kind: "text", text: "durable A" });
    const b = f.store.appendMessage(f.threadId, { role: "bot", kind: "text", text: "durable B" });
    const durableCount = f.store.messagesFor(f.threadId).length;
    const connection = openProbeConnection();
    try {
      connection.exec("CREATE TRIGGER persist_fail BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'persist fail'); END");
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const onlyMemory = f.store.appendMessage(f.threadId, { role: "bot", kind: "text", text: "memory-only C" }, { bestEffort: true });
        expect(f.store.messagesFor(f.threadId).at(-1)?.id).toBe(onlyMemory.id);
        expect(f.store.activeLeaf(f.threadId)).toBe(onlyMemory.id);
        expect(rows(f.threadId).messages).toHaveLength(durableCount);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(String(spy.mock.calls[0][0])).toContain("memory only");
      } finally { spy.mockRestore(); }
      connection.exec("DROP TRIGGER persist_fail");
      const kept = f.store.appendMessage(f.threadId, { role: "user", kind: "text", text: "durable D" });
      expect(rows(f.threadId).messages.at(-1)?.id).toBe(kept.id);
    } finally { connection.close(); }
    const expected = f.store.messagesFor(f.threadId).map((message) => ({ ...message }));
    const leaf = f.store.activeLeaf(f.threadId);
    const path = f.store.activePath(f.threadId);
    expect(path.slice(-4).map(({ id, parentId, text }) => ({ id, parentId, text }))).toEqual([
      { id: a.id, parentId: a.parentId, text: "durable A" },
      { id: b.id, parentId: a.id, text: "durable B" },
      { id: expected.at(-2)?.id, parentId: b.id, text: "memory-only C" },
      { id: leaf, parentId: expected.at(-2)?.id, text: "durable D" },
    ]);
    expect(rows(f.threadId)).toEqual({ messages: expected, activeLeafId: leaf });
    closeMessageDb();
    const restored = new Store(selection);
    expect(restored.messagesFor(f.threadId)).toEqual(expected);
    expect(restored.activeLeaf(f.threadId)).toBe(leaf);
    expect(restored.activePath(f.threadId)).toEqual(path);
    closeMessageDb();
    // A fresh bounded process has neither this Store's cache nor its pending
    // markers. It opens only the owned SQLite data and starts no providers.
    const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", `
      import { Socket } from "node:net";
      let outboundAttempts = 0;
      const blocked = () => { outboundAttempts++; throw new Error("Owned restart has no network"); };
      Socket.prototype.connect = blocked;
      globalThis.fetch = blocked;
      const { Store } = await import(${JSON.stringify(new URL("./store.ts", import.meta.url).href)});
      const { closeMessageDb } = await import(${JSON.stringify(new URL("./message-db.ts", import.meta.url).href)});
      try {
        const store = new Store(() => ({ instanceId: "owned-offline", model: "test-model" }));
        const thread = ${JSON.stringify(f.threadId)};
        process.stdout.write(JSON.stringify({ messages: store.messagesFor(thread), leaf: store.activeLeaf(thread), path: store.activePath(thread), outboundAttempts }));
      } finally { closeMessageDb(); }
    `], {
      cwd: DATA_DIR, encoding: "utf8", timeout: 8_000, maxBuffer: 1_000_000,
      env: { PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter), HOME: homedir(), USERPROFILE: homedir(),
        OMB_DATA_DIR: DATA_DIR, OMB_COMPANION_DIR: join(homedir(), ".muster-companion"), VITEST: "true", NODE_ENV: "test" },
    });
    // Record terminal process evidence even when an assertion below fails.
    console.info(JSON.stringify({ scope: "owned Store fresh-process terminal", pid: child.pid, exit: child.status,
      signal: child.signal, error: child.error?.message ?? null, stdoutBytes: Buffer.byteLength(child.stdout ?? ""),
      stderrBytes: Buffer.byteLength(child.stderr ?? "") }));
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(child.signal).toBeNull();
    expect(JSON.parse(child.stdout)).toEqual({ messages: expected, leaf, path, outboundAttempts: 0 });
    console.info(JSON.stringify({ scope: "owned Store fresh-process restart", pid: child.pid, exit: child.status,
      signal: child.signal, outboundAttempts: 0, threadId: f.threadId, messages: expected.length }));
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

describe("recovery of required volatile ancestry", () => {
  for (const failure of ["middle ancestor", "leaf update"]) {
    it(`rolls back every recovered row on ${failure} failure, emits nothing, and retries without duplicates`, () => {
      const f = setup();
      const durable = f.store.appendMessage(f.threadId, { role: "user", kind: "text", text: "durable attachment" });
      const connection = openProbeConnection();
      try {
        const pending = appendVolatile(f, connection, [
          { role: "bot", kind: "text", text: "pending first" },
          { role: "bot", kind: "text", text: "pending second" },
          { role: "bot", kind: "text", text: "pending third" },
        ]);
        expect(pending.map((message) => message.parentId)).toEqual([durable.id, pending[0].id, pending[1].id]);
        const diskBefore = rows(f.threadId);
        const memoryBefore = structuredClone(f.store.messagesFor(f.threadId));
        const leafBefore = f.store.activeLeaf(f.threadId);
        const events = recordEvents(f.store);
        connection.exec(failure === "middle ancestor"
          ? "CREATE TRIGGER recovery_fail BEFORE INSERT ON messages WHEN NEW.text = 'pending second' BEGIN SELECT RAISE(ABORT, 'owned recovery failure'); END"
          : "CREATE TRIGGER recovery_fail BEFORE UPDATE ON thread_state BEGIN SELECT RAISE(ABORT, 'owned recovery failure'); END");
        expect(() => f.store.appendMessage(f.threadId, { role: "user", kind: "text", text: "retry durable descendant" })).toThrow(/owned recovery failure/);
        expect(rows(f.threadId)).toEqual(diskBefore);
        expect(f.store.messagesFor(f.threadId)).toEqual(memoryBefore);
        expect(f.store.activeLeaf(f.threadId)).toBe(leafBefore);
        expect(events).toEqual([]);
        connection.exec("DROP TRIGGER recovery_fail");
        const kept = f.store.appendMessage(f.threadId, { role: "user", kind: "text", text: "retry durable descendant" });
        expect(kept.parentId).toBe(pending[2].id);
        const expected = [...memoryBefore, kept];
        expect(rows(f.threadId)).toEqual({ messages: expected, activeLeafId: kept.id });
        expect(events).toEqual([{ type: "message", threadId: f.threadId, message: kept }]);
        // A second selection is a legitimate replay of the already-recovered
        // path; it must not rewrite or duplicate any ancestor rows.
        f.store.setActiveLeaf(f.threadId, pending[0].id);
        expect(rows(f.threadId)).toEqual({ messages: expected, activeLeafId: kept.id });
        expect(new Set(rows(f.threadId).messages.map((message) => message.id)).size).toBe(expected.length);
        closeMessageDb();
        const reopened = new Store(selection);
        expect(reopened.messagesFor(f.threadId)).toEqual(expected);
        expect(reopened.activeLeaf(f.threadId)).toBe(kept.id);
        expect(reopened.activePath(f.threadId)).toEqual(expected);
      } finally { connection.close(); }
    });
  }

  it("a pending message's latest zero-row patch is recovered after a failed attempt and later retry", () => {
    const f = setup();
    const connection = openProbeConnection();
    try {
      const [pending] = appendVolatile(f, connection, [{ role: "bot", kind: "text", text: "initial volatile text" }]);
      // Current patchMessage does not assert that UPDATE affected a row.
      // This test covers preserving that latest in-memory value when a later
      // durable append repairs the ancestry, not new strict patch durability.
      const latest = f.store.patchMessage(f.threadId, pending.id, { text: "  latest volatile text\nsecond line  " });
      expect(latest?.text).toBe("  latest volatile text\nsecond line  ");
      expect(rows(f.threadId).messages.some((message) => message.id === pending.id)).toBe(false);
      const before = rows(f.threadId);
      const events = recordEvents(f.store);
      connection.exec("CREATE TRIGGER recovery_fail BEFORE UPDATE ON thread_state BEGIN SELECT RAISE(ABORT, 'patched recovery failure'); END");
      expect(() => f.store.appendMessage(f.threadId, { role: "user", kind: "text", text: "after patched ancestor" })).toThrow(/patched recovery failure/);
      expect(rows(f.threadId)).toEqual(before);
      expect(events).toEqual([]);
      expect(f.store.activeLeaf(f.threadId)).toBe(pending.id);
      connection.exec("DROP TRIGGER recovery_fail");
      const kept = f.store.appendMessage(f.threadId, { role: "user", kind: "text", text: "after patched ancestor" });
      expect(rows(f.threadId)).toEqual({ messages: [...before.messages, latest, kept], activeLeafId: kept.id });
      expect(events).toEqual([{ type: "message", threadId: f.threadId, message: kept }]);
      closeMessageDb();
      const reopened = new Store(selection);
      expect(reopened.messagesFor(f.threadId)).toEqual([...before.messages, latest, kept]);
      expect(reopened.activePath(f.threadId)).toEqual([...before.messages, latest, kept]);
    } finally { connection.close(); }
  });

  it("branchMessage recovers source.parentId rather than the active volatile source and tail", () => {
    const f = setup();
    const attachment = f.store.appendMessage(f.threadId, { role: "user", kind: "text", text: "durable attachment" });
    const connection = openProbeConnection();
    try {
      const before = rows(f.threadId);
      const [parent, source, tail] = appendVolatile(f, connection, [
        { role: "bot", kind: "text", text: "required parent" },
        { role: "user", kind: "text", text: "source being replaced" },
        { role: "bot", kind: "text", text: "unrelated volatile tail" },
      ]);
      const events = recordEvents(f.store);
      expect(f.store.activeLeaf(f.threadId)).toBe(tail.id);
      const branch = f.store.branchMessage(f.threadId, source.id, "replacement branch");
      expect(branch?.parentId).toBe(parent.id);
      expect(parent.parentId).toBe(attachment.id);
      expect(rows(f.threadId)).toEqual({ messages: [...before.messages, parent, branch], activeLeafId: branch?.id });
      expect(f.store.messagesFor(f.threadId).map((message) => message.id)).toContain(source.id);
      expect(f.store.messagesFor(f.threadId).map((message) => message.id)).toContain(tail.id);
      expect(events).toEqual([{ type: "message", threadId: f.threadId, message: branch }]);
      closeMessageDb();
      const reopened = new Store(selection);
      expect(reopened.messagesFor(f.threadId)).toEqual([...before.messages, parent, branch]);
      expect(reopened.activePath(f.threadId)).toEqual([...before.messages, parent, branch]);
    } finally { connection.close(); }
  });

  it("setActiveLeaf recovers only the selected volatile chain, with rollback and no unrelated tail flush", () => {
    const f = setup();
    const attachment = f.store.appendMessage(f.threadId, { role: "user", kind: "text", text: "durable attachment" });
    const connection = openProbeConnection();
    try {
      const diskBefore = rows(f.threadId);
      const [selected, child, unrelated] = appendVolatile(f, connection, [
        { role: "bot", kind: "text", text: "selected volatile branch", at: 1001 },
        { role: "bot", kind: "text", text: "selected descendant", at: 1002 },
        { role: "bot", kind: "text", text: "unrelated later branch", at: 1003, parentId: attachment.id },
      ]);
      const before = structuredClone(f.store.messagesFor(f.threadId));
      const events = recordEvents(f.store);
      connection.exec("CREATE TRIGGER select_fail BEFORE UPDATE ON thread_state BEGIN SELECT RAISE(ABORT, 'selection failure'); END");
      expect(() => f.store.setActiveLeaf(f.threadId, selected.id)).toThrow(/selection failure/);
      expect(rows(f.threadId)).toEqual(diskBefore);
      expect(f.store.messagesFor(f.threadId)).toEqual(before);
      expect(f.store.activeLeaf(f.threadId)).toBe(unrelated.id);
      expect(events).toEqual([]);
      connection.exec("DROP TRIGGER select_fail");
      expect(f.store.setActiveLeaf(f.threadId, selected.id)).toBe(child.id);
      const expected = [...diskBefore.messages, selected, child];
      expect(rows(f.threadId)).toEqual({ messages: expected, activeLeafId: child.id });
      expect(events).toEqual([{ type: "thread", threadId: f.threadId, activeLeafId: child.id }]);
      expect(f.store.messagesFor(f.threadId).map((message) => message.id)).toContain(unrelated.id);
      closeMessageDb();
      const reopened = new Store(selection);
      expect(reopened.messagesFor(f.threadId)).toEqual(expected);
      expect(reopened.activeLeaf(f.threadId)).toBe(child.id);
      expect(reopened.activePath(f.threadId)).toEqual(expected);
    } finally { connection.close(); }
  });

  it("an explicit durable parent does not flush the currently active unrelated volatile chain", () => {
    const f = setup();
    const attachment = f.store.appendMessage(f.threadId, { role: "user", kind: "text", text: "durable parent" });
    const connection = openProbeConnection();
    try {
      const before = rows(f.threadId);
      const pending = appendVolatile(f, connection, [
        { role: "bot", kind: "text", text: "unrelated first" },
        { role: "bot", kind: "text", text: "unrelated last" },
      ]);
      const kept = f.store.appendMessage(f.threadId, { role: "user", kind: "text", text: "explicit sibling", parentId: attachment.id });
      expect(rows(f.threadId)).toEqual({ messages: [...before.messages, kept], activeLeafId: kept.id });
      expect(f.store.messagesFor(f.threadId).slice(-3)).toEqual([...pending, kept]);
      expect(f.store.activePath(f.threadId)).toEqual([...before.messages, kept]);
    } finally { connection.close(); }
  });
});
