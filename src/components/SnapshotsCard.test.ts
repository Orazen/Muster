// SnapshotsCard's pure surface — no DOM: the retention formatter, the §11
// gate sentences (in the runner's own order, with toggle-off NOT a gate),
// and the policy-view schema (strict policy/store, passthrough bookkeeping).
import { describe, expect, it } from "vitest";

import { formatRetentionCounts, snapshotsGateMissing, snapshotsPolicyReply, type SnapshotsPolicyView } from "./SnapshotsCard";

const openGateView = (): SnapshotsPolicyView => ({
  policy: { nightlyEnabled: true, retention: { recent: 7, daily: 7, weekly: 4, monthly: 6 } },
  store: { status: "available", hasPassphrase: true },
  driveConnected: true,
  health: null,
  runs: {
    lastAttemptAt: null,
    lastAttemptReason: null,
    lastSuccessAt: null,
    lastError: null,
    lastOutcome: null,
    lastDetail: null,
    consecutiveFailures: 0,
  },
  history: [],
  nextNightlyAt: 1_760_000_000_000,
});

describe("formatRetentionCounts", () => {
  it("prints the four buckets exactly as the card copy quotes them", () => {
    expect(formatRetentionCounts({ recent: 7, daily: 7, weekly: 4, monthly: 6 })).toBe("7 recent · 7 daily · 4 weekly · 6 monthly");
    expect(formatRetentionCounts({ recent: 0, daily: 30, weekly: 2, monthly: 1 })).toBe("0 recent · 30 daily · 2 weekly · 1 monthly");
  });
});

describe("snapshotsGateMissing", () => {
  it("returns null when Drive, the store and a stored passphrase all exist", () => {
    expect(snapshotsGateMissing(openGateView())).toBeNull();
  });

  it("treats nightly being OFF as a choice, not a missing gate", () => {
    const view = openGateView();
    view.policy.nightlyEnabled = false;
    expect(snapshotsGateMissing(view)).toBeNull();
  });

  it("reports the Drive half first", () => {
    const view = { ...openGateView(), driveConnected: false };
    view.store = { status: "unavailable", hasPassphrase: false };
    expect(snapshotsGateMissing(view)).toContain("Connect Google Drive");
  });

  it("reports an unavailable store before a missing passphrase", () => {
    const view = { ...openGateView(), store: { status: "unavailable", hasPassphrase: false } as const };
    expect(snapshotsGateMissing(view)).toContain("trusted passphrase store");
  });

  it("flags the passphrase-store decision when the store is fine but empty", () => {
    const view = { ...openGateView(), store: { status: "available", hasPassphrase: false } as const };
    expect(snapshotsGateMissing(view)).toContain("passphrase-store decision is the gate");
  });
});

describe("snapshotsPolicyReply", () => {
  it("accepts the server's view and tolerates extra bookkeeping keys", () => {
    const parsed = snapshotsPolicyReply.parse({
      ...openGateView(),
      runs: { ...openGateView().runs, futureField: "ignored-not-rejected" },
      someNewServerField: true,
    });
    expect(parsed.policy.retention).toEqual({ recent: 7, daily: 7, weekly: 4, monthly: 6 });
    expect(parsed.store).toEqual({ status: "available", hasPassphrase: true });
    expect(parsed.nextNightlyAt).toBe(1_760_000_000_000);
    expect("someNewServerField" in parsed).toBe(false);
  });

  it.each([
    ["a non-numeric nightly time", { nextNightlyAt: "tomorrow" }],
    ["a strict policy extra key", { policy: { nightlyEnabled: true, retention: { recent: 7, daily: 7, weekly: 4, monthly: 6 }, surprise: 1 } }],
    ["a missing store section", { store: undefined }],
    ["a fractional retention bucket", { policy: { nightlyEnabled: true, retention: { recent: 1.5, daily: 7, weekly: 4, monthly: 6 } } }],
    ["a bad outcome enum", { runs: { lastAttemptAt: 1, lastAttemptReason: "manual", lastSuccessAt: 1, lastError: null, lastOutcome: "maybe", lastDetail: "", consecutiveFailures: 0 } }],
  ])("rejects %s", (_label, override) => {
    expect(snapshotsPolicyReply.safeParse({ ...openGateView(), ...override }).success).toBe(false);
  });
});
