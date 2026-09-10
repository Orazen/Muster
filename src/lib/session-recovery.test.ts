import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionRecovery, readSession, type SessionPayload, type SessionSnapshot } from "./session-recovery";

const stamp = "2026-09-10T12:00:00.000Z";
function payload(id = "fixture-owner") {
  return {
    user: { id, name: "Fixture", email: "fixture@example.invalid", emailVerified: true, createdAt: stamp, updatedAt: stamp },
    session: { id: "fixture-session", userId: id, token: "fixture-token", expiresAt: stamp },
  };
}
function request() { return readSession(new AbortController().signal); }
type SessionTestBody = null | { user?: object; session?: object };
function response(body: SessionTestBody, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("session response boundaries", () => {
  it("sends existing cookies and accepts an explicit successful signed-out response", async () => {
    const fetcher = vi.fn().mockResolvedValue(response(null));
    vi.stubGlobal("fetch", fetcher);
    expect(await request()).toBeNull();
    expect(fetcher).toHaveBeenCalledWith("/api/auth/get-session", expect.objectContaining({ credentials: "include", signal: expect.any(AbortSignal) }));
  });
  it.each([401, 403, 502, 503])("treats HTTP %i as unavailable even when its body is null", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(null, status)));
    await expect(request()).rejects.toThrow();
  });
  it.each([{}, { user: payload().user }, { ...payload(), session: { ...payload().session, userId: "another-owner" } }, { ...payload(), user: { ...payload().user, createdAt: "bad-date" } }])("rejects malformed or inconsistent session data: %j", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(body)));
    await expect(request()).rejects.toThrow();
  });
  it("validates the complete session and restores wire dates", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(payload())));
    expect(await request()).toMatchObject({ user: { id: "fixture-owner", createdAt: new Date(stamp) }, session: { userId: "fixture-owner" } });
  });
  it("rejects an HTML proxy response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>upstream unavailable</html>")));
    await expect(request()).rejects.toThrow();
  });
  it("bounds an unresponsive request to eight seconds", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", (_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));
    const rejected = expect(request()).rejects.toThrow("Aborted");
    await vi.advanceTimersByTimeAsync(8_000);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
  it("cancels the request on owner cleanup and removes its timeout", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", (_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));
    const owner = new AbortController();
    const rejected = expect(readSession(owner.signal)).rejects.toThrow("Aborted");
    owner.abort();
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("session recovery lifecycle", () => {
  it("recovers from startup 503 to the same account without any signed-out state", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response(null, 503)).mockResolvedValueOnce(response(payload())));
    const snapshots: SessionSnapshot[] = [];
    const recovery = createSessionRecovery((snapshot) => snapshots.push(snapshot));
    expect(await recovery.refresh()).toMatchObject({ status: "unavailable", user: null });
    expect(await recovery.refresh()).toMatchObject({ status: "ready", user: { id: "fixture-owner" } });
    expect(snapshots.some((snapshot) => snapshot.status === "ready" && !snapshot.user)).toBe(false);
  });
  it("retains a known identity through an unavailable retry, then clears it only on confirmed expiration", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response(payload())).mockRejectedValueOnce(new TypeError("Network unavailable")).mockResolvedValueOnce(response(null)));
    const recovery = createSessionRecovery(() => {});
    await recovery.refresh();
    expect(await recovery.refresh()).toMatchObject({ status: "unavailable", user: { id: "fixture-owner" } });
    expect(await recovery.refresh()).toEqual({ status: "ready", user: null, session: null });
  });
  it("ignores a late previous-account response after a newer retry", async () => {
    let finishOld!: (value: SessionPayload | null) => void;
    const old = new Promise<SessionPayload | null>((resolve) => { finishOld = resolve; });
    const fresh = await (async () => { vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(payload("new-owner")))); return request(); })();
    const snapshots: SessionSnapshot[] = [];
    const recovery = createSessionRecovery((snapshot) => snapshots.push(snapshot), vi.fn().mockReturnValueOnce(old).mockResolvedValueOnce(fresh));
    const previous = recovery.refresh();
    await recovery.refresh();
    finishOld(null);
    expect(await previous).toBeNull();
    expect(snapshots.at(-1)).toMatchObject({ status: "ready", user: { id: "new-owner" } });
  });
  it("does not resurrect a session after a successful sign-out", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(payload())));
    const oldSession = await request();
    let finish!: (value: SessionPayload | null) => void;
    const snapshots: SessionSnapshot[] = [];
    const recovery = createSessionRecovery((snapshot) => snapshots.push(snapshot), () => new Promise((resolve) => { finish = resolve; }));
    const pending = recovery.refresh();
    recovery.clear();
    finish(oldSession);
    expect(await pending).toBeNull();
    expect(snapshots).toHaveLength(2);
    expect(snapshots.at(-1)).toEqual({ user: null, session: null, status: "ready" });
  });
  it("publishes nothing after unmount and supports the following mount", async () => {
    let fail!: (error: Error) => void;
    const snapshots: SessionSnapshot[] = [];
    const requester = vi.fn<(signal: AbortSignal) => Promise<SessionPayload | null>>()
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; })).mockResolvedValueOnce(null);
    const recovery = createSessionRecovery((snapshot) => snapshots.push(snapshot), requester);
    const pending = recovery.refresh();
    const signal = requester.mock.calls[0][0];
    recovery.cancel();
    expect(signal.aborted).toBe(true);
    fail(new Error("late offline"));
    expect(await pending).toBeNull();
    expect(snapshots).toHaveLength(1);
    expect(await recovery.refresh()).toEqual({ user: null, session: null, status: "ready" });
  });
});
