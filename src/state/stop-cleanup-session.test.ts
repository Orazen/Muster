import { afterEach, describe, expect, it, vi } from "vitest";
import { EMPTY_STOP_ACTION, StopCleanupSession } from "./stop-cleanup-session";

const receipt = "a".repeat(64);
const pendingBody = { code: "STOP_CLEANUP_PENDING", error: "Queued handoffs could not be saved. Retry cleanup.", cleanupReceipt: receipt };
type FixtureBody = Record<string, string | boolean>;
const json = (body: FixtureBody, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach((cleanup) => cleanup()); vi.useRealTimers(); });
function fixture() {
  let accountId = "account-a";
  let bots = [{ id: "bot-a", threadId: "task-one", busy: true, hidden: false }, { id: "bot-b", threadId: "task-two", busy: true, hidden: false }];
  const request = vi.fn<(url: string, init: RequestInit) => Promise<Response>>().mockRejectedValue(new Error("Offline"));
  const unauthorized = vi.fn();
  const session = new StopCleanupSession({ accountId, getAccountId: () => accountId, getBot: (id) => bots.find((bot) => bot.id === id), request, onUnauthorized: unauthorized });
  const detach = session.attach();
  cleanups.push(detach);
  return { session, request, unauthorized, detach,
    switchAccount: () => { accountId = "account-b"; },
    change: (id: string, patch: Partial<typeof bots[number]>) => { bots = bots.map((bot) => bot.id === id ? { ...bot, ...patch } : bot); },
    remove: (id: string) => { bots = bots.filter((bot) => bot.id !== id); },
  };
}
async function failedStop(f: ReturnType<typeof fixture>) {
  f.request.mockResolvedValueOnce(json(pendingBody, 503));
  await f.session.interrupt("bot-a");
  expect(f.session.action("bot-a").recovery?.receipt).toBe(receipt);
}

describe("account-scoped Stop recovery", () => {
  it("does not send when mounted or for idle, hidden, missing bots", async () => {
    const f = fixture();
    f.change("bot-a", { busy: false });
    f.change("bot-b", { hidden: true });
    await Promise.all([f.session.interrupt("bot-a"), f.session.interrupt("bot-b"), f.session.interrupt("missing"), f.session.retry("bot-a")]);
    expect(f.request).not.toHaveBeenCalled();
    expect(f.session.getSnapshot()).toEqual({});
  });
  it("locks every Stop entrypoint synchronously before a render or network result", async () => {
    const f = fixture();
    const response = deferred<Response>();
    f.request.mockReturnValueOnce(response.promise);
    const one = f.session.interrupt("bot-a");
    const two = f.session.interrupt("bot-a");
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.session.action("bot-a").pending).toBe("stop");
    response.resolve(json(pendingBody, 503));
    await Promise.all([one, two]);
    expect(f.session.action("bot-a").pending).toBeNull();
  });
  it("retains the original receipt past idle and the transient six-second banner lifetime", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await failedStop(f);
    f.change("bot-a", { busy: false });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.session.action("bot-a").recovery).toEqual({ receipt, threadId: "task-one", message: pendingBody.error });
    expect(f.session.action("bot-b")).toBe(EMPTY_STOP_ACTION);
  });
  it("retries cleanup only with the original receipt after task changes, never another interrupt", async () => {
    const f = fixture();
    await failedStop(f);
    f.change("bot-a", { threadId: "a-new-task", busy: false });
    f.request.mockResolvedValueOnce(json(pendingBody, 503));
    await f.session.retry("bot-a");
    expect(f.request.mock.calls[1][0]).toBe("/api/bots/bot-a/stop-cleanup");
    expect(f.request.mock.calls[1][1].body).toBe(JSON.stringify({ receipt }));
    expect(f.session.action("bot-a").recovery?.threadId).toBe("task-one");
    f.request.mockResolvedValueOnce(json({ ok: true }));
    await f.session.retry("bot-a");
    expect(f.session.action("bot-a")).toEqual(EMPTY_STOP_ACTION);
    expect(f.request.mock.calls.filter(([url]) => url.endsWith("/interrupt"))).toHaveLength(1);
  });
  it("locks retry, Stop and dismiss together while one cleanup is pending", async () => {
    const f = fixture();
    await failedStop(f);
    const response = deferred<Response>();
    f.request.mockReturnValueOnce(response.promise);
    const retry = f.session.retry("bot-a");
    await f.session.retry("bot-a");
    await f.session.interrupt("bot-a");
    f.session.dismiss("bot-a");
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(f.session.action("bot-a")).toMatchObject({ pending: "cleanup", recovery: { receipt } });
    response.resolve(json({ ok: true }));
    await retry;
    expect(f.session.action("bot-a")).toEqual(EMPTY_STOP_ACTION);
  });
  it.each([400, 403, 404, 409])("turns a refused cleanup (%s) into inspect-only recovery", async (status) => {
    const f = fixture();
    await failedStop(f);
    f.request.mockResolvedValueOnce(json({ code: "STOP_CLEANUP_STALE", error: "Check current work." }, status));
    await f.session.retry("bot-a");
    expect(f.session.action("bot-a").recovery).toMatchObject({ receipt: null, message: expect.stringContaining("current work") });
    await f.session.retry("bot-a");
    expect(f.request).toHaveBeenCalledTimes(2);
  });
  it("keeps a receipt on retry network failure and never replaces it with another generation", async () => {
    const f = fixture();
    await failedStop(f);
    await f.session.retry("bot-a");
    expect(f.session.action("bot-a").recovery?.receipt).toBe(receipt);
    f.request.mockResolvedValueOnce(json({ ...pendingBody, cleanupReceipt: "b".repeat(64) }, 503));
    await f.session.retry("bot-a");
    expect(f.session.action("bot-a").recovery?.receipt).toBe(receipt);
    expect(f.session.action("bot-a").pending).toBeNull();
  });
  it.each(["offline", "missing", "malformed", "unknown-code"])("never offers blind retry for an initial %s response", async (kind) => {
    const f = fixture();
    if (kind === "missing") f.request.mockResolvedValueOnce(json({ error: "Save failed." }, 503));
    if (kind === "malformed") f.request.mockResolvedValueOnce(json({ ...pendingBody, cleanupReceipt: "wrong" }, 503));
    if (kind === "unknown-code") f.request.mockResolvedValueOnce(json({ ...pendingBody, code: "OTHER" }, 503));
    await f.session.interrupt("bot-a");
    expect(f.session.action("bot-a").recovery?.receipt).toBeNull();
    await f.session.retry("bot-a");
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it("allows an intentional later Stop to replace recovery, while another bot has an independent lock", async () => {
    const f = fixture();
    await failedStop(f);
    const later = deferred<Response>();
    f.request.mockReturnValueOnce(later.promise).mockResolvedValueOnce(json({ ok: true }));
    const stop = f.session.interrupt("bot-a");
    await f.session.interrupt("bot-b");
    expect(f.session.action("bot-a")).toEqual({ pending: "stop", recovery: null });
    expect(f.session.action("bot-b")).toEqual(EMPTY_STOP_ACTION);
    later.resolve(json({ ...pendingBody, cleanupReceipt: "b".repeat(64) }, 503));
    await stop;
    expect(f.session.action("bot-a").recovery?.receipt).toBe("b".repeat(64));
  });
  it.each(["unmount", "account", "deleted"])("fences late responses after %s", async (change) => {
    const f = fixture();
    const response = deferred<Response>();
    f.request.mockReturnValueOnce(response.promise);
    const request = f.session.interrupt("bot-a");
    const notifications = vi.fn();
    f.session.subscribe(notifications);
    if (change === "unmount") f.detach();
    if (change === "account") f.switchAccount();
    if (change === "deleted") f.remove("bot-a");
    response.resolve(json(pendingBody, 503));
    await request;
    expect(notifications).not.toHaveBeenCalled();
    expect(f.session.action("bot-a").recovery).toBeNull();
    await f.session.interrupt("bot-a");
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it("a detached then reattached provider never accepts its earlier request", async () => {
    const f = fixture();
    const response = deferred<Response>();
    f.request.mockReturnValueOnce(response.promise);
    const first = f.session.interrupt("bot-a");
    f.detach();
    cleanups.push(f.session.attach());
    f.request.mockResolvedValueOnce(json({ ok: true }));
    await f.session.interrupt("bot-a");
    response.resolve(json(pendingBody, 503));
    await first;
    expect(f.session.action("bot-a")).toEqual(EMPTY_STOP_ACTION);
  });
  it("retires all recovery and pending requests on a confirmed expired session", async () => {
    const f = fixture();
    await failedStop(f);
    const otherResponse = deferred<Response>();
    f.request.mockReturnValueOnce(otherResponse.promise).mockResolvedValueOnce(json({ error: "Sign in" }, 401));
    const otherStop = f.session.interrupt("bot-b");
    await f.session.retry("bot-a");
    expect(f.unauthorized).toHaveBeenCalledOnce();
    expect(f.session.getSnapshot()).toEqual({});
    otherResponse.resolve(json(pendingBody, 503));
    await otherStop;
    expect(f.session.getSnapshot()).toEqual({});
  });
  it.each(["headers", "body"])("times out stalled %s without holding the Stop lock forever", async (stage) => {
    vi.useFakeTimers();
    const f = fixture();
    const response = deferred<Response>();
    const body = deferred<unknown>();
    if (stage === "headers") f.request.mockReturnValueOnce(response.promise);
    else {
      const stalled = json({}, 503);
      vi.spyOn(stalled, "json").mockReturnValue(body.promise);
      f.request.mockResolvedValueOnce(stalled);
    }
    const stop = f.session.interrupt("bot-a");
    await vi.advanceTimersByTimeAsync(10_001);
    await stop;
    expect(f.request.mock.calls[0][1].signal?.aborted).toBe(true);
    expect(f.session.action("bot-a")).toMatchObject({ pending: null, recovery: { receipt: null } });
    response.resolve(json(pendingBody, 503));
    body.resolve(pendingBody);
    await Promise.resolve();
    expect(f.session.action("bot-a").recovery?.receipt).toBeNull();
  });
  it("retains the original receipt on a cleanup timeout, so another explicit retry remains possible", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await failedStop(f);
    const response = deferred<Response>();
    f.request.mockReturnValueOnce(response.promise);
    const retry = f.session.retry("bot-a");
    await vi.advanceTimersByTimeAsync(10_001);
    await retry;
    expect(f.session.action("bot-a")).toMatchObject({ pending: null, recovery: { receipt } });
    f.request.mockResolvedValueOnce(json({ ok: true }));
    await f.session.retry("bot-a");
    response.resolve(json(pendingBody, 503));
    await Promise.resolve();
    expect(f.session.action("bot-a")).toEqual(EMPTY_STOP_ACTION);
  });
  it("dismisses only this bot’s recovery and never sends a request or writes browser storage", async () => {
    const f = fixture();
    await failedStop(f);
    f.request.mockResolvedValueOnce(json(pendingBody, 503));
    await f.session.interrupt("bot-b");
    f.session.dismiss("bot-a");
    expect(f.session.action("bot-a")).toEqual(EMPTY_STOP_ACTION);
    expect(f.session.action("bot-b").recovery?.receipt).toBe(receipt);
    expect(f.request).toHaveBeenCalledTimes(2);
  });
  it("does not restore a receipt or send anything when a fresh account provider mounts after a reload", async () => {
    const old = fixture();
    await failedStop(old);
    old.detach();
    const fresh = fixture();
    expect(fresh.session.getSnapshot()).toEqual({});
    await fresh.session.retry("bot-a");
    expect(fresh.request).not.toHaveBeenCalled();
  });
});
