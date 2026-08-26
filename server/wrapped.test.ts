import { describe, expect, it } from "vitest";
import { buildWrapped, renderWrappedText } from "./wrapped.js";

const TUESDAY = "2026-08-25T12:00:00.000Z"; // a Tuesday

const fleet = [
  { name: "Compass", turns: 40, tokensIn: 50_000, tokensOut: 9_000, costUsd: 1.2 },
  { name: "Quill", turns: 61, tokensIn: 80_000, tokensOut: 15_000, costUsd: 2.05 },
  { name: "Idle", turns: 0, tokensIn: 0, tokensOut: 0, costUsd: null },
];

describe("buildWrapped", () => {
  it("snaps to the Monday of the given week", () => {
    expect(buildWrapped({ bots: fleet, today: TUESDAY }).weekOf).toBe("2026-08-24");
  });

  it("totals turns/tokens/cost and picks the top teammate", () => {
    const w = buildWrapped({ bots: fleet, today: TUESDAY });
    expect(w.totalTurns).toBe(101);
    expect(w.totalTokens).toBe(154_000);
    expect(w.costUsd).toBeCloseTo(3.25);
    expect(w.topBot).toBe("Quill");
    expect(w.activeBots).toBe(2);
  });

  it("handles an empty week without crashing", () => {
    const w = buildWrapped({ bots: [], today: TUESDAY });
    expect(w.totalTurns).toBe(0);
    expect(w.topBot).toBeNull();
    expect(w.headline).toContain("quiet");
  });

  it("handles null costs across the board", () => {
    const w = buildWrapped({ bots: [{ name: "A", turns: 3, tokensIn: 10, tokensOut: 5, costUsd: null }], today: TUESDAY });
    expect(w.costUsd).toBeNull();
  });
});

describe("renderWrappedText", () => {
  it("includes the week, headline, totals and top bot", () => {
    const t = renderWrappedText(buildWrapped({ bots: fleet, today: TUESDAY }));
    expect(t).toContain("2026-08-24");
    expect(t).toContain("101");
    expect(t).toContain("Quill");
    expect(t).toContain("$3.25");
  });

  it("renders n/a spend when nothing reported costs", () => {
    const t = renderWrappedText(buildWrapped({ bots: [], today: TUESDAY }));
    expect(t).toContain("Spend: n/a");
  });
});
