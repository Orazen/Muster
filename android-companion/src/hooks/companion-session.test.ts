import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { APIError, type Connection } from "../core/client";
import type { Fleet, Message, PairResponse, RequestBehavior, RequestOutcome, ThreadPage } from "../core/types";
import { cardActionKey, cardReference, type CardAction, type CardReference } from "../core/card-actions";
import {
  CompanionSession, ConnectionPersistence, currentChatTarget,
  type CompanionClient, type CompanionDependencies, type PairInput,
} from "./companion-session";

function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error("Deferred not initialized"); };
  let reject: (error: Error) => void = () => { throw new Error("Deferred not initialized"); };
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function settleMicrotasks(): Promise<void> {
  for (let i = 0; i < 15; i++) await Promise.resolve();
}

const A: Connection = { host: "a.fixture.invalid", port: 8810, token: "offline-token-a", scheme: "http" };
const B: Connection = { host: "b.fixture.invalid", port: 443, token: "offline-token-b", scheme: "https" };
const C: Connection = { host: "c.fixture.invalid", port: 443, token: "offline-token-c", scheme: "https" };
const newest = { id: "newest", role: "bot", kind: "text", at: 2, text: "Current reply" } satisfies ThreadPage["messages"][number];
const older = { id: "older", role: "user", kind: "text", at: 1, text: "Earlier task" } satisfies ThreadPage["messages"][number];

function fleet(id: string): Fleet {
  return { bots: [{ id, name: id, threadId: "thread", messages: [newest], activeLeafId: newest.id, hasMore: true }], groups: [] };
}

type Stream = {
  since: string | null;
  frame: Parameters<CompanionClient["events"]>[1];
  cursor: Parameters<CompanionClient["events"]>[2];
  status: NonNullable<Parameters<CompanionClient["events"]>[3]>;
  stopped: boolean;
};

class FixtureClient implements CompanionClient {
  fleetCalls = 0;
  fleetResponses: Array<Promise<Fleet>> = [];
  pageResponses: Array<Promise<ThreadPage>> = [];
  sendResponses: Array<Promise<void>> = [];
  readResponses: Array<Promise<void>> = [];
  responseResults: Array<Promise<RequestOutcome>> = [];
  grantResults: Array<Promise<void>> = [];
  decisions: Array<{ thread: string; request: string; behavior: RequestBehavior; message?: string }> = [];
  reads: Array<{ kind: "bot" | "room"; id: string; signal?: AbortSignal }> = [];
  streams: Stream[] = [];
  actions: string[] = [];
  pages: Array<{ threadId: string; before?: string }> = [];
  onOpen?: (stream: Stream) => void;

  constructor(private readonly botId: string) {}
  fleet(): Promise<Fleet> {
    this.fleetCalls++;
    return this.fleetResponses.shift() ?? Promise.resolve(fleet(this.botId));
  }
  messages(threadId: string, options?: { before?: string; limit?: number }): Promise<ThreadPage> {
    this.pages.push({ threadId, before: options?.before });
    return this.pageResponses.shift() ?? Promise.resolve({ messages: [older], hasMore: false });
  }
  events(...args: Parameters<CompanionClient["events"]>) {
    const [since, frame, cursor, status = () => undefined] = args;
    const stream: Stream = { since, frame, cursor, status, stopped: false };
    this.streams.push(stream);
    this.onOpen?.(stream);
    return { stop: () => { stream.stopped = true; } };
  }
  async sendToBot(id: string, text: string): Promise<void> { this.actions.push(`bot:${id}:${text}`); await this.sendResponses.shift(); }
  async sendToGroup(id: string, text: string): Promise<void> { this.actions.push(`group:${id}:${text}`); await this.sendResponses.shift(); }
  async respond(thread: string, request: string, behavior: RequestBehavior, message?: string): Promise<RequestOutcome> {
    this.actions.push(`respond:${thread}:${request}:${behavior}`);
    this.decisions.push({ thread, request, behavior, message });
    return await (this.responseResults.shift() ?? Promise.resolve(behavior === "answer" ? "answered" : behavior === "deny" ? "rejected" : "allowed-once"));
  }
  async alwaysAllow(bot: string, key: string): Promise<void> { this.actions.push(`always:${bot}:${key}`); await this.grantResults.shift(); }
  async markBotRead(id: string, signal?: AbortSignal): Promise<void> {
    this.reads.push({ kind: "bot", id, signal });
    await this.readResponses.shift();
  }
  async markGroupRead(id: string, signal?: AbortSignal): Promise<void> {
    this.reads.push({ kind: "room", id, signal });
    await this.readResponses.shift();
  }
}

type PairResult = { connection: Connection; response: PairResponse };
function paired(connection: Connection): PairResult {
  return { connection, response: { token: connection.token, device: { id: "fixture-device", name: "Fixture" } } };
}
const sessions: CompanionSession[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) session.dispose();
  await settleMicrotasks();
  jest.useRealTimers();
});

function fixture(saved: Connection | null = A) {
  let stored = saved;
  const clients = new Map([[A.token, new FixtureClient("a")], [B.token, new FixtureClient("b")], [C.token, new FixtureClient("c")]]);
  const writes: Array<Connection | null> = [];
  const pairRequests: Array<{ input: PairInput; response: ReturnType<typeof deferred<PairResult>> }> = [];
  let read = () => Promise.resolve(stored);
  let beforeSave = async (_connection: Connection | null): Promise<void> => undefined;
  const persistence = new ConnectionPersistence({
    load: () => read(),
    async save(connection) {
      writes.push(connection);
      await beforeSave(connection);
      stored = connection;
    },
  });
  const dependencies: CompanionDependencies = {
    persistence,
    createClient(connection) {
      const client = clients.get(connection.token);
      if (!client) throw new Error("Unexpected fixture connection");
      return client;
    },
    pair(input) {
      const response = deferred<PairResult>();
      pairRequests.push({ input, response });
      return response.promise;
    },
  };
  const create = () => {
    const session = new CompanionSession(dependencies);
    sessions.push(session);
    return session;
  };
  const session = create();
  return {
    session, create, writes, pairRequests, a: clients.get(A.token)!, b: clients.get(B.token)!, c: clients.get(C.token)!,
    stored: () => stored,
    delayRead: (next: () => Promise<Connection | null>) => { read = next; },
    interceptSave: (next: (connection: Connection | null) => Promise<void>) => { beforeSave = next; },
  };
}

async function boot(f: ReturnType<typeof fixture>): Promise<void> {
  await f.session.start();
  await settleMicrotasks();
}

async function pairWith(f: ReturnType<typeof fixture>, connection = B): Promise<void> {
  const result = f.session.pair({ address: `${connection.scheme}://${connection.host}:${connection.port}`, code: "000000" });
  await settleMicrotasks();
  f.pairRequests[f.pairRequests.length - 1].response.resolve(paired(connection));
  expect(await result).toEqual({ response: paired(connection).response });
  await settleMicrotasks();
}

const readBot = { kind: "bot", id: "a", threadId: "thread" } as const;
const readRoom = { kind: "room", id: "room", threadId: "room-thread" } as const;
const room = { id: "room", threadId: "room-thread", memberIds: ["a"], defaultResponder: { kind: "any" }, unread: 1 };

async function readingFixture(foreground = true) {
  const f = fixture();
  f.a.fleetResponses.push(Promise.resolve({
    bots: [{ ...fleet("a").bots[0], unread: 1 }, { id: "other", name: "Other", threadId: "other-thread", unread: 1 }],
    groups: [room],
  }));
  f.session.setForeground(foreground);
  await boot(f);
  f.a.streams[0].status("connected");
  return f;
}

function referenceFor(target: CardReference["target"], message: Message): CardReference {
  const reference = cardReference(target, message);
  if (!reference) throw new Error("Fixture requires a live request identity");
  return reference;
}

async function cardFixture(permission = false, inRoom = false) {
  const f = await readingFixture();
  const target = inRoom ? readRoom : readBot;
  if (inRoom) f.a.streams[0].frame({ kind: "group", group: { ...room, busyBotId: "a" } }, null);
  const card = permission
    ? { title: "Run this tool?", options: ["Allow", "Deny"], requestId: "ask", tool: "Read", allowKey: "read:workspace" }
    : { title: "What should I do?", options: ["Allow", "Deny", "Another choice"], requestId: "ask" };
  const message: Message = { id: "card-message", at: 3, role: "bot", kind: "options", card, from: { botId: "a" } };
  const emit = (next: Message) => f.a.streams[0].frame({ kind: "message.patch", threadId: target.threadId, message: next }, null);
  f.a.streams[0].frame({ kind: "message", threadId: target.threadId, message }, null);
  const leave = f.session.viewConversation(f.a, target); await settleMicrotasks();
  const reference = referenceFor(target, message);
  const state = () => f.session.getSnapshot().cardActions[cardActionKey(reference)];
  const act = (action: CardAction) => f.session.actOnCard(f.a, reference, action);
  return { ...f, target, message, reference, leave, emit, state, act };
}

describe("native question and permission decisions", () => {
  it.each(["Allow", "Deny", "  custom\nanswer  "])("sends %s as exact question text, never a permission", async (text) => {
    const f = await cardFixture(); await f.act({ kind: "answer", text });
    expect(f.a.decisions).toEqual([{ thread: "thread", request: "ask", behavior: "answer", message: text }]);
    expect(f.state()).toMatchObject({ phase: "settled", outcome: "answered", grantSaved: false });
    expect(f.session.getSnapshot().state.messages.thread.find((message) => message.id === f.message.id)?.card?.answered).toBeUndefined();
  });

  it.each(["allow", "deny"] as const)("sends the exact permission %s with no question text", async (kind) => {
    const f = await cardFixture(true); await f.act({ kind });
    expect(f.a.decisions).toEqual([{ thread: "thread", request: "ask", behavior: kind, message: undefined }]);
    expect(f.state()?.outcome).toBe(kind === "allow" ? "allowed-once" : "rejected");
  });

  it("routes a room question through its thread and current speaker", async () => {
    const f = await cardFixture(false, true); await f.act({ kind: "answer", text: "Room answer" });
    expect(f.a.decisions).toEqual([{ thread: "room-thread", request: "ask", behavior: "answer", message: "Room answer" }]);
  });

  it("rejects a card left behind by a different room speaker", async () => {
    const f = await cardFixture(false, true);
    f.a.streams[0].frame({ kind: "group", group: { ...room, busyBotId: "other" } }, null);
    await f.act({ kind: "answer", text: "Former speaker" });
    expect(f.a.decisions).toHaveLength(0); expect(f.state()?.phase).toBe("failed");
  });

  it.each(["allow", "deny", "always"] as const)("rejects permission %s on a question", async (kind) => {
    const f = await cardFixture(); await f.act({ kind });
    expect(f.a.actions).toEqual([]); expect(f.state()?.phase).toBe("failed");
  });

  it("rejects a text answer on a permission and rejects blank question answers", async () => {
    const permission = await cardFixture(true); await permission.act({ kind: "answer", text: "Allow" });
    expect(permission.a.actions).toEqual([]);
    const question = await cardFixture(); await question.act({ kind: "answer", text: " \n " });
    expect(question.a.actions).toEqual([]); expect(question.state()?.message).toContain("Enter an answer");
  });

  it("locks immediate repeated taps and remains settled before the server frame arrives", async () => {
    const f = await cardFixture(true); const response = deferred<RequestOutcome>(); f.a.responseResults.push(response.promise);
    const first = f.act({ kind: "allow" }); const second = f.act({ kind: "deny" });
    expect(f.a.decisions).toHaveLength(1); expect(f.state()?.phase).toBe("pending");
    response.resolve("allowed-once"); await Promise.all([first, second]);
    await f.act({ kind: "deny" }); expect(f.a.decisions).toHaveLength(1);
    expect(f.state()?.outcome).toBe("allowed-once");
  });

  it("keeps unavailable distinct from a successful answer and does not retry it", async () => {
    const f = await cardFixture(); f.a.responseResults.push(Promise.resolve("unavailable"));
    await f.act({ kind: "answer", text: "Too late" }); await f.act({ kind: "answer", text: "Again" });
    expect(f.state()).toMatchObject({ phase: "settled", outcome: "unavailable", message: expect.stringContaining("not delivered") });
    expect(f.a.decisions).toHaveLength(1);
  });

  it.each(["network", "http"])("preserves failed %s decisions and only retries after a new explicit action", async (failure) => {
    jest.useFakeTimers(); const f = await cardFixture(); const pending = deferred<RequestOutcome>(); f.a.responseResults.push(pending.promise);
    const sending = f.act({ kind: "answer", text: "Keep my answer" });
    pending.reject(failure === "http" ? new APIError(409, "Request changed") : new Error("Network unavailable"));
    await sending; await jest.advanceTimersByTimeAsync(60_000);
    expect(f.state()?.phase).toBe("failed");
    expect(f.state()?.message).toContain(failure === "http" ? "not accepted" : "Could not confirm");
    if (failure === "http") expect(f.state()?.message).toContain("Request changed");
    expect(f.a.decisions).toHaveLength(1);
    await f.act({ kind: "answer", text: "Keep my answer" });
    expect(f.a.decisions).toHaveLength(2); expect(f.state()?.outcome).toBe("answered");
  });

  it("saves Always before releasing the exact permission", async () => {
    const f = await cardFixture(true); const grant = deferred<void>(); const response = deferred<RequestOutcome>();
    f.a.grantResults.push(grant.promise); f.a.responseResults.push(response.promise);
    const saving = f.act({ kind: "always" });
    await f.act({ kind: "always" });
    expect(f.a.actions).toEqual(["always:a:read:workspace"]);
    expect(f.state()).toMatchObject({ phase: "pending", grantSaved: false });
    grant.resolve(); await settleMicrotasks();
    expect(f.a.actions).toEqual(["always:a:read:workspace", "respond:thread:ask:allow"]);
    expect(f.state()).toMatchObject({ phase: "pending", grantSaved: true });
    response.resolve("allowed-once"); await saving;
    expect(f.state()).toMatchObject({ phase: "settled", grantSaved: true, outcome: "allowed-once" });
  });

  it.each(["conflict", "network"])("does not approve after a %s grant failure", async (failure) => {
    const f = await cardFixture(true); const grant = deferred<void>(); f.a.grantResults.push(grant.promise);
    const saving = f.act({ kind: "always" });
    grant.reject(failure === "conflict" ? new APIError(409, "No matching pending grant") : new Error("Connection lost"));
    await saving;
    expect(f.a.decisions).toHaveLength(0);
    expect(f.state()).toMatchObject({ phase: "failed", grantSaved: false });
    expect(f.state()?.message).toContain("No approval response was sent");
    if (failure === "conflict") expect(f.state()?.message).toContain("No matching pending grant");
  });

  it.each(["answer", "grant"])("reports an ambiguous %s 502 without claiming the computer is offline", async (kind) => {
    jest.useFakeTimers();
    const f = await cardFixture(kind === "grant");
    const error = new APIError(502, "Muster is not running on this computer");
    if (kind === "grant") {
      f.a.grantResults.push(Promise.reject(error));
      await f.act({ kind: "always" });
    } else {
      f.a.responseResults.push(Promise.reject(error));
      await f.act({ kind: "answer", text: "Preserve this answer" });
    }
    await jest.advanceTimersByTimeAsync(60_000);
    expect(f.state()?.message).toContain("Could not confirm whether");
    expect(f.state()?.message).not.toContain("not running");
    expect(f.a.actions).toHaveLength(1);
    if (kind === "grant") {
      expect(f.a.decisions).toHaveLength(0);
      expect(f.state()?.message).toContain("No approval response was sent");
    }
  });

  it("keeps an accepted grant visible when the following decision is unconfirmed", async () => {
    const f = await cardFixture(true); const response = deferred<RequestOutcome>(); f.a.responseResults.push(response.promise);
    const saving = f.act({ kind: "always" }); await settleMicrotasks();
    response.reject(new Error("Response lost")); await saving;
    expect(f.state()).toMatchObject({ phase: "failed", grantSaved: true, message: expect.stringContaining("preference was saved") });
    expect(f.a.actions).toHaveLength(2);
  });

  it.each(["room", "missing-key"])("does not save an ineligible Always grant: %s", async (invalid) => {
    const f = await cardFixture(true, invalid === "room");
    const message = invalid === "missing-key" ? { ...f.message, card: { ...f.message.card!, allowKey: undefined } } : f.message;
    f.emit(message);
    await f.session.actOnCard(f.a, referenceFor(f.target, message), { kind: "always" });
    expect(f.a.actions).toEqual([]);
  });

  it.each(["leave", "background", "settle", "change-ask", "change-thread", "unpair"])("does not release a permission when %s happens while saving its grant", async (change) => {
    const f = await cardFixture(true); const grant = deferred<void>(); f.a.grantResults.push(grant.promise);
    const saving = f.act({ kind: "always" });
    if (change === "leave") f.leave();
    if (change === "background") f.session.setForeground(false);
    if (change === "settle") f.emit({ ...f.message, card: { ...f.message.card!, answered: "Deny" } });
    if (change === "change-ask") f.emit({ ...f.message, card: { ...f.message.card!, subtitle: "A different action", allowKey: "other:key" } });
    if (change === "change-thread") f.a.streams[0].frame({ kind: "bot", bot: { ...fleet("a").bots[0], threadId: "next" } }, null);
    if (change === "unpair") await f.session.unpair();
    grant.resolve(); await saving;
    expect(f.a.decisions).toHaveLength(0);
    if (change === "leave" || change === "background") expect(f.state()).toMatchObject({ phase: "failed", grantSaved: true });
  });

  it.each(["leave", "background", "stale-client", "signature", "settled", "hidden-branch"])("rejects a new action from %s context", async (invalid) => {
    const f = await cardFixture(true);
    if (invalid === "leave") f.leave();
    if (invalid === "background") f.session.setForeground(false);
    if (invalid === "signature") f.emit({ ...f.message, card: { ...f.message.card!, tool: "Bash" } });
    if (invalid === "settled") f.emit({ ...f.message, card: { ...f.message.card!, answered: "Allow" } });
    if (invalid === "hidden-branch") f.a.streams[0].frame({ kind: "message", threadId: "thread", message: { ...newest, id: "separate-branch" } }, null);
    await f.session.actOnCard(invalid === "stale-client" ? f.b : f.a, f.reference, { kind: "allow" });
    expect(f.a.actions).toEqual([]); expect(f.b.actions).toEqual([]);
  });

  it("does not let a late old response settle a different question reusing its request ID", async () => {
    const f = await cardFixture(); const pending = deferred<RequestOutcome>(); f.a.responseResults.push(pending.promise);
    const sending = f.act({ kind: "answer", text: "Original" });
    const replacement = { ...f.message, id: "new-card", card: { ...f.message.card!, title: "Replacement ask" } };
    f.a.streams[0].frame({ kind: "message", threadId: "thread", message: replacement }, null);
    const reference = referenceFor(f.target, replacement);
    await f.session.actOnCard(f.a, reference, { kind: "answer", text: "Must wait" });
    expect(f.a.decisions).toHaveLength(1);
    pending.resolve("answered"); await sending;
    expect(f.session.getSnapshot().cardActions[cardActionKey(reference)]).toBeUndefined();
    expect(f.state()).toBeUndefined();
    await f.session.actOnCard(f.a, reference, { kind: "answer", text: "New answer" });
    expect(f.a.decisions).toHaveLength(2);
  });

  it("preserves a server settlement when the HTTP response is lost", async () => {
    const f = await cardFixture(true); const pending = deferred<RequestOutcome>(); f.a.responseResults.push(pending.promise);
    const sending = f.act({ kind: "allow" });
    f.emit({ ...f.message, card: { ...f.message.card!, answered: "Allow" } });
    pending.reject(new Error("Response lost")); await sending;
    await f.act({ kind: "allow" }); expect(f.a.decisions).toHaveLength(1);
    expect(f.session.getSnapshot().state.messages.thread.find((message) => message.id === f.message.id)?.card?.answered).toBe("Allow");
  });

  it("fences a previous account's pending decision after pairing to a new client", async () => {
    const f = await cardFixture(); const pending = deferred<RequestOutcome>(); f.a.responseResults.push(pending.promise);
    const sending = f.act({ kind: "answer", text: "Old account" }); await pairWith(f);
    pending.reject(new APIError(401, "Old account revoked")); await sending;
    expect(f.session.getSnapshot().client).toBe(f.b); expect(f.session.getSnapshot().cardActions).toEqual({});
  });

  it.each([401, 403])("clears the current connection for authorization failure %s", async (status) => {
    const f = await cardFixture(); const pending = deferred<RequestOutcome>(); f.a.responseResults.push(pending.promise);
    const sending = f.act({ kind: "answer", text: "Answer" }); pending.reject(new APIError(status, "Revoked")); await sending; await settleMicrotasks();
    expect(f.session.getSnapshot().client).toBeNull(); expect(f.stored()).toBeNull();
    expect(f.session.getSnapshot().cardActions).toEqual({});
  });

  it("revalidates ownership before a write if a synchronous subscriber unpairs on pending", async () => {
    const f = await cardFixture(true);
    const unsubscribe = f.session.subscribe(() => {
      if (f.state()?.phase === "pending") void f.session.unpair();
    });
    await f.act({ kind: "allow" }); unsubscribe(); await settleMicrotasks();
    expect(f.a.actions).toEqual([]); expect(f.session.getSnapshot().client).toBeNull();
  });

  it("reports a failed explicit status check without sending a decision", async () => {
    const f = await cardFixture(); f.a.fleetResponses.push(Promise.reject(new APIError(503, "Offline")));
    await expect(f.session.refreshCards(f.a)).rejects.toThrow("Could not load the latest request status");
    expect(f.a.decisions).toHaveLength(0);
    expect(f.session.getSnapshot().state.messages.thread).toContainEqual(f.message);
  });

  it("reports a stale status check while preserving a newer ask", async () => {
    const f = await cardFixture(); const pending = deferred<Fleet>(); f.a.fleetResponses.push(pending.promise);
    const checking = f.session.refreshCards(f.a);
    const replacement = { ...f.message, card: { ...f.message.card!, subtitle: "Updated request" } };
    f.emit(replacement); pending.resolve(fleet("a"));
    await expect(checking).rejects.toThrow("conversation changed");
    expect(f.session.getSnapshot().state.messages.thread).toContainEqual(replacement);
    expect(f.a.decisions).toHaveLength(0);
  });

  it("ignores an old account status check before and after transport", async () => {
    const f = await cardFixture(); const pending = deferred<Fleet>(); f.a.fleetResponses.push(pending.promise);
    const checking = f.session.refreshCards(f.a); await pairWith(f);
    pending.reject(new APIError(401, "Former credentials")); await checking;
    const calls = f.a.fleetCalls; await f.session.refreshCards(f.a);
    expect(f.a.fleetCalls).toBe(calls); expect(f.session.getSnapshot().client).toBe(f.b);
    expect(f.session.getSnapshot().cardActions).toEqual({});
  });
});

describe("shared conversation read state", () => {
  it.each([readBot, readRoom])("acknowledges the $kind owner after acceptance without clearing its neighbors", async (target) => {
    const f = await readingFixture(); const request = deferred<void>();
    f.a.readResponses.push(request.promise);
    f.session.viewConversation(f.a, target);
    expect(f.a.reads).toMatchObject([{ kind: target.kind, id: target.id }]);
    expect(f.session.getSnapshot().state.bots.a.unread).toBe(1);
    expect(f.session.getSnapshot().state.rooms.room.unread).toBe(1);
    request.resolve(); await settleMicrotasks();
    expect(f.session.getSnapshot().state.bots.a.unread).toBe(target.kind === "bot" ? 0 : 1);
    expect(f.session.getSnapshot().state.rooms.room.unread).toBe(target.kind === "room" ? 0 : 1);
    expect(f.session.getSnapshot().state.bots.other.unread).toBe(1);
    expect(f.session.getSnapshot().readError).toBeNull();
  });

  it("keeps a different owner sharing the viewed thread unread", async () => {
    const f = await readingFixture();
    f.a.streams[0].frame({ kind: "group", group: { ...room, threadId: "thread" } }, null);
    f.session.viewConversation(f.a, readBot); await settleMicrotasks();
    f.a.streams[0].frame({ kind: "message", threadId: "thread", message: { ...newest, id: "shared" } }, null);
    await settleMicrotasks();
    expect(f.session.getSnapshot().state.bots.a.unread).toBe(0);
    expect(f.session.getSnapshot().state.rooms.room.unread).toBe(2);
    expect(f.a.reads.map((read) => [read.kind, read.id])).toEqual([["bot", "a"], ["bot", "a"]]);
  });

  it.each(["missing", "hidden", "changed-thread", "stale-client"])("does not acknowledge a %s target", async (invalid) => {
    const f = await readingFixture();
    if (invalid === "hidden") f.a.streams[0].frame({ kind: "bot", bot: { ...fleet("a").bots[0], hidden: true } }, null);
    f.session.viewConversation(invalid === "stale-client" ? f.b : f.a, {
      ...readBot, id: invalid === "missing" ? "absent" : "a", threadId: invalid === "changed-thread" ? "former-thread" : "thread",
    });
    await settleMicrotasks();
    expect(f.a.reads).toHaveLength(0); expect(f.b.reads).toHaveLength(0);
    expect(f.session.getSnapshot().state.viewedTarget).toBeNull();
  });

  it("waits for foreground and acknowledges again after returning from background", async () => {
    const f = await readingFixture(false);
    f.session.viewConversation(f.a, readBot);
    expect(f.a.reads).toHaveLength(0);
    expect(f.session.getSnapshot().state.viewedTarget).toBeNull();
    f.session.setForeground(true); await settleMicrotasks();
    expect(f.a.reads).toHaveLength(1);
    f.session.setForeground(false);
    expect(f.session.getSnapshot().state.viewedTarget).toBeNull();
    f.a.streams[0].frame({ kind: "message", threadId: "thread", message: { ...newest, id: "while-away" } }, null);
    await settleMicrotasks();
    expect(f.session.getSnapshot().state.bots.a.unread).toBe(1);
    expect(f.a.reads).toHaveLength(1);
    f.session.setForeground(true); await settleMicrotasks();
    expect(f.a.reads).toHaveLength(2);
    expect(f.session.getSnapshot().state.bots.a.unread).toBe(0);
  });

  it("clears the view on leaving and counts later messages without sending reads", async () => {
    const f = await readingFixture();
    const leave = f.session.viewConversation(f.a, readBot); await settleMicrotasks();
    leave();
    f.a.streams[0].frame({ kind: "message", threadId: "thread", message: { ...newest, id: "after-back" } }, null);
    expect(f.session.getSnapshot().state.viewedTarget).toBeNull();
    expect(f.session.getSnapshot().state.bots.a.unread).toBe(1);
    expect(f.a.reads).toHaveLength(1);
  });

  it("allows only the current screen lease to clear visibility, even for the same target", async () => {
    const f = await readingFixture(); const pending = deferred<void>();
    f.a.readResponses.push(pending.promise);
    const leaveFirst = f.session.viewConversation(f.a, readBot);
    const leaveSecond = f.session.viewConversation(f.a, readBot);
    expect(f.a.reads).toHaveLength(1);
    expect(f.a.reads[0].signal?.aborted).toBe(true);
    leaveFirst(); await settleMicrotasks();
    expect(f.a.reads).toHaveLength(2);
    expect(f.session.getSnapshot().state.viewedTarget).toEqual(readBot);
    pending.reject(new APIError(401, "Old request")); await settleMicrotasks();
    expect(f.session.getSnapshot().client).toBe(f.a);
    leaveSecond(); expect(f.session.getSnapshot().state.viewedTarget).toBeNull();
  });

  it("does not erase a newer unread event with an older acceptance and coalesces pending events", async () => {
    const f = await readingFixture(); const first = deferred<void>(); const second = deferred<void>();
    f.a.readResponses.push(first.promise, second.promise);
    f.session.viewConversation(f.a, readBot);
    const stream = f.a.streams[0];
    stream.frame({ kind: "bot", bot: { ...fleet("a").bots[0], unread: 2 } }, null);
    stream.frame({ kind: "message", threadId: "thread", message: { ...newest, id: "new-reading" } }, null);
    expect(f.a.reads).toHaveLength(1);
    first.resolve(); await settleMicrotasks();
    expect(f.a.reads).toHaveLength(2);
    expect(f.session.getSnapshot().state.bots.a.unread).toBe(2);
    second.resolve(); await settleMicrotasks();
    expect(f.session.getSnapshot().state.bots.a.unread).toBe(0);
    expect(f.a.reads).toHaveLength(2);
  });

  it("ignores read broadcasts, unrelated owners, message patches, and replayed messages", async () => {
    const f = await readingFixture(); f.session.viewConversation(f.a, readBot); await settleMicrotasks();
    const stream = f.a.streams[0];
    stream.frame({ kind: "bot", bot: { ...fleet("a").bots[0], unread: 0 } }, null);
    stream.frame({ kind: "group", group: room }, null);
    stream.frame({ kind: "message", threadId: "thread", message: newest }, null);
    stream.frame({ kind: "message.patch", threadId: "thread", message: { ...newest, text: "Patch" } }, null);
    stream.cursor("live:25"); await settleMicrotasks();
    expect(f.a.reads).toHaveLength(1);
  });

  it("reconciles reconnects and an unread hydration without losing the rendered owner", async () => {
    const f = await readingFixture(); f.session.viewConversation(f.a, readRoom); await settleMicrotasks();
    f.a.streams[0].status("disconnected"); f.a.streams[0].status("connected");
    await settleMicrotasks(); expect(f.a.reads).toHaveLength(2);
    f.a.fleetResponses.push(Promise.resolve({ bots: fleet("a").bots, groups: [room] }));
    await f.session.refresh(); await settleMicrotasks();
    expect(f.a.reads).toHaveLength(3);
    expect(f.session.getSnapshot().state.viewedTarget).toEqual(readRoom);
    expect(f.session.getSnapshot().state.rooms.room.unread).toBe(0);
    f.a.streams[0].status("connected"); await settleMicrotasks();
    expect(f.a.reads).toHaveLength(3);
  });

  it.each(["deleted", "hidden", "switched-thread"])("aborts a read and clears visibility when its owner is %s", async (change) => {
    const f = await readingFixture(); const pending = deferred<void>(); f.a.readResponses.push(pending.promise);
    f.session.viewConversation(f.a, readBot);
    if (change === "deleted") f.a.streams[0].frame({ kind: "bot.deleted", botId: "a" }, null);
    else f.a.streams[0].frame({ kind: "bot", bot: { ...fleet("a").bots[0], hidden: change === "hidden", threadId: change === "switched-thread" ? "replacement" : "thread", unread: 1 } }, null);
    expect(f.a.reads[0].signal?.aborted).toBe(true);
    expect(f.session.getSnapshot().state.viewedTarget).toBeNull();
    pending.reject(new APIError(401, "Former owner")); await settleMicrotasks();
    expect(f.session.getSnapshot().client).toBe(f.a);
    expect(f.session.getSnapshot().readError).toBeNull();
  });

  it("retries transient errors with bounded backoff, preserves unread, and supports explicit recovery", async () => {
    jest.useFakeTimers(); const f = await readingFixture();
    const fail = () => { const pending = deferred<void>(); f.a.readResponses.push(pending.promise); return pending; };
    let pending = fail(); f.session.viewConversation(f.a, readBot);
    pending.reject(new APIError(503, "Computer unavailable")); await settleMicrotasks();
    expect(f.session.getSnapshot().readError).toMatchObject({ target: readBot, message: expect.stringContaining("Computer unavailable") });
    expect(f.session.getSnapshot().state.bots.a.unread).toBe(1);
    pending = fail(); await jest.advanceTimersByTimeAsync(499); expect(f.a.reads).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1); pending.reject(new Error("Network unavailable")); await settleMicrotasks();
    pending = fail(); await jest.advanceTimersByTimeAsync(999); expect(f.a.reads).toHaveLength(2);
    await jest.advanceTimersByTimeAsync(1); pending.reject(new APIError(429, "Try later")); await settleMicrotasks();
    await jest.advanceTimersByTimeAsync(30_000); expect(f.a.reads).toHaveLength(3);
    expect(jest.getTimerCount()).toBe(0);
    f.session.retryRead(f.a, readRoom); expect(f.a.reads).toHaveLength(3);
    f.session.retryRead(f.a, readBot); await settleMicrotasks();
    expect(f.a.reads).toHaveLength(4);
    expect(f.session.getSnapshot().readError).toBeNull();
    expect(f.session.getSnapshot().state.bots.a.unread).toBe(0);
  });

  it("does not automatically retry a permanent API error", async () => {
    jest.useFakeTimers(); const f = await readingFixture(); const pending = deferred<void>(); f.a.readResponses.push(pending.promise);
    f.session.viewConversation(f.a, readRoom); pending.reject(new APIError(404, "Room unavailable")); await settleMicrotasks();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(f.a.reads).toHaveLength(1); expect(jest.getTimerCount()).toBe(0);
    expect(f.session.getSnapshot().state.rooms.room.unread).toBe(1);
    expect(f.session.getSnapshot().readError?.message).toContain("Room unavailable");
  });

  it("bounds a hung transport by a cancellable ten-second deadline and ignores its late acceptance", async () => {
    jest.useFakeTimers(); const f = await readingFixture(); const pending = deferred<void>(); const retry = deferred<void>();
    f.a.readResponses.push(pending.promise, retry.promise); f.session.viewConversation(f.a, readBot);
    await jest.advanceTimersByTimeAsync(9_999); expect(f.a.reads[0].signal?.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1); expect(f.a.reads[0].signal?.aborted).toBe(true);
    expect(f.session.getSnapshot().readError?.message).toContain("timed out");
    expect(f.session.getSnapshot().state.bots.a.unread).toBe(1);
    await jest.advanceTimersByTimeAsync(500); expect(f.a.reads).toHaveLength(2);
    pending.resolve(); await settleMicrotasks();
    expect(f.session.getSnapshot().state.bots.a.unread).toBe(1);
    retry.resolve(); await settleMicrotasks();
    expect(f.session.getSnapshot().state.bots.a.unread).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("cancels pending work on background and fences a late unauthorized response from the new focus", async () => {
    const f = await readingFixture(); const pending = deferred<void>(); const retry = deferred<void>();
    f.a.readResponses.push(pending.promise, retry.promise); f.session.viewConversation(f.a, readBot);
    f.session.setForeground(false); expect(f.a.reads[0].signal?.aborted).toBe(true);
    f.session.setForeground(true); await settleMicrotasks(); expect(f.a.reads).toHaveLength(2);
    pending.reject(new APIError(403, "Old focus")); await settleMicrotasks();
    expect(f.session.getSnapshot().client).toBe(f.a);
    expect(f.session.getSnapshot().state.bots.a.unread).toBe(1);
    retry.resolve(); await settleMicrotasks(); expect(f.session.getSnapshot().state.bots.a.unread).toBe(0);
  });

  it.each(["leave", "background", "unpair", "dispose"])("cancels a scheduled retry on %s", async (operation) => {
    jest.useFakeTimers(); const f = await readingFixture(); const pending = deferred<void>(); f.a.readResponses.push(pending.promise);
    const leave = f.session.viewConversation(f.a, readBot); pending.reject(new Error("Network unavailable")); await settleMicrotasks();
    expect(jest.getTimerCount()).toBe(1);
    if (operation === "leave") leave();
    if (operation === "background") f.session.setForeground(false);
    if (operation === "unpair") await f.session.unpair();
    if (operation === "dispose") f.session.dispose();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(f.a.reads).toHaveLength(1); expect(jest.getTimerCount()).toBe(0);
  });

  it("does not let a former account read clear a newly paired owner with the same ID", async () => {
    const f = await readingFixture(); const pending = deferred<void>(); f.a.readResponses.push(pending.promise);
    f.session.viewConversation(f.a, readBot);
    f.b.fleetResponses.push(Promise.resolve({ bots: [{ ...fleet("a").bots[0], unread: 1 }], groups: [] }));
    await pairWith(f);
    expect(f.a.reads[0].signal?.aborted).toBe(true);
    pending.reject(new APIError(401, "Old account revoked")); await settleMicrotasks();
    expect(f.session.getSnapshot().client).toBe(f.b);
    expect(f.session.getSnapshot().state.bots.a.unread).toBe(1);
    expect(f.session.getSnapshot().state.viewedTarget).toBeNull();
    expect(f.b.reads).toHaveLength(0);
  });

  it.each([401, 403])("clears the current connection on a current read authorization failure %s", async (status) => {
    const f = await readingFixture(); const pending = deferred<void>(); f.a.readResponses.push(pending.promise);
    f.session.viewConversation(f.a, readBot); pending.reject(new APIError(status, "Revoked")); await settleMicrotasks();
    expect(f.session.getSnapshot().client).toBeNull(); expect(f.stored()).toBeNull();
    expect(f.session.getSnapshot().state.viewedTarget).toBeNull();
    expect(f.session.getSnapshot().pairError).toMatch(/expired|revoked/);
  });
});

describe("companion session lifecycle", () => {
  it("reports connected only from stream readiness, and clears it throughout reconnect", async () => {
    const f = fixture(); await boot(f);
    expect(f.session.getSnapshot()).toMatchObject({ connected: false, connecting: true });
    const stream = f.a.streams[0];
    stream.status("connecting");
    expect(f.session.getSnapshot().connected).toBe(false);
    stream.status("connected");
    expect(f.session.getSnapshot()).toMatchObject({ connected: true, connecting: false });
    stream.status("disconnected");
    expect(f.session.getSnapshot()).toMatchObject({ connected: false, connecting: false });
    stream.status("connecting");
    expect(f.session.getSnapshot().connected).toBe(false);
    stream.status("connected");
    expect(f.session.getSnapshot().connected).toBe(true);
  });

  it("clears the old fleet/cursor synchronously at a new pairing attempt and retains HTTPS", async () => {
    const f = fixture(); await boot(f);
    f.a.streams[0].cursor("old-stream:8");
    const result = f.session.pair({ address: "https://b.fixture.invalid", code: "000000" });
    expect(f.session.getSnapshot()).toMatchObject({ client: null, pairing: true, connected: false });
    expect(f.session.getSnapshot().state.cursor).toBeNull();
    expect(f.session.getSnapshot().state.bots).toEqual({});
    expect(f.a.streams[0].stopped).toBe(true);
    await settleMicrotasks();
    expect(f.pairRequests[0].input.address).toBe("https://b.fixture.invalid");
    f.pairRequests[0].response.resolve(paired(B));
    await result; await settleMicrotasks();
    expect(f.stored()).toEqual(B);
    expect(f.b.streams[0].since).toBeNull();
    expect(Object.keys(f.session.getSnapshot().state.bots)).toEqual(["b"]);
  });

  it("ignores boot restoration that completes after the user pairs elsewhere", async () => {
    const f = fixture(); const read = deferred<Connection | null>();
    f.delayRead(() => read.promise);
    const starting = f.session.start(); await settleMicrotasks();
    await pairWith(f);
    read.resolve(A); await starting; await settleMicrotasks();
    expect(f.session.getSnapshot().client).toBe(f.b);
    expect(f.a.streams).toHaveLength(0);
    expect(f.stored()).toEqual(B);
  });

  it.each(["resolve", "reject"])("ignores an older overlapping pairing that later %s", async (outcome) => {
    const f = fixture(null); await boot(f);
    const first = f.session.pair({ address: A.host, code: "000000" }); await settleMicrotasks();
    await pairWith(f);
    if (outcome === "resolve") f.pairRequests[0].response.resolve(paired(A));
    else f.pairRequests[0].response.reject(new Error("Older pairing failed"));
    expect(await first).toBeNull();
    expect(f.session.getSnapshot()).toMatchObject({ client: f.b, pairing: false, pairError: null });
    expect(f.stored()).toEqual(B);
    expect(f.writes).not.toContainEqual(A);
  });

  it("ignores late fleet and scrollback responses after the client changes", async () => {
    const f = fixture(); await boot(f);
    const snapshot = deferred<Fleet>(); const page = deferred<ThreadPage>();
    f.a.fleetResponses.push(snapshot.promise); f.a.pageResponses.push(page.promise);
    const refresh = f.session.refresh();
    const paging = f.session.loadOlder(f.a, "thread", true);
    await pairWith(f);
    snapshot.resolve(fleet("a")); page.resolve({ messages: [older], hasMore: false });
    await Promise.all([refresh, paging]);
    expect(Object.keys(f.session.getSnapshot().state.bots)).toEqual(["b"]);
    expect(f.session.getSnapshot().state.messages.thread).toEqual([newest]);
  });

  it("ignores old frames, cursors and connection statuses after unpair and re-pair", async () => {
    const f = fixture(); await boot(f); const old = f.a.streams[0];
    await f.session.unpair();
    expect(f.session.getSnapshot().state.cursor).toBeNull();
    await pairWith(f);
    old.frame({ kind: "bot", bot: fleet("a").bots[0] }, null);
    old.cursor("old:99"); old.status("connected");
    expect(Object.keys(f.session.getSnapshot().state.bots)).toEqual(["b"]);
    expect(f.session.getSnapshot().state.cursor).toBeNull();
    expect(f.session.getSnapshot().connected).toBe(false);
  });

  it("drops an unauthorized stream immediately and ignores its trailing callbacks", async () => {
    const f = fixture(); await boot(f); const stream = f.a.streams[0];
    stream.status("connected"); stream.cursor("stream:1");
    stream.status("unauthorized");
    expect(f.session.getSnapshot()).toMatchObject({ client: null, connected: false, connecting: false });
    expect(f.session.getSnapshot().state.cursor).toBeNull();
    expect(f.session.getSnapshot().pairError).toMatch(/expired|revoked/);
    stream.cursor("stream:2"); stream.status("connected");
    await settleMicrotasks();
    expect(f.stored()).toBeNull();
    expect(f.session.getSnapshot().state.cursor).toBeNull();
  });

  it("does not interpret an unknown unauthorized wire kind as transport revocation", async () => {
    const f = fixture(); await boot(f); const stream = f.a.streams[0];
    stream.status("connected");
    stream.frame({ kind: "unknown", rawKind: "unauthorized" }, null);
    await settleMicrotasks();
    expect(f.session.getSnapshot()).toMatchObject({ client: f.a, connected: true, pairError: null });
    expect(f.stored()).toEqual(A);
    stream.status("unauthorized");
    expect(f.session.getSnapshot().client).toBeNull();
  });

  it.each(["unpair", "unauthorized"])("persists %s removal even when disposal happens before the queued delete", async (operation) => {
    const f = fixture(); await boot(f);
    const clearing = operation === "unpair" ? f.session.unpair() : Promise.resolve(f.a.streams[0].status("unauthorized"));
    f.session.dispose();
    const replacement = f.create();
    await Promise.all([clearing, replacement.start()]); await settleMicrotasks();
    expect(f.stored()).toBeNull();
    expect(replacement.getSnapshot().client).toBeNull();
  });

  it("orders a durable old deletion before an immediately requested new pairing", async () => {
    const f = fixture(); await boot(f);
    const clearing = f.session.unpair();
    await pairWith(f);
    await clearing;
    expect(f.stored()).toEqual(B);
    expect(f.session.getSnapshot().client).toBe(f.b);
  });

  it("stops a stream that synchronously revokes access before returning its handle", async () => {
    const f = fixture();
    f.a.onOpen = (stream) => stream.status("unauthorized");
    await boot(f);
    expect(f.a.streams[0].stopped).toBe(true);
    expect(f.session.getSnapshot().client).toBeNull();
  });

  it("treats an unauthorized fleet request as lost access, without opening a stream", async () => {
    const f = fixture(); f.a.fleetResponses.push(Promise.reject(new APIError(401, "Fixture unauthorized")));
    await boot(f);
    expect(f.session.getSnapshot().client).toBeNull();
    expect(f.a.streams).toHaveLength(0);
    expect(f.stored()).toBeNull();
  });

  it("preserves new pairing recovery errors against an old unauthorized request", async () => {
    const f = fixture(); await boot(f);
    const stale = deferred<Fleet>(); f.a.fleetResponses.push(stale.promise);
    const refresh = f.session.refresh();
    const pairing = f.session.pair({ address: B.host, code: "000000" }); await settleMicrotasks();
    f.pairRequests[0].response.reject(new Error("Current code expired")); await pairing;
    stale.reject(new APIError(401, "Old account revoked")); await refresh;
    expect(f.session.getSnapshot().pairError).toBe("Current code expired");
  });

  it("clears visible identity before a failed credential removal and reports recovery", async () => {
    const f = fixture(); await boot(f);
    f.interceptSave(async () => { throw new Error("Fixture storage locked"); });
    const unpairing = f.session.unpair();
    expect(f.session.getSnapshot().client).toBeNull();
    expect(f.session.getSnapshot().state.bots).toEqual({});
    await unpairing;
    expect(f.session.getSnapshot().pairError).toContain("Could not remove the saved connection");
    expect(f.session.getSnapshot().pairError).toContain("Fixture storage locked");
  });

  it("does not publish late reads or frames after disposal", async () => {
    const f = fixture(); await boot(f);
    const late = deferred<Fleet>(); f.a.fleetResponses.push(late.promise);
    const pending = f.session.refresh(); const stream = f.a.streams[0];
    let updates = 0; const unsubscribe = f.session.subscribe(() => { updates++; });
    f.session.dispose(); late.resolve(fleet("unexpected"));
    stream.cursor("late:1"); stream.status("connected"); stream.frame({ kind: "bot", bot: fleet("unexpected").bots[0] }, null);
    await pending;
    expect(updates).toBe(0); expect(stream.stopped).toBe(true);
    expect(f.session.getSnapshot().state.bots.unexpected).toBeUndefined();
    unsubscribe();
  });

  it("ignores a pairing response after disposal before credentials are written", async () => {
    const f = fixture(null); await boot(f);
    const pending = f.session.pair({ address: A.host, code: "000000" }); await settleMicrotasks();
    f.session.dispose(); f.pairRequests[0].response.resolve(paired(A));
    expect(await pending).toBeNull(); await settleMicrotasks();
    expect(f.writes).not.toContainEqual(A);
    expect(f.stored()).toBeNull();
  });

  it("serializes unpair behind an in-flight credential write so old credentials cannot return", async () => {
    const f = fixture(null); await boot(f); const writing = deferred<void>();
    f.interceptSave(async (connection) => { if (connection?.token === B.token) await writing.promise; });
    const pending = f.session.pair({ address: B.host, code: "000000" }); await settleMicrotasks();
    f.pairRequests[0].response.resolve(paired(B)); await settleMicrotasks();
    expect(f.writes).toContainEqual(B);
    const unpairing = f.session.unpair();
    expect(f.session.getSnapshot().client).toBeNull();
    writing.resolve(); await Promise.all([pending, unpairing]); await settleMicrotasks();
    expect(f.stored()).toBeNull(); expect(f.b.streams).toHaveLength(0);
    expect(f.writes[f.writes.length - 1]).toBeNull();
  });

  it("serializes remount restoration after cleanup of an unmounted pairing write", async () => {
    const f = fixture(null); await boot(f); const writing = deferred<void>();
    f.interceptSave(async (connection) => { if (connection?.token === B.token) await writing.promise; });
    const pending = f.session.pair({ address: B.host, code: "000000" }); await settleMicrotasks();
    f.pairRequests[0].response.resolve(paired(B)); await settleMicrotasks();
    f.session.dispose(); const replacement = f.create(); const restored = replacement.start();
    writing.resolve(); await Promise.all([pending, restored]); await settleMicrotasks();
    expect(f.stored()).toBeNull(); expect(replacement.getSnapshot().client).toBeNull();
    expect(f.b.streams).toHaveLength(0);
  });

  it("does not clear a replacement connection when an old session is disposed twice", async () => {
    const f = fixture(null); await boot(f);
    const oldPair = f.session.pair({ address: A.host, code: "000000" }); await settleMicrotasks();
    f.session.dispose();
    const replacement = f.create(); await replacement.start(); await settleMicrotasks();
    const newPair = replacement.pair({ address: B.host, code: "000000" }); await settleMicrotasks();
    f.pairRequests[1].response.resolve(paired(B)); await newPair; await settleMicrotasks();
    f.session.dispose();
    f.pairRequests[0].response.resolve(paired(A)); await oldPair; await settleMicrotasks();
    expect(f.stored()).toEqual(B);
    expect(replacement.getSnapshot().client).toBe(f.b);
  });

  it("keeps the newest pairing pending while an older credential write finishes", async () => {
    const f = fixture(null); await boot(f); const writing = deferred<void>();
    f.interceptSave(async (connection) => { if (connection?.token === B.token) await writing.promise; });
    const first = f.session.pair({ address: B.host, code: "000000" }); await settleMicrotasks();
    f.pairRequests[0].response.resolve(paired(B)); await settleMicrotasks();
    const latest = f.session.pair({ address: C.host, code: "000000" });
    writing.resolve(); expect(await first).toBeNull(); await settleMicrotasks();
    expect(f.session.getSnapshot()).toMatchObject({ client: null, pairing: true, pairError: null });
    f.pairRequests[1].response.resolve(paired(C)); await latest; await settleMicrotasks();
    expect(f.stored()).toEqual(C);
    expect(f.session.getSnapshot()).toMatchObject({ client: f.c, pairing: false });
    expect(f.b.streams).toHaveLength(0);
  });

  it("does not activate a connection whose credential write failed and allows a later retry", async () => {
    const f = fixture(null); await boot(f);
    f.interceptSave(async (connection) => {
      if (connection?.token === B.token) throw new Error("Fixture credential write failed");
    });
    const pending = f.session.pair({ address: B.host, code: "000000" }); await settleMicrotasks();
    f.pairRequests[0].response.resolve(paired(B)); expect(await pending).toBeNull();
    expect(f.session.getSnapshot()).toMatchObject({ client: null, pairing: false, pairError: "Fixture credential write failed" });
    expect(f.b.streams).toHaveLength(0);
    await pairWith(f, C);
    expect(f.session.getSnapshot()).toMatchObject({ client: f.c, pairError: null });
    expect(f.stored()).toEqual(C);
  });

  it("keeps newer stream data and cursor when a refresh snapshot arrives late", async () => {
    const f = fixture(); await boot(f); const late = deferred<Fleet>();
    f.a.fleetResponses.push(late.promise); const refresh = f.session.refresh();
    const streamed = { ...newest, id: "streamed", text: "Fresh stream reply" };
    f.a.streams[0].frame({ kind: "message", threadId: "thread", message: streamed }, null);
    f.a.streams[0].cursor("current:3");
    late.resolve(fleet("a")); await refresh;
    expect(f.session.getSnapshot().state.messages.thread).toContainEqual(streamed);
    expect(f.session.getSnapshot().state.cursor).toBe("current:3");
  });

  it("hydrates a fresh hello after its cursor commits to recover the initial stream gap", async () => {
    const f = fixture(); await boot(f); const recovered = deferred<Fleet>();
    f.a.fleetResponses.push(recovered.promise);
    const stream = f.a.streams[0];
    stream.frame({ kind: "hello", cursor: "fresh:9", resumed: false }, null);
    stream.cursor("fresh:9");
    await settleMicrotasks();
    expect(f.a.fleetCalls).toBe(2);
    recovered.resolve(fleet("recovered")); await settleMicrotasks();
    expect(Object.keys(f.session.getSnapshot().state.bots)).toEqual(["recovered"]);
    expect(f.session.getSnapshot().state.cursor).toBe("fresh:9");
  });

  it("keeps resumed replay on the stream without requesting a replacement snapshot", async () => {
    const f = fixture(); await boot(f);
    f.a.streams[0].frame({ kind: "hello", cursor: "existing:9", resumed: true }, null);
    await settleMicrotasks();
    expect(f.a.fleetCalls).toBe(1);
  });

  it("retries required recovery after newer SSE invalidates its first snapshot", async () => {
    jest.useFakeTimers();
    const f = fixture(); await boot(f);
    const stale = deferred<Fleet>(); const fresh = deferred<Fleet>();
    f.a.fleetResponses.push(stale.promise, fresh.promise);
    const stream = f.a.streams[0];
    stream.frame({ kind: "hello", cursor: "restart:8", resumed: false }, null);
    stream.cursor("restart:8"); await settleMicrotasks();
    const streamed = { ...newest, id: "streamed", text: "Arrived during recovery" };
    stream.frame({ kind: "message", threadId: "thread", message: streamed }, null);
    stream.cursor("restart:9");
    stale.resolve(fleet("a")); await settleMicrotasks();
    expect(f.session.getSnapshot().state.messages.thread).toContainEqual(streamed);
    expect(f.a.fleetCalls).toBe(2);
    await jest.advanceTimersByTimeAsync(249);
    expect(f.a.fleetCalls).toBe(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(f.a.fleetCalls).toBe(3);
    const recovered = fleet("a"); recovered.bots[0].messages = [older, newest, streamed];
    fresh.resolve(recovered); await settleMicrotasks();
    expect(f.session.getSnapshot().state.messages.thread).toEqual([older, newest, streamed]);
    expect(f.session.getSnapshot().state.cursor).toBe("restart:9");
    expect(jest.getTimerCount()).toBe(0);
  });

  it("backs off failed recovery requests and cancels the pending retry on disposal", async () => {
    jest.useFakeTimers();
    const f = fixture(); await boot(f);
    const requests = Array.from({ length: 6 }, () => deferred<Fleet>());
    f.a.fleetResponses.push(...requests.map((request) => request.promise));
    f.a.streams[0].frame({ kind: "hello", cursor: "restart:1", resumed: false }, null);
    f.a.streams[0].cursor("restart:1"); await settleMicrotasks();
    const delays = [250, 500, 1_000, 2_000, 2_000];
    for (const [index, delay] of delays.entries()) {
      requests[index].reject(new Error("Fixture offline")); await settleMicrotasks();
      expect(f.a.fleetCalls).toBe(index + 2);
      await jest.advanceTimersByTimeAsync(delay - 1);
      expect(f.a.fleetCalls).toBe(index + 2);
      await jest.advanceTimersByTimeAsync(1);
      expect(f.a.fleetCalls).toBe(index + 3);
    }
    requests[5].reject(new Error("Fixture offline")); await settleMicrotasks();
    expect(jest.getTimerCount()).toBe(1);
    f.session.dispose();
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(f.a.fleetCalls).toBe(7);
  });

  it("does not let a slower refresh overwrite a more recent refresh", async () => {
    const f = fixture(); await boot(f);
    const old = deferred<Fleet>(); const next = deferred<Fleet>();
    f.a.fleetResponses.push(old.promise, next.promise);
    const first = f.session.refresh(); const second = f.session.refresh();
    next.resolve(fleet("newest-roster")); await second;
    old.resolve(fleet("older-roster")); await first;
    expect(Object.keys(f.session.getSnapshot().state.bots)).toEqual(["newest-roster"]);
  });

  it("ignores a scrollback page after a same-session branch switch", async () => {
    const f = fixture(); await boot(f); const page = deferred<ThreadPage>();
    f.a.pageResponses.push(page.promise);
    const paging = f.session.loadOlder(f.a, "thread", true);
    f.a.streams[0].frame({ kind: "thread", threadId: "thread", activeLeafId: "other-branch" }, null);
    page.resolve({ messages: [older], hasMore: false }); await paging;
    expect(f.session.getSnapshot().state.messages.thread).toEqual([newest]);
    expect(f.session.getSnapshot().state.leaves.thread).toBe("other-branch");
    expect(f.session.getSnapshot().state.hasMore.thread).toBe(true);
  });

  it("invalidates selected bot tasks, sends and pending pages when the active thread changes", async () => {
    const f = fixture(); await boot(f);
    const target = { kind: "bot", id: "a", threadId: "thread" } as const;
    const page = deferred<ThreadPage>(); f.a.pageResponses.push(page.promise);
    const paging = f.session.loadOlder(f.a, "thread", true);
    f.a.streams[0].frame({ kind: "bot", bot: {
      ...fleet("a").bots[0], threadId: "new-thread",
    } }, null);
    expect(currentChatTarget({ client: f.a, target }, f.a, f.session.getSnapshot().state)).toBeNull();
    await expect(f.session.send(f.a, target, "stale draft")).resolves.toBe(false);
    await f.session.actOnCard(f.a, { target, messageId: "former-card", requestId: "request", signature: "former-ask" }, { kind: "allow" });
    expect(f.a.actions).toEqual([]);
    page.resolve({ messages: [older], hasMore: false }); await paging;
    expect(f.session.getSnapshot().state.messages.thread).toEqual([newest]);
    await expect(f.session.send(f.a, { ...target, threadId: "new-thread" }, "current draft")).resolves.toBe(true);
    expect(f.a.actions).toEqual(["bot:a:current draft"]);
  });

  it("invalidates a selected room and rejects its stale send after a thread change", async () => {
    const f = fixture(); await boot(f);
    const room = { id: "room", threadId: "room-thread", memberIds: ["a"], defaultResponder: { kind: "any" } };
    const target = { kind: "room", id: "room", threadId: room.threadId } as const;
    f.a.streams[0].frame({ kind: "group", group: room }, null);
    const selection = { client: f.a, target };
    expect(currentChatTarget(selection, f.a, f.session.getSnapshot().state)).toEqual(target);
    f.a.streams[0].frame({ kind: "group", group: { ...room, threadId: "new-room-thread" } }, null);
    expect(currentChatTarget(selection, f.a, f.session.getSnapshot().state)).toBeNull();
    await expect(f.session.send(f.a, target, "stale room draft")).resolves.toBe(false);
    expect(f.a.actions).toEqual([]);
  });

  it("prepends a current scrollback page and maintains existing messages", async () => {
    const f = fixture(); await boot(f);
    await f.session.loadOlder(f.a, "thread", true);
    expect(f.a.pages).toEqual([{ threadId: "thread", before: "newest" }]);
    expect(f.session.getSnapshot().state.messages.thread).toEqual([older, newest]);
    expect(f.session.getSnapshot().state.hasMore.thread).toBe(false);
  });

  it("fences callbacks retained by an old screen and clears selection even when bot IDs repeat", async () => {
    const f = fixture(); await boot(f);
    const target = { kind: "bot", id: "a", threadId: "thread" } as const;
    const selection = { client: f.a, target };
    expect(currentChatTarget(selection, f.a, f.session.getSnapshot().state)).toEqual(target);
    f.b.fleetResponses.push(Promise.resolve(fleet("a")));
    await pairWith(f);
    expect(f.session.getSnapshot().state.bots.a.threadId).toBe(target.threadId);
    expect(currentChatTarget(selection, f.b, f.session.getSnapshot().state)).toBeNull();
    expect(currentChatTarget(selection, null, f.session.getSnapshot().state)).toBeNull();
    await expect(f.session.send(f.a, target, "old screen")).resolves.toBe(false);
    const formerCard = { target, messageId: "former-card", requestId: "request", signature: "former-ask" };
    await f.session.actOnCard(f.a, formerCard, { kind: "allow" });
    await f.session.actOnCard(f.a, formerCard, { kind: "always" });
    f.session.viewConversation(f.a, target);
    expect(f.a.actions).toEqual([]); expect(f.b.actions).toEqual([]);
    expect(f.a.reads).toEqual([]); expect(f.b.reads).toEqual([]);
    expect(f.session.getSnapshot().state.viewedTarget).toBeNull();
  });

  it("reports acceptance for a current room send only after transport completion", async () => {
    const f = fixture(); await boot(f);
    const room = { id: "room", threadId: "room-thread", memberIds: ["a"], defaultResponder: { kind: "any" } };
    f.a.streams[0].frame({ kind: "group", group: room }, null);
    const request = deferred<void>(); f.a.sendResponses.push(request.promise);
    let settled = false;
    const sending = f.session.send(f.a, { kind: "room", id: room.id, threadId: room.threadId }, "room task");
    void sending.then(() => { settled = true; });
    await settleMicrotasks();
    expect(f.a.actions).toEqual(["group:room:room task"]);
    expect(settled).toBe(false);
    request.resolve();
    await expect(sending).resolves.toBe(true);
  });

  it.each(["account", "thread"])("does not report a late send acknowledgement as current after a %s switch", async (context) => {
    const f = fixture(); await boot(f);
    const request = deferred<void>(); f.a.sendResponses.push(request.promise);
    const sending = f.session.send(f.a, { kind: "bot", id: "a", threadId: "thread" }, "old task");
    if (context === "account") {
      f.b.fleetResponses.push(Promise.resolve(fleet("a")));
      await pairWith(f);
    } else {
      f.a.streams[0].frame({ kind: "bot", bot: { ...fleet("a").bots[0], threadId: "new-thread" } }, null);
    }
    request.resolve();
    await expect(sending).resolves.toBe(false);
    expect(f.a.actions).toEqual(["bot:a:old task"]);
    expect(f.b.actions).toEqual([]);
  });

  it("propagates the actual send error so the composer can retain the draft and explain recovery", async () => {
    const f = fixture(); await boot(f);
    const request = deferred<void>(); f.a.sendResponses.push(request.promise);
    const sending = f.session.send(f.a, { kind: "bot", id: "a", threadId: "thread" }, "unsent task");
    const error = new APIError(503, "Your computer is temporarily unavailable");
    request.reject(error);
    await expect(sending).rejects.toBe(error);
  });
});
