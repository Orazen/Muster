import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { APIError, type Connection } from "../core/client";
import type { Fleet, PairResponse, ThreadPage } from "../core/types";
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
  async respond(thread: string, request: string, behavior: string): Promise<void> { this.actions.push(`respond:${thread}:${request}:${behavior}`); }
  async alwaysAllow(bot: string, key: string): Promise<void> { this.actions.push(`always:${bot}:${key}`); }
  async markRead(thread: string): Promise<void> { this.actions.push(`read:${thread}`); }
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
    await f.session.respond(f.a, "thread", "request", "allow");
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
    await f.session.respond(f.a, "thread", "request", "allow");
    await f.session.alwaysAllow(f.a, "a", "tool");
    await f.session.viewThread(f.a, "thread");
    expect(f.a.actions).toEqual([]); expect(f.b.actions).toEqual([]);
    expect(f.session.getSnapshot().state.viewedThread).toBeNull();
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
