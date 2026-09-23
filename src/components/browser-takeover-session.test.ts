import { describe, expect, it, vi } from "vitest";
import {
  createBrowserTakeoverSession,
  emptyBrowserTakeover,
  mapTakeoverClick,
  TAKEOVER_VIEWPORT,
  type BrowserTakeoverAction,
  type BrowserTakeoverSnapshot,
  type TakeoverReply,
} from "./browser-takeover-session";

const reply: TakeoverReply = { running: false, url: null, title: null, profile: "bot", error: null };

const deferred = () => {
  let resolve!: (value: TakeoverReply) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<TakeoverReply>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function harness() {
  const snapshots: BrowserTakeoverSnapshot[] = [];
  const request = vi.fn<(path: string, init?: RequestInit) => Promise<TakeoverReply>>();
  request.mockResolvedValue(reply);
  const session = createBrowserTakeoverSession("owned-bot", request, (snapshot) => snapshots.push(snapshot));
  return { request, session, snapshots, latest: () => snapshots.at(-1)! };
}

describe("takeover click mapping (fixed 1280×800 viewport)", () => {
  it("scales a click inside the frame into viewport coordinates", () => {
    const rect = { left: 100, top: 50, width: 640, height: 400 };
    expect(mapTakeoverClick({ clientX: 420, clientY: 250 }, rect)).toEqual({ x: 640, y: 400 });
  });

  it("clamps clicks on the frame edges instead of leaving the viewport", () => {
    const rect = { left: 0, top: 0, width: 320, height: 200 };
    expect(mapTakeoverClick({ clientX: -40, clientY: -10 }, rect)).toEqual({ x: 0, y: 0 });
    expect(mapTakeoverClick({ clientX: 1000, clientY: 1000 }, rect)).toEqual({ x: 1279, y: 799 });
  });

  it("keeps the viewport constant the frames are captured at", () => {
    expect(TAKEOVER_VIEWPORT).toEqual({ width: 1280, height: 800 });
  });
});

describe("takeover session request lifecycle", () => {
  it("starts empty with no request of its own", () => {
    const h = harness();
    expect(h.session.snapshot()).toEqual(emptyBrowserTakeover());
    expect(h.snapshots).toHaveLength(0);
    expect(h.request).not.toHaveBeenCalled();
  });

  it("posts each action to the bot's takeover endpoint with its JSON body", async () => {
    const h = harness();
    const actions: BrowserTakeoverAction[] = [
      { type: "click", x: 10, y: 20 },
      { type: "key", key: "Enter" },
      { type: "scroll", deltaY: -600 },
    ];
    for (const action of actions) await h.session.send(action);
    expect(h.request.mock.calls).toEqual(actions.map((action) => [
      "/api/bots/owned-bot/browser-panel/takeover",
      { method: "POST", body: JSON.stringify(action) },
    ]));
    expect(h.latest()).toMatchObject({ status: "live", busy: false, error: null });
  });

  it("clears the draft only when the sent text is still what is in the box", async () => {
    const h = harness();
    h.session.setText("hello");
    await h.session.send({ type: "text", text: "hello" });
    expect(h.latest().text).toBe("");

    const flight = deferred();
    h.request.mockReturnValueOnce(flight.promise);
    h.session.setText("typed during flight");
    const completion = h.session.send({ type: "text", text: "typed during flight" });
    h.session.setText("more typing");
    flight.resolve(reply);
    await completion;
    // The send cleared the exact sent text, then newer typing stayed put.
    expect(h.latest().text).toBe("more typing");
  });

  it("keeps an unsent draft and reports the failure when the action errors", async () => {
    const h = harness();
    h.session.setText("keep me");
    h.request.mockRejectedValueOnce(new Error("takeover action failed (HTTP 502)"));
    await h.session.send({ type: "text", text: "keep me" });
    expect(h.latest()).toMatchObject({
      status: "disconnected",
      error: "takeover action failed (HTTP 502)",
      text: "keep me",
      busy: false,
    });
  });

  it("never sends an empty text action", async () => {
    const h = harness();
    await h.session.send({ type: "text", text: "" });
    expect(h.request).not.toHaveBeenCalled();
  });

  it("blocks a second action while one is in flight", async () => {
    const h = harness();
    const flight = deferred();
    h.request.mockReturnValueOnce(flight.promise);
    const first = h.session.send({ type: "click", x: 1, y: 2 });
    await h.session.send({ type: "click", x: 3, y: 4 });
    expect(h.request).toHaveBeenCalledTimes(1);
    flight.resolve(reply);
    await first;
    expect(h.latest()).toMatchObject({ status: "live", busy: false });
  });

  it("drives live/disconnected status from screenshot load events without clobbering an in-flight action", async () => {
    const h = harness();
    h.session.markFrame(false);
    expect(h.latest().status).toBe("disconnected");
    h.session.markFrame(true);
    expect(h.latest().status).toBe("live");

    const flight = deferred();
    h.request.mockReturnValueOnce(flight.promise);
    const pending = h.session.send({ type: "key", key: "Tab" });
    h.session.markFrame(false);
    expect(h.latest().status).toBe("updating");
    flight.resolve(reply);
    await pending;
    expect(h.latest().status).toBe("live");
  });

  it("returns the console to connecting and drops the visible error on manual refresh", async () => {
    const h = harness();
    h.request.mockRejectedValueOnce(new Error("stale failure"));
    await h.session.send({ type: "scroll", deltaY: 100 });
    expect(h.latest().error).toBe("stale failure");
    h.session.refresh();
    expect(h.latest()).toMatchObject({ status: "connecting", error: null });
  });

  it("discards late replies and stops new work after disposal", async () => {
    const h = harness();
    const flight = deferred();
    h.request.mockReturnValueOnce(flight.promise);
    const pending = h.session.send({ type: "click", x: 5, y: 6 });
    const published = h.snapshots.length;
    h.session.dispose();
    flight.resolve(reply);
    await pending;
    h.session.setText("after dispose");
    await h.session.send({ type: "key", key: "Enter" });
    h.session.markFrame(true);
    h.session.refresh();
    expect(h.snapshots).toHaveLength(published);
    expect(h.request).toHaveBeenCalledTimes(1);
  });
});
