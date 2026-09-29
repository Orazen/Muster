// The card's copy is only as honest as this decision. Each case below is a way
// the card used to promise browser tools to a bot that could not have them, or
// to stay silent about a toggle the product cannot honour.
import { describe, expect, it, vi } from "vitest";
import { setImmediate } from "node:timers/promises";
import { browserBlockedCount, browserCardVerdict, refreshBrowserStatus, type BrowserStatus, type BrowserStatusEntry } from "./browser-status.js";

function entry(overrides: Partial<BrowserStatusEntry> = {}): BrowserStatusEntry {
  return {
    id: "bot-1",
    name: "Scout",
    enabled: true,
    engineId: "eng-1",
    engineSupportsBrowser: true,
    effective: true,
    reason: null,
    ...overrides,
  };
}

function status(overrides: Partial<BrowserStatus> = {}): BrowserStatus {
  return { available: true, command: "obscura", tools: 14, status: [entry()], blockedCount: 0, ...overrides };
}

describe("browserCardVerdict", () => {
  it("confirms tools only when the engine can actually mount them", () => {
    expect(browserCardVerdict(status(), "bot-1", true)).toEqual({ kind: "ready", tools: 14 });
  });

  it("refuses to claim tools for a bot whose engine cannot mount the browser", () => {
    // The defect. `available` was true, the toggle was on, and the card said
    // "This bot gets 14 browser tools" for a bot that got none — the driver
    // does not declare `customMcp`, so the mount is skipped every turn.
    const blocked = status({
      status: [entry({ engineSupportsBrowser: false, effective: false, reason: "engine-unsupported" })],
      blockedCount: 1,
    });
    expect(browserCardVerdict(blocked, "bot-1", true)).toEqual({
      kind: "engine-unsupported",
      engineId: "eng-1",
    });
  });

  it("names the engine so the user knows what to change", () => {
    const blocked = status({
      status: [entry({ engineId: "eng-grok", engineSupportsBrowser: false, effective: false, reason: "engine-unsupported" })],
    });
    const verdict = browserCardVerdict(blocked, "bot-1", true);
    expect(verdict.kind).toBe("engine-unsupported");
    expect(verdict.kind === "engine-unsupported" && verdict.engineId).toBe("eng-grok");
  });

  it("does not blame the engine when the driver is merely unknown", () => {
    // engineId is null because no instance resolved. The claim is still false,
    // so the verdict must still refuse — an unnamed engine is not a pass.
    const blocked = status({
      status: [entry({ engineId: null, engineSupportsBrowser: false, effective: false, reason: "engine-unsupported" })],
    });
    expect(browserCardVerdict(blocked, "bot-1", true)).toEqual({ kind: "engine-unsupported", engineId: null });
  });

  it("says nothing it cannot support when status has not loaded", () => {
    expect(browserCardVerdict(null, "bot-1", true)).toEqual({ kind: "unknown" });
  });

  it("says nothing about a bot the server did not report", () => {
    // An older server, or a roster that changed under the card. Optimising to
    // "ready" here would reintroduce the original lie by another route.
    expect(browserCardVerdict(status(), "bot-other", true)).toEqual({ kind: "unknown" });
  });

  it("offers the install path when the binary is missing, whatever the toggle says", () => {
    const missing = status({
      available: false,
      command: null,
      status: [entry({ effective: false, reason: "not-installed" })],
    });
    expect(browserCardVerdict(missing, "bot-1", true)).toEqual({ kind: "not-installed" });
    expect(browserCardVerdict(missing, "bot-1", false)).toEqual({ kind: "not-installed" });
  });

  it("stays quiet about the engine while the toggle is off", () => {
    // Nothing is claimed while off, so there is nothing to correct. A bot on
    // an unsupported engine should not nag before the user has asked for it.
    const blocked = status({
      status: [entry({ enabled: false, engineSupportsBrowser: false, effective: false, reason: "off" })],
    });
    expect(browserCardVerdict(blocked, "bot-1", false)).toEqual({ kind: "off" });
  });

  it("distinguishes a vanished binary from an unsupported engine", () => {
    const vanished = status({
      available: true,
      status: [entry({ effective: false, reason: "not-installed" })],
    });
    expect(browserCardVerdict(vanished, "bot-1", true)).toEqual({ kind: "blocked-missing-binary" });
  });

  it("trusts the toggle the user is looking at, not the server's cached copy", () => {
    // The card re-reads after an install and after a toggle. If the server row
    // still says enabled while the UI says off, the UI is what the user sees.
    const stale = status({ status: [entry({ enabled: true })] });
    expect(browserCardVerdict(stale, "bot-1", false)).toEqual({ kind: "off" });
  });
});

describe("browserBlockedCount", () => {
  it("counts only enabled bots the engine cannot honour", () => {
    const fleet = status({
      status: [
        entry({ id: "a", effective: true }),
        entry({ id: "b", engineSupportsBrowser: false, effective: false, reason: "engine-unsupported" }),
        entry({ id: "c", engineSupportsBrowser: false, effective: false, reason: "engine-unsupported" }),
        entry({ id: "d", enabled: false, effective: false, reason: "off" }),
      ],
      blockedCount: 2,
    });
    expect(browserBlockedCount(fleet)).toBe(2);
  });

  it("is zero before status loads, so nothing is claimed", () => {
    expect(browserBlockedCount(null)).toBe(0);
  });
});


describe("browser card response compatibility and pending edits", () => {
  it("accepts an older machine-only envelope without crashing or claiming tools", () => {
    const legacy = JSON.parse('{"available":true,"command":"obscura","tools":14}');
    expect(browserCardVerdict(legacy, "bot-1", true)).toEqual({ kind: "unknown" });
  });
  it("does not trust a missing row array", () => {
    const malformed = JSON.parse('{"available":true,"command":"obscura","tools":14,"status":null}');
    expect(browserCardVerdict(malformed, "bot-1", true)).toEqual({ kind: "unknown" });
  });
  it("keeps a pending off-to-on edit unknown until the server confirms it", () => {
    const off = status({ status: [entry({ enabled: false, effective: false, reason: "off" })] });
    expect(browserCardVerdict(off, "bot-1", true)).toEqual({ kind: "unknown" });
  });
  it("does not report a previous engine's tools for a replacement engine", () => {
    expect(browserCardVerdict(status(), "bot-1", true, "eng-replacement")).toEqual({ kind: "unknown" });
  });
  it("does not invent an unsupported-engine reason for inconsistent capability data", () => {
    expect(browserCardVerdict(status({ status: [entry({ effective: false, reason: null })] }), "bot-1", true)).toEqual({ kind: "unknown" });
  });
});


const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

describe("browser card request ownership", () => {
  it("clears the old status immediately while waiting for a new read", async () => {
    const response = deferred<BrowserStatus>();
    const publish = vi.fn<(value: BrowserStatus | null) => void>();
    const request = vi.fn<(signal: AbortSignal) => Promise<BrowserStatus>>(() => response.promise);
    const cancel = refreshBrowserStatus(request, publish);
    expect(publish.mock.calls).toEqual([[null]]);
    await setImmediate();
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0][0].aborted).toBe(false);
    response.resolve(status());
    await setImmediate();
    expect(publish).toHaveBeenLastCalledWith(status());
    cancel();
    expect(request.mock.calls[0][0].aborted).toBe(true);
  });

  it("a held off-to-on response cannot replace the later server-confirmed toggle", async () => {
    const old = deferred<BrowserStatus>();
    const confirmed = deferred<BrowserStatus>();
    const publish = vi.fn<(value: BrowserStatus | null) => void>();
    const cancelOld = refreshBrowserStatus(() => old.promise, publish);
    await setImmediate();
    cancelOld();
    const cancelNew = refreshBrowserStatus(() => confirmed.promise, publish);
    await setImmediate();
    confirmed.resolve(status());
    await setImmediate();
    const calls = publish.mock.calls.length;
    old.resolve(status({ status: [entry({ enabled: false, effective: false, reason: "off" })] }));
    await setImmediate();
    expect(publish).toHaveBeenCalledTimes(calls);
    expect(browserCardVerdict(publish.mock.calls.at(-1)![0], "bot-1", true)).toEqual({ kind: "ready", tools: 14 });
    cancelNew();
  });

  it("a held previous-engine response cannot replace the replacement engine verdict", async () => {
    const old = deferred<BrowserStatus>();
    const publish = vi.fn<(value: BrowserStatus | null) => void>();
    const cancelOld = refreshBrowserStatus(() => old.promise, publish);
    await setImmediate();
    cancelOld();
    const blocked = status({ status: [entry({ engineId: "new-engine", engineSupportsBrowser: false, effective: false, reason: "engine-unsupported" })] });
    const cancelNew = refreshBrowserStatus(async () => blocked, publish);
    await setImmediate();
    old.resolve(status());
    await setImmediate();
    expect(publish).toHaveBeenLastCalledWith(blocked);
    expect(browserCardVerdict(publish.mock.calls.at(-1)![0], "bot-1", true, "new-engine")).toEqual({ kind: "engine-unsupported", engineId: "new-engine" });
    cancelNew();
  });

  it("a late failure from the previous read does not erase the current status", async () => {
    const old = deferred<BrowserStatus>();
    const publish = vi.fn<(value: BrowserStatus | null) => void>();
    const cancelOld = refreshBrowserStatus(() => old.promise, publish);
    await setImmediate();
    cancelOld();
    const cancelNew = refreshBrowserStatus(async () => status(), publish);
    await setImmediate();
    const calls = publish.mock.calls.length;
    old.reject(new Error("Old connection failed"));
    await setImmediate();
    expect(publish).toHaveBeenCalledTimes(calls);
    expect(publish).toHaveBeenLastCalledWith(status());
    cancelNew();
  });

  it("a current failure stays unknown and the next server-frame refresh can recover", async () => {
    const publish = vi.fn<(value: BrowserStatus | null) => void>();
    const cancelFailed = refreshBrowserStatus(async () => { throw new Error("Offline"); }, publish);
    await setImmediate();
    expect(publish).toHaveBeenLastCalledWith(null);
    cancelFailed();
    const cancelRecovered = refreshBrowserStatus(async () => status(), publish);
    await setImmediate();
    expect(publish).toHaveBeenLastCalledWith(status());
    cancelRecovered();
  });

  it("closing a card before its queued read starts does not make that request", async () => {
    const request = vi.fn(async () => status());
    const publish = vi.fn<(value: BrowserStatus | null) => void>();
    const cancel = refreshBrowserStatus(request, publish);
    cancel();
    await setImmediate();
    expect(request).not.toHaveBeenCalled();
    expect(publish.mock.calls).toEqual([[null]]);
  });

  it("closing a card while its transport ignores abort prevents later publication", async () => {
    const response = deferred<BrowserStatus>();
    const publish = vi.fn<(value: BrowserStatus | null) => void>();
    const cancel = refreshBrowserStatus(() => response.promise, publish);
    await setImmediate();
    cancel();
    response.resolve(status());
    await setImmediate();
    expect(publish.mock.calls).toEqual([[null]]);
  });

  it.each([
    '{"available":true,"command":"obscura","tools":14,"status":null}',
    '{"available":true,"command":"obscura","tools":-1,"status":[]}',
    '{"available":"true","command":"obscura","tools":14,"status":[]}',
    '{"available":true,"command":"obscura","tools":14,"status":[{"id":"bot-1","effective":"true"}]}',
  ])("does not publish a malformed runtime envelope: %s", async (payload) => {
    const publish = vi.fn<(value: BrowserStatus | null) => void>();
    const cancel = refreshBrowserStatus(async () => JSON.parse(payload), publish);
    await setImmediate();
    expect(publish.mock.calls).toEqual([[null], [null]]);
    expect(browserBlockedCount(JSON.parse(payload))).toBe(0);
    cancel();
  });

  it("retains an older machine envelope without authorizing a bot capability", async () => {
    const legacy = JSON.parse('{"available":true,"command":"obscura","tools":14}');
    const publish = vi.fn<(value: BrowserStatus | null) => void>();
    const cancel = refreshBrowserStatus(async () => legacy, publish);
    await setImmediate();
    expect(publish).toHaveBeenLastCalledWith(legacy);
    expect(browserCardVerdict(publish.mock.calls.at(-1)![0], "bot-1", true)).toEqual({ kind: "unknown" });
    expect(browserBlockedCount(publish.mock.calls.at(-1)![0])).toBe(0);
    cancel();
  });
});
