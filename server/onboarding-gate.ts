// Per-account onboarding gate — the server-side half of the first-run
// wizard state.
//
// The wizard's dismissal used to live only in localStorage, keyed by user
// id. That split the decision along browser and login-method lines: an
// account that completed onboarding through email sign-in saw the wizard
// again on its next Google sign-in (different browser, cleared storage, or
// a refetch flicker that wrote the key under "legacy"), and vice versa.
// This module is the shared truth: one JSON file in DATA_DIR keyed by
// better-auth user id, so the gate follows the ACCOUNT, whichever way it
// signed in. localStorage remains a fast-path cache in front of it.
//
// House persistence pattern (see why-journal.ts): one JSON file per data
// dir, written through writeFileAtomic with mode 0600, zod-validated on
// load, and a corrupt or unrecognized file starts empty rather than
// wedging sign-in.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { parseJson } from "./schema.ts";

/** File name (inside DATA_DIR) of the persisted gate map. */
export const ONBOARDING_GATE_FILE = "onboarding-gate.json";

/** How an account finished the wizard. */
export type OnboardingStatus = "submitted" | "skipped";

const gateFileSchema = z.object({
  version: z.literal(1),
  gates: z.record(z.string(), z.enum(["submitted", "skipped"])),
});

type GateFile = z.infer<typeof gateFileSchema>;

const gatePath = (dataDir: string) => join(dataDir, ONBOARDING_GATE_FILE);

// In-memory cache keyed by file path so tests can use throwaway data dirs.
const gates = new Map<string, GateFile["gates"]>();

function loadGate(path: string): GateFile["gates"] {
  const cached = gates.get(path);
  if (cached) return cached;
  let map: GateFile["gates"] = {};
  if (existsSync(path)) {
    try {
      const parsed = gateFileSchema.safeParse(
        // SAFETY: parseJson returns JSON-compatible values by contract; the
        // Zod gateFileSchema above is the actual validation step.
        parseJson(readFileSync(path, "utf8")),
      );
      if (parsed.success) map = parsed.data.gates;
      // A corrupt or unrecognized file starts empty — the gate is a UX
      // nicety, never worth blocking sign-in over.
    } catch {
      // Same posture for unreadable files: start empty.
    }
  }
  gates.set(path, map);
  return map;
}

/** Whether this account has already been through onboarding, and how. */
export function readOnboardingStatus(dataDir: string, userId: string): OnboardingStatus | undefined {
  return loadGate(gatePath(dataDir))[userId];
}

/** Record that this account finished (or skipped) onboarding. Persisted
 * synchronously — a flag lost to a crash means the wizard greets a user
 * who already did this, which is the bug this module exists to kill. */
export function setOnboardingStatus(dataDir: string, userId: string, status: OnboardingStatus): void {
  const path = gatePath(dataDir);
  const map = loadGate(path);
  map[userId] = status;
  gates.set(path, map);
  const file: GateFile = { version: 1, gates: map };
  writeFileAtomic(path, JSON.stringify(file, null, 2), { mode: 0o600 });
}

/** Test helper: drop the in-memory map for a path. Not used by production
 * code paths. */
export function resetOnboardingGateForTest(dataDir: string): void {
  gates.delete(gatePath(dataDir));
}
