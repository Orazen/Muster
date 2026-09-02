// Muster Shield — severity ordering, the auto-approve × always-allow
// interaction, budget and shield advisories, and hidden-bot silence.
import { describe, expect, it } from "vitest";

import { scanBotSecurity, type ScanBotInput } from "./security-scan.ts";

const bot = (over: Partial<ScanBotInput> = {}): ScanBotInput => ({
  id: "b1",
  name: "Scout",
  ...over,
});

describe("scanBotSecurity", () => {
  it("a default bot with a budget and Shield draws no findings", () => {
    const findings = scanBotSecurity([bot({ tokenBudget: 500_000, privacyShield: true })]);
    expect(findings).toEqual([]);
  });

  it("auto-approve + destructive always-allow is HIGH and names the entries", () => {
    const findings = scanBotSecurity([
      bot({ autoApprove: true, alwaysAllow: ["git status", "rm -rf /tmp/build"], hasComputer: true }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("high");
    expect(findings[0]!.title).toBe("Auto-approves destructive commands");
    expect(findings[0]!.detail).toContain("rm -rf /tmp/build");
  });

  it("auto-approve on a computer without destructive entries is MEDIUM", () => {
    const findings = scanBotSecurity([bot({ autoApprove: true, hasComputer: true, tokenBudget: 1 })]);
    expect(findings.map((f) => f.severity).sort()).toEqual(["medium"]);
  });

  it("missing budget is MEDIUM; Shield-off on a cloud model is LOW", () => {
    const findings = scanBotSecurity([bot({ usesCloudModel: true, privacyShield: false })]);
    expect(findings.map((f) => f.severity).sort()).toEqual(["low", "medium"]);
    expect(findings.find((f) => f.severity === "low")!.title).toBe("Privacy Shield off");
  });

  it("Shield-off on a LOCAL model draws no privacy finding", () => {
    const findings = scanBotSecurity([bot({ usesCloudModel: false, privacyShield: false })]);
    expect(findings.map((f) => f.severity)).toEqual(["medium"]); // only the budget
  });

  it("findings come back high → medium → low", () => {
    const findings = scanBotSecurity([
      bot({ id: "low", name: "Low", usesCloudModel: true, privacyShield: false }),
      bot({ id: "high", name: "High", autoApprove: true, alwaysAllow: ["sudo reboot"], hasComputer: true }),
      bot({ id: "med", name: "Med" }),
    ]);
    // The "low" bot draws budget (medium) + shield (low); ordering is by
    // severity, then stable insertion order within a severity.
    expect(findings.map((f) => f.severity)).toEqual(["high", "medium", "medium", "low"]);
    expect(findings[0]!.botId).toBe("high");
    expect(findings[findings.length - 1]!.botId).toBe("low");
  });

  it("hidden bots stay silent", () => {
    const findings = scanBotSecurity([bot({ hidden: true })]);
    expect(findings).toEqual([]);
  });
});
