// Skins are pure CSS. Each one is a block of palette custom properties in
// styles.css, selected by a `data-theme` attribute; this module only decides
// which skin is active and remembers the choice. Nothing here knows how to
// paint — that split keeps the two halves from drifting, and adding a skin is
// one CSS block plus one entry in THEMES.

export const THEME_IDS = ["midnight", "atelier", "foundry", "lagoon"] as const;
export type ThemeId = (typeof THEME_IDS)[number];

/** Three dots shown next to each option in the picker: background, panel,
 * accent. Literal hexes so the swatch needs no DOM or computed styles. */
export type ThemeSwatch = {
  readonly surface: string;
  readonly panel: string;
  readonly accent: string;
};

export type Theme = {
  id: ThemeId;
  label: string;
  /** One line, shown under the label in the picker. */
  description: string;
  swatch: ThemeSwatch;
  /** Windows paints the caption-button strip from a native overlay that
   * cannot read CSS variables, so each skin carries literal tints: the
   * window background behind the glyphs and a readable ink for them.
   * macOS traffic lights are native (no overlay) and Linux keeps the
   * desktop title bar, so this only ever matters on Windows. */
  overlay: { color: string; symbolColor: string };
};

export const THEMES: readonly Theme[] = [
  {
    id: "midnight",
    label: "Midnight",
    description: "The original. Cool and dark.",
    swatch: { surface: "#070707", panel: "#111111", accent: "#1084fe" },
    overlay: { color: "#070707", symbolColor: "#b5b5b5" },
  },
  {
    id: "atelier",
    label: "Atelier",
    description: "Daylight on paper, warm and quiet.",
    swatch: { surface: "#f4efe4", panel: "#ece5d6", accent: "#a94e26" },
    overlay: { color: "#f4efe4", symbolColor: "#6b5d43" },
  },
  {
    id: "foundry",
    label: "Foundry",
    description: "Night shift. Dark, warm, lit in brass.",
    swatch: { surface: "#16110c", panel: "#1f1811", accent: "#aa6418" },
    overlay: { color: "#16110c", symbolColor: "#cdc0a8" },
  },
  {
    id: "lagoon",
    label: "Lagoon",
    description: "Cool daylight. Porcelain and deep teal.",
    swatch: { surface: "#edf2f3", panel: "#e2eaec", accent: "#0e6e80" },
    overlay: { color: "#edf2f3", symbolColor: "#476b74" },
  },
];

export const DEFAULT_THEME: ThemeId = "midnight";

const KEY = "omb-skin";

// The input is whatever Storage.getItem hands back — a string this app wrote
// on an earlier run, a value edited by hand, or a leftover from an older
// build. Membership in THEME_IDS is decided here, at this one boundary.
export function isThemeId(value: string | null): value is ThemeId {
  // SAFETY: the assertion only satisfies includes()' parameter type; the
  // membership check itself decides, and a non-member returns false.
  return THEME_IDS.includes(value as ThemeId);
}

// Reaching for localStorage is itself a failure point: on an origin with
// storage blocked merely touching the getter throws, and skins must never
// take the app down with them. Same guard as drafts.ts.
function getStore(): Pick<Storage, "getItem" | "setItem"> | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

export function readTheme(): ThemeId {
  try {
    // ?? null folds "no storage" into the same shape as "no value saved".
    const stored = getStore()?.getItem(KEY) ?? null;
    return isThemeId(stored) ? stored : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

/**
 * Point the document at a skin and remember it. Called by the picker — a
 * stamped attribute rather than a class so it can never collide with
 * Tailwind utilities.
 */
export function applyTheme(id: ThemeId): void {
  document.documentElement.dataset.theme = id;
  try {
    getStore()?.setItem(KEY, id);
  } catch {
    /* quota / private mode — the skin still applies for this session */
  }
  syncWindowChrome(id);
}

/**
 * Stamp the saved skin before the first paint (main.tsx), without writing:
 * booting is a read, not a choice.
 */
export function restoreTheme(): void {
  const id = readTheme();
  document.documentElement.dataset.theme = id;
  syncWindowChrome(id);
}

// Windows paints its caption buttons from the native titleBarOverlay, which
// cannot read CSS variables — so the renderer pushes the active skin's
// literal colors across the bridge on every skin change, boot included.
// Every link here is optional: no bridge in the browser, no method in older
// packaged shells, and non-Windows answers false.
function syncWindowChrome(id: ThemeId): void {
  try {
    const overlay = THEMES.find((theme) => theme.id === id)?.overlay;
    if (!overlay) return;
    globalThis.window?.ogb
      ?.setTitleBarOverlay?.(overlay)
      ?.catch(() => undefined);
  } catch {
    /* re-tinting the chrome is cosmetic; never let it break a skin switch */
  }
}
