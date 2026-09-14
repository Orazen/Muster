// The gaze math is the only pure part of the tracker; the listener plumbing
// is verified by the browser pass. These pin clamping, centering and the
// attenuation falloff.
import { describe, expect, it } from "vitest";

import { computeGaze } from "./gaze";

const rect = { left: 100, top: 100, width: 40, height: 40 }; // center 120,120

describe("computeGaze", () => {
  it("is centered when the pointer sits on the element", () => {
    const g = computeGaze(rect, 120, 120, false);
    expect(g.mx).toBe(0);
    expect(g.my).toBe(0);
  });

  it("points toward the pointer and clamps to [-1,1]", () => {
    const near = computeGaze(rect, 140, 120, false);
    expect(near.mx).toBeGreaterThan(0);
    expect(near.my).toBe(0);
    const far = computeGaze(rect, 10_000, 120, false);
    expect(far.mx).toBeLessThanOrEqual(1);
    expect(far.mx).toBeGreaterThan(0.9);
    const up = computeGaze(rect, 120, -500, false);
    expect(up.my).toBeLessThan(0);
  });

  it("attenuates distant avatars toward rest", () => {
    const noAtt = computeGaze(rect, 4000, 120, false);
    const att = computeGaze(rect, 4000, 120, true);
    // same direction, smaller magnitude once attenuation applies
    expect(Math.sign(att.mx)).toBe(Math.sign(noAtt.mx));
    expect(Math.abs(att.mx)).toBeLessThan(Math.abs(noAtt.mx));
    expect(att.attenuation).toBeGreaterThanOrEqual(0.2);
    expect(att.attenuation).toBeLessThan(1);
    const close = computeGaze(rect, 125, 120, true);
    expect(close.attenuation).toBeGreaterThan(att.attenuation);
  });

  it("survives zero-size rects without dividing by zero", () => {
    const g = computeGaze({ left: 10, top: 10, width: 0, height: 0 }, 500, 10, false);
    expect(Number.isFinite(g.mx)).toBe(true);
    expect(Number.isFinite(g.my)).toBe(true);
  });
});
