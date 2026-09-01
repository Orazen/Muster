import { describe, expect, it, vi } from "vitest";

import { runRepairs, safeRepairs, type DoctorReport, type RepairCandidate } from "./doctor-repairs.ts";

const healthy: DoctorReport = {
  schemaVersion: 1,
  engines: [
    {
      schemaVersion: 1,
      instanceId: "codex:main",
      engine: "codex",
      access: "subscription",
      ok: true,
      checks: [
        { name: "binary-reachable", ok: true, detail: "engine binary found and responding" },
        { name: "models-loaded", ok: true, detail: "12 models" },
      ],
      repair: null,
    },
  ],
};

const modelsLoadFail: DoctorReport = {
  schemaVersion: 1,
  engines: [
    {
      schemaVersion: 1,
      instanceId: "claude:main",
      engine: "claude",
      access: "subscription",
      ok: false,
      checks: [
        { name: "binary-reachable", ok: true, detail: "engine binary found and responding" },
        { name: "models-loaded", ok: false, detail: "0 models" },
      ],
      repair: "Check that the claude CLI is on PATH, or pick another engine in Settings → Engines",
    },
  ],
};

const installNeeded: DoctorReport = {
  schemaVersion: 1,
  engines: [
    {
      schemaVersion: 1,
      instanceId: "gemini:main",
      engine: "gemini",
      access: "byo-key",
      ok: false,
      checks: [
        { name: "binary-reachable", ok: false, detail: "not found" },
        { name: "models-loaded", ok: false, detail: "0 models" },
      ],
      repair: "Install the gemini CLI with npm install -g @google/gemini-cli",
    },
  ],
};

describe("safeRepairs", () => {
  it("classifies a healthy report as needing no repairs", () => {
    expect(safeRepairs(healthy)).toEqual([]);
  });

  it("offers reload-instances as auto-safe when models fail to load", () => {
    const repairs = safeRepairs(modelsLoadFail);
    expect(repairs).toEqual([
      {
        action: "reload-instances",
        safe: true,
        requiresApproval: false,
        detail: "re-register provider instances from the vault to refresh PATH and model lists",
      },
    ]);
  });

  it("keeps install-shaped repairs behind approval as rescan-path", () => {
    const repairs = safeRepairs(installNeeded);
    expect(repairs).toEqual([
      {
        action: "rescan-path",
        safe: false,
        requiresApproval: true,
        detail: "Install the gemini CLI with npm install -g @google/gemini-cli",
      },
    ]);
  });
});

describe("runRepairs", () => {
  it("runs the safe action through the injected hook and reports success", async () => {
    const reloadInstances = vi.fn(async () => {});
    const outcomes = await runRepairs(safeRepairs(modelsLoadFail), { reloadInstances });
    expect(reloadInstances).toHaveBeenCalledOnce();
    expect(outcomes).toEqual([
      { action: "reload-instances", ok: true, detail: "provider instances re-registered from the vault" },
    ]);
  });

  it("does nothing when no candidate is safe (rescan-path needs approval)", async () => {
    const reloadInstances = vi.fn(async () => {});
    const candidates: RepairCandidate[] = safeRepairs(installNeeded);
    expect(candidates[0].action).toBe("rescan-path");
    const outcomes = await runRepairs(candidates, { reloadInstances });
    expect(reloadInstances).not.toHaveBeenCalled();
    expect(outcomes).toEqual([]);
  });

  it("turns a hook failure into that action's unsuccessful outcome", async () => {
    const reloadInstances = vi.fn(async () => {
      throw new Error("vault unreadable");
    });
    const outcomes = await runRepairs(safeRepairs(modelsLoadFail), { reloadInstances });
    expect(outcomes).toEqual([{ action: "reload-instances", ok: false, detail: "vault unreadable" }]);
  });
});

// Keep the candidate type referenced so noUnusedLocals stays honest if the
// shape is ever reworked: both lists flow through the same classifier.
describe("RepairCandidate flow", () => {
  it("mixed reports produce one candidate per unhealthy engine", () => {
    const mixed: DoctorReport = {
      schemaVersion: 1,
      engines: [...modelsLoadFail.engines, ...installNeeded.engines],
    };
    const candidates: RepairCandidate[] = safeRepairs(mixed);
    expect(candidates.map((c) => c.safe)).toEqual([true, false]);
  });
});
