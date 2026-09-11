import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { APPROVAL_ACTION_VERSION, prepareApprovalGrant, type ApprovalGrantInput } from "./approval-action-contract.ts";
import { DATA_DIR } from "./config.ts";
import { closeMessageDb } from "./message-db.ts";
import { Store, type OptionCardData, type StoreChange } from "./store.ts";

const body = { allowKey: "Bash:git", expectedThreadId: "thread-one", requestId: "ask-one", cardId: "card-one" };
const bot = { threadId: "thread-one", alwaysAllow: ["Read"] };
const permission = {
  id: "card-one", role: "bot", kind: "options",
  card: { requestId: "ask-one", allowKey: "Bash:git", tool: "Bash" },
};

describe("bound approval grant contract", () => {
  it("reports version one and returns exact grant identity without answering the request", () => {
    expect(APPROVAL_ACTION_VERSION).toBe(1);
    expect(prepareApprovalGrant(body, bot, [permission], [permission])).toEqual({
      alwaysAllow: ["Read", "Bash:git"],
      grant: { threadId: "thread-one", requestId: "ask-one", cardId: "card-one", allowKey: "Bash:git" },
    });
    expect(permission.card).not.toHaveProperty("answered");
    expect(bot.alwaysAllow).toEqual(["Read"]);
  });

  it("keeps the legacy response without a grant tuple", () => {
    expect(prepareApprovalGrant({ allowKey: "Bash:git" }, bot, [permission], [])).toEqual({ alwaysAllow: ["Read", "Bash:git"] });
  });

  it.each([null, undefined, true, 1, "", [], {}])("rejects malformed grant key %j", (allowKey) => {
    expect(() => prepareApprovalGrant({ ...body, allowKey }, bot, [permission], [permission]))
      .toThrow(expect.objectContaining({ status: 400 }));
  });

  for (const field of ["expectedThreadId", "cardId"] as const) {
    it.each([null, undefined, true, 1, "", " ", "a/b", "café", "a".repeat(129), [], {}])(
      `rejects malformed ${field} %j instead of falling back to legacy`, (value) => {
        expect(() => prepareApprovalGrant({ ...body, [field]: value }, bot, [permission], [permission]))
          .toThrow(expect.objectContaining({ status: 400 }));
      },
    );
  }

  it.each([null, undefined, true, 1, "", " \n\ufeff", "a".repeat(4097), [], {}])(
    "rejects malformed opaque request ID %j", (requestId) => {
      expect(() => prepareApprovalGrant({ ...body, requestId }, bot, [permission], [permission]))
        .toThrow(expect.objectContaining({ status: 400 }));
    },
  );

  it.each(["provider/ask:工具", " café ", "e\u0301", "a".repeat(129), "😀".repeat(2048)])(
    "preserves a provider's exact opaque request ID", (requestId) => {
      const candidate = { ...permission, card: { ...permission.card, requestId } };
      expect(prepareApprovalGrant({ ...body, requestId }, bot, [candidate], [candidate]).grant?.requestId).toBe(requestId);
    },
  );

  it("does not trim or Unicode-normalize request IDs when matching", () => {
    for (const [requestId, received] of [[" café ", "café"], ["é", "e\u0301"]]) {
      const candidate = { ...permission, card: { ...permission.card, requestId } };
      expect(() => prepareApprovalGrant({ ...body, requestId: received }, bot, [candidate], [candidate]))
        .toThrow(expect.objectContaining({ status: 409 }));
    }
  });

  it.each<ApprovalGrantInput>([
    { expectedThreadId: "thread-one" }, { requestId: "ask-one" }, { cardId: "card-one" },
    { expectedThreadId: "thread-one", requestId: "ask-one" },
    { expectedThreadId: "thread-one", cardId: "card-one" },
    { requestId: "ask-one", cardId: "card-one" },
  ])("rejects partial tuple %j", (tuple) => {
    expect(() => prepareApprovalGrant({ allowKey: "Bash:git", ...tuple }, bot, [permission], [permission]))
      .toThrow(expect.objectContaining({ status: 400 }));
  });

  it.each([
    { expectedThreadId: "thread-other" }, { requestId: "ask-other" }, { cardId: "card-other" },
    { allowKey: "Bash:npm" }, { requestId: "ASK-ONE" },
  ])("rejects a stale or mismatched approval %j", (changed) => {
    expect(() => prepareApprovalGrant({ ...body, ...changed }, bot, [permission], [permission]))
      .toThrow(expect.objectContaining({ status: 409 }));
  });

  it.each([
    { answered: "allow" }, { answered: "deny" }, { answered: "unavailable" }, { dismissed: true },
    { requestId: undefined }, { tool: undefined }, { tool: "" }, { tool: " \n" },
  ])("refuses settled or nonpermission metadata %j for both client versions", (changed) => {
    const card = { ...permission, card: { ...permission.card, ...changed } };
    for (const input of [body, { allowKey: "Bash:git" }]) {
      expect(() => prepareApprovalGrant(input, bot, [card], [card])).toThrow(expect.objectContaining({ status: 409 }));
    }
  });

  it("refuses a hidden card even when another active request has the same key", () => {
    const replacement = { ...permission, id: "new-card", card: { ...permission.card, requestId: "new-ask" } };
    expect(() => prepareApprovalGrant(body, bot, [permission, replacement], [replacement]))
      .toThrow(expect.objectContaining({ status: 409 }));
  });

  it("keeps exact deduplicated existing keys and permits an existing key at capacity", () => {
    const keys = Array.from({ length: 199 }, (_, i) => `tool-${i}`);
    const full = { ...bot, alwaysAllow: [...keys, "Bash:git", "Bash:git"] };
    const prepared = prepareApprovalGrant(body, full, [permission], [permission]);
    expect(prepared.alwaysAllow).toEqual([...keys, "Bash:git"]);
    expect(full.alwaysAllow).toHaveLength(201);
  });

  it("rejects a new key at capacity for strict and legacy clients without truncation", () => {
    const full = { ...bot, alwaysAllow: Array.from({ length: 200 }, (_, i) => `tool-${i}`) };
    for (const input of [body, { allowKey: "Bash:git" }]) {
      expect(() => prepareApprovalGrant(input, full, [permission], [permission]))
        .toThrow(expect.objectContaining({ status: 409 }));
    }
    expect(full.alwaysAllow).toHaveLength(200);
  });
});

describe("approval grants with actual Store state", () => {
  beforeEach(() => { closeMessageDb(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });
  afterEach(() => closeMessageDb());

  function setup() {
    const store = new Store(() => ({ instanceId: "owned-offline", model: "test-model" }));
    const owner = store.createBot({ name: "Owned approval" });
    const card: OptionCardData = { title: "Approval needed", subtitle: "git status", options: ["Allow", "Deny"], tool: "Bash", requestId: "owned-ask", allowKey: "Bash:git" };
    const message = store.appendMessage(owner.threadId, { role: "bot", kind: "options", card });
    const input = { expectedThreadId: owner.threadId, requestId: card.requestId, cardId: message.id, allowKey: card.allowKey };
    const events: StoreChange[] = [];
    store.onChange((event) => events.push(event));
    const apply = () => {
      const prepared = prepareApprovalGrant(input, owner, store.messagesFor(owner.threadId), store.activePath(owner.threadId));
      const updated = store.patchBot(owner.id, { alwaysAllow: prepared.alwaysAllow });
      return { updated, grant: prepared.grant };
    };
    const snapshot = () => ({ disk: readFileSync(join(DATA_DIR, "bots.json"), "utf8"), messages: structuredClone(store.messagesFor(input.expectedThreadId)), events: structuredClone(events) });
    return { store, owner, message, card, input, events, apply, snapshot };
  }

  it("saves one key and receipt, survives reopen, and does not settle the card", () => {
    const f = setup(); const result = f.apply(); f.apply();
    expect(result.grant).toEqual({ threadId: f.input.expectedThreadId, requestId: "owned-ask", cardId: f.message.id, allowKey: "Bash:git" });
    expect(result.updated?.alwaysAllow).toEqual(["Bash:git"]);
    const reloaded = new Store(() => ({ instanceId: "owned-offline", model: "test-model" }));
    expect(reloaded.bot(f.owner.id)?.alwaysAllow).toEqual(["Bash:git"]);
    expect(reloaded.messagesFor(f.input.expectedThreadId).find((m) => m.id === f.message.id)?.card?.answered).toBeUndefined();
  });

  it("rejects an old task after actual task rotation without disk or event changes", () => {
    const f = setup(); f.store.createTask(f.owner.id, "Another task");
    const before = f.snapshot();
    expect(() => f.apply()).toThrow(expect.objectContaining({ status: 409 }));
    expect(f.snapshot()).toEqual(before);
  });

  it("rejects the old card on a sibling branch even with the same grant key", () => {
    const f = setup();
    const parent = f.message.parentId;
    if (!parent) throw new Error("Expected a seeded parent");
    f.store.appendMessage(f.owner.threadId, { role: "bot", kind: "options", parentId: parent, card: { ...f.card, requestId: "replacement" } });
    const before = f.snapshot();
    expect(f.store.messagesFor(f.owner.threadId).some((m) => m.id === f.message.id)).toBe(true);
    expect(f.store.activePath(f.owner.threadId).some((m) => m.id === f.message.id)).toBe(false);
    expect(() => f.apply()).toThrow(expect.objectContaining({ status: 409 }));
    expect(f.snapshot()).toEqual(before);
  });

  it("rejects a request settled before the save without patching anything", () => {
    const f = setup();
    f.store.patchMessage(f.owner.threadId, f.message.id, { card: { ...f.card, answered: "deny" } });
    const before = f.snapshot();
    expect(() => f.apply()).toThrow(expect.objectContaining({ status: 409 }));
    expect(f.snapshot()).toEqual(before);
  });

  it("rejects capacity before a Store write and permits recovery after removing a grant", () => {
    const f = setup(); const keys = Array.from({ length: 200 }, (_, i) => `owned-${i}`);
    f.store.patchBot(f.owner.id, { alwaysAllow: keys }); const before = f.snapshot();
    expect(() => f.apply()).toThrow(expect.objectContaining({ status: 409 }));
    expect(f.snapshot()).toEqual(before);
    f.store.patchBot(f.owner.id, { alwaysAllow: keys.slice(1) });
    expect(f.apply().updated?.alwaysAllow).toEqual([...keys.slice(1), "Bash:git"]);
  });
});
