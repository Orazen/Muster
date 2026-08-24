import { describe, expect, it } from "vitest";

import { DEFAULT_THEME, THEMES, THEME_IDS, isThemeId } from "./skins";

// Pure-logic coverage only: this suite runs in a node environment with no
// document and no storage, which is exactly why skins.ts keeps its decision
// logic separate from its DOM writes.
describe("skins", () => {
  it("ships exactly the four documented themes", () => {
    expect(THEMES.map((theme) => theme.id)).toEqual([...THEME_IDS]);
    expect(THEME_IDS).toEqual(["midnight", "atelier", "foundry", "lagoon"]);
  });

  it("labels and describes every theme for the picker", () => {
    for (const theme of THEMES) {
      expect(theme.label.length).toBeGreaterThan(0);
      expect(theme.description.length).toBeGreaterThan(0);
      expect(theme.swatch.surface).toMatch(/^#[0-9a-f]{6}$/);
      expect(theme.swatch.panel).toMatch(/^#[0-9a-f]{6}$/);
      expect(theme.swatch.accent).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("falls back to Midnight", () => {
    expect(DEFAULT_THEME).toBe("midnight");
  });

  it("accepts only known ids when validating stored values", () => {
    for (const id of THEME_IDS) {
      expect(isThemeId(id)).toBe(true);
    }
    expect(isThemeId("solarflare")).toBe(false);
    expect(isThemeId(null)).toBe(false);
    expect(isThemeId("")).toBe(false);
  });
});
