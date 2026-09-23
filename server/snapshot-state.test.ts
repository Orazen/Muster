// Snapshot automation state (B1): the policy the Settings card edits, the
// healthy marker deletion safety rests on, and the run log — including the
// section-level .catch that keeps one corrupt section from discarding the
// healthy marker with it.
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import {
  RETENTION_DEFAULTS,
  defaultSnapshotState,
  markSnapshotHealth,
  readSnapshotState,
  recordSnapshotRun,
  writeSnapshotPolicy,
} from "./snapshot-state.ts";

const DIR = join(DATA_DIR, "snapshot-state");
const FILE = join(DIR, "automation.json");

function writeRawFile(contents: string): void {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  writeFileSync(FILE, contents, { mode: 0o600 });
}

beforeEach(() => {
  rmSync(FILE, { force: true });
});

describe("readSnapshotState", () => {
  it("returns the defaults on first run — nightly on, the 7/7/4/6 ladder, no healthy point", () => {
    expect(readSnapshotState()).toEqual(defaultSnapshotState());
    expect(readSnapshotState().policy).toEqual({ nightlyEnabled: true, retention: RETENTION_DEFAULTS });
    expect(readSnapshotState().health).toBeNull();
  });

  it("keeps valid sections when another section is corrupt (section-level .catch)", () => {
    writeRawFile(
      JSON.stringify({
        version: 1,
        policy: { nightlyEnabled: false, retention: { recent: 3, daily: 3, weekly: 2, monthly: 2 } },
        health: "corrupt-not-an-object",
        runs: { nonsense: true },
        history: "not-an-array",
      }),
    );
    const state = readSnapshotState();
    expect(state.policy).toEqual({ nightlyEnabled: false, retention: { recent: 3, daily: 3, weekly: 2, monthly: 2 } });
    expect(state.health).toBeNull();
    expect(state.runs.consecutiveFailures).toBe(0);
    expect(state.history).toEqual([]);
  });

  it("treats unparseable file contents as first run", () => {
    writeRawFile("{not json at all");
    expect(readSnapshotState()).toEqual(defaultSnapshotState());
  });
});

describe("writeSnapshotPolicy", () => {
  it("round-trips the toggle and counts through a 0600 file in a 0700 directory", () => {
    writeSnapshotPolicy({ nightlyEnabled: false, retention: { recent: 1, daily: 2, weekly: 3, monthly: 4 } });
    expect(readSnapshotState().policy).toEqual({ nightlyEnabled: false, retention: { recent: 1, daily: 2, weekly: 3, monthly: 4 } });
    expect(statSync(FILE).mode & 0o777).toBe(0o600);
    expect(statSync(DIR).mode & 0o777).toBe(0o700);
  });

  it("throws instead of silently dropping an invalid policy", () => {
    expect(() => writeSnapshotPolicy({ nightlyEnabled: true, retention: { recent: -1, daily: 7, weekly: 4, monthly: 6 } })).toThrow();
    expect(() => writeSnapshotPolicy({ nightlyEnabled: true, retention: { recent: 61, daily: 7, weekly: 4, monthly: 6 } })).toThrow();
    expect(readSnapshotState().policy).toEqual({ nightlyEnabled: true, retention: RETENTION_DEFAULTS });
  });

  it("preserves the healthy marker and run history across a policy edit", () => {
    markSnapshotHealth({ snapshotId: "keep-me", name: "muster-workspace-v2-1-deadbeef.enc", verifiedAt: 1_000 });
    writeSnapshotPolicy({ nightlyEnabled: false, retention: RETENTION_DEFAULTS });
    expect(readSnapshotState().health?.snapshotId).toBe("keep-me");
  });
});

describe("markSnapshotHealth", () => {
  it("records the verified point and rejects malformed markers (the runner must see the failure)", () => {
    markSnapshotHealth({ snapshotId: "snap-1", name: "muster-workspace-v2-1700000000000-deadbeef.enc", verifiedAt: 1_700_000_000_000 });
    expect(readSnapshotState().health).toEqual({
      snapshotId: "snap-1",
      name: "muster-workspace-v2-1700000000000-deadbeef.enc",
      verifiedAt: 1_700_000_000_000,
    });
    expect(() => markSnapshotHealth({ snapshotId: "", name: "x", verifiedAt: 1 })).toThrow();
    expect(() => markSnapshotHealth({ snapshotId: "x", name: "x", verifiedAt: -1 })).toThrow();
    expect(readSnapshotState().health?.snapshotId).toBe("snap-1"); // failed write left the old marker intact
  });
});

describe("recordSnapshotRun", () => {
  const entry = (outcome: "success" | "failed" | "skipped", at: number) => ({
    at,
    reason: "nightly",
    outcome,
    detail: outcome === "failed" ? "upload rejected" : outcome,
  });

  it("advances the runs view: success zeroes failures, failure stores the error and counts up", () => {
    recordSnapshotRun(entry("failed", 1_000));
    recordSnapshotRun(entry("failed", 2_000));
    expect(readSnapshotState().runs).toMatchObject({
      lastAttemptAt: 2_000,
      lastOutcome: "failed",
      lastError: "upload rejected",
      lastSuccessAt: null,
      consecutiveFailures: 2,
    });
    recordSnapshotRun(entry("success", 3_000));
    expect(readSnapshotState().runs).toMatchObject({
      lastAttemptAt: 3_000,
      lastOutcome: "success",
      lastError: null,
      lastSuccessAt: 3_000,
      consecutiveFailures: 0,
    });
  });

  it("caps history at the newest 20 entries", () => {
    for (let i = 1; i <= 25; i++) recordSnapshotRun(entry("success", i));
    const { history } = readSnapshotState();
    expect(history).toHaveLength(20);
    expect(history[0]?.at).toBe(6);
    expect(history[19]?.at).toBe(25);
  });

  it("never throws into the run it describes — an invalid entry is dropped, state untouched", () => {
    recordSnapshotRun(entry("success", 5_000));
    expect(() => recordSnapshotRun({ at: -1, reason: "", outcome: "success", detail: "" })).not.toThrow();
    const state = readSnapshotState();
    expect(state.history).toHaveLength(1);
    expect(state.runs.lastAttemptAt).toBe(5_000);
  });

  it("stores what it read back byte-for-byte (history entries survive a round trip)", () => {
    recordSnapshotRun({ at: 42, reason: "pre-restore", outcome: "success", detail: "sealed", uploadedId: "snap-9", pruned: 2, pruneFailed: 1 });
    expect(readSnapshotState().history).toHaveLength(1);
    expect(readSnapshotState().history[0]).toEqual({
      at: 42,
      reason: "pre-restore",
      outcome: "success",
      detail: "sealed",
      uploadedId: "snap-9",
      pruned: 2,
      pruneFailed: 1,
    });
  });
});
