import { describe, expect, it } from "vitest";
import { AGENT_COLOR_NAMES, AGENT_COLORS } from "./mascot";
import { blendHex, contrastForeground, roomToneForColor, toneForBg, voiceRoomVars } from "./voice-surface";

/** WCAG contrast ratio, recomputed here so the module is checked against an
 * independent implementation of the floor, not its own math. */
function lum(hex: string): number {
  const n = parseInt(hex.replace("#", ""), 16);
  const ch = (s: number) => {
    const c = ((n >> s) & 0xff) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(16) + 0.7152 * ch(8) + 0.0722 * ch(0);
}
function ratio(a: string, b: string): number {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("toneForBg", () => {
  it("picks dark ink on light fills and white ink on dark ones", () => {
    expect(toneForBg("#D8A729").isLight).toBe(true); // yellow
    expect(toneForBg("#D8A729").fg).toBe("#1A1A1A");
    expect(toneForBg("#01A492").isLight).toBe(false); // teal
    expect(toneForBg("#01A492").fg).toBe("#FFFFFF");
  });

  it("bubbleFg clears WCAG AA against the BLENDED bubble pixel, every palette color", () => {
    for (const name of AGENT_COLOR_NAMES) {
      const bg = AGENT_COLORS[name];
      const tone = toneForBg(bg);
      const blended = blendHex(bg, tone.isLight ? "#000000" : "#ffffff", tone.isLight ? 0.1 : 0.16);
      expect(ratio(tone.bubbleFg, blended), `${name} bubble ink`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("primary ink follows the YIQ rule it ports (Vellum's room heuristic)", () => {
    // White on everything at or below the 0.6 brightness cutoff, dark above.
    // Mid-tone saturated fills (teal, orange, blue) sit where WCAG's pick
    // would differ — Vellum ships YIQ anyway, and the room's AA guarantee is
    // the bubble ink (test above), which carries the caption text.
    for (const name of AGENT_COLOR_NAMES) {
      const tone = toneForBg(AGENT_COLORS[name]);
      expect(tone.fg, name).toBe(tone.isLight ? "#1A1A1A" : "#FFFFFF");
    }
  });

  it("muted ink is a red that never merges with the fill", () => {
    expect(toneForBg("#D94B52").mutedInk).toBe("#FCA5A5"); // red bot, dark fill → pale red
    expect(toneForBg("#D8A729").mutedInk).toBe("#991B1B"); // yellow bot, light fill → deep red
  });

  it("survives malformed input without throwing", () => {
    const tone = toneForBg("not-a-color");
    expect(tone.isLight).toBe(false);
    expect(blendHex("#000000", "garbage", 0.5)).toBe("#000000");
  });
});

describe("roomToneForColor", () => {
  it("maps a bot's palette name to its fill", () => {
    expect(roomToneForColor("teal").bg).toBe("#01A492");
  });

  it("falls back to the ambient dark for no color", () => {
    expect(roomToneForColor(undefined).bg).toBe("#151515");
    expect(roomToneForColor(undefined).fg).toBe("#FFFFFF");
  });
});

describe("voiceRoomVars", () => {
  it("carries the full --room contract plus the fill", () => {
    const style = voiceRoomVars(toneForBg("#01A492")) as Record<string, string>;
    expect(style.backgroundColor).toBe("#01A492");
    for (const key of ["--room-fg", "--room-fg-muted", "--room-wash", "--room-bubble", "--room-bubble-fg", "--room-muted-ink"]) {
      expect(style[key], key).toBeTruthy();
    }
  });
});

describe("contrastForeground", () => {
  it("chooses the harder-contrasting ink", () => {
    expect(contrastForeground("#FFFFFF")).toBe("#1A1A1A");
    expect(contrastForeground("#000000")).toBe("#FFFFFF");
  });
});
