// The seed-engine pick: a brand-new bot must not be born onto an installed
// CLI with expired auth (`authenticated === false`) — every send fails with
// "OAuth session expired" and the first run looks broken. Reproduced live:
// the wizard listed Droid/Antigravity READY while the seed bot sat on an
// expired Claude. The rule mirrors the wizard's engineReady (Onboarding.tsx).
import { describe, expect, it } from "vitest";
import { pickSeedEngine, type SeedCandidate } from "./model-selection.ts";

const candidate = (overrides: Partial<SeedCandidate> & { id: string }): SeedCandidate => ({
  instanceId: overrides.id,
  driverKind: overrides.driverKind ?? "droid",
  models: overrides.models ?? { default: `${overrides.id}-model` },
  snapshot: overrides.snapshot ?? { state: "available" },
});

describe("pickSeedEngine", () => {
  it("prefers claudeAgent when it is signed in", () => {
    const pick = pickSeedEngine([
      candidate({ id: "droid", driverKind: "droid" }),
      candidate({ id: "claude", driverKind: "claudeAgent", snapshot: { state: "available" } }),
    ]);
    expect(pick).toEqual({ instanceId: "claude", model: "claude-model" });
  });

  it("skips an expired-auth claudeAgent for a signed-in engine (the live bug)", () => {
    const pick = pickSeedEngine([
      candidate({ id: "claude", driverKind: "claudeAgent", snapshot: { state: "available", authenticated: false } }),
      candidate({ id: "droid", driverKind: "droid", snapshot: { state: "available" } }),
    ]);
    expect(pick).toEqual({ instanceId: "droid", model: "droid-model" });
  });

  it("falls back to the unsigned-in claudeAgent when nothing is signed in", () => {
    // Legacy shape preserved: an installed engine still beats an empty
    // selection — signing in afterwards fixes the bot with no surgery.
    const pick = pickSeedEngine([
      candidate({ id: "claude", driverKind: "claudeAgent", snapshot: { state: "available", authenticated: false } }),
    ]);
    expect(pick).toEqual({ instanceId: "claude", model: "claude-model" });
  });

  it("keeps the first signed-in engine when the preferred kind is unsigned-in and two options exist", () => {
    const pick = pickSeedEngine([
      candidate({ id: "antigravity", driverKind: "antigravity", snapshot: { state: "available" } }),
      candidate({ id: "claude", driverKind: "claudeAgent", snapshot: { state: "available", authenticated: false } }),
      candidate({ id: "hermes", driverKind: "antigravity", snapshot: { state: "available" } }),
    ]);
    expect(pick.instanceId).toBe("antigravity");
  });

  it("returns an honest empty selection when no engine is available", () => {
    expect(pickSeedEngine([])).toEqual({ instanceId: "", model: "" });
  });
});
