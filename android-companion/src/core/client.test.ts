import { APIError, MusterClient, type ClientFetch, type ClientResponse, type Connection, type ConnectionStatus } from "./client";
import { jsonSchema, type JsonValue } from "./contracts";
import type { ClientRequest, StreamReader } from "./transport";
import type { Frame } from "./frames";
import { SEED_CARD_PURPOSE, SEED_CARD_TITLE, SEED_CARD_SUBTITLE, SEED_CARD_OPTIONS } from "./seed-card";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
class Reader implements StreamReader {
  pending = deferred<{ done: boolean; value?: Uint8Array }>();
  cancels = 0;
  releases = 0;
  read() { return this.pending.promise; }
  push(text: string) {
    const pending = this.pending;
    this.pending = deferred();
    pending.resolve({ done: false, value: new TextEncoder().encode(text) });
  }
  end() { this.pending.resolve({ done: true }); }
  fail() { this.pending.reject(new Error("read failed")); }
  async cancel() { this.cancels++; this.end(); }
  releaseLock() { this.releases++; }
}
function response(data: JsonValue = null, status = 200, reader: StreamReader | null = null, contentType = "application/json"): ClientResponse {
  return { ok: status >= 200 && status < 300, status, statusText: `HTTP ${status}`, json: async () => data,
    headers: { get: (name) => name.toLowerCase() === "content-type" ? contentType : null },
    body: reader ? { getReader: () => reader } : null };
}
function fixture(conn: Connection = { host: "localhost", port: 8810, token: "fixture-token" }) {
  const calls: Array<{ url: string; init?: ClientRequest }> = [];
  const requests: Array<ReturnType<typeof deferred<ClientResponse>>> = [];
  const fetchRequest: ClientFetch = (url, init) => { calls.push({ url, init }); const req = deferred<ClientResponse>(); requests.push(req); return req.promise; };
  return { client: new MusterClient(conn, fetchRequest), calls, requests, fetchRequest };
}
function streamFixture() {
  const fixtureState = fixture();
  const frames: Frame[] = [], cursors: string[] = [], statuses: ConnectionStatus[] = [];
  const handle = fixtureState.client.events(null, (frame) => frames.push(frame), (cursor) => cursors.push(cursor), (status) => statuses.push(status));
  return { ...fixtureState, frames, cursors, statuses, handle };
}
const permission = { token: "device-token", device: { id: "device-1", name: "Test phone" } };

describe("HTTP client", () => {
  afterEach(() => { jest.useRealTimers(); });
  test("uses explicit HTTPS for pairing and subsequent requests, including bracketed IPv6", async () => {
    const f = fixture({ host: "::1", port: 443, scheme: "https", token: "device-token" });
    const pair = MusterClient.pair("::1", 443, { scheme: "https", deviceName: "Test phone", credential: "fixture-credential", code: "123456" }, f.fetchRequest);
    expect(f.calls[0].url).toBe("https://[::1]:443/api/pair");
    expect(JSON.parse(f.calls[0].init?.body ?? "")).toEqual({ deviceName: "Test phone", credential: "fixture-credential" });
    expect(f.calls[0].init?.headers).not.toHaveProperty("Authorization");
    f.requests[0].resolve(response(permission));
    await expect(pair).resolves.toEqual({ response: expect.objectContaining(permission), token: "device-token" });
    const fleet = f.client.fleet();
    expect(f.calls[1].url).toBe("https://[::1]:443/api/bots?messages=50");
    expect(f.calls[1].init).toMatchObject({ credentials: "omit", headers: { Authorization: "Bearer device-token" } });
    f.requests[1].resolve(response({ bots: [], groups: [] }));
    await expect(fleet).resolves.toEqual({ bots: [], groups: [] });
  });
  test.each([{}, { token: "bad token", device: permission.device }, { token: "x" }])("rejects incomplete pairing response %#", async (data) => {
    const f = fixture(); const pair = MusterClient.pair("localhost", 8810, { deviceName: "phone", code: "123456" }, f.fetchRequest);
    f.requests[0].resolve(response(jsonSchema.parse(data)));
    await expect(pair).rejects.toThrow("invalid pairing response");
  });
  test("rejects pairing without a credential before network", async () => {
    const f = fixture();
    await expect(MusterClient.pair("localhost", 8810, { deviceName: "phone" }, f.fetchRequest)).rejects.toThrow("Need a QR");
    expect(f.calls).toHaveLength(0);
  });
  test("decodes paginated messages and wrapped instances at the HTTP boundary", async () => {
    const f = fixture(); const page = f.client.messages("thread/1", { before: "m?2", limit: 2 });
    expect(f.calls[0].url).toContain("/api/threads/thread%2F1/messages?before=m%3F2&limit=2");
    f.requests[0].resolve(response({ messages: [{ id: "m", kind: "future", at: 1 }, null], hasMore: true }));
    await expect(page).resolves.toMatchObject({ messages: [{ id: "m", kind: "unknown" }], hasMore: true });
    const instances = f.client.instances();
    f.requests[1].resolve(response({ instances: [{ instanceId: "i", driverKind: "codex", snapshot: { state: "ready" }, models: { default: "gpt", options: [] } }] }));
    await expect(instances).resolves.toHaveLength(1);
  });
  test("requires accepted HTTP writes and handles 204 without parsing a body", async () => {
    const f = fixture(); const send = f.client.sendToBot("b/1", "hello");
    expect(JSON.parse(f.calls[0].init?.body ?? "")).toEqual({ text: "hello" });
    f.requests[0].resolve(response({ error: "denied" }, 403));
    await expect(send).rejects.toEqual(new APIError(403, "denied"));
    const groupSend = f.client.sendToGroup("g1", "hello"); const res = response(null, 204);
    res.json = async () => { throw new Error("must not read 204"); };
    f.requests[1].resolve(res); await expect(groupSend).resolves.toBeUndefined();
  });
  test("acknowledges bot and room owner IDs with explicit native POST bodies", async () => {
    const f = fixture({ host: "read.fixture.invalid", port: 443, scheme: "https", token: "owned-read-token" });
    const bot = { id: "orbit-owner", threadId: "orbit-thread", name: "Orbit", unread: false };
    const group = { id: "room-owner", threadId: "room-thread", memberIds: [bot.id], unread: false };
    const botRead = f.client.markBotRead(bot.id);
    const groupRead = f.client.markGroupRead(group.id);
    expect(f.calls.map(({ url, init }) => ({ url, method: init?.method, body: init?.body }))).toEqual([
      { url: "https://read.fixture.invalid:443/api/bots/orbit-owner/read", method: "POST", body: "{}" },
      { url: "https://read.fixture.invalid:443/api/groups/room-owner/read", method: "POST", body: "{}" },
    ]);
    for (const call of f.calls) {
      expect(call.init).toMatchObject({
        credentials: "omit", headers: { Authorization: "Bearer owned-read-token", "Content-Type": "application/json" },
      });
    }
    // Real routes return owner envelopes with200. Read acknowledgement does
    // not return a stale owner object for a caller to merge over newer SSE.
    f.requests[0].resolve(response({ bot }, 200));
    f.requests[1].resolve(response({ group }, 200));
    await expect(botRead).resolves.toBeUndefined();
    await expect(groupRead).resolves.toBeUndefined();
  });
  test.each(["allowed-once", "rejected", "answered", "unavailable"])("preserves the actual decision outcome %s", async (outcome) => {
    const f = fixture(); const result = f.client.respond("room/thread", "ask-id", "answer", "Allow\n  exact answer  ");
    expect(f.calls[0].url).toContain("/api/threads/room%2Fthread/respond");
    expect(JSON.parse(f.calls[0].init?.body ?? "")).toEqual({ requestId: "ask-id", behavior: "answer", message: "Allow\n  exact answer  " });
    f.requests[0].resolve(response({ ok: true, outcome }));
    await expect(result).resolves.toBe(outcome);
  });
  test.each([{ ok: true }, { ok: false, outcome: "answered" }, { ok: true, outcome: "future" }, null])("does not treat an unknown response envelope as approval %#", async (body) => {
    const f = fixture(); const result = f.client.respond("thread", "permission", "allow");
    f.requests[0].resolve(response(jsonSchema.parse(body)));
    await expect(result).rejects.toThrow("unrecognized response");
  });
  test("retains a rejected decision's actual HTTP message", async () => {
    const f = fixture(); const result = f.client.respond("thread", "permission", "deny");
    expect(JSON.parse(f.calls[0].init?.body ?? "")).toEqual({ requestId: "permission", behavior: "deny" });
    f.requests[0].resolve(response({ error: "Request is no longer waiting" }, 409));
    await expect(result).rejects.toEqual(new APIError(409, "Request is no longer waiting"));
  });
  test.each([401, 403, 404, 503])("preserves bot and room read refusal status %i", async (status) => {
    const f = fixture();
    const botRead = f.client.markBotRead("bot-owner");
    f.requests[0].resolve(response({ error: "Bot read was not accepted" }, status));
    await expect(botRead).rejects.toEqual(new APIError(status, "Bot read was not accepted"));
    const groupRead = f.client.markGroupRead("room-owner");
    f.requests[1].resolve(response({ error: "Room read was not accepted" }, status));
    await expect(groupRead).rejects.toEqual(new APIError(status, "Room read was not accepted"));
  });
  test("does not acknowledge a read before transport completes and preserves network failure", async () => {
    const f = fixture();
    let acknowledged = false;
    const read = f.client.markGroupRead("room-owner");
    const result = read.then(() => { acknowledged = true; }, (error: Error) => error);
    await flush();
    expect(acknowledged).toBe(false);
    const failure = new Error("Owned transport connection lost");
    f.requests[0].reject(failure);
    await expect(result).resolves.toBe(failure);
    expect(acknowledged).toBe(false);
  });
  test.each(["bot", "room"])("relays caller cancellation to the %s read transport", async (kind) => {
    jest.useFakeTimers();
    const f = fixture();
    const caller = new AbortController();
    const read = kind === "bot"
      ? f.client.markBotRead("bot-owner", caller.signal)
      : f.client.markGroupRead("room-owner", caller.signal);
    expect(f.calls[0].init?.body).toBe("{}");
    expect(f.calls[0].init?.signal?.aborted).toBe(false);
    caller.abort();
    expect(f.calls[0].init?.signal?.aborted).toBe(true);
    const cancellation = new Error("Owned transport aborted the read");
    f.requests[0].reject(cancellation);
    await expect(read).rejects.toBe(cancellation);
    expect(jest.getTimerCount()).toBe(0);
  });
  test.each(["bot", "room"])("passes an already-aborted caller into %s read transport as aborted", async (kind) => {
    jest.useFakeTimers();
    const f = fixture();
    const caller = new AbortController();
    caller.abort();
    const read = kind === "bot"
      ? f.client.markBotRead("bot-owner", caller.signal)
      : f.client.markGroupRead("room-owner", caller.signal);
    expect(f.calls[0].init?.signal?.aborted).toBe(true);
    const cancellation = new Error("Native transport rejected an already-aborted request");
    f.requests[0].reject(cancellation);
    await expect(read).rejects.toBe(cancellation);
    expect(jest.getTimerCount()).toBe(0);
  });
  test("removes the caller cancellation listener after a successful read", async () => {
    jest.useFakeTimers();
    const f = fixture();
    const caller = new AbortController();
    const read = f.client.markGroupRead("room-owner", caller.signal);
    f.requests[0].resolve(response({ group: { id: "room-owner", unread: false } }));
    await read;
    caller.abort();
    expect(f.calls[0].init?.signal?.aborted).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });
  test("aborts timed-out requests and releases successful request timers", async () => {
    jest.useFakeTimers(); const f = fixture(); const request = f.client.fleet();
    jest.advanceTimersByTime(20_000); expect(f.calls[0].init?.signal?.aborted).toBe(true);
    f.requests[0].reject(new Error("aborted")); await expect(request).rejects.toThrow("aborted");
    expect(jest.getTimerCount()).toBe(0);
    const next = f.client.fleet(); f.requests[1].resolve(response({ bots: [] })); await next;
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe("SSE lifecycle", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => { expect(jest.getTimerCount()).toBe(0); jest.useRealTimers(); });
  test("is connecting until an accepted stream, then disconnects and resumes after EOF", async () => {
    const f = streamFixture(); const reader = new Reader();
    expect(f.statuses).toEqual(["connecting"]);
    f.requests[0].resolve(response(null, 200, reader, "text/event-stream; charset=utf-8")); await flush();
    expect(f.statuses).toEqual(["connecting", "connected"]);
    reader.push('id: s:1\ndata: {"kind":"hello","cursor":"s:1"}\n\n'); await flush();
    expect(f.cursors).toEqual(["s:1"]);
    reader.end(); await flush(); expect(f.statuses.at(-1)).toBe("disconnected");
    expect(reader.cancels).toBe(1); expect(reader.releases).toBe(1);
    jest.advanceTimersByTime(2000); await flush();
    expect(f.calls[1].url).toContain("since=s%3A1");
    f.handle.stop(); f.requests[1].reject(new Error("aborted")); await flush();
  });
  test.each([401, 403])("signals unauthorized %i once, without retrying", async (code) => {
    const f = streamFixture(); const reader = new Reader();
    f.requests[0].resolve(response(null, code, reader)); await flush();
    expect(f.frames).toEqual([]);
    expect(f.statuses).toEqual(["connecting", "unauthorized"]);
    expect(reader.releases).toBe(1); expect(f.calls).toHaveLength(1); f.handle.stop();
  });
  test.each(["missing body", "non-stream content", "HTTP failure"]) ("does not claim connected for %s", async (failure) => {
    const f = streamFixture(); const reader = new Reader();
    f.requests[0].resolve(response(null, failure === "HTTP failure" ? 503 : 200, failure === "missing body" ? null : reader, failure === "non-stream content" ? "text/html" : "text/event-stream"));
    await flush(); expect(f.statuses).toEqual(["connecting", "disconnected"]);
    f.handle.stop(); await flush();
  });
  test("stop suppresses late fetch results and cancels their reader", async () => {
    const f = streamFixture(); f.handle.stop(); const reader = new Reader();
    expect(f.calls[0].init?.signal?.aborted).toBe(true);
    f.requests[0].resolve(response(null, 200, reader, "text/event-stream")); await flush();
    expect(reader.cancels).toBe(1); expect(reader.releases).toBe(1);
    expect(f.statuses).toEqual(["connecting"]); expect(f.frames).toEqual([]);
  });
  test("stop cancels pending reads and is idempotent", async () => {
    const f = streamFixture(); const reader = new Reader();
    f.requests[0].resolve(response(null, 200, reader, "text/event-stream")); await flush();
    f.handle.stop(); f.handle.stop(); await flush();
    expect(reader.cancels).toBe(1); expect(reader.releases).toBe(1);
    expect(f.statuses).toEqual(["connecting", "connected"]); expect(f.frames).toEqual([]);
  });
  test("failure backoff is cancellable and cannot reopen after stop", async () => {
    const f = streamFixture(); f.requests[0].reject(new Error("offline")); await flush();
    expect(f.statuses).toEqual(["connecting", "disconnected"]);
    expect(jest.getTimerCount()).toBe(1); f.handle.stop(); await flush();
    jest.advanceTimersByTime(3000); await flush(); expect(f.calls).toHaveLength(1);
  });
  test("deduplicates replayed runtime deltas and resets partial frames across reconnect", async () => {
    const f = streamFixture(); const reader = new Reader();
    f.requests[0].resolve(response(null, 200, reader, "text/event-stream")); await flush();
    const delta = 'data: {"kind":"runtime","event":{"type":"content.delta","delta":"hello"}}\n\n';
    reader.push(`id: s:2\n${delta}`); await flush();
    reader.push(`id: s:2\n${delta}id: s:1\n${delta}data: {"kind":`); await flush();
    expect(f.frames).toHaveLength(1); expect(f.cursors).toEqual(["s:2"]);
    reader.fail(); await flush(); jest.advanceTimersByTime(2000); await flush();
    const next = new Reader(); f.requests[1].resolve(response(null, 200, next, "text/event-stream")); await flush();
    next.push(`id: s:3\n${delta}`); await flush(); expect(f.frames).toHaveLength(2);
    expect(f.cursors).toEqual(["s:2", "s:3"]); f.handle.stop(); await flush();
  });
  test("stop during a frame callback suppresses cursor and remaining same-chunk frames", async () => {
    const f = fixture(); const frames: Frame[] = []; const cursors: string[] = [];
    const handle = f.client.events(null, (frame) => { frames.push(frame); handle.stop(); }, (cursor) => cursors.push(cursor));
    const reader = new Reader(); f.requests[0].resolve(response(null, 200, reader, "text/event-stream")); await flush();
    reader.push('id: s:1\ndata: {"kind":"config"}\n\nid: s:2\ndata: {"kind":"config"}\n\n'); await flush();
    expect(frames).toEqual([{ kind: "config" }]); expect(cursors).toEqual([]);
  });
  test("replays all missed events after the real server's latest-cursor hello", async () => {
    const f = fixture(); const frames: Frame[] = []; const cursors: string[] = [];
    const handle = f.client.events("s:5", (frame) => frames.push(frame), (cursor) => cursors.push(cursor));
    const reader = new Reader(); f.requests[0].resolve(response(null, 200, reader, "text/event-stream")); await flush();
    reader.push('data: {"kind":"hello","cursor":"s:8","resumed":true}\n\n'); await flush();
    expect(cursors).toEqual([]);
    for (const seq of [6, 7, 8, 8]) {
      reader.push(`id: s:${seq}\ndata: {"kind":"runtime","event":{"type":"content.delta","delta":"${seq}"}}\n\n`); await flush();
    }
    expect(frames.filter((frame) => frame.kind === "runtime")).toHaveLength(3);
    expect(cursors).toEqual(["s:6", "s:7", "s:8"]); handle.stop(); await flush();
  });
  test("unknown wire unauthorized event never signals transport authentication failure", async () => {
    const f = streamFixture(); const reader = new Reader();
    f.requests[0].resolve(response(null, 200, reader, "text/event-stream")); await flush();
    reader.push('data: {"kind":"unauthorized"}\n\n'); await flush();
    expect(f.frames).toEqual([{ kind: "unknown", rawKind: "unauthorized" }]);
    expect(f.statuses).toEqual(["connecting", "connected"]); f.handle.stop(); await flush();
  });

});


function seedReply() {
  return {
    ok: true, outcome: "starting",
    cardMessage: { id: "card_1", role: "bot", kind: "options", at: 2, parentId: "hello",
      card: { purpose: SEED_CARD_PURPOSE, title: SEED_CARD_TITLE, subtitle: SEED_CARD_SUBTITLE, options: [...SEED_CARD_OPTIONS],
        answered: "  Plan my day\nplease  ", seedAnswer: { messageId: "answer", attempt: 1, status: "starting" } } },
    userMessage: { id: "answer", role: "user", kind: "text", at: 3, parentId: "card_1", text: "  Plan my day\nplease  " },
  };
}

describe("dedicated welcome-answer HTTP methods", () => {
  test("rejects a saved receipt for another card or another exact answer", async () => {
    const f = fixture(); const first = f.client.seedCardStatus("bot", "different-card", "thread");
    f.requests[0].resolve(response(seedReply())); await expect(first).rejects.toThrow("unrecognized");
    const second = f.client.answerSeedCard("bot", "card_1", "thread", "Plan my day\nplease");
    f.requests[1].resolve(response(seedReply())); await expect(second).rejects.toThrow("unrecognized");
    expect(f.calls).toHaveLength(2);
  });
  test("uses exact direct-bot routes, untrimmed text and explicit native POST bodies", async () => {
    const f = fixture({ host: "::1", port: 443, scheme: "https", token: "owned-seed-token" });
    const answer = "  Plan my day\nplease  ";
    const write = f.client.answerSeedCard("bot/1", "card_1", "thread?1", answer);
    const read = f.client.seedCardStatus("bot/1", "card_1", "thread?1");
    const start = f.client.startSeedCard("bot/1", "card_1", "thread?1", 1);
    expect(f.calls.map(({ url, init }) => ({ url, method: init?.method, body: init?.body }))).toEqual([
      { url: "https://[::1]:443/api/bots/bot%2F1/cards/card_1/answer", method: "POST", body: JSON.stringify({ threadId: "thread?1", answer }) },
      { url: "https://[::1]:443/api/bots/bot%2F1/cards/card_1/answer?threadId=thread%3F1", method: "GET", body: undefined },
      { url: "https://[::1]:443/api/bots/bot%2F1/cards/card_1/answer/start", method: "POST", body: JSON.stringify({ threadId: "thread?1", expectedAttempt: 1 }) },
    ]);
    for (const call of f.calls) expect(call.init).toMatchObject({ credentials: "omit", headers: { Authorization: "Bearer owned-seed-token", "Content-Type": "application/json" } });
    for (const request of f.requests) request.resolve(response(seedReply(), 202));
    await expect(write).resolves.toMatchObject({ userMessage: { text: answer } });
    await expect(read).resolves.toMatchObject({ cardMessage: { card: { seedAnswer: { attempt: 1 } } } });
    await expect(start).resolves.toMatchObject({ outcome: "starting" });
    expect(f.calls).toHaveLength(3);
  });
  test.each(["", " \n ", "x".repeat(4001)])("rejects invalid text before network %#", async (answer) => {
    const f = fixture();
    await expect(f.client.answerSeedCard("bot", "card", "thread", answer)).rejects.toThrow("4,000");
    expect(f.calls).toHaveLength(0);
  });
  test.each([-1, 1.2, Number.MAX_SAFE_INTEGER, Infinity, NaN])("rejects invalid attempt before network %s", async (attempt) => {
    const f = fixture();
    await expect(f.client.startSeedCard("bot", "card", "thread", attempt)).rejects.toThrow("attempt");
    expect(f.calls).toHaveLength(0);
  });
  test.each([400, 401, 403, 404, 409, 503])("retains HTTP%s provider or ownership failure without sending a second request", async (status) => {
    const f = fixture(); const operation = f.client.answerSeedCard("bot", "card", "thread", "Answer");
    f.requests[0].resolve(response({ error: "Current conversation unavailable" }, status));
    await expect(operation).rejects.toEqual(new APIError(status, "Current conversation unavailable"));
    expect(f.calls).toHaveLength(1);
  });
  test.each([null, { ok: true }, { ...seedReply(), outcome: "future" }, { ...seedReply(), userMessage: null }, { ...seedReply(), ok: false }])("rejects malformed 2xx saved receipts %#", async (body) => {
    const f = fixture(); const operation = f.client.answerSeedCard("bot", "card_1", "thread", "Answer");
    f.requests[0].resolve(response(body));
    await expect(operation).rejects.toThrow("unrecognized saved-answer receipt");
    expect(f.calls).toHaveLength(1);
  });
  test("GET permits an unanswered record but POST requires the durable saved receipt", async () => {
    const f = fixture(); const raw = seedReply();
    const blank = { ok: true, cardMessage: { ...raw.cardMessage, card: { purpose: SEED_CARD_PURPOSE, title: SEED_CARD_TITLE, subtitle: SEED_CARD_SUBTITLE, options: [...SEED_CARD_OPTIONS] } }, userMessage: null };
    const read = f.client.seedCardStatus("bot", "card_1", "thread");
    f.requests[0].resolve(response(blank)); await expect(read).resolves.toMatchObject({ userMessage: null });
    const write = f.client.answerSeedCard("bot", "card_1", "thread", "Answer");
    f.requests[1].resolve(response(blank)); await expect(write).rejects.toThrow("unrecognized");
  });
  test("forwards caller cancellation through every method without an automatic retry", async () => {
    const f = fixture(); const abort = new AbortController();
    const read = f.client.seedCardStatus("bot", "card", "thread", abort.signal);
    const write = f.client.answerSeedCard("bot", "card", "thread", "Answer", abort.signal);
    const start = f.client.startSeedCard("bot", "card", "thread", 0, abort.signal);
    const rejected = Promise.allSettled([read, write, start]);
    abort.abort();
    expect(f.calls.every((call) => call.init?.signal?.aborted)).toBe(true);
    for (const request of f.requests) request.reject(new Error("cancelled"));
    expect((await rejected).every((outcome) => outcome.status === "rejected")).toBe(true);
    expect(f.calls).toHaveLength(3);
  });
});
