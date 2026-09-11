import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { closeMessageDb, deleteThread, readThread } from "./message-db.ts";
import { SeedAnswerError, SEED_CARD_PURPOSE, isRecognizedSeedCard } from "./seed-card.ts";
import type { JsonValue } from "./schema.ts";
import { Store, type Message, type OptionCardData, type StoreChange } from "./store.ts";

const selection = () => ({ instanceId: "owned-offline", model: "test-model" });
const legacyFile = (threadId: string) => join(DATA_DIR, `messages-${threadId}.json`);
const rows = (threadId: string) => structuredClone(readThread(threadId, legacyFile(threadId)));
function setup() {
  const store = new Store(selection);
  const bot = store.createBot({ name: "Original name" });
  const threadId = bot.threadId;
  const seed = store.messagesFor(threadId)[1];
  const changes: StoreChange[] = [];
  store.onChange((change) => changes.push(change));
  const answer = (text: JsonValue | undefined = "Writing & research") => store.answerSeedCard(bot.id, threadId, seed.id, text);
  const claim = (attempt = 0) => store.claimSeedAnswerDispatch(bot.id, threadId, seed.id, attempt);
  const status = () => store.seedAnswerStatus(bot.id, threadId, seed.id);
  return { store, bot, threadId, seed, changes, answer, claim, status };
}
function fails(action: () => void, status: number) {
  try { action(); throw new Error("Expected a seed contract rejection"); }
  catch (error) { expect(error).toBeInstanceOf(SeedAnswerError); expect(error).toMatchObject({ status }); }
}
function snapshot(fixture: ReturnType<typeof setup>) {
  return { messages: structuredClone(fixture.store.messagesFor(fixture.threadId)), leaf: fixture.store.activeLeaf(fixture.threadId), disk: rows(fixture.threadId), changes: structuredClone(fixture.changes) };
}

beforeEach(() => { closeMessageDb(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => closeMessageDb());

describe("durable onboarding seed answers", () => {
  it("records exact raw text, linked message and branch before either event is emitted", () => {
    const f = setup();
    const text = "  Keep the café on Friday.\nAsk me before sending.  ";
    let observations = 0;
    f.store.onChange(() => {
      const state = f.status();
      expect(state.userMessage?.text).toBe(text);
      expect(state.cardMessage.card?.seedAnswer?.messageId).toBe(state.userMessage?.id);
      expect(rows(f.threadId).messages).toEqual(f.store.messagesFor(f.threadId));
      expect(rows(f.threadId).activeLeafId).toBe(state.userMessage?.id);
      observations++;
    });
    const result = f.answer(text);
    expect(result.outcome).toBe("recorded");
    expect(result.cardMessage.card).toMatchObject({ purpose: SEED_CARD_PURPOSE, answered: text, seedAnswer: { messageId: result.userMessage.id, attempt: 0, status: "recorded" } });
    expect(result.userMessage).toMatchObject({ role: "user", kind: "text", text, parentId: f.seed.id });
    expect(f.changes.map((change) => change.type)).toEqual(["message.patch", "message"]);
    expect(observations).toBe(2);
  });

  it.each(["Allow", "Deny", "x".repeat(4000)])("records a literal answer without permission semantics (%s)", (text) => {
    const f = setup(); const result = f.answer(text);
    expect(result.userMessage.text).toBe(text);
    expect(result.cardMessage.card?.requestId).toBeUndefined();
    expect(result.cardMessage.card?.seedAnswer?.status).toBe("recorded");
  });

  const invalidAnswers: Array<{ name: string; value: JsonValue | undefined }> = [
    { name: "missing", value: undefined }, { name: "null", value: null }, { name: "boolean", value: false },
    { name: "number", value: 1 }, { name: "array", value: [] }, { name: "object", value: {} },
    { name: "empty", value: "" }, { name: "blank", value: " \n\t " }, { name: "oversized", value: "x".repeat(4001) },
    { name: "raw oversized even though trimming would fit", value: " ".repeat(4000) + "x" },
  ];
  it.each(invalidAnswers)("rejects $name without any state change", ({ value }) => {
    const f = setup(); const before = snapshot(f); fails(() => f.store.answerSeedCard(f.bot.id, f.threadId, f.seed.id, value), 400); expect(snapshot(f)).toEqual(before);
  });

  it("returns the original receipt on repeated exact answers, including when the bot is busy", () => {
    const f = setup(); const first = f.answer(" Allow "); f.store.setActivity(f.bot.id, "working"); f.changes.length = 0;
    const before = snapshot(f); const again = f.answer(" Allow ");
    expect(again).toEqual({ ...first, outcome: "already-recorded" }); expect(snapshot(f)).toEqual(before);
    fails(() => f.answer("Allow"), 409); expect(snapshot(f)).toEqual(before);
  });

  it("survives database reopen without dispatching or adding another user message", () => {
    const f = setup(); const first = f.answer(); closeMessageDb();
    const restored = new Store(selection); const events: StoreChange[] = []; restored.onChange((change) => events.push(change));
    const replay = restored.answerSeedCard(f.bot.id, f.threadId, f.seed.id, first.userMessage.text!);
    expect(replay).toEqual({ ...first, outcome: "already-recorded" });
    expect(restored.messagesFor(f.threadId).filter((message) => message.role === "user")).toEqual([first.userMessage]);
    expect(events).toEqual([]); expect(restored.bot(f.bot.id)?.busy).toBe(false);
  });

  it("reads unanswered and answered state without writes, including after newer user work", () => {
    const f = setup(); const initial = snapshot(f); expect(f.status().userMessage).toBeNull(); expect(snapshot(f)).toEqual(initial);
    const answer = f.answer(); f.store.appendMessage(f.threadId, { role: "user", kind: "text", text: "New task" });
    f.changes.length = 0; const before = snapshot(f);
    expect(f.status().userMessage).toEqual(answer.userMessage); expect(f.answer().outcome).toBe("already-recorded"); expect(snapshot(f)).toEqual(before);
    fails(() => f.claim(), 409); expect(snapshot(f)).toEqual(before);
  });

  it.each(["busy", "later-user", "dismissed", "old-settlement"])("rejects first answer after %s without changes", (reason) => {
    const f = setup();
    if (reason === "busy") f.store.setActivity(f.bot.id, "working");
    if (reason === "later-user") f.store.appendMessage(f.threadId, { role: "user", kind: "text", text: "Other work" });
    if (reason === "dismissed") f.store.patchMessage(f.threadId, f.seed.id, { card: { ...f.seed.card!, dismissed: true } });
    if (reason === "old-settlement") f.store.patchMessage(f.threadId, f.seed.id, { card: { ...f.seed.card!, answered: "Previously chosen" } });
    f.changes.length = 0; const before = snapshot(f); fails(() => f.answer(), 409); expect(snapshot(f)).toEqual(before);
  });

  it("rejects a switched task, another bot, hidden bot and an inactive branch", () => {
    const f = setup(); const other = f.store.createBot();
    fails(() => f.store.answerSeedCard(other.id, f.threadId, f.seed.id, "x"), 404);
    f.store.patchBot(f.bot.id, { hidden: true }); fails(() => f.answer(), 404); f.store.patchBot(f.bot.id, { hidden: false });
    f.store.createTask(f.bot.id); fails(() => f.answer(), 404); f.store.switchTask(f.bot.id, f.threadId);
    const greeting = f.store.messagesFor(f.threadId)[0];
    f.store.appendMessage(f.threadId, { parentId: greeting.id, role: "bot", kind: "activity", tool: { name: "Other branch" } });
    const before = snapshot(f); fails(() => f.answer(), 409); fails(() => f.status(), 409); expect(snapshot(f)).toEqual(before);
  });

  const rejectedCards: Array<{ name: string; patch: Partial<Message>; message: true } | { name: string; patch: Partial<OptionCardData>; message?: false }> = [
    { name: "live question", patch: { requestId: "live-question" } }, { name: "empty request ID", patch: { requestId: "" } },
    { name: "tool", patch: { tool: "Bash" } }, { name: "grant", patch: { allowKey: "Bash:git" } },
    { name: "held approval", patch: { held: "Review" } }, { name: "unknown purpose", patch: { purpose: "future-seed" } },
    { name: "changed title", patch: { title: "Unrecognized question" } }, { name: "changed choices", patch: { options: ["Allow", "Deny"] } },
    { name: "user role", patch: { role: "user" }, message: true }, { name: "text kind", patch: { kind: "text" }, message: true },
    { name: "room attribution", patch: { from: { botId: "other", name: "Other", color: "orange" } }, message: true },
  ];
  it.each(rejectedCards)("does not authorize $name as a seed", ({ patch, message }) => {
    const f = setup();
    if (message) f.store.patchMessage(f.threadId, f.seed.id, patch);
    else f.store.patchMessage(f.threadId, f.seed.id, { card: { ...f.seed.card!, ...patch } });
    f.changes.length = 0; const before = snapshot(f); fails(() => f.answer(), 404); expect(snapshot(f)).toEqual(before);
  });

  it("supports only the canonical legacy second seed, independently of a later bot rename", () => {
    const f = setup(); const card = { ...f.seed.card! }; delete card.purpose;
    f.store.patchMessage(f.threadId, f.seed.id, { card }); f.store.patchBot(f.bot.id, { name: "Renamed bot" });
    const result = f.answer(); expect(result.cardMessage.card?.purpose).toBe(SEED_CARD_PURPOSE);
    const arbitrary = f.store.appendMessage(f.threadId, { role: "bot", kind: "options", card });
    expect(isRecognizedSeedCard(f.store.messagesFor(f.threadId), arbitrary)).toBe(false);
  });

  it("accepts the original legacy flat transcript after synthesized parent links", () => {
    const f = setup(); const old = f.store.messagesFor(f.threadId).map(({ parentId: _parentId, ...message }) => message);
    const card = { ...old[1].card! }; delete card.purpose; old[1] = { ...old[1], card };
    deleteThread(f.threadId); writeFileSync(legacyFile(f.threadId), JSON.stringify(old)); closeMessageDb();
    const restored = new Store(selection); const result = restored.answerSeedCard(f.bot.id, f.threadId, f.seed.id, "Legacy answer");
    expect(result.userMessage.parentId).toBe(f.seed.id); expect(rows(f.threadId).activeLeafId).toBe(result.userMessage.id);
  });

  it.each(["unrecognized greeting", "not-root greeting", "wrong seed parent"])("rejects legacy %s", (reason) => {
    const f = setup(); const card = { ...f.seed.card! }; delete card.purpose; f.store.patchMessage(f.threadId, f.seed.id, { card });
    const greeting = f.store.messagesFor(f.threadId)[0];
    if (reason === "unrecognized greeting") f.store.patchMessage(f.threadId, greeting.id, { text: "Imported arbitrary greeting" });
    if (reason === "not-root greeting") f.store.patchMessage(f.threadId, greeting.id, { parentId: "absent" });
    if (reason === "wrong seed parent") f.store.patchMessage(f.threadId, f.seed.id, { parentId: null });
    fails(() => f.answer(), 404);
  });
});

describe("seed dispatch receipt compare-and-set", () => {
  it("claims once durably before any event and does not re-claim an old transport attempt", () => {
    const f = setup(); const first = f.answer(); f.changes.length = 0;
    f.store.onChange(() => expect(rows(f.threadId).messages.find((message) => message.id === f.seed.id)?.card?.seedAnswer?.status).toBe("starting"));
    const claim = f.claim(); expect(claim.outcome).toBe("claimed"); expect(claim.userMessage).toEqual(first.userMessage);
    expect(claim.cardMessage.card?.seedAnswer).toEqual({ messageId: first.userMessage.id, attempt: 1, status: "starting" });
    const before = snapshot(f); expect(f.claim().outcome).toBe("already-claimed"); expect(snapshot(f)).toEqual(before);
    fails(() => f.claim(1), 409); fails(() => f.claim(2), 409); expect(snapshot(f)).toEqual(before);
  });

  it("retries only an explicitly current not-started attempt and ignores stale completions", () => {
    const f = setup(); f.answer(); f.claim();
    const failed = f.store.finishSeedAnswerDispatch(f.threadId, f.seed.id, 1, "not-started", "Connect an engine");
    expect(failed?.card?.seedAnswer).toMatchObject({ attempt: 1, status: "not-started", error: "Connect an engine" });
    expect(f.claim(0).outcome).toBe("already-claimed");
    const retry = f.claim(1); expect(retry.cardMessage.card?.seedAnswer).toMatchObject({ attempt: 2, status: "starting" });
    expect(retry.cardMessage.card?.seedAnswer?.error).toBeUndefined();
    const before = snapshot(f); expect(f.store.finishSeedAnswerDispatch(f.threadId, f.seed.id, 1, "started")).toBeNull(); expect(snapshot(f)).toEqual(before);
    expect(f.store.finishSeedAnswerDispatch(f.threadId, f.seed.id, 2, "started")?.card?.seedAnswer?.status).toBe("started");
    fails(() => f.claim(2), 409); expect(f.claim(1).outcome).toBe("already-claimed");
  });

  it.each(["busy", "newer-work"])("keeps a recorded answer but refuses dispatch during %s", (reason) => {
    const f = setup(); f.answer();
    if (reason === "busy") f.store.setActivity(f.bot.id, "working");
    else f.store.appendMessage(f.threadId, { role: "user", kind: "text", text: "Another task" });
    f.changes.length = 0; const before = snapshot(f); fails(() => f.claim(), 409); expect(snapshot(f)).toEqual(before);
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])("rejects invalid expected attempt %s", (attempt) => {
    const f = setup(); f.answer(); const before = snapshot(f); fails(() => f.claim(attempt), 400); expect(snapshot(f)).toEqual(before);
  });

  it("finishes the captured original thread after task switch without recreating a deleted task", () => {
    const f = setup(); f.answer(); f.claim(); f.store.createTask(f.bot.id);
    expect(f.store.finishSeedAnswerDispatch(f.threadId, f.seed.id, 1, "started")?.card?.seedAnswer?.status).toBe("started");
    f.store.deleteTask(f.bot.id, f.threadId); f.changes.length = 0;
    expect(f.store.finishSeedAnswerDispatch(f.threadId, f.seed.id, 1, "uncertain")).toBeNull();
    expect(rows(f.threadId).messages).toEqual([]); expect(f.changes).toEqual([]);
  });

  it("reconciles interrupted starting to uncertain on restart without replaying or changing attempts", () => {
    const f = setup(); const answer = f.answer(); f.claim(); closeMessageDb();
    const restored = new Store(selection); const state = restored.seedAnswerStatus(f.bot.id, f.threadId, f.seed.id);
    expect(state.cardMessage.card?.seedAnswer).toMatchObject({ messageId: answer.userMessage.id, attempt: 1, status: "uncertain" });
    expect(state.userMessage).toEqual(answer.userMessage); expect(restored.bot(f.bot.id)?.busy).toBe(false);
    expect(restored.claimSeedAnswerDispatch(f.bot.id, f.threadId, f.seed.id, 0).outcome).toBe("already-claimed");
    fails(() => restored.claimSeedAnswerDispatch(f.bot.id, f.threadId, f.seed.id, 1), 409);
    const before = rows(f.threadId); closeMessageDb(); new Store(selection); expect(rows(f.threadId)).toEqual(before);
  });

  it.each(["recorded", "started", "not-started", "uncertain"] as const)("preserves %s on restart without inventing a dispatch", (status) => {
    const f = setup(); f.answer();
    if (status !== "recorded") { f.claim(); f.store.finishSeedAnswerDispatch(f.threadId, f.seed.id, 1, status); }
    const before = rows(f.threadId); closeMessageDb(); new Store(selection); expect(rows(f.threadId)).toEqual(before);
  });
});

describe("real SQLite transaction failures", () => {
  const failures = [
    { name: "card update", sql: "CREATE TRIGGER seed_fail BEFORE UPDATE ON messages BEGIN SELECT RAISE(ABORT, 'owned card update failure'); END" },
    { name: "user insert", sql: "CREATE TRIGGER seed_fail BEFORE INSERT ON messages WHEN NEW.role = 'user' BEGIN SELECT RAISE(ABORT, 'owned user insert failure'); END" },
    { name: "branch head update", sql: "CREATE TRIGGER seed_fail BEFORE UPDATE ON thread_state BEGIN SELECT RAISE(ABORT, 'owned branch update failure'); END" },
    { name: "deferred commit", sql: "CREATE TABLE seed_parent (id INTEGER PRIMARY KEY); CREATE TABLE seed_child (id INTEGER REFERENCES seed_parent(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER seed_fail AFTER UPDATE ON messages BEGIN INSERT INTO seed_child VALUES(1); END" },
  ];
  it.each(failures)("rolls back $name with no memory, transcript, branch or SSE mutation", ({ sql }) => {
    const f = setup(); const before = snapshot(f); const connection = new DatabaseSync(join(DATA_DIR, "messages.db"));
    try {
      connection.exec(sql); expect(() => f.answer()).toThrow(); expect(snapshot(f)).toEqual(before);
      connection.exec("DROP TRIGGER seed_fail");
      expect(f.answer().outcome).toBe("recorded");
    } finally { connection.close(); }
    closeMessageDb(); const restored = new Store(selection);
    expect(restored.messagesFor(f.threadId).filter((message) => message.role === "user")).toHaveLength(1);
  });

  it("does not publish failed claim or completion writes, and a later retry uses the same receipt", () => {
    const f = setup(); f.answer(); f.changes.length = 0; const connection = new DatabaseSync(join(DATA_DIR, "messages.db"));
    try {
      connection.exec("CREATE TRIGGER seed_fail BEFORE UPDATE ON messages BEGIN SELECT RAISE(ABORT, 'owned receipt failure'); END");
      const beforeClaim = snapshot(f); expect(() => f.claim()).toThrow(); expect(snapshot(f)).toEqual(beforeClaim);
      connection.exec("DROP TRIGGER seed_fail"); f.claim(); f.changes.length = 0;
      connection.exec("CREATE TRIGGER seed_fail BEFORE UPDATE ON messages BEGIN SELECT RAISE(ABORT, 'owned receipt failure'); END");
      const beforeFinish = snapshot(f); expect(() => f.store.finishSeedAnswerDispatch(f.threadId, f.seed.id, 1, "started")).toThrow(); expect(snapshot(f)).toEqual(beforeFinish);
      connection.exec("DROP TRIGGER seed_fail"); expect(f.store.finishSeedAnswerDispatch(f.threadId, f.seed.id, 1, "started")).not.toBeNull();
    } finally { connection.close(); }
  });

  it("rejects stale in-memory card and branch snapshots before any write", () => {
    const f = setup(); const connection = new DatabaseSync(join(DATA_DIR, "messages.db"));
    try {
      connection.prepare("UPDATE messages SET json = json_set(json, '$.card.dismissed', json('true')) WHERE id = ?").run(f.seed.id);
      const before = snapshot(f); fails(() => f.answer(), 409); expect(snapshot(f)).toEqual(before);
      connection.prepare("UPDATE messages SET json = ? WHERE id = ?").run(JSON.stringify(f.seed), f.seed.id);
      connection.prepare("UPDATE thread_state SET active_leaf_id = ? WHERE thread_id = ?").run("changed-branch", f.threadId);
      const branchBefore = snapshot(f); fails(() => f.answer(), 409); expect(snapshot(f)).toEqual(branchBefore);
    } finally { connection.close(); }
  });

  it("startup receipt failure leaves the original starting record intact for a later restart", () => {
    const f = setup(); f.answer(); f.claim(); const before = rows(f.threadId); const botBytes = readFileSync(join(DATA_DIR, "bots.json"), "utf8");
    const connection = new DatabaseSync(join(DATA_DIR, "messages.db"));
    try {
      connection.exec("CREATE TRIGGER seed_fail BEFORE UPDATE ON messages BEGIN SELECT RAISE(ABORT, 'owned startup receipt failure'); END");
      expect(() => new Store(selection)).toThrow(); expect(rows(f.threadId)).toEqual(before); expect(readFileSync(join(DATA_DIR, "bots.json"), "utf8")).toBe(botBytes);
      connection.exec("DROP TRIGGER seed_fail");
    } finally { connection.close(); }
    expect(new Store(selection).seedAnswerStatus(f.bot.id, f.threadId, f.seed.id).cardMessage.card?.seedAnswer?.status).toBe("uncertain");
  });
});
