import { readFileSync } from "node:fs";
import { compile } from "tailwindcss";
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

function palette(block: string, prefix = "color"): Record<string, string> {
  return Object.fromEntries([...block.matchAll(new RegExp(`--${prefix}-([a-z-]+):\\s*(#[0-9a-f]{6})\\s*;`, "g"))]
    .map(([, key, value]) => [key, value]));
}

function luminance(hex: string): number {
  const channels = hex.slice(1).match(/../g)!.map((channel) => parseInt(channel, 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrast(foreground: string, background: string): number {
  const [bright, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (bright + 0.05) / (dark + 0.05);
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

  it.each([null, "unknown-from-a-newer-build"])("restores the default for %s without writing a new saved choice", (stored) => {
    const browser = browserSkin(stored);
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

  it("keeps default and Midnight actions readable before and after workspace styling", () => {
    const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
    const workspace = readFileSync(new URL("../styles/workspace-gaia.css", import.meta.url), "utf8");
    const defaultBlock = css.match(/@theme\s*\{([^}]+)\}/)?.[1];
    const midnightBlock = css.match(/\[data-theme="midnight"\]\s*\{([^}]+)\}/)?.[1];
    const workspaceBlock = workspace.match(/\.muster-workspace\[data-theme="midnight"\]\s*\{([^}]+)\}/)?.[1];
    expect(defaultBlock).toBeDefined();
    expect(midnightBlock).toBeDefined();
    expect(workspaceBlock).toBeDefined();
    const defaults = palette(defaultBlock!);
    const midnight = palette(midnightBlock!);
    const effectiveWorkspace = { ...defaults, ...midnight, ...palette(workspaceBlock!) };
    const send = palette(workspaceBlock!, "workspace");
    const theme = THEMES.find((entry) => entry.id === DEFAULT_THEME)!;
    expect(theme.swatch).toEqual({ surface: midnight.app, panel: midnight.panel, accent: midnight.accent });
    for (const key of ["accent", "accent-border", "bubble-user", "bubble-user-border"]) {
      expect(defaults[key], `${key} remains consistent during initial skin restoration`).toBe(midnight[key]);
    }
    for (const colors of [defaults, { ...defaults, ...midnight }, effectiveWorkspace]) {
      expect(contrast(defaults["primary-foreground"], colors.accent)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colors.ink, colors["bubble-user"])).toBeGreaterThanOrEqual(4.5);
      for (const surface of ["app", "panel", "raised", "raised-hover", "card", "inset"]) {
        expect(contrast(colors["accent-border"], colors[surface])).toBeGreaterThanOrEqual(4.5);
        expect(contrast(colors.focus, colors[surface])).toBeGreaterThanOrEqual(3);
      }
    }
    expect(contrast(send["send-ink"], send.send)).toBeGreaterThanOrEqual(4.5);
  });

  it("compiles bright accent text and hover variants for portals without changing fills or other skins", async () => {
    const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
    const defaults = css.match(/@theme\s*\{([^}]+)\}/)?.[1];
    const textTheme = css.match(/@theme inline\s*\{[^}]*--text-color-accent:[^}]+\}/)?.[0];
    expect(defaults).toBeDefined();
    expect(textTheme).toBeDefined();
    // Compile the actual text namespace, including Tailwind's built-in hover
    // handling. Merely checking the bright palette would miss a text-accent
    // utility that still paints a dark button fill in a body-portaled toast.
    const compiler = await compile(`@theme { ${defaults!} }\n${textTheme!}\n@tailwind utilities;`);
    const output = compiler.build(["text-accent", "hover:text-accent", "hover:text-ink", "bg-accent"]);
    const rule = (selector: string) => {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const declarations = output.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`))?.[1];
      expect(declarations, selector).toBeDefined();
      return declarations!;
    };
    for (const selector of [".text-accent", ".hover\\:text-accent:hover"]) {
      const colors = [...rule(selector).matchAll(/(?:^|;)\s*color:\s*([^;]+);/g)].map((match) => match[1]);
      expect(colors.at(-1), selector).toBe("var(--color-accent-text, var(--color-accent))");
    }
    expect(rule(".bg-accent")).toContain("background-color: var(--color-accent)");
    expect(rule(".hover\\:text-ink:hover")).toContain("color: var(--color-ink)");
    expect(css).toMatch(/:root,\s*\[data-theme\]\s*\{\s*--color-accent-text:\s*var\(--color-accent\);\s*\}/);
    expect(css).toMatch(/:root:not\(\[data-theme\]\),\s*\[data-theme="midnight"\]\s*\{\s*--color-accent-text:\s*var\(--color-accent-border\);\s*\}/);
    const colors = palette(defaults!);
    for (const surface of ["card", "raised", "raised-hover"]) {
      expect(contrast(colors["accent-border"], colors[surface])).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("uses skin action colors for auth, onboarding and OS controls instead of fixed blue fills", () => {
    const auth = readFileSync(new URL("../components/AuthShell.css", import.meta.url), "utf8");
    const onboarding = readFileSync(new URL("../components/onboarding-chat.css", import.meta.url), "utf8");
    const os = readFileSync(new URL("../components/os/os-tokens.css", import.meta.url), "utf8");
    expect(auth).toMatch(/--auth-primary:\s*var\(--color-accent\);/);
    expect(auth).toMatch(/--auth-accent:\s*var\(--color-accent-text, var\(--color-accent\)\);/);
    expect(auth).toMatch(/\.auth-submit\s*\{[^}]*background:\s*var\(--auth-primary\);[^}]*color:\s*var\(--color-primary-foreground, #fff\);/);
    expect(auth).toMatch(/--auth-primary-hover:\s*color-mix\(in srgb, var\(--auth-primary\) 86%, #000\);/);
    expect(auth).toMatch(/\.auth-submit:hover:not\(:disabled\)\s*\{[^}]*background:\s*var\(--auth-primary-hover\);/);
    // Rooms is outside the workspace and paints its status text directly,
    // so it must opt into the text token rather than the darker action fill.
    expect(os).toMatch(/\.os-desktop \.rooms-plan-assigned\s*\{\s*color:\s*var\(--color-accent-text, var\(--color-accent\)\);\s*\}/);
    for (const [css, control] of [[onboarding, ".onboarding-chat .continue-pill"], [os, ".os-desktop .os-primary-action"]]) {
      const selector = control.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      expect(css).toMatch(new RegExp(`${selector}\\s*\\{[^}]*background:\\s*var\\(--color-accent\\);[^}]*color:\\s*var\\(--color-primary-foreground, #fff\\);`));
      expect(css).toMatch(new RegExp(`${selector}:hover:not\\(:disabled\\)\\s*\\{[^}]*background:\\s*color-mix\\(in srgb, var\\(--color-accent\\) 86%, #000\\);`));
    }
  });

  it("aligns the Light swatch and native chrome with readable CSS palette values", () => {
    const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
    const block = css.match(/\[data-theme="light"\]\s*\{([^}]+)\}/)?.[1];
    expect(block).toBeDefined();
    expect(block).toMatch(/color-scheme:\s*light/);
    const colors = palette(block!);
    const theme = THEMES.find((entry) => entry.id === "light")!;
    expect(theme.swatch).toEqual({ surface: colors.app, panel: colors.panel, accent: colors.accent });
    expect(theme.overlay).toEqual({ color: colors.app, symbolColor: colors["ink-secondary"] });
    for (const surface of ["app", "panel", "raised", "card", "inset"]) {
      expect(contrast(colors.ink, colors[surface])).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colors["ink-secondary"], colors[surface])).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colors.focus, colors[surface])).toBeGreaterThanOrEqual(3);
    }
    expect(contrast("#ffffff", colors.accent)).toBeGreaterThanOrEqual(4.5);
  });
});
