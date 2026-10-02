import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_THEME, THEMES, THEME_IDS, applyTheme, isThemeId, readTheme, restoreTheme } from "./skins";

afterEach(() => vi.unstubAllGlobals());

function browserSkin(stored: string | null) {
  const dataset: DOMStringMap = {};
  const storage = { getItem: vi.fn(() => stored), setItem: vi.fn() };
  const setTitleBarOverlay = vi.fn(async () => true);
  vi.stubGlobal("document", { documentElement: { dataset } });
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("window", { ogb: { setTitleBarOverlay } });
  return { dataset, storage, setTitleBarOverlay };
}

describe("skins", () => {
  it("adds Light without changing the existing saved theme ids or their order", () => {
    expect(THEMES.map((theme) => theme.id)).toEqual([...THEME_IDS]);
    expect(THEME_IDS).toEqual(["midnight", "atelier", "foundry", "lagoon", "light"]);
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

  it("carries literal overlay tints the Windows caption strip can accept", () => {
    for (const theme of THEMES) {
      // The main-process handler rejects anything but #rrggbb hex; the CSS
      // palette these mirror is all lowercase hex, so hold that line here.
      expect(theme.overlay.color).toMatch(/^#[0-9a-f]{6}$/);
      expect(theme.overlay.symbolColor).toMatch(/^#[0-9a-f]{6}$/);
      // A glyph color that equals the strip would hide the caption buttons.
      expect(theme.overlay.symbolColor).not.toBe(theme.overlay.color);
    }
    // Midnight must keep the exact pre-skin-follow look on a fresh install.
    expect(THEMES[0].overlay).toEqual({ color: "#070707", symbolColor: "#b5b5b5" });
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

  it.each(THEME_IDS)("restores saved %s and its Windows overlay without rewriting storage", (id) => {
    const browser = browserSkin(id);
    restoreTheme();
    expect(browser.dataset.theme).toBe(id);
    expect(browser.storage.getItem).toHaveBeenCalledWith("omb-skin");
    expect(browser.storage.setItem).not.toHaveBeenCalled();
    expect(browser.setTitleBarOverlay).toHaveBeenCalledExactlyOnceWith(THEMES.find((theme) => theme.id === id)!.overlay);
  });

  it.each(THEME_IDS)("persists an explicit %s choice using the established storage key", (id) => {
    const browser = browserSkin("foundry");
    applyTheme(id);
    expect(browser.dataset.theme).toBe(id);
    expect(browser.storage.setItem).toHaveBeenCalledExactlyOnceWith("omb-skin", id);
    expect(browser.setTitleBarOverlay).toHaveBeenCalledExactlyOnceWith(THEMES.find((theme) => theme.id === id)!.overlay);
  });

  it("falls back on an unknown saved id without erasing the stored choice", () => {
    const browser = browserSkin("unknown-from-a-newer-build");
    restoreTheme();
    expect(browser.dataset.theme).toBe("midnight");
    expect(browser.storage.setItem).not.toHaveBeenCalled();
  });

  it("restores the default when storage reads are blocked", () => {
    const browser = browserSkin(null);
    browser.storage.getItem.mockImplementation(() => { throw new Error("Storage blocked"); });
    expect(readTheme()).toBe("midnight");
    expect(() => restoreTheme()).not.toThrow();
    expect(browser.dataset.theme).toBe("midnight");
  });

  it("applies Light in this session when persistence is unavailable", () => {
    const browser = browserSkin("foundry");
    browser.storage.setItem.mockImplementation(() => { throw new Error("Quota exceeded"); });
    expect(() => applyTheme("light")).not.toThrow();
    expect(browser.dataset.theme).toBe("light");
    expect(browser.setTitleBarOverlay).toHaveBeenCalledExactlyOnceWith({ color: "#ffffff", symbolColor: "#626262" });
  });

  it("applies Light in browsers with no native bridge", () => {
    const browser = browserSkin(null);
    vi.stubGlobal("window", {});
    expect(() => applyTheme("light")).not.toThrow();
    expect(browser.dataset.theme).toBe("light");
    expect(browser.storage.setItem).toHaveBeenCalledWith("omb-skin", "light");
  });

  it("keeps the selected skin when native overlay synchronization rejects", async () => {
    const browser = browserSkin(null);
    browser.setTitleBarOverlay.mockRejectedValue(new Error("Native overlay unavailable"));
    applyTheme("light");
    await Promise.resolve();
    expect(browser.dataset.theme).toBe("light");
    expect(browser.storage.setItem).toHaveBeenCalledWith("omb-skin", "light");
  });

  it("aligns the Light swatch and native chrome with readable CSS palette values", () => {
    const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
    const block = css.match(/\[data-theme="light"\]\s*\{([^}]+)\}/)?.[1];
    expect(block).toBeDefined();
    expect(block).toMatch(/color-scheme:\s*light/);
    const palette = Object.fromEntries([...block!.matchAll(/--color-([a-z-]+):\s*(#[0-9a-f]{6})\s*;/g)].map(([, key, value]) => [key, value]));
    const theme = THEMES.find((entry) => entry.id === "light")!;
    expect(theme.swatch).toEqual({ surface: palette.app, panel: palette.panel, accent: palette.accent });
    expect(theme.overlay).toEqual({ color: palette.app, symbolColor: palette["ink-secondary"] });
    const luminance = (hex: string) => {
      const channels = hex.slice(1).match(/../g)!.map((channel) => parseInt(channel, 16) / 255)
        .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    };
    const contrast = (foreground: string, background: string) => {
      const [bright, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
      return (bright + 0.05) / (dark + 0.05);
    };
    for (const surface of ["app", "panel", "raised", "card", "inset"]) {
      expect(contrast(palette.ink, palette[surface])).toBeGreaterThanOrEqual(4.5);
      expect(contrast(palette["ink-secondary"], palette[surface])).toBeGreaterThanOrEqual(4.5);
      expect(contrast(palette.focus, palette[surface])).toBeGreaterThanOrEqual(3);
    }
    expect(contrast("#ffffff", palette.accent)).toBeGreaterThanOrEqual(4.5);
  });
});
