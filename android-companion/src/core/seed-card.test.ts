import { decodeMessage, decodeFleet, decodeFrame } from "./frames";
import { jsonSchema, threadPageSchema, type JsonValue } from "./contracts";
import { applyFrame, hydrate, initialState, type CompanionState } from "./store";
import { isRecognizedSeedCard, matchesSeedCardResult, mergeSeedCardResult, SEED_CARD_OPTIONS, SEED_CARD_PURPOSE,
  SEED_CARD_SUBTITLE, SEED_CARD_TITLE, seedAnswerTextSchema, seedCardOnActiveBranch, seedCardResultSchema,
  seedCardSignature, seedCardWriteBlocker } from "./seed-card";
import type { Message, SeedAnswerReceipt, SeedCardResult } from "./types";

function seed(): Message {
  return { id: "seed", role: "bot", kind: "options", parentId: "greeting", at: 2, from: null,
    card: { title: SEED_CARD_TITLE, subtitle: SEED_CARD_SUBTITLE, options: [...SEED_CARD_OPTIONS], purpose: SEED_CARD_PURPOSE } };
}
function greeting(): Message { return { id: "greeting", role: "bot", kind: "text", at: 1, text: "Hey — I'm Orbit. Nice to meet you.", parentId: null, from: null }; }
function receipt(status: SeedAnswerReceipt["status"] = "starting", attempt = 1): SeedCardResult {
  const cardMessage = seed();
  cardMessage.card = { ...cardMessage.card!, answered: "  Task\nplease  ", seedAnswer: { messageId: "answer", status, attempt } };
  return { ok: true, outcome: "starting", cardMessage,
    userMessage: { id: "answer", role: "user", kind: "text", at: 3, text: "  Task\nplease  ", parentId: "seed" } };
}
function state(messages: Message[] = [greeting(), seed()], leaf = "seed"): CompanionState {
  return hydrate(initialState(), { bots: [{ id: "bot", threadId: "thread", name: "Orbit", messages, activeLeafId: leaf }], groups: [] });
}
function decode(raw: JsonValue): Message {
  const message = decodeMessage(jsonSchema.parse(raw));
  if (!message) throw new Error("Invalid test message");
  return message;
}

describe("welcome card provenance", () => {
  test("recognizes canonical marked cards with native normalized from:null", () => {
    const marked = decode(jsonSchema.parse(seed()));
    expect(marked.from).toBeNull();
    expect(isRecognizedSeedCard([marked], marked)).toBe(true);
    expect(seedCardOnActiveBranch(state(), "bot", "thread", "seed")?.id).toBe("seed");
  });
  test("legacy needs the loaded original root greeting and exact second card", () => {
    const legacy = seed(); delete legacy.card!.purpose;
    expect(isRecognizedSeedCard([greeting(), legacy], legacy)).toBe(true);
    expect(isRecognizedSeedCard([legacy], legacy)).toBe(false);
    expect(isRecognizedSeedCard([greeting(), { ...greeting(), id: "other" }, legacy], legacy)).toBe(false);
    expect(isRecognizedSeedCard([{ ...greeting(), parentId: "missing" }, legacy], legacy)).toBe(false);
    expect(isRecognizedSeedCard([{ ...greeting(), text: "Hello!" }, legacy], legacy)).toBe(false);
  });
  test.each([
    { purpose: null }, { purpose: 4 }, { purpose: "onboarding-v2" }, { seedAnswer: null }, { seedAnswer: {} },
    { seedAnswer: { messageId: "answer", attempt: 0, status: "started" } },
    { seedAnswer: { messageId: "answer", attempt: 1, status: "future" } },
    { seedAnswer: { messageId: "answer", attempt: 1.2, status: "starting" } },
    { seedAnswer: { messageId: "answer", attempt: 1, status: "starting", unknown: true } },
    { requestId: null }, { requestId: 5 }, { requestId: "" }, { tool: false }, { tool: "" },
    { held: {} }, { held: "" }, { allowKey: null }, { allowKey: "" },
    { answered: false }, { answered: "old answer" }, { dismissed: "false" }, { dismissed: true },
    { options: [...SEED_CARD_OPTIONS, 42] }, { options: [...SEED_CARD_OPTIONS].reverse() },
  ])("never launders malformed or non-seed card metadata into a new answer %#", (patch) => {
    const original = seed();
    const message = decode(jsonSchema.parse({ ...original, card: { ...original.card, ...patch } }));
    expect(isRecognizedSeedCard([greeting(), message], message)).toBe(false);
  });
  test.each([{ from: 5 }, { from: { botId: 7 } }, { from: {} }, { from: { botId: "worker" } }, { parentId: 4 }, { role: null }, { role: "future" }])("rejects damaged message context %#", (patch) => {
    const message = decode(jsonSchema.parse({ ...seed(), ...patch }));
    expect(isRecognizedSeedCard([greeting(), message], message)).toBe(false);
  });
  test.each([{ from: 5 }, { from: { botId: 7 } }, { parentId: 4 }, { role: null }])("does not infer original greeting from lossy context %#", (patch) => {
    const legacy = seed(); delete legacy.card!.purpose;
    const first = decode(jsonSchema.parse({ ...greeting(), ...patch }));
    expect(isRecognizedSeedCard([first, legacy], legacy)).toBe(false);
  });
  test("roster, pagination and SSE retain the same typed receipt and invalid marker", () => {
    const good = receipt().cardMessage;
    const bad = { ...seed(), id: "bad", card: { ...seed().card, seedAnswer: "damaged" } };
    const messages = jsonSchema.parse([good, bad]);
    const fleet = decodeFleet({ bots: [{ id: "bot", threadId: "thread", messages }] });
    const page = threadPageSchema.parse({ messages });
    expect(fleet.bots[0].messages).toEqual(page.messages);
    expect(page.messages[0].card?.seedAnswer).toEqual(good.card?.seedAnswer);
    expect(page.messages[1].card?.seedInvalid).toBe(true);
    expect(decodeFrame(JSON.stringify({ kind: "message.patch", threadId: "thread", message: bad }))).toMatchObject({ message: page.messages[1] });
  });
  test("keeps valid live request decisions separate", () => {
    const message = decode(jsonSchema.parse({ ...seed(), card: { title: "Run?", options: ["Allow", "Deny"], requestId: "request", tool: "Bash", allowKey: "Bash:pwd" } }));
    expect(message.card).toMatchObject({ requestId: "request", tool: "Bash", allowKey: "Bash:pwd" });
    expect(message.card?.seedInvalid).not.toBe(true);
    expect(isRecognizedSeedCard([message], message)).toBe(false);
  });
  test("requires current nonhidden bot and actual active branch; rooms stay inert", () => {
    const s = state();
    expect(seedCardOnActiveBranch(s, "room", "thread", "seed")).toBeNull();
    expect(seedCardOnActiveBranch(s, "bot", "old-thread", "seed")).toBeNull();
    expect(seedCardOnActiveBranch({ ...s, bots: { bot: { ...s.bots.bot, hidden: true } } }, "bot", "thread", "seed")).toBeNull();
    expect(seedCardOnActiveBranch({ ...s, leaves: { thread: "missing" } }, "bot", "thread", "seed")).toBeNull();
    expect(seedCardOnActiveBranch(state([greeting(), seed(), { ...greeting(), id: "sibling" }], "sibling"), "bot", "thread", "seed")).toBeNull();
  });
  test("later user work and busy state prevent writes but preserve status reads", () => {
    const saved = receipt("not-started");
    const messages = [greeting(), saved.cardMessage, saved.userMessage!, { id: "later", role: "user", kind: "text", at: 4, text: "New work", parentId: "answer" } satisfies Message];
    const s = state(messages, "later");
    expect(seedCardOnActiveBranch(s, "bot", "thread", "seed")).not.toBeNull();
    expect(seedCardWriteBlocker(s, "bot", "thread", "seed")).toContain("newer work");
    expect(seedCardWriteBlocker(state(messages.slice(0, 3), "answer"), "bot", "thread", "seed")).toBeNull();
    const busy = state(); busy.bots.bot.busy = true;
    expect(seedCardWriteBlocker(busy, "bot", "thread", "seed")).toContain("working");
    expect(seedCardOnActiveBranch(busy, "bot", "thread", "seed")).not.toBeNull();
  });
  test("receipt linkage must identify the exact saved user before another start", () => {
    const saved = receipt("not-started");
    const wrongRole = state([greeting(), saved.cardMessage, { ...saved.userMessage!, role: "bot" }], "answer");
    expect(seedCardWriteBlocker(wrongRole, "bot", "thread", "seed")).toContain("could not be confirmed");
    const wrongText = state([greeting(), saved.cardMessage, { ...saved.userMessage!, text: "Different" }], "answer");
    expect(seedCardWriteBlocker(wrongText, "bot", "thread", "seed")).toContain("could not be confirmed");
  });
});

describe("strict saved-answer receipts", () => {
  test.each(["recorded", "starting", "started", "not-started", "uncertain"] as const)("accepts actual %s receipt and preserves exact answer", (status) => {
    const result = receipt(status, status === "recorded" ? 0 : 1);
    expect(seedCardResultSchema.parse(result)).toEqual(result);
    expect(matchesSeedCardResult(seed(), result)).toBe(true);
    expect(seedCardSignature(result.cardMessage)).toBe(seedCardSignature(seed()));
  });
  test("accepts status-only unanswered record without inventing a user", () => {
    expect(seedCardResultSchema.parse({ ok: true, cardMessage: seed(), userMessage: null })).toMatchObject({ userMessage: null });
  });
  test.each([
    { ok: false }, { outcome: "future" }, { userMessage: null },
    { userMessage: { id: "other", role: "user", kind: "text", text: "  Task\nplease  ", at: 3 } },
    { userMessage: { id: "answer", role: "user", kind: "text", text: "Task", at: 3 } },
    { userMessage: { id: "answer", role: "bot", kind: "text", text: "  Task\nplease  ", at: 3 } },
  ])("rejects inconsistent successful envelope %#", (patch) => {
    expect(seedCardResultSchema.safeParse({ ...receipt(), ...patch }).success).toBe(false);
  });
  test.each([{ requestId: null }, { tool: "" }, { purpose: "future" }, { seedAnswer: { messageId: "seed", attempt: 1, status: "starting" } }])("rejects non-seed response metadata %#", (patch) => {
    const result = receipt();
    const raw = { ...result, cardMessage: { ...result.cardMessage, card: { ...result.cardMessage.card, ...patch } } };
    expect(seedCardResultSchema.safeParse(raw).success).toBe(false);
  });
  test("preserves UTF-16 length and whitespace validation boundary", () => {
    expect(seedAnswerTextSchema.safeParse("😀".repeat(2000)).success).toBe(true);
    expect(seedAnswerTextSchema.safeParse("😀".repeat(2000) + "x").success).toBe(false);
    expect(seedAnswerTextSchema.safeParse(" \n ").success).toBe(false);
    expect(seedAnswerTextSchema.parse("  Task\nplease  ")).toBe("  Task\nplease  ");
  });
});

describe("receipt and echo ordering", () => {
  test("inserts one direct child, preserves streams, and ignores its duplicate SSE", () => {
    const s = state(); s.streams.thread = { text: "in progress", reasoning: "thinking" }; s.cursor = "stream:8";
    const result = receipt(); const merged = mergeSeedCardResult(s, "bot", "thread", "seed", result);
    expect(merged.messages.thread.map((message) => message.id)).toEqual(["greeting", "seed", "answer"]);
    expect(merged.leaves.thread).toBe("answer");
    expect(merged.streams).toBe(s.streams); expect(merged.cursor).toBe("stream:8");
    const newer = applyFrame(merged, { kind: "message", threadId: "thread", message: { id: "reply", role: "bot", kind: "text", at: 4, text: "Result", parentId: "answer" } });
    const replay = applyFrame(newer, { kind: "message", threadId: "thread", message: result.userMessage! });
    expect(replay).toBe(newer); expect(replay.leaves.thread).toBe("reply");
  });
  test("API receipt after the actual SSE echo cannot rewind a newer reply", () => {
    const result = receipt(); const reply: Message = { id: "reply", role: "bot", kind: "text", at: 4, parentId: "answer", text: "Ready" };
    const s = state([greeting(), seed(), result.userMessage!, reply], "reply"); s.streams.thread = { text: "new task", reasoning: "" };
    const merged = mergeSeedCardResult(s, "bot", "thread", "seed", result);
    expect(merged.leaves).toBe(s.leaves); expect(merged.streams).toBe(s.streams);
    expect(merged.messages.thread.filter((message) => message.id === "answer")).toHaveLength(1);
  });
  test("a response cannot overwrite a known echoed message with conflicting content", () => {
    const result = receipt(); const s = state([greeting(), seed(), { ...result.userMessage!, text: "Different" }], "answer");
    expect(mergeSeedCardResult(s, "bot", "thread", "seed", result)).toBe(s);
  });
  test.each(["missing", "greeting", "answer"])("does not append an echo under an unrelated or cyclic parent %s", (parentId) => {
    const result = receipt(); result.userMessage!.parentId = parentId;
    const s = state();
    expect(mergeSeedCardResult(s, "bot", "thread", "seed", result)).toBe(s);
  });
  test.each([receipt("recorded", 0), receipt("starting", 1), receipt("not-started", 1), receipt("uncertain", 1)])("retains terminal status against an older/conflicting API or SSE receipt %#", (result) => {
    const latest = receipt("started", 1); const s = state([greeting(), latest.cardMessage, latest.userMessage!], "answer");
    expect(mergeSeedCardResult(s, "bot", "thread", "seed", result)).toBe(s);
    expect(applyFrame(s, { kind: "message.patch", threadId: "thread", message: result.cardMessage }).messages.thread[1]).toBe(latest.cardMessage);
  });
  test("advances a confirmed retry attempt and retains it against older SSE or API", () => {
    const prior = receipt("not-started", 1); const s = state([greeting(), prior.cardMessage, prior.userMessage!], "answer");
    const next = mergeSeedCardResult(s, "bot", "thread", "seed", receipt("starting", 2));
    expect(next.messages.thread[1].card?.seedAnswer?.attempt).toBe(2);
    expect(mergeSeedCardResult(next, "bot", "thread", "seed", prior)).toBe(next);
    expect(applyFrame(next, { kind: "message.patch", threadId: "thread", message: prior.cardMessage }).messages.thread[1]).toBe(next.messages.thread[1]);
  });
  test("does not merge into switched threads, invisible branches or changed cards", () => {
    const s = state();
    expect(mergeSeedCardResult(s, "bot", "other", "seed", receipt())).toBe(s);
    const hidden = state([greeting(), seed(), { ...greeting(), id: "other" }], "other");
    expect(mergeSeedCardResult(hidden, "bot", "thread", "seed", receipt())).toBe(hidden);
    const result = receipt(); result.cardMessage.parentId = "different";
    expect(mergeSeedCardResult(s, "bot", "thread", "seed", result)).toBe(s);
  });
});
