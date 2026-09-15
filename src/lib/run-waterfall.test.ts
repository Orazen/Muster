import { describe, expect, it } from "vitest";

import { buildRunWaterfall, formatStepDuration, stepLabel } from "./run-waterfall";

const steps = (over: Array<Partial<{ id: string; name: string; ok: boolean | undefined; at: number }>>) =>
  over.map((o, i) => ({
    id: o.id ?? `s${i}`,
    name: o.name ?? `mcp__muster-computer__tool${i}`,
    ok: "ok" in o ? o.ok : true,
    at: o.at ?? 1_000 * i,
  }));

describe("buildRunWaterfall", () => {
  it("returns null for shapes with no interesting story", () => {
    expect(buildRunWaterfall(steps([{ at: 0 }]))).toBeNull(); // single step
    expect(buildRunWaterfall(steps([{ at: 0 }, { at: 500 }]))).toBeNull(); // sub-second
  });

  it("models each step as the wait its report ended; bars sum to the span", () => {
    const w = buildRunWaterfall(
      steps([{ at: 10_000 }, { at: 13_000 }, { at: 21_000 }]),
    );
    expect(w).not.toBeNull();
    expect(w!.totalMs).toBe(11_000);
    const [first, second, third] = w!.steps;
    expect(first.durationMs).toBe(0); // anchor: no measurable predecessor
    expect(second.durationMs).toBe(3_000);
    expect(third.durationMs).toBe(8_000);
    // geometry: the third bar starts where the second ended
    expect(second.leftPct).toBeCloseTo((3_000 / 11_000) * 100, 6);
    expect(third.leftPct + third.widthPct).toBeCloseTo(100, 6);
    expect(w!.steps.reduce((s, x) => s + x.durationMs, 0)).toBe(w!.totalMs);
  });

  it("gives the running tail a bar that grows to NOW, flagged inProgress", () => {
    const w = buildRunWaterfall(
      steps([{ at: 0, ok: true }, { at: 2_000, ok: undefined }]),
      12_000,
    );
    expect(w!.totalMs).toBe(12_000);
    const tail = w!.steps[1];
    expect(tail.inProgress).toBe(true);
    expect(tail.durationMs).toBe(10_000);
    expect(tail.widthPct).toBeCloseTo(100 - (2_000 / 12_000) * 100, 6);
  });

  it("never lets a nonzero step vanish and never overflows the track", () => {
    const w = buildRunWaterfall(
      steps([{ at: 0 }, { at: 10_000 }, { at: 10_050 }]),
    );
    const tiny = w!.steps[2];
    expect(tiny.widthPct).toBeGreaterThanOrEqual(1.5);
    for (const s of w!.steps) {
      expect(s.leftPct + s.widthPct).toBeLessThanOrEqual(100.0001);
    }
  });

  it("tolerates out-of-order timestamps without negative bars", () => {
    const w = buildRunWaterfall(steps([{ at: 5_000 }, { at: 3_000 }, { at: 9_000 }]));
    for (const s of w!.steps) {
      expect(s.durationMs).toBeGreaterThanOrEqual(0);
      expect(s.offsetMs).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("labels and durations", () => {
  it("shortens MCP names to the verb, keeps plain names", () => {
    expect(stepLabel("mcp__muster-computer__click")).toBe("click");
    expect(stepLabel("Read")).toBe("Read");
  });

  it("formats durations for the tooltip column", () => {
    expect(formatStepDuration(1_234)).toBe("1.2s");
    expect(formatStepDuration(45_000)).toBe("45s");
    expect(formatStepDuration(248_000)).toBe("4m 08s");
    expect(formatStepDuration(3_720_000)).toBe("1h 02m");
  });
});
