import { describe, expect, it } from "vitest";

import { receiptFindings, type FindingMessage } from "./receipt-findings.ts";
import { buildReceipt, renderReceiptText } from "./receipts.ts";

const user = (text: string, at = 0): FindingMessage => ({ role: "user", kind: "text", text, at });
const botText = (text: string, at = 0): FindingMessage => ({ role: "bot", kind: "text", text, at });
const tool = (name: string, ok: boolean | undefined, at = 0): FindingMessage => ({
  role: "bot",
  kind: "activity",
  tool: { name, ok },
  at,
});
const card = (at = 0): FindingMessage => ({ role: "bot", kind: "options", at });

describe("receiptFindings", () => {
  it("a clean run yields no findings", () => {
    expect(receiptFindings([user("go"), tool("Read", true), botText("done")])).toEqual([]);
  });

  it("counts failed steps and names up to three distinct ones", () => {
    const findings = receiptFindings([
      tool("mcp__x__click", false),
      tool("mcp__x__click", false),
      tool("Bash", false),
      tool("Read", false),
      tool("Grep", false),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatch(/^5 failed steps: mcp__x__click, Bash, Read …$/);
  });

  it("flags a run that ended on an unanswered card, not an answered one", () => {
    expect(receiptFindings([card(0), user("option A", 1000)])).toEqual([]);
    expect(receiptFindings([user("go"), card(1000)])).toEqual([
      "ended waiting on you — a question or approval went unanswered",
    ]);
    // a later user turn answers even an earlier card
    expect(receiptFindings([card(0), botText("moved on", 1000), user("ok", 2000)])).toEqual([]);
  });

  it("flags a long silence but not ordinary pacing", () => {
    const minute = 60_000;
    expect(receiptFindings([user("a", 0), botText("b", 11 * minute)])).toEqual([
      "paused ~11 min mid-run (stall or sleep)",
    ]);
    expect(receiptFindings([user("a", 0), botText("b", 9 * minute)])).toEqual([]);
  });

  it("strips the error: prefix from engine-failure chips", () => {
    expect(receiptFindings([tool("error: provider exploded", false)]).join()).toContain("provider exploded");
  });
});

describe("findings on the receipt itself", () => {
  const BASE = {
    botName: "Compass",
    taskTitle: "Weekly competitor sweep",
    createdAt: 1_700_000_000_000,
    finishedAt: 1_700_000_060_000,
    usage: { input: 10, output: 20, costUsd: 0.0123, turns: 1 },
    finalWord: "done",
  };

  it("omits the field when there is nothing to say, renders clean", () => {
    const r = buildReceipt(BASE);
    expect("findings" in r).toBe(false);
    expect(renderReceiptText(r)).toContain("Findings: none — clean run");
  });

  it("carries findings and renders them", () => {
    const r = buildReceipt({ ...BASE, findings: ["2 failed steps: Read"] });
    expect(r.findings).toEqual(["2 failed steps: Read"]);
    expect(renderReceiptText(r)).toContain("Findings: 2 failed steps: Read");
  });
});
