import { describe, expect, it } from "vitest";

import { startBargeInMonitor } from "./barge-in-monitor";

describe("barge-in monitor", () => {
  it("resolves null when the capture API is unavailable (headless/jsdom)", async () => {
    // jsdom has no navigator.mediaDevices — the honest degradation path the
    // call room surfaces as a note instead of a dead promise.
    await expect(startBargeInMonitor({ onTrip: () => {} })).resolves.toBeNull();
  });
});
