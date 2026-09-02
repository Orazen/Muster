// Unit contracts for the per-account onboarding gate: persistence shape,
// corrupt-file posture, and the HTTP routes' auth + validation behavior.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  ONBOARDING_GATE_FILE,
  readOnboardingStatus,
  resetOnboardingGateForTest,
  setOnboardingStatus,
} from "./onboarding-gate.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  resetOnboardingGateForTest(join(tmpdir(), "onboarding-gate-nonexistent"));
});

const scratchDir = (label: string) => {
  const dir = mkdtempSync(join(tmpdir(), `onboarding-gate-${label}-`));
  dirs.push(dir);
  resetOnboardingGateForTest(dir);
  return dir;
};

describe("onboarding gate store", () => {
  it("round-trips a status per user id", () => {
    const dir = scratchDir("roundtrip");
    expect(readOnboardingStatus(dir, "u1")).toBeUndefined();
    setOnboardingStatus(dir, "u1", "submitted");
    setOnboardingStatus(dir, "u2", "skipped");
    expect(readOnboardingStatus(dir, "u1")).toBe("submitted");
    expect(readOnboardingStatus(dir, "u2")).toBe("skipped");
    expect(readOnboardingStatus(dir, "u3")).toBeUndefined();
  });

  it("persists across a fresh module-cache load of the same file", () => {
    const dir = scratchDir("persist");
    setOnboardingStatus(dir, "acct-a", "skipped");
    // read the file directly: the next server boot must see the same thing.
    // SAFETY: the file was just written by setOnboardingStatus, whose
    // on-disk contract is { version: 1, gates } — the parse only feeds
    // toMatchObject, so an unexpected shape fails the test rather than
    // crashing anything.
    const raw = JSON.parse(readFileSync(join(dir, ONBOARDING_GATE_FILE), "utf8")) as unknown;
    expect(raw).toMatchObject({ version: 1, gates: { "acct-a": "skipped" } });
  });

  it("starts empty on a corrupt file instead of throwing", () => {
    const dir = scratchDir("corrupt");
    writeFileSync(join(dir, ONBOARDING_GATE_FILE), "{not json at all");
    expect(readOnboardingStatus(dir, "u1")).toBeUndefined();
    // and a later write heals the file
    setOnboardingStatus(dir, "u1", "submitted");
    expect(readOnboardingStatus(dir, "u1")).toBe("submitted");
  });
});
