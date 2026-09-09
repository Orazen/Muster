import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TaskUsage } from "@/state/store";
import { TaskUsageStats } from "./TaskUsageStats";

function usageText(usage?: TaskUsage): string {
  return renderToStaticMarkup(createElement(TaskUsageStats, { usage }))
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

describe("task usage evidence", () => {
  it("explains absent usage without inventing zero counters or cost", () => {
    const text = usageText();
    expect(text).toBe("Usage has not been recorded for this task yet.");
    expect(text).not.toContain("Total tokens");
    expect(text).not.toContain("$0");
  });

  it("sums input and output and identifies the scope as all settled turns", () => {
    const text = usageText({ input: 10_000, output: 2_400, costUsd: 0.31, turns: 3 });
    expect(text).toContain("Totals across this task’s settled turns.");
    expect(text).toContain("Settled turns 3");
    expect(text).toContain("Total tokens 12.4k");
    expect(text).toContain("Reported cost $0.31");
    expect(text).not.toMatch(/trend|increase|decrease|charged|%/i);
  });

  it("preserves an engine-reported zero cost", () => {
    const text = usageText({ input: 40, output: 10, costUsd: 0, turns: 1 });
    expect(text).toContain("Reported cost $0");
    expect(text).not.toContain("Not reported");
  });

  it("keeps a null cost unknown instead of presenting free execution", () => {
    const text = usageText({ input: 40, output: 10, costUsd: null, turns: 1 });
    expect(text).toContain("Reported cost Not reported");
    expect(text).not.toContain("$");
  });

  it("handles a legacy persisted record with no cost field", () => {
    // Older records predate costUsd; load the actual wire shape without a store mock.
    const legacy: TaskUsage = JSON.parse('{"input":40,"output":10,"turns":1}');
    const text = usageText(legacy);
    expect(text).toContain("Total tokens 50");
    expect(text).toContain("Reported cost Not reported");
    expect(text).not.toMatch(/\$|NaN/);
  });

  it("keeps a small reported cost visible", () => {
    const text = usageText({ input: 12, output: 8, costUsd: 0.004, turns: 1 });
    expect(text).toContain("Reported cost $0.004");
  });

  it("distinguishes recorded zero counters from absent usage", () => {
    const text = usageText({ input: 0, output: 0, costUsd: null, turns: 0 });
    expect(text).toContain("Settled turns 0");
    expect(text).toContain("Total tokens 0");
    expect(text).not.toContain("not been recorded");
  });
});
