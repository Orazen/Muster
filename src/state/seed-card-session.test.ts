import { afterEach, describe, expect, it, vi } from "vitest";
import { createOnboardingCard } from "../../server/seed-card";
import { initialState, reducer, visibleMessages, type AppState, type Bot, type Message } from "./store";
import { SeedCardSession, seedCardReference, seedCardWriteBlocker, type SeedAnswer, type SeedCardReference, type SeedCardResult } from "./seed-card-session";

const greeting: Message = { id: "greeting", role: "bot", kind: "text", text: "Hey — I'm Original. Nice to meet you.", at: 1, parentId: null };
const question: Message = { id: "seed", role: "bot", kind: "options", card: createOnboardingCard(), at: 2, parentId: greeting.id };
const bot: Bot = {
  id: "owner-bot", threadId: "current-thread", name: "Renamed", title: "", description: "", notifications: true,
  color: "green", unread: false, activity: "idle", busy: false,
  modelSelection: { instanceId: "codex", model: "default" }, messages: [greeting, question], activeLeafId: question.id,
};
function loaded(): AppState {
  return reducer({ ...initialState, connected: true }, { type: "hydrate", bots: [bot], groups: [] });
}
function reference(state: AppState): SeedCardReference {
  const ref = seedCardReference(state, bot.id, question.id);
  if (!ref) throw new Error("Fixture did not produce a recognized visible seed.");
  return ref;
}
function receipt(answer: string, status: SeedAnswer["status"] = "starting", attempt = 1): SeedCardResult {
  return {
    ok: true, outcome: "starting",
    cardMessage: { id: question.id, parentId: question.parentId, at: question.at, role: "bot", kind: "options", card: {
      ...createOnboardingCard(), purpose: "onboarding-v1", answered: answer, seedAnswer: { messageId: "saved-user", attempt, status },
    } },
    userMessage: { id: "saved-user", role: "user", kind: "text", text: answer, at: 3, parentId: question.id },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.useRealTimers(); });

function fixture() {
  let state = loaded();
  const request = vi.fn<(url: string, init: RequestInit) => Promise<Response>>().mockRejectedValue(new Error("No fixture response configured."));
  const apply = vi.fn((ref: SeedCardReference, result: SeedCardResult) => {
    state = reducer(state, { type: "seedCardRecorded", reference: ref, result });
    session.sync(state);
  });
  const session = new SeedCardSession({ getState: () => state, request, apply });
  session.sync(state);
  const detach = session.attach();
  cleanups.push(detach);
  return {
    session, request, apply, detach, ref: reference(state),
    state: () => state,
    set: (next: AppState) => { state = next; session.sync(state); },
    settle: (result: SeedCardResult) => { state = reducer(state, { type: "seedCardRecorded", reference: reference(state), result }); session.sync(state); },
  };
}

describe("seed card visibility and server-only settlement", () => {
  it("recognizes the canonical original greeting after a rename, while rejecting lookalikes and unknown branches", () => {
    const state = loaded();
    const legacy: Message = { ...question, card: { ...question.card!, purpose: undefined } };
    const withLegacy = { ...state, bots: [{ ...bot, messages: [greeting, legacy] }] };
    expect(seedCardReference(withLegacy, bot.id, question.id)).not.toBeNull();
    expect(seedCardReference({ ...withLegacy, bots: [{ ...bot, messages: [legacy, greeting] }] }, bot.id, question.id)).toBeNull();
    expect(seedCardReference({ ...state, bots: [{ ...bot, activeLeafId: "missing" }] }, bot.id, question.id)).toBeNull();
    expect(seedCardReference({ ...state, bots: [{ ...bot, messages: [greeting, { ...question, card: { ...question.card!, title: "Different question" } }] }] }, bot.id, question.id)).toBeNull();
  });

  it("does not optimistically answer/dismiss a seed or claim working; live asks retain their existing reducer path", () => {
    const state = loaded();
    expect(reducer(state, { type: "answerCard", botId: bot.id, messageId: question.id, answer: "Life admin" })).toBe(state);
    expect(reducer(state, { type: "dismissCard", botId: bot.id, messageId: question.id })).toBe(state);
    const live = { ...state, bots: [{ ...bot, messages: [{ ...question, card: { ...question.card!, requestId: "live-request" } }] }] };
    expect(reducer(live, { type: "answerCard", botId: bot.id, messageId: question.id, answer: "Existing live answer" }).bots[0].messages[0].card?.answered).toBe("Existing live answer");
    expect(seedCardReference(live, bot.id, question.id)).toBeNull();
  });

  it.each([false, true])("keeps an answered legacy card without a receipt inert even with newer work=%s", async (newerWork) => {
    const f = fixture();
    const legacy: Message = { ...question, card: { ...question.card!, purpose: undefined, answered: "  Previous answer\n" } };
    const later: Message = { id: "legacy-user", role: "user", kind: "text", text: "Other work", at: 3, parentId: question.id };
    f.set({ ...f.state(), bots: [{ ...bot, messages: newerWork ? [greeting, legacy, later] : [greeting, legacy], activeLeafId: newerWork ? later.id : legacy.id }] });
    expect(seedCardReference(f.state(), bot.id, question.id)).toBeNull();
    // A handler captured before settlement must also stop both writes and reads.
    await f.session.answer(f.ref, "  Previous answer\n");
    await f.session.start(f.ref);
    await f.session.check(f.ref);
    expect(f.request).not.toHaveBeenCalled();
    expect(f.state().bots[0].messages[1].card?.answered).toBe("  Previous answer\n");
    expect(f.state().bots[0].messages[1].card?.seedAnswer).toBeUndefined();
  });

  it.each(["recorded", "starting", "started", "not-started", "uncertain"] as const)("retains a reference for a real %s receipt", (status) => {
    const f = fixture();
    f.settle(receipt("Life admin", status));
    expect(seedCardReference(f.state(), bot.id, question.id)).toEqual(f.ref);
  });

  it("does not send on attach, hydration, prefill or editing", () => {
    const f = fixture();
    f.session.edit(f.ref, "  preserved draft\n");
    f.session.sync(f.state());
    expect(f.session.action(f.ref).draft).toBe("  preserved draft\n");
    expect(f.request).not.toHaveBeenCalled();
  });

  it("records exact answer bytes with one narrow POST and suppresses same-frame repeats", async () => {
    const f = fixture();
    const response = deferred<Response>();
    f.request.mockReturnValue(response.promise);
    const answer = "  Work & projects\n  keep indentation  ";
    f.session.edit(f.ref, answer);
    const pending = f.session.answer(f.ref, answer);
    await f.session.answer(f.ref, answer);
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.request.mock.calls[0][0]).toBe("/api/bots/owner-bot/cards/seed/answer");
    expect(f.request.mock.calls[0][1]).toMatchObject({ method: "POST", body: JSON.stringify({ threadId: bot.threadId, answer }) });
    expect(f.state().bots[0].messages[1].card?.answered).toBeUndefined();
    expect(f.state().bots[0].busy).toBe(false);
    f.session.edit(f.ref, "A newer draft while the answer is pending");
    response.resolve(Response.json(receipt(answer), { status: 202 }));
    await pending;
    expect(f.state().bots[0].messages[1].card?.seedAnswer?.status).toBe("starting");
    expect(f.state().bots[0].messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(f.session.action(f.ref)).toMatchObject({ pending: null, error: null, draft: "A newer draft while the answer is pending" });
  });

  it.each([400, 401, 409, 503])("checks HTTP %s and retains exact draft + retry answer without optimistic mutation", async (status) => {
    const f = fixture();
    const answer = "  exact answer\n";
    f.session.edit(f.ref, answer);
    f.request.mockResolvedValue(Response.json({ error: "Owned fixture refusal" }, { status }));
    await f.session.answer(f.ref, answer);
    expect(f.session.action(f.ref)).toMatchObject({ draft: answer, lastAnswer: answer, pending: null });
    expect(f.session.action(f.ref).error).toContain("Owned fixture refusal");
    expect(f.state().bots[0].messages).toEqual(bot.messages);
  });

  it.each(["", "  \n", "x".repeat(4001)])("rejects blank or oversized input without transport", async (answer) => {
    const f = fixture();
    await f.session.answer(f.ref, answer);
    expect(f.request).not.toHaveBeenCalled();
    expect(f.session.action(f.ref).error).toContain("4,000");
  });

  it("recovers a lost response with GET and displays the server receipt without another send", async () => {
    const f = fixture();
    f.request.mockRejectedValueOnce(new Error("Response connection lost"));
    await f.session.answer(f.ref, "Life admin");
    expect(f.session.action(f.ref).error).toContain("may have recorded");
    f.request.mockResolvedValueOnce(Response.json(receipt("Life admin", "started")));
    await f.session.check(f.ref);
    expect(f.request.mock.calls.map(([url, init]) => [url, init.method])).toEqual([
      ["/api/bots/owner-bot/cards/seed/answer", "POST"],
      ["/api/bots/owner-bot/cards/seed/answer?threadId=current-thread", "GET"],
    ]);
    expect(f.state().bots[0].messages[1].card?.seedAnswer?.status).toBe("started");
    expect(f.state().bots[0].messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(f.session.action(f.ref).error).toBeNull();
  });

  it("retries the same answer explicitly and folds an already-recorded receipt without duplicating the echo", async () => {
    const f = fixture();
    f.request.mockRejectedValueOnce(new Error("Lost response"));
    const answer = "  Life admin\n";
    await f.session.answer(f.ref, answer);
    f.settle(receipt(answer, "not-started"));
    f.request.mockResolvedValueOnce(Response.json({ ...receipt(answer, "not-started"), outcome: "already-recorded" }));
    await f.session.answer(f.ref, f.session.action(f.ref).lastAnswer!);
    expect(f.request.mock.calls[1][1].body).toBe(JSON.stringify({ threadId: bot.threadId, answer }));
    expect(f.state().bots[0].messages.filter((message) => message.id === "saved-user")).toHaveLength(1);
  });

  it.each([
    { ok: true },
    { ...receipt("Life admin"), ok: false },
    { ...receipt("Life admin"), outcome: "already-started" },
    { ...receipt("Life admin"), cardMessage: { ...receipt("Life admin").cardMessage, id: "other-card" } },
    { ...receipt("Life admin"), userMessage: { ...receipt("Life admin").userMessage, id: "wrong-echo" } },
    { ...receipt("Life admin"), cardMessage: { ...receipt("Life admin").cardMessage, from: { botId: "room-speaker" } } },
    { ...receipt("Life admin"), cardMessage: { ...receipt("Life admin").cardMessage, card: { ...receipt("Life admin").cardMessage.card, held: "Provider permission" } } },
    receipt("Different answer"),
  ])("rejects malformed or mismatched receipts without applying them (%#)", async (body) => {
    const f = fixture();
    f.request.mockResolvedValue(Response.json(body));
    await f.session.answer(f.ref, "Life admin");
    expect(f.apply).not.toHaveBeenCalled();
    expect(f.session.action(f.ref).error).toContain("unrecognized answer receipt");
  });

  it.each(["selected", "thread", "hidden", "branch", "content", "connection", "away-back", "unmount"]) ("ignores an old response after %s changes", async (change) => {
    const f = fixture();
    const response = deferred<Response>();
    f.request.mockReturnValue(response.promise);
    const pending = f.session.answer(f.ref, "Life admin");
    const original = f.state();
    if (change === "selected" || change === "away-back") f.set({ ...original, selectedId: "another-bot" });
    if (change === "away-back") f.set(original);
    if (change === "thread") f.set({ ...original, bots: [{ ...bot, threadId: "another-thread" }] });
    if (change === "hidden") f.set({ ...original, bots: [{ ...bot, hidden: true }] });
    if (change === "branch") f.set({ ...original, bots: [{ ...bot, activeLeafId: greeting.id }] });
    if (change === "content") f.set({ ...original, bots: [{ ...bot, messages: [greeting, { ...question, card: { ...question.card!, title: "Changed content" } }] }] });
    if (change === "connection") f.session.connectionChanged();
    if (change === "unmount") f.detach();
    response.resolve(Response.json(receipt("Life admin")));
    await pending;
    expect(f.apply).not.toHaveBeenCalled();
    expect(f.state().bots[0].messages.some((message) => message.id === "saved-user")).toBe(false);
  });

  it("keeps another account's draft and transcript independent even when IDs are reused", async () => {
    const previous = fixture();
    const response = deferred<Response>();
    previous.request.mockReturnValue(response.promise);
    previous.session.edit(previous.ref, "Previous account draft");
    const pending = previous.session.answer(previous.ref, "Life admin");
    previous.detach();
    const current = fixture();
    current.session.edit(current.ref, "Current account draft");
    response.resolve(Response.json(receipt("Life admin")));
    await pending;
    expect(current.session.action(current.ref).draft).toBe("Current account draft");
    expect(current.apply).not.toHaveBeenCalled();
    expect(previous.apply).not.toHaveBeenCalled();
  });

  it("bounds a hung request and keeps status recovery explicit", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.request.mockReturnValue(new Promise<Response>(() => {}));
    const pending = f.session.answer(f.ref, "Life admin");
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;
    expect(f.request.mock.calls[0][1].signal?.aborted).toBe(true);
    expect(f.session.action(f.ref).error).toContain("timed out");
    expect(f.session.action(f.ref).pending).toBeNull();
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores a reply after switching between branches that share the same seed ancestor", async () => {
    const f = fixture();
    const first: Message = { id: "first-branch", parentId: question.id, role: "bot", kind: "text", text: "First branch", at: 3 };
    const second: Message = { ...first, id: "second-branch", text: "Second branch" };
    f.set({ ...f.state(), bots: [{ ...bot, messages: [...bot.messages, first, second], activeLeafId: first.id }] });
    const response = deferred<Response>();
    f.request.mockReturnValue(response.promise);
    const pending = f.session.answer(f.ref, "Life admin");
    f.set({ ...f.state(), bots: [{ ...f.state().bots[0], activeLeafId: second.id }] });
    response.resolve(Response.json(receipt("Life admin")));
    await pending;
    expect(f.apply).not.toHaveBeenCalled();
    expect(f.state().bots[0].activeLeafId).toBe(second.id);
  });

  it("checks an unanswered card without sending, and does not invent a saved receipt", async () => {
    const f = fixture();
    f.request.mockResolvedValue(Response.json({ ok: true, cardMessage: question, userMessage: null }));
    await f.session.check(f.ref);
    expect(f.request.mock.calls[0][1]).toMatchObject({ method: "GET", body: undefined });
    expect(f.state().bots[0].messages[1].card?.answered).toBeUndefined();
    expect(f.state().bots[0].messages[1].card?.seedAnswer).toBeUndefined();
    expect(f.session.action(f.ref).error).toBeNull();
  });

  it("rejects malformed JSON rather than reporting that an answer was saved", async () => {
    const f = fixture();
    f.request.mockResolvedValue(new Response("{broken", { status: 202 }));
    await f.session.answer(f.ref, "Life admin");
    expect(f.apply).not.toHaveBeenCalled();
    expect(f.session.action(f.ref).error).toContain("unrecognized answer receipt");
  });

  it("sends attempt zero unchanged, locks duplicate starts and trusts a returned failure over the outcome label", async () => {
    const f = fixture();
    f.settle(receipt("Life admin", "recorded", 0));
    const response = deferred<Response>();
    f.request.mockReturnValue(response.promise);
    const pending = f.session.start(f.ref);
    await f.session.start(f.ref);
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.request.mock.calls[0][1].body).toBe(JSON.stringify({ threadId: bot.threadId, expectedAttempt: 0 }));
    response.resolve(Response.json({ ...receipt("Life admin", "not-started", 1), outcome: "already-requested" }));
    await pending;
    expect(f.state().bots[0].messages[1].card?.seedAnswer?.status).toBe("not-started");
    expect(f.request).toHaveBeenCalledTimes(1);
  });

  it("does not regress a newer attempt when an older status request finishes", async () => {
    const f = fixture();
    f.settle(receipt("Life admin", "not-started", 1));
    const response = deferred<Response>();
    f.request.mockReturnValue(response.promise);
    const pending = f.session.check(f.ref);
    f.settle(receipt("Life admin", "started", 2));
    response.resolve(Response.json(receipt("Life admin", "not-started", 1)));
    await pending;
    expect(f.state().bots[0].messages[1].card?.seedAnswer).toMatchObject({ attempt: 2, status: "started" });
    expect(f.state().bots[0].messages.filter((message) => message.role === "user")).toHaveLength(1);
  });

  it("blocks an unused seed after newer user work, retaining draft and read-only status", async () => {
    const f = fixture();
    f.session.edit(f.ref, "An unsent custom answer");
    const newer: Message = { id: "other-work", role: "user", kind: "text", text: "Do this instead", at: 3, parentId: question.id };
    f.set(reducer(f.state(), { type: "messageAdded", threadId: bot.threadId, message: newer }));
    expect(seedCardWriteBlocker(f.state(), f.ref)).toContain("newer work");
    await f.session.answer(f.ref, "Life admin");
    expect(f.request).not.toHaveBeenCalled();
    expect(f.session.action(f.ref).draft).toBe("An unsent custom answer");
    f.request.mockResolvedValue(Response.json({ ok: true, cardMessage: question, userMessage: null }));
    await f.session.check(f.ref);
    expect(f.request.mock.calls[0][1].method).toBe("GET");
    expect(f.state().bots[0].activeLeafId).toBe(newer.id);
  });

  it("excludes the receipt's linked user from newer work, but blocks restart after a subsequent user message", async () => {
    const f = fixture();
    f.settle(receipt("Life admin", "not-started"));
    expect(seedCardWriteBlocker(f.state(), f.ref)).toBeNull();
    const newer: Message = { id: "later-user", role: "user", kind: "text", text: "A different task", at: 4, parentId: "saved-user" };
    f.set(reducer(f.state(), { type: "messageAdded", threadId: bot.threadId, message: newer }));
    expect(seedCardWriteBlocker(f.state(), f.ref)).toContain("newer work");
    await f.session.start(f.ref);
    expect(f.request).not.toHaveBeenCalled();
    f.request.mockResolvedValue(Response.json(receipt("Life admin", "not-started")));
    await f.session.check(f.ref);
    expect(f.request.mock.calls[0][1].method).toBe("GET");
  });

  it("ignores later user messages on a hidden branch when computing write availability", () => {
    const f = fixture();
    const hidden: Message = { id: "hidden-user", role: "user", kind: "text", text: "Other branch task", at: 4, parentId: question.id };
    f.set({ ...f.state(), bots: [{ ...bot, messages: [...bot.messages, hidden], activeLeafId: question.id }] });
    expect(seedCardWriteBlocker(f.state(), f.ref)).toBeNull();
    f.set({ ...f.state(), bots: [{ ...f.state().bots[0], activeLeafId: hidden.id }] });
    expect(seedCardWriteBlocker(f.state(), f.ref)).toContain("newer work");
  });

  it("blocks busy bot writes without blocking status reads or automatically submitting when idle", async () => {
    const f = fixture();
    f.set({ ...f.state(), bots: [{ ...bot, busy: true }] });
    await f.session.answer(f.ref, "Life admin");
    expect(f.request).not.toHaveBeenCalled();
    expect(seedCardWriteBlocker(f.state(), f.ref)).toContain("working");
    f.request.mockResolvedValue(Response.json({ ok: true, cardMessage: question, userMessage: null }));
    await f.session.check(f.ref);
    f.set({ ...f.state(), bots: [{ ...f.state().bots[0], busy: false }] });
    expect(seedCardWriteBlocker(f.state(), f.ref)).toBeNull();
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.request.mock.calls[0][1].method).toBe("GET");
  });

  it.each(["recorded", "not-started", "starting", "started", "uncertain"] as const)("only explicitly starts a saved task in %s state when eligible", async (status) => {
    const f = fixture();
    f.settle(receipt("Life admin", status, 4));
    expect(f.request).not.toHaveBeenCalled();
    f.request.mockResolvedValue(Response.json({ ...receipt("Life admin", "starting", 5), outcome: "starting" }));
    await f.session.start(f.ref);
    if (status === "recorded" || status === "not-started") {
      expect(f.request).toHaveBeenCalledTimes(1);
      expect(f.request.mock.calls[0]).toEqual(["/api/bots/owner-bot/cards/seed/answer/start", expect.objectContaining({
        method: "POST", body: JSON.stringify({ threadId: bot.threadId, expectedAttempt: 4 }),
      })]);
      expect(f.state().bots[0].messages.filter((message) => message.role === "user")).toHaveLength(1);
    } else expect(f.request).not.toHaveBeenCalled();
  });

  it("keeps the latest server receipt and branch when an older acknowledgement follows a newer reply", async () => {
    const f = fixture();
    const response = deferred<Response>();
    f.request.mockReturnValue(response.promise);
    const pending = f.session.answer(f.ref, "Life admin");
    f.settle(receipt("Life admin", "started"));
    const reply: Message = { id: "actual-reply", role: "bot", kind: "text", text: "Here is your result", at: 4, parentId: "saved-user" };
    f.set(reducer(f.state(), { type: "messageAdded", threadId: bot.threadId, message: reply }));
    response.resolve(Response.json(receipt("Life admin", "starting")));
    await pending;
    expect(f.state().bots[0].messages[1].card?.seedAnswer?.status).toBe("started");
    expect(f.state().bots[0].activeLeafId).toBe(reply.id);
    expect(visibleMessages(f.state().bots[0]).map((message) => message.id)).toEqual([greeting.id, question.id, "saved-user", reply.id]);
  });
});
