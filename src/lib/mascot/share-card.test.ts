import { describe, expect, it } from "vitest";
import {
  SHARE_CARD_HEIGHT,
  SHARE_CARD_WIDTH,
  buildShareCard,
  shareCardLayout,
} from "./share-card";

describe("buildShareCard", () => {
  it("renders a working bot honestly", () => {
    const card = buildShareCard({ name: "Mimi", color: "orange", face: "focused", busy: true });
    expect(card.face).toBe("focused");
    expect(card.line).toBe("Working — Mimi");
    expect(card.bodyHex).toBe("#f08a24");
  });

  it("a failed tool shows the problem, not a celebration", () => {
    const card = buildShareCard({ name: "Mimi", color: "orange", face: "mad", lastToolFailed: true });
    expect(card.line).toContain("Hit a problem");
  });

  it("idle cards stay silent about status but keep the name", () => {
    const card = buildShareCard({ name: "Mochi", color: "blue", face: "idle" });
    expect(card.line).toBe("");
    expect(card.name).toBe("Mochi");
    expect(card.bodyHex).toBe("#4A90D9");
  });
});

describe("shareCardLayout", () => {
  it("keeps every element inside the 1080×1440 card", () => {
    const layout = shareCardLayout(buildShareCard({ name: "X", color: "green", face: "idle" }));
    for (const at of [layout.nameAt, layout.lineAt, layout.markAt]) {
      expect(at.x).toBeGreaterThan(0);
      expect(at.x).toBeLessThan(SHARE_CARD_WIDTH);
      expect(at.y).toBeGreaterThan(0);
      expect(at.y).toBeLessThan(SHARE_CARD_HEIGHT);
    }
    const face = layout.faceRect;
    expect(face.x).toBeGreaterThanOrEqual(0);
    expect(face.x + face.size).toBeLessThanOrEqual(SHARE_CARD_WIDTH);
    expect(face.y + face.size).toBeLessThan(SHARE_CARD_HEIGHT);
  });
});
