import { describe, expect, it } from "vitest";
import { buildReceipt, formatDuration, renderReceiptText } from "./receipts.js";

const BASE = {
  botName: "Compass",
  taskTitle: "Weekly competitor sweep",
  createdAt: Date.parse("2026-08-26T09:00:00Z"),
  finishedAt: Date.parse("2026-08-26T09:04:30Z"),
  usage: { input: 1200, output: 340, costUsd: 0.0123, turns: 3 },
  finalWord: "Found 4 rivals. Wrote the digest to competitors.md.",
};

describe("formatDuration", () => {
  it("renders seconds, minutes and hours", () => {
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(270_000)).toBe("4m 30s");
    expect(formatDuration(3_600_000 + 120_000)).toBe("1h 2m");
    expect(formatDuration(-5)).toBe("—");
  });
});

describe("buildReceipt", () => {
  it("captures duration, usage and the bot's final word", () => {
    const r = buildReceipt(BASE);
    expect(r.bot).toBe("Compass");
    expect(r.durationHuman).toBe("4m 30s");
    expect(r.turns).toBe(3);
    expect(r.tokensIn).toBe(1200);
    expect(r.costUsd).toBeCloseTo(0.0123);
    expect(r.result).toBe("done");
    expect(r.summary).toContain("competitors.md");
  });

  it("collapses whitespace in the summary and caps its length", () => {
    const r = buildReceipt({ ...BASE, finalWord: `line one\n\nline   two ${"x".repeat(400)}` });
    expect(r.summary).not.toMatch(/\n/);
    expect(r.summary.length).toBeLessThanOrEqual(280);
  });

  it("reports no-reply when the bot never answered", () => {
    const r = buildReceipt({ ...BASE, finalWord: null, usage: undefined });
    expect(r.result).toBe("no-reply");
    expect(r.turns).toBe(0);
    expect(r.costUsd).toBeNull();
  });

  it("never produces a negative duration", () => {
    const r = buildReceipt({ ...BASE, finishedAt: BASE.createdAt - 1000 });
    expect(r.durationMs).toBe(0);
  });
});

describe("renderReceiptText", () => {
  it("includes the job, bot, spend and summary", () => {
    const text = renderReceiptText(buildReceipt(BASE));
    expect(text).toContain("Weekly competitor sweep");
    expect(text).toContain("Compass");
    expect(text).toContain("$0.0123");
    expect(text).toContain("bots with receipts");
  });

  it("renders n/a cost when no turn reported one", () => {
    const text = renderReceiptText(buildReceipt({ ...BASE, usage: { ...BASE.usage!, costUsd: null } }));
    expect(text).toContain("Cost: n/a");
  });
});
