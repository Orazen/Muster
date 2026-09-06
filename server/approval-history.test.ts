import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { DecisionLog } from "./decision-log.ts";
import { approvalHistory } from "./approval-history.ts";

function newLog(): DecisionLog {
  let tick = 0;
  // unique file per instance: the constructor loads its persistence file,
  // so shared paths would leak entries across tests
  return new DecisionLog({
    file: `/tmp/approval-history-test-${randomUUID()}.json`,
    now: () => Date.now() + tick++ * 1000,
    makeId: () => `d-${tick}`,
    maxEntries: 500,
  });
}

describe("approvalHistory", () => {
  it("returns zeros and no summary for a tool the bot never used", () => {
    const h = approvalHistory(newLog(), "bot-1", "Write");
    expect(h.total).toBe(0);
    expect(h.summary).toBeNull();
    expect(h.lastDecision).toBeNull();
  });

  it("counts allowed vs denied and says never denied on a clean record", () => {
    const log = newLog();
    log.record("bot-1", { action: "Bash:git", decision: "approved", summary: "status" });
    log.record("bot-1", { action: "Bash:git", decision: "approved", summary: "commit" });
    log.record("bot-1", { action: "Bash:git", decision: "auto", summary: "pull" });
    const h = approvalHistory(log, "bot-1", "Bash:git");
    expect(h.total).toBe(3);
    expect(h.approved).toBe(2);
    expect(h.auto).toBe(1);
    expect(h.denied).toBe(0);
    expect(h.summary).toContain("allowed 3×");
    expect(h.summary).toContain("never denied");
  });

  it("calls out denials when they exist", () => {
    const log = newLog();
    log.record("bot-1", { action: "Bash:npm", decision: "approved", summary: "install" });
    log.record("bot-1", { action: "Bash:npm", decision: "denied", summary: "publish" });
    const h = approvalHistory(log, "bot-1", "Bash:npm");
    expect(h.denied).toBe(1);
    expect(h.summary).toContain("1 denied");
  });

  it("matches a bare tool across program suffixes — Bash:git informs Bash:npm", () => {
    const log = newLog();
    log.record("bot-1", { action: "Bash:git", decision: "approved", summary: "status" });
    const h = approvalHistory(log, "bot-1", "Bash:npm");
    expect(h.total).toBe(1);
    expect(h.summary).not.toBeNull();
  });

  it("strips the mcp__server__ prefix before matching", () => {
    const log = newLog();
    log.record("bot-1", { action: "mcp__browser__browser_navigate", decision: "approved", summary: "nav" });
    const h = approvalHistory(log, "bot-1", "mcp__browser__browser_navigate");
    expect(h.total).toBe(1);
    expect(h.summary).toContain("allowed 1×");
  });

  it("scopes strictly by bot — another bot's history does not leak", () => {
    const log = newLog();
    log.record("bot-1", { action: "Bash", decision: "approved", summary: "x" });
    const h = approvalHistory(log, "bot-2", "Bash");
    expect(h.total).toBe(0);
    expect(h.summary).toBeNull();
  });

  it("reports denials as data — never a gate", () => {
    const log = newLog();
    log.record("bot-1", { action: "Bash", decision: "denied", summary: "rm" });
    log.record("bot-1", { action: "Bash", decision: "denied", summary: "rm again" });
    const h = approvalHistory(log, "bot-1", "Bash");
    expect(h.denied).toBe(2);
    expect(h.summary).toContain("2 denied");
    // the module exports evidence; there is no gate to assert
  });

  it("uses the mcp prefix-insensitive bare name for the summary", () => {
    const log = newLog();
    log.record("bot-1", { action: "mcp__obscura__browser_click", decision: "approved", summary: "click" });
    const h = approvalHistory(log, "bot-1", "mcp__obscura__browser_click");
    expect(h.summary).toContain("Browser_click was allowed");
  });
});
