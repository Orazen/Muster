import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { closeMessageDb } from "./message-db.ts";
import { SeedAnswerDispatcher, seedAnswerInputSchema, seedStartInputSchema, seedStatusInputSchema, type SeedDispatchStore, type SeedTurnOptions, type SeedTurnStart } from "./seed-answer-dispatch.ts";
import { Store } from "./store.ts";

const selection = () => ({ instanceId: "offline-test", model: "offline" });
function fixture(startTurn: SeedTurnStart) {
  const store = new Store(selection);
  const bot = store.createBot();
  const card = store.messagesFor(bot.threadId)[1];
  const dispatcher = new SeedAnswerDispatcher(store, startTurn);
  const read = () => store.seedAnswerStatus(bot.id, bot.threadId, card.id);
  return { store, bot, card, dispatcher, read };
}

describe("saved welcome task dispatch", () => {
  beforeEach(() => { rmSync(DATA_DIR, { recursive: true, force: true }); });

  it("commits the exact answer and startup claim before invoking the driver", () => {
    let calls = 0;
    const text = "  My first task\nwith spacing  ";
    const f = fixture(async (botId, answer, options) => {
      calls++;
      expect(botId).toBe(f.bot.id);
      expect(answer).toBe(text);
      expect(options.threadId).toBe(f.bot.threadId);
      expect(f.read().userMessage).toEqual(options.userMessage);
      expect(f.read().cardMessage.card?.seedAnswer).toMatchObject({ messageId: options.userMessage.id, attempt: 1, status: "starting" });
      options.onDispatched();
    });
    const result = f.dispatcher.answer(f.bot.id, f.bot.threadId, f.card.id, text);
    expect(result.cardMessage.card?.seedAnswer?.status).toBe("started");
    expect(calls).toBe(1);
    expect(f.store.messagesFor(f.bot.threadId).filter(message => message.role === "user")).toHaveLength(1);
  });

  it("never dispatches a repeated answer or an old startup request", () => {
    let calls = 0;
    const f = fixture(async () => { calls++; });
    const first = f.dispatcher.answer(f.bot.id, f.bot.threadId, f.card.id, "Work");
    const replay = f.dispatcher.answer(f.bot.id, f.bot.threadId, f.card.id, "Work");
    expect(replay.outcome).toBe("already-recorded");
    expect(replay.userMessage.id).toBe(first.userMessage.id);
    expect(f.dispatcher.start(f.bot.id, f.bot.threadId, f.card.id, 0).outcome).toBe("already-requested");
    expect(() => f.dispatcher.start(f.bot.id, f.bot.threadId, f.card.id, 1)).toThrow();
    expect(calls).toBe(1);
  });

  it("keeps a definite setup failure saved until an explicit versioned retry", async () => {
    let calls = 0;
    const f = fixture(async (_botId, _text, options) => {
      calls++;
      if (calls === 1) throw new Error("Connect an engine first");
      options.onDispatched();
    });
    const first = f.dispatcher.answer(f.bot.id, f.bot.threadId, f.card.id, "Work");
    await Promise.resolve();
    expect(f.read().cardMessage.card?.seedAnswer).toMatchObject({ attempt: 1, status: "not-started", error: "Connect an engine first" });
    f.dispatcher.answer(f.bot.id, f.bot.threadId, f.card.id, "Work");
    expect(calls).toBe(1);
    const retry = f.dispatcher.start(f.bot.id, f.bot.threadId, f.card.id, 1);
    expect(retry.userMessage.id).toBe(first.userMessage.id);
    expect(f.read().cardMessage.card?.seedAnswer).toMatchObject({ attempt: 2, status: "started" });
    expect(f.dispatcher.start(f.bot.id, f.bot.threadId, f.card.id, 1).outcome).toBe("already-requested");
    expect(calls).toBe(2);
  });

  it("allows explicit startup when recording succeeded but the initial claim never happened", () => {
    let calls = 0;
    const f = fixture(async (_botId, _text, options) => { calls++; options.onDispatched(); });
    const recorded = f.store.answerSeedCard(f.bot.id, f.bot.threadId, f.card.id, "Work");
    expect(f.dispatcher.answer(f.bot.id, f.bot.threadId, f.card.id, "Work").outcome).toBe("already-recorded");
    expect(calls).toBe(0);
    expect(f.dispatcher.start(f.bot.id, f.bot.threadId, f.card.id, 0).userMessage.id).toBe(recorded.userMessage.id);
    expect(calls).toBe(1);
  });

  it("does not retry an uncertain provider invocation", () => {
    let calls = 0;
    const f = fixture(async (_botId, _text, options) => { calls++; options.onDispatchError("The provider disconnected", true); });
    f.dispatcher.answer(f.bot.id, f.bot.threadId, f.card.id, "Work");
    expect(f.read().cardMessage.card?.seedAnswer?.status).toBe("uncertain");
    f.dispatcher.answer(f.bot.id, f.bot.threadId, f.card.id, "Work");
    expect(() => f.dispatcher.start(f.bot.id, f.bot.threadId, f.card.id, 1)).toThrow();
    expect(calls).toBe(1);
  });

  it("fences late startup callbacks from an earlier failed attempt", () => {
    const attempts: SeedTurnOptions[] = [];
    const f = fixture(async (_botId, _text, options) => { attempts.push(options); });
    f.dispatcher.answer(f.bot.id, f.bot.threadId, f.card.id, "Work");
    attempts[0].onDispatchError("Setup unavailable", false);
    f.dispatcher.start(f.bot.id, f.bot.threadId, f.card.id, 1);
    attempts[0].onDispatched();
    expect(f.read().cardMessage.card?.seedAnswer).toMatchObject({ attempt: 2, status: "starting" });
    attempts[1].onDispatched();
    attempts[1].onDispatchError("A late failure", true);
    expect(f.read().cardMessage.card?.seedAnswer).toMatchObject({ attempt: 2, status: "started" });
  });

  it("keeps the durable starting marker if saving provider acceptance fails", async () => {
    const f = fixture(async () => {});
    const errors: Error[] = [];
    let accepted = false;
    const faultStore: SeedDispatchStore = {
      answerSeedCard: f.store.answerSeedCard.bind(f.store),
      claimSeedAnswerDispatch: f.store.claimSeedAnswerDispatch.bind(f.store),
      seedAnswerStatus: f.store.seedAnswerStatus.bind(f.store),
      messagesFor: f.store.messagesFor.bind(f.store),
      finishSeedAnswerDispatch: () => { throw new Error("Disk unavailable"); },
    };
    const dispatcher = new SeedAnswerDispatcher(faultStore, async (_botId, _text, options) => {
      options.onDispatched();
      accepted = true;
    }, error => errors.push(error));
    dispatcher.answer(f.bot.id, f.bot.threadId, f.card.id, "Work");
    await Promise.resolve();
    expect(accepted).toBe(true);
    expect(errors.map(error => error.message)).toEqual(["Disk unavailable"]);
    expect(f.read().cardMessage.card?.seedAnswer?.status).toBe("starting");
    expect(() => dispatcher.start(f.bot.id, f.bot.threadId, f.card.id, 1)).toThrow();
  });

  it("does not replay a pending provider invocation after reopening the database", () => {
    let calls = 0;
    const f = fixture(async () => { calls++; });
    f.dispatcher.answer(f.bot.id, f.bot.threadId, f.card.id, "Work");
    closeMessageDb();
    const reloaded = new Store(selection);
    const dispatcher = new SeedAnswerDispatcher(reloaded, async () => { calls++; });
    expect(reloaded.seedAnswerStatus(f.bot.id, f.bot.threadId, f.card.id).cardMessage.card?.seedAnswer?.status).toBe("uncertain");
    dispatcher.answer(f.bot.id, f.bot.threadId, f.card.id, "Work");
    expect(() => dispatcher.start(f.bot.id, f.bot.threadId, f.card.id, 1)).toThrow();
    expect(calls).toBe(1);
  });
});

describe("welcome task request boundaries", () => {
  it.each(["", " \n\t ", "x".repeat(4001)])("rejects blank or oversized text %#", answer => {
    expect(seedAnswerInputSchema.safeParse({ threadId: "task-1", answer }).success).toBe(false);
  });
  it("preserves valid exact text and rejects extra fields", () => {
    expect(seedAnswerInputSchema.parse({ threadId: "task-1", answer: " Work\n " }).answer).toBe(" Work\n ");
    expect(seedAnswerInputSchema.safeParse({ threadId: "task-1", answer: "Work", autoRetry: true }).success).toBe(false);
    expect(seedStatusInputSchema.safeParse({ threadId: "task-1", answer: "Work" }).success).toBe(false);
  });
  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER, Infinity])("rejects an invalid startup version %#", expectedAttempt => {
    expect(seedStartInputSchema.safeParse({ threadId: "task-1", expectedAttempt }).success).toBe(false);
  });
});
