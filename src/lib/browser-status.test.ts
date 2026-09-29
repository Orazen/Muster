// The card's copy is only as honest as this decision. Each case below is a way
// the card used to promise browser tools to a bot that could not have them, or
// to stay silent about a toggle the product cannot honour.
import { describe, expect, it } from "vitest";
import { browserBlockedCount, browserCardVerdict, type BrowserStatus, type BrowserStatusEntry } from "./browser-status.js";

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
