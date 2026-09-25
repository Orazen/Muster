// The Settings → Analytics switch must be able to stop every capture,
// including the tracker's first init, and its choice must survive both
// blocked storage and an app restart.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const posthogMock = vi.hoisted(() => ({
  init: vi.fn(),
  capture: vi.fn(),
  identify: vi.fn(),
  opt_out_capturing: vi.fn(),
  opt_in_capturing: vi.fn(),
  has_opted_out_capturing: vi.fn(() => false),
}));

// oxlint-disable-next-line anti-slop/no-module-mocking -- posthog is the module's only external side effect; a DI seam would rewrite prod code just for tests
vi.mock("posthog-js", () => ({ default: posthogMock }));

const OPT_OUT_KEY = "muster:analytics-opt-out";

type FakeStorage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
};

function memoryStorage(initial: Record<string, string> = {}): FakeStorage {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key)! : null),
    setItem: (key, value) => {
      map.set(key, String(value));
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

function blockingStorage(): FakeStorage {
  const deny = () => {
    throw new Error("storage blocked");
  };
  return { getItem: deny, setItem: deny, removeItem: deny };
}

function stubStorage(storage: FakeStorage): void {
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("sessionStorage", storage);
}

/** Fresh module state (ready/initialized/sessionChoice) against the same
 * shared posthog mock — call once at the start of each test. */
async function loadAnalytics() {
  vi.resetModules();
  return import("./analytics");
}

beforeEach(() => {
  vi.clearAllMocks();
  posthogMock.has_opted_out_capturing.mockReturnValue(false);
  stubStorage(memoryStorage());
  vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 Electron/33.0" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it("defaults to enabled when storage holds no choice", async () => {
  const { analyticsEnabled } = await loadAnalytics();
  expect(analyticsEnabled()).toBe(true);
});

it("disables only on the exact opt-out marker", async () => {
  stubStorage(memoryStorage({ [OPT_OUT_KEY]: "1" }));
  const a = await loadAnalytics();
  expect(a.analyticsEnabled()).toBe(false);

  stubStorage(memoryStorage({ [OPT_OUT_KEY]: "0" }));
  expect(a.analyticsEnabled()).toBe(true);
});

it("keeps the in-session choice when storage itself is blocked", async () => {
  stubStorage(blockingStorage());
  const a = await loadAnalytics();
  // no stored choice to honor — the pre-existing default is enabled
  expect(a.analyticsEnabled()).toBe(true);
  expect(() => a.setAnalyticsEnabled(false)).not.toThrow();
  // the choice could not be persisted, but it still gates this session
  expect(a.analyticsEnabled()).toBe(false);
  a.initAnalytics();
  expect(posthogMock.init).not.toHaveBeenCalled();
  a.track("anything");
  expect(posthogMock.capture).not.toHaveBeenCalled();
});

it("captures one install marker and one open, and init is idempotent", async () => {
  const a = await loadAnalytics();
  a.initAnalytics();
  a.initAnalytics();
  expect(posthogMock.init).toHaveBeenCalledTimes(1);
  expect(posthogMock.capture).toHaveBeenNthCalledWith(1, "app_first_open", {
    platform: "desktop",
  });
  expect(posthogMock.capture).toHaveBeenNthCalledWith(2, "app_opened", {
    platform: "desktop",
  });
  expect(posthogMock.capture).toHaveBeenCalledTimes(2);
});

it("never loads the tracker when the stored choice is opted out", async () => {
  stubStorage(memoryStorage({ [OPT_OUT_KEY]: "1" }));
  const a = await loadAnalytics();
  a.initAnalytics();
  expect(posthogMock.init).not.toHaveBeenCalled();
  expect(posthogMock.capture).not.toHaveBeenCalled();
});

it("clears a stale posthog-side opt-out on a fresh enabled init", async () => {
  // our marker is absent (enabled) but PostHog still remembers its own flag
  posthogMock.has_opted_out_capturing.mockReturnValue(true);
  const a = await loadAnalytics();
  a.initAnalytics();
  expect(posthogMock.init).toHaveBeenCalledTimes(1);
  expect(posthogMock.opt_in_capturing).toHaveBeenCalledTimes(1);
  a.track("feature_used");
  expect(posthogMock.capture).toHaveBeenCalledWith("feature_used", undefined);
});

it("opts out mid-session: posthog is told, every later call is dropped", async () => {
  const storage = memoryStorage();
  stubStorage(storage);
  const a = await loadAnalytics();
  a.initAnalytics();
  a.setAnalyticsEnabled(false);
  expect(posthogMock.opt_out_capturing).toHaveBeenCalledTimes(1);
  expect(storage.getItem(OPT_OUT_KEY)).toBe("1");

  a.track("composer_sent", { n: 1 });
  a.identifyEmail("person@example.com");
  // only the two init-time events ever reached posthog
  expect(posthogMock.capture).toHaveBeenCalledTimes(2);
  expect(posthogMock.identify).not.toHaveBeenCalled();
});

it("opts back in without replaying the open event", async () => {
  const storage = memoryStorage();
  stubStorage(storage);
  const a = await loadAnalytics();
  a.initAnalytics();
  a.setAnalyticsEnabled(false);
  a.setAnalyticsEnabled(true);
  expect(posthogMock.opt_in_capturing).toHaveBeenCalledTimes(1);
  expect(storage.getItem(OPT_OUT_KEY)).toBeNull();

  a.track("feature_used");
  const calls = posthogMock.capture.mock.calls;
  expect(calls.filter(([event]) => event === "feature_used")).toHaveLength(1);
  expect(calls.filter(([event]) => event === "app_opened")).toHaveLength(1);
});

it("turns analytics on from a fresh opted-out start", async () => {
  stubStorage(memoryStorage({ [OPT_OUT_KEY]: "1" }));
  const a = await loadAnalytics();
  a.initAnalytics();
  expect(posthogMock.init).not.toHaveBeenCalled();

  a.setAnalyticsEnabled(true);
  expect(posthogMock.init).toHaveBeenCalledTimes(1);
  a.track("feature_used");
  expect(posthogMock.capture).toHaveBeenCalledWith("feature_used", undefined);
});

it("opt-out survives an app restart", async () => {
  // session 1: enable, then opt out (persists the marker)
  let a = await loadAnalytics();
  a.initAnalytics();
  a.setAnalyticsEnabled(false);

  // session 2: fresh module, same storage
  posthogMock.init.mockClear();
  posthogMock.capture.mockClear();
  a = await loadAnalytics();
  a.initAnalytics();
  a.track("anything");
  expect(posthogMock.init).not.toHaveBeenCalled();
  expect(posthogMock.capture).not.toHaveBeenCalled();
});

describe("clearOnboardingGate (Replay welcome tour)", () => {
  const REPLAY_KEY = "muster:tour-replay";

  function gateResponse(ok: boolean): Response {
    return new Response("{}", { status: ok ? 200 : 500 });
  }

  it("clears the local gate and arms replay only after the server confirms", async () => {
    const fetchMock = vi.fn().mockResolvedValue(gateResponse(true));
    vi.stubGlobal("fetch", fetchMock);
    const a = await loadAnalytics();

    expect(await a.clearOnboardingGate("user-1")).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/me/onboarding",
      expect.objectContaining({ method: "PUT" }),
    );
    // the local fast-path is dropped and the one-shot replay flag is armed
    expect(localStorage.getItem("omb-email-gate.user-1")).toBeNull();
    expect(sessionStorage.getItem(REPLAY_KEY)).toBe("1");
  });

  it("reports failure and leaves the gate intact when the server rejects the reset", async () => {
    // A 500 must not look like success: reloading here would land back on a
    // still-gated wizard, so the old code cleared the gate and reloaded into
    // a hidden tour with no error.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(gateResponse(false)));
    const a = await loadAnalytics();

    expect(await a.clearOnboardingGate("user-1")).toBe(false);
    // no replay armed — the caller stays put and can surface the error
    expect(sessionStorage.getItem(REPLAY_KEY)).toBeNull();
  });

  it("reports failure and leaves the gate intact when the network throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const a = await loadAnalytics();

    expect(await a.clearOnboardingGate("user-1")).toBe(false);
    expect(sessionStorage.getItem(REPLAY_KEY)).toBeNull();
  });

  it("tourReplayPending peeks without consuming the one-shot flag", async () => {
    const a = await loadAnalytics();
    expect(a.tourReplayPending()).toBe(false);
    a.requestTourReplay();
    // the App-level gate decision peeks; the flag must survive for the wizard
    expect(a.tourReplayPending()).toBe(true);
    expect(sessionStorage.getItem(REPLAY_KEY)).toBe("1");
    // and a later consume still gets it exactly once
    expect(a.consumeTourReplay()).toBe(true);
    expect(a.tourReplayPending()).toBe(false);
    expect(a.consumeTourReplay()).toBe(false);
  });
});
