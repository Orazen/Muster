import { describe, expect, it } from "vitest";
import type { TaskUsage } from "@/state/store";

import { botUsage, costCaption, formatTokens, formatUsd, sumUsage, usageChip } from "./usage";

describe("usage formatting", () => {
  it("formats token counts compactly", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(12_400)).toBe("12.4k");
    expect(formatTokens(120_000)).toBe("120k");
    expect(formatTokens(2_300_000)).toBe("2.3M");
  });

  it("keeps small dollar amounts visible", () => {
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(0.004)).toBe("$0.004");
    expect(formatUsd(0.31)).toBe("$0.31");
  });

  it("builds the chip: tokens always, cost only when known, nothing when unused", () => {
    expect(usageChip({ input: 0, output: 0, costUsd: null, turns: 0 })).toBe("");
    expect(usageChip({ input: 10_000, output: 2_400, costUsd: null, turns: 3 })).toBe("12.4k tok");
    expect(usageChip({ input: 10_000, output: 2_400, costUsd: 0.06, turns: 3 })).toBe("12.4k tok · $0.06");
  });

  it("sums across tasks and leaves cost null until one reports it", () => {
    expect(sumUsage([{ input: 1, output: 1, costUsd: null, turns: 1 }, undefined, { input: 2, output: 2, costUsd: null, turns: 1 }])).toEqual({
      input: 3,
      output: 3,
      costUsd: null,
      turns: 2,
    });
    expect(
      botUsage({
        tasks: [
          { threadId: "a", title: "", createdAt: 0, usage: { input: 5, output: 5, costUsd: 0.01, turns: 1 } },
          { threadId: "b", title: "", createdAt: 0 },
          { threadId: "c", title: "", createdAt: 0, usage: { input: 5, output: 5, costUsd: null, turns: 2 } },
        ],
      }),
    ).toEqual({ input: 10, output: 10, costUsd: 0.01, turns: 3 });
  });

  it("captions cost by billing", () => {
    expect(costCaption("subscription")).toMatch(/not billed/);
    expect(costCaption("metered")).toMatch(/API key/);
    expect(costCaption(undefined)).toMatch(/reported/);
  });

  it("renders a legacy usage chip without treating missing cost as a number", () => {
    const legacy: TaskUsage = JSON.parse('{"input":10000,"output":2400,"turns":3}');
    expect(usageChip(legacy)).toBe("12.4k tok");
  });

  it("keeps an all-unknown aggregate null when legacy records omit cost", () => {
    const legacy: TaskUsage = JSON.parse('{"input":40,"output":10,"turns":1}');
    expect(sumUsage([legacy, undefined, { input: 2, output: 3, costUsd: null, turns: 1 }])).toEqual({
      input: 42,
      output: 13,
      costUsd: null,
      turns: 2,
    });
  });

  it("preserves an explicitly reported zero among unknown costs", () => {
    const legacy: TaskUsage = JSON.parse('{"input":40,"output":10,"turns":1}');
    const total = sumUsage([legacy, { input: 10, output: 20, costUsd: 0, turns: 1 }, legacy]);
    expect(total).toEqual({ input: 90, output: 40, costUsd: 0, turns: 3 });
    expect(usageChip(total)).toBe("130 tok · $0");
  });

  it("retains reported cost when legacy tasks occur before and after it", () => {
    const legacy: TaskUsage = JSON.parse('{"input":40,"output":10,"turns":1}');
    expect(sumUsage([legacy, { input: 10, output: 20, costUsd: 0.06, turns: 1 }, legacy])).toEqual({
      input: 90,
      output: 40,
      costUsd: 0.06,
      turns: 3,
    });
  });
});
