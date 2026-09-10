import { describe, expect, it, vi } from "vitest";
import { createBrowserPreviewSession, type BrowserPreviewReply, type BrowserPreviewSnapshot, type BrowserPreviewState } from "./browser-preview-session";

const idle: BrowserPreviewState = { running: false, url: null, title: null, profile: "bot", error: null };
const running: BrowserPreviewState = { ...idle, running: true, url: "https://example.com/confirmed", title: "Confirmed page" };
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function harness(state: BrowserPreviewState = running) {
  const snapshots: BrowserPreviewSnapshot[] = [];
  const request = vi.fn<(path: string, init?: RequestInit) => Promise<BrowserPreviewReply>>();
  request.mockResolvedValueOnce({ state, frame: state.running ? "initial-frame" : null });
  const session = createBrowserPreviewSession("owned-bot", request, (snapshot) => snapshots.push(snapshot));
  return { request, session, snapshots, latest: () => snapshots.at(-1)! };
}

describe("browser preview request lifecycle", () => {
  it.each(["bot", "guest"] as const)("starts the selected %s profile after confirming idle state", async (profile) => {
    const h = harness(idle);
    await h.session.pull();
    h.request.mockResolvedValueOnce({ ...running, profile });
    await h.session.start(profile);
    expect(h.request).toHaveBeenLastCalledWith("/api/bots/owned-bot/browser-panel/start", { method: "POST", body: JSON.stringify({ profile }) });
    expect(h.latest()).toMatchObject({ state: { running: true, profile }, busy: null, error: null, frame: null });
  });

  it("does not start before the existing session state is known", async () => {
    const h = harness(idle);
    await h.session.start("bot");
    expect(h.request).not.toHaveBeenCalled();
  });

  it("keeps the last confirmed session after a rejected stop and never starts the requested profile", async () => {
    const h = harness();
    await h.session.pull();
    h.request.mockRejectedValueOnce(new Error("Stop rejected"));
    await h.session.switchProfile("guest");
    expect(h.request.mock.calls.map(([path]) => path)).toEqual([
      "/api/bots/owned-bot/browser-panel/frame", "/api/bots/owned-bot/browser-panel/stop",
    ]);
    expect(h.latest()).toMatchObject({ state: running, frame: "initial-frame", error: "Stop rejected", busy: null });
  });

  it("clears the preview only after stop succeeds", async () => {
    const h = harness();
    await h.session.pull();
    const stopping = deferred<BrowserPreviewReply>();
    h.request.mockReturnValueOnce(stopping.promise);
    const completion = h.session.stop();
    expect(h.latest()).toMatchObject({ state: running, frame: "initial-frame", busy: "stop" });
    stopping.resolve({ ok: true });
    await completion;
    expect(h.latest()).toMatchObject({ state: idle, frame: null, busy: null });
  });

  it("waits for stop before starting a new profile and reports a subsequent start failure as closed", async () => {
    const h = harness();
    await h.session.pull();
    const stopping = deferred<BrowserPreviewReply>();
    h.request.mockReturnValueOnce(stopping.promise).mockRejectedValueOnce(new Error("Guest failed to launch"));
    const completion = h.session.switchProfile("guest");
    expect(h.request).toHaveBeenCalledTimes(2);
    stopping.resolve({ ok: true });
    await completion;
    expect(h.request).toHaveBeenLastCalledWith("/api/bots/owned-bot/browser-panel/start", { method: "POST", body: '{"profile":"guest"}' });
    expect(h.latest()).toMatchObject({ state: idle, frame: null, busy: null, error: "Guest failed to launch" });
  });

  it("blocks duplicate navigation, stop, profile and poll requests while an action is pending", async () => {
    const h = harness();
    await h.session.pull();
    const navigation = deferred<BrowserPreviewState>();
    h.request.mockReturnValueOnce(navigation.promise);
    const completion = h.session.navigate(" https://example.com/next ");
    await Promise.all([h.session.navigate("https://example.com/duplicate"), h.session.stop(), h.session.switchProfile("guest"), h.session.pull()]);
    expect(h.request).toHaveBeenCalledTimes(2);
    expect(h.latest().busy).toBe("navigate");
    expect(h.request).toHaveBeenLastCalledWith("/api/bots/owned-bot/browser-panel/navigate", { method: "POST", body: '{"url":"https://example.com/next"}' });
    navigation.resolve({ ...running, url: "https://example.com/next" });
    await completion;
    expect(h.latest()).toMatchObject({ state: { url: "https://example.com/next" }, busy: null, frame: null });
  });

  it("discards a poll begun before stop rather than reviving the stopped preview", async () => {
    const h = harness();
    await h.session.pull();
    const oldRead = deferred<BrowserPreviewReply>();
    h.request.mockReturnValueOnce(oldRead.promise).mockResolvedValueOnce({ ok: true });
    const readCompletion = h.session.pull();
    await h.session.stop();
    const published = h.snapshots.length;
    oldRead.resolve({ state: running, frame: "stale-frame" });
    await readCompletion;
    expect(h.snapshots).toHaveLength(published);
    expect(h.latest()).toMatchObject({ state: idle, frame: null });
  });

  it("does not publish an old bot's late frame after disposal", async () => {
    const pending = deferred<BrowserPreviewReply>();
    const request = vi.fn().mockReturnValue(pending.promise);
    const publish = vi.fn();
    const oldBot = createBrowserPreviewSession("old-bot", request, publish);
    const completion = oldBot.pull();
    oldBot.dispose();
    pending.resolve({ state: running, frame: "old-bot-frame" });
    await completion;
    await oldBot.pull();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("/api/bots/old-bot/browser-panel/frame");
    expect(publish).not.toHaveBeenCalled();
  });

  it("does not start another old-bot profile when disposal occurs during stop", async () => {
    const h = harness();
    await h.session.pull();
    const stopping = deferred<BrowserPreviewReply>();
    h.request.mockReturnValueOnce(stopping.promise);
    const completion = h.session.switchProfile("guest");
    h.session.dispose();
    const published = h.snapshots.length;
    stopping.resolve({ ok: true });
    await completion;
    expect(h.request).toHaveBeenCalledTimes(2);
    expect(h.snapshots).toHaveLength(published);
  });

  it("surfaces poll failures, preserves the last frame, and clears the poll error on recovery", async () => {
    const h = harness();
    await h.session.pull();
    h.request.mockRejectedValueOnce(new Error("Preview service unreachable"));
    await h.session.pull();
    expect(h.latest()).toMatchObject({ state: running, frame: "initial-frame", pollError: "Preview service unreachable" });
    h.request.mockResolvedValueOnce({ state: running, frame: "recovered-frame" });
    await h.session.pull();
    expect(h.latest()).toMatchObject({ frame: "recovered-frame", pollError: null });
  });

  it("keeps a failed navigation visible even when polling succeeds", async () => {
    const h = harness();
    await h.session.pull();
    h.request.mockRejectedValueOnce(new Error("That address is not allowed"));
    await h.session.navigate("file:///invalid-fixture");
    expect(h.latest()).toMatchObject({ state: running, frame: "initial-frame", error: "That address is not allowed", busy: null });
    h.request.mockResolvedValueOnce({ state: running, frame: "same-page" });
    await h.session.pull();
    expect(h.latest().error).toBe("That address is not allowed");
  });
});
