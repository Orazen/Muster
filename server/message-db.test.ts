// SQLite message-store contract: per-mutation persistence, one-time legacy
// import, deletion, and the LIKE search used by /api/search.
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import {
  closeMessageDb,
  appendMessage,
  deleteThread,
  insertMessage,
  readThread,
  persistMessagePath,
  searchMessages,
  setActiveLeaf,
  updateMessage,
} from "./message-db.ts";
import { Store, type Message } from "./store.ts";
import type { ModelSelection } from "./contracts.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
const legacy = (threadId: string) => join(DATA_DIR, `messages-${threadId}.json`);
const msg = (id: string, text: string, extra: Partial<Message> = {}): Message => ({
  id,
  role: "user",
  kind: "text",
  text,
  at: Date.now(),
  ...extra,
});

describe("message-db", () => {
  beforeEach(() => {
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
    mkdirSync(DATA_DIR, { recursive: true });
  });
  afterEach(() => closeMessageDb());

  it("persists inserts, updates, and the active leaf across a reopen", () => {
    insertMessage("t1", msg("m1", "hello"));
    insertMessage("t1", msg("m2", "world"));
    setActiveLeaf("t1", "m2");
    updateMessage("t1", msg("m1", "hello, edited"));

    closeMessageDb(); // simulate a restart
    const thread = readThread("t1", legacy("t1"));
    expect(thread.messages.map((m) => m.text)).toEqual(["hello, edited", "world"]);
    expect(thread.activeLeafId).toBe("m2");
  });

  it("imports a legacy JSON thread file exactly once", () => {
    writeFileSync(
      legacy("t2"),
      JSON.stringify({ activeLeafId: "b", messages: [msg("a", "from json"), msg("b", "second")] }),
    );
    const imported = readThread("t2", legacy("t2"));
    expect(imported.messages.map((m) => m.id)).toEqual(["a", "b"]);
    expect(imported.activeLeafId).toBe("b");
    // the file was renamed so wiped rows can never resurrect stale data
    expect(existsSync(legacy("t2"))).toBe(false);
    expect(existsSync(`${legacy("t2")}.imported`)).toBe(true);

    deleteThread("t2");
    expect(readThread("t2", legacy("t2")).messages).toEqual([]);
  });

  it("imports a pre-branching flat array file", () => {
    writeFileSync(legacy("t3"), JSON.stringify([msg("a", "one"), msg("b", "two")]));
    const imported = readThread("t3", legacy("t3"));
    expect(imported.messages).toHaveLength(2);
    expect(imported.activeLeafId).toBeNull(); // Store derives the tail
  });

  it("migrates known legacy transcripts at Store startup so search sees unopened tasks", () => {
    const initial = new Store(selection);
    const bot = initial.createBot({}, { seedMessages: false });
    closeMessageDb();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(join(DATA_DIR, `messages.db${suffix}`), { force: true });
    writeFileSync(legacy(bot.threadId), JSON.stringify([msg("old", "find this unopened legacy conversation")]));

    new Store(selection);
    expect(searchMessages("unopened legacy")).toMatchObject([{ threadId: bot.threadId, messageId: "old" }]);
    expect(existsSync(`${legacy(bot.threadId)}.imported`)).toBe(true);
  });

  it("stores transcripts with owner-only permissions", () => {
    insertMessage("private", msg("m1", "secret"));
    if (process.platform !== "win32") {
      expect(statSync(join(DATA_DIR, "messages.db")).mode & 0o777).toBe(0o600);
    }
  });

  it("deleteThread removes rows and state", () => {
    insertMessage("t4", msg("m1", "gone soon"));
    setActiveLeaf("t4", "m1");
    deleteThread("t4");
    const thread = readThread("t4", legacy("t4"));
    expect(thread.messages).toEqual([]);
    expect(thread.activeLeafId).toBeNull();
  });

  it("search is case-insensitive, escapes LIKE wildcards, and snips long text", () => {
    insertMessage("t5", msg("m1", "Deploy with `railway up --service workers` and verify the heartbeat"));
    insertMessage("t5", msg("m2", "totally unrelated"));
    insertMessage("t5", { ...msg("m3", "an activity chip"), kind: "activity" });
    insertMessage("t6", msg("m4", `padding start ${"x".repeat(200)} RAILWAY tail`));

    const hits = searchMessages("railway");
    expect(hits).toHaveLength(2);
    expect(hits.every((hit) => hit.snippet.toLowerCase().includes("railway"))).toBe(true);
    // long text gets windowed around the hit
    const long = hits.find((hit) => hit.threadId === "t6")!;
    expect(long.snippet.length).toBeLessThan(200);
    expect(long.snippet.startsWith("…")).toBe(true);

    // a literal % is a literal, not match-everything
    expect(searchMessages("%")).toHaveLength(0);
    insertMessage("t5", msg("m5", "50% done"));
    expect(searchMessages("%")).toHaveLength(1);
    expect(searchMessages("")).toEqual([]);
  });

  it("search reports the match offset for highlighting, and finds activity chips by tool name", () => {
    insertMessage("t7", msg("m1", "please\n\n   run   the migration now"));
    insertMessage("t7", { ...msg("m2", ""), kind: "activity", role: "bot", tool: { name: "Bash: alembic upgrade head", ok: true } });
    insertMessage("t7", { ...msg("m3", "we spoke about it"), from: { botId: "b2", name: "Scout", color: "green" } });

    const text = searchMessages("the migration")[0];
    expect(text.messageId).toBe("m1");
    // whitespace folded in the snippet, offset points at the folded match
    expect(text.snippet.slice(text.matchStart, text.matchStart + text.matchLength)).toBe("the migration");

    // "which bot ran that migration" — the tool name is searchable
    const chip = searchMessages("alembic")[0];
    expect(chip).toMatchObject({ messageId: "m2", kind: "activity" });
    expect(chip.snippet).toContain("alembic upgrade head");

    // room attribution rides along
    expect(searchMessages("spoke")[0].from).toBe("Scout");
  });

  it("Store round-trips branching through the DB across a restart", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const first = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "original" });
    store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "reply" });
    const fork = store.branchMessage(bot.threadId, first.id, "edited")!;

    closeMessageDb();
    const reloaded = new Store(selection);
    const path = reloaded.activePath(bot.threadId);
    expect(path.at(-1)?.id).toBe(fork.id);
    expect(path.at(-1)?.text).toBe("edited");
    // both branches survive in the tree
    expect(reloaded.messagesFor(bot.threadId).filter((m) => m.parentId === first.parentId)).toHaveLength(2);
  });

  const pathFixture = () => {
    const threadId = "owned-recovery";
    const a = msg("a", "durable root", { parentId: null });
    const b = msg("b", "first recovered message", { parentId: a.id });
    const c = msg("c", "second recovered message", { parentId: b.id });
    const d = msg("d", "new descendant", { parentId: c.id });
    appendMessage(threadId, a);
    return { threadId, a, b, c, d };
  };
  const rawRows = (threadId: string) => {
    const connection = new DatabaseSync(join(DATA_DIR, "messages.db"));
    try { return connection.prepare("SELECT rowid, id, json FROM messages WHERE thread_id = ? ORDER BY rowid").all(threadId); }
    finally { connection.close(); }
  };

  it("atomically recovers parent-first messages and their descendant, then replays without replacing rows", () => {
    const f = pathFixture();
    persistMessagePath(f.threadId, [f.b, f.c], f.d.id, f.d);
    const before = rawRows(f.threadId);
    expect(readThread(f.threadId, legacy(f.threadId))).toEqual({ messages: [f.a, f.b, f.c, f.d], activeLeafId: f.d.id });
    closeMessageDb();
    persistMessagePath(f.threadId, [f.b, f.c], f.d.id, f.d);
    expect(rawRows(f.threadId)).toEqual(before);
    const restored = new Store(selection);
    expect(restored.activePath(f.threadId)).toEqual([f.a, f.b, f.c, f.d]);
    expect(restored.activeLeaf(f.threadId)).toBe(f.d.id);
  });

  it("recovers a selected pending leaf without appending a new message or adopting another branch", () => {
    const f = pathFixture();
    const sibling = msg("sibling", "unrelated durable branch", { parentId: f.a.id });
    appendMessage(f.threadId, sibling);
    persistMessagePath(f.threadId, [f.b, f.c], f.c.id);
    closeMessageDb();
    const restored = new Store(selection);
    expect(restored.activePath(f.threadId)).toEqual([f.a, f.b, f.c]);
    expect(restored.messagesFor(f.threadId)).toEqual([f.a, sibling, f.b, f.c]);
  });

  it("selects an existing durable leaf without rewriting its messages", () => {
    const f = pathFixture();
    appendMessage(f.threadId, f.b);
    const before = rawRows(f.threadId);
    persistMessagePath(f.threadId, [], f.a.id);
    expect(rawRows(f.threadId)).toEqual(before);
    expect(readThread(f.threadId, legacy(f.threadId)).activeLeafId).toBe(f.a.id);
  });

  it.each([
    { name: "second ancestor insert", trigger: "CREATE TRIGGER recovery_fail BEFORE INSERT ON messages WHEN NEW.id = 'c' BEGIN SELECT RAISE(ABORT, 'owned recovery failure'); END" },
    { name: "new descendant insert", trigger: "CREATE TRIGGER recovery_fail BEFORE INSERT ON messages WHEN NEW.id = 'd' BEGIN SELECT RAISE(ABORT, 'owned recovery failure'); END" },
    { name: "existing branch head update", trigger: "CREATE TRIGGER recovery_fail BEFORE UPDATE ON thread_state BEGIN SELECT RAISE(ABORT, 'owned recovery failure'); END" },
  ])("rolls back every inserted ancestor when $name fails, and retries after recovery", ({ trigger }) => {
    const f = pathFixture();
    const before = rawRows(f.threadId);
    const connection = new DatabaseSync(join(DATA_DIR, "messages.db"));
    try {
      connection.exec(trigger);
      expect(() => persistMessagePath(f.threadId, [f.b, f.c], f.d.id, f.d)).toThrow("owned recovery failure");
      expect(rawRows(f.threadId)).toEqual(before);
      expect(readThread(f.threadId, legacy(f.threadId))).toEqual({ messages: [f.a], activeLeafId: f.a.id });
      connection.exec("DROP TRIGGER recovery_fail");
      persistMessagePath(f.threadId, [f.b, f.c], f.d.id, f.d);
    } finally { connection.close(); }
    closeMessageDb();
    expect(readThread(f.threadId, legacy(f.threadId))).toEqual({ messages: [f.a, f.b, f.c, f.d], activeLeafId: f.d.id });
  });

  it("rolls back a new thread's rows when inserting its first branch head fails", () => {
    const f = pathFixture();
    const newThread = "new-owned-recovery";
    const connection = new DatabaseSync(join(DATA_DIR, "messages.db"));
    try {
      connection.exec("CREATE TRIGGER recovery_fail BEFORE INSERT ON thread_state BEGIN SELECT RAISE(ABORT, 'owned leaf insert failure'); END");
      expect(() => persistMessagePath(newThread, [f.a, f.b], f.c.id, f.c)).toThrow("owned leaf insert failure");
      expect(readThread(newThread, legacy(newThread))).toEqual({ messages: [], activeLeafId: null });
      expect(readThread(f.threadId, legacy(f.threadId))).toEqual({ messages: [f.a], activeLeafId: f.a.id });
      connection.exec("DROP TRIGGER recovery_fail");
      persistMessagePath(newThread, [f.a, f.b], f.c.id, f.c);
    } finally { connection.close(); }
    closeMessageDb();
    expect(readThread(newThread, legacy(newThread))).toEqual({ messages: [f.a, f.b, f.c], activeLeafId: f.c.id });
  });

  it.each(["ancestor", "new-message"])("rejects a conflicting durable %s without replacing or partially inserting rows", (conflict) => {
    const f = pathFixture();
    const durable = msg("existing", "durable version", { parentId: f.a.id });
    appendMessage(f.threadId, durable);
    const before = rawRows(f.threadId);
    const changed = { ...durable, text: "conflicting version", parentId: f.b.id };
    expect(() => conflict === "ancestor"
      ? persistMessagePath(f.threadId, [f.b, changed], f.d.id, { ...f.d, parentId: changed.id })
      : persistMessagePath(f.threadId, [f.b], changed.id, changed)).toThrow("conflicts with an existing durable row");
    expect(rawRows(f.threadId)).toEqual(before);
    expect(readThread(f.threadId, legacy(f.threadId)).activeLeafId).toBe(durable.id);
  });

  it("rejects a missing same-thread parent even when its ID exists in another thread", () => {
    const f = pathFixture();
    const foreign = msg("foreign-parent", "different thread", { parentId: null });
    appendMessage("other-thread", foreign);
    const before = rawRows(f.threadId);
    expect(() => persistMessagePath(f.threadId, [], f.b.id, { ...f.b, parentId: foreign.id })).toThrow("parent is missing from this thread");
    expect(rawRows(f.threadId)).toEqual(before);
    expect(readThread("other-thread", legacy("other-thread"))).toEqual({ messages: [foreign], activeLeafId: foreign.id });
  });

  it("rolls back recovered rows when the selected leaf belongs only to another thread", () => {
    const f = pathFixture();
    appendMessage("other-thread", msg("foreign-leaf", "different leaf", { parentId: null }));
    const before = rawRows(f.threadId);
    expect(() => persistMessagePath(f.threadId, [f.b, f.c], "foreign-leaf")).toThrow("leaf is missing from this thread");
    expect(rawRows(f.threadId)).toEqual(before);
    expect(readThread(f.threadId, legacy(f.threadId)).activeLeafId).toBe(f.a.id);
  });

  it("rejects a selected durable row whose immediate parent is absent", () => {
    const f = pathFixture();
    const orphan = msg("orphan", "owned malformed row", { parentId: "missing" });
    insertMessage(f.threadId, orphan);
    const before = rawRows(f.threadId);
    expect(() => persistMessagePath(f.threadId, [f.b], orphan.id)).toThrow("parent is missing from this thread");
    expect(rawRows(f.threadId)).toEqual(before);
    expect(readThread(f.threadId, legacy(f.threadId)).activeLeafId).toBe(f.a.id);
  });

  it.each(["out-of-order", "self-parent", "cycle"])("rejects %s recovery input without any durable change", (invalid) => {
    const f = pathFixture();
    const before = rawRows(f.threadId);
    const ancestors = invalid === "out-of-order" ? [f.c, f.b]
      : invalid === "self-parent" ? [{ ...f.b, parentId: f.b.id }]
        : [{ ...f.b, parentId: f.c.id }, f.c];
    expect(() => persistMessagePath(f.threadId, ancestors, f.d.id, f.d)).toThrow(/parent-first|reference itself/);
    expect(rawRows(f.threadId)).toEqual(before);
    expect(readThread(f.threadId, legacy(f.threadId)).activeLeafId).toBe(f.a.id);
  });

  it("accepts Store's inferred legacy parents without changing legacy JSON or row order", () => {
    const threadId = "legacy-recovery";
    const a = msg("a", "legacy root");
    const b = msg("b", "legacy child");
    insertMessage(threadId, a);
    insertMessage("other-thread", msg("unrelated", "interleaved row"));
    insertMessage(threadId, b);
    const before = rawRows(threadId);
    const c = msg("c", "new descendant", { parentId: b.id });
    persistMessagePath(threadId, [{ ...a, parentId: null }, { ...b, parentId: a.id }], c.id, c);
    expect(rawRows(threadId).slice(0, 2)).toEqual(before);
    closeMessageDb();
    expect(new Store(selection).activePath(threadId)).toEqual([{ ...a, parentId: null }, { ...b, parentId: a.id }, c]);
  });

  it("does not accept an invented parent for an existing legacy row", () => {
    const threadId = "legacy-conflict";
    const a = msg("a", "legacy root");
    const b = msg("b", "legacy child");
    insertMessage(threadId, a);
    insertMessage(threadId, b);
    setActiveLeaf(threadId, b.id);
    const before = rawRows(threadId);
    expect(() => persistMessagePath(threadId, [{ ...b, parentId: null }], b.id)).toThrow("conflicts with an existing durable row");
    expect(rawRows(threadId)).toEqual(before);
    expect(readThread(threadId, legacy(threadId)).activeLeafId).toBe(b.id);
  });

  it("preserves flat legacy-shaped input inference within a newly recovered thread", () => {
    const threadId = "new-legacy-recovery";
    const a = msg("a", "legacy root");
    const b = msg("b", "legacy child");
    persistMessagePath(threadId, [a], b.id, b);
    closeMessageDb();
    expect(new Store(selection).activePath(threadId)).toEqual([{ ...a, parentId: null }, { ...b, parentId: a.id }]);
  });
});
