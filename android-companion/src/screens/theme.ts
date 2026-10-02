import { useColorScheme } from "react-native";

/** Presentation only. System appearance never changes the paired connection,
 * selected conversation, drafts, saved bot colors or request authority. */
export interface CompanionTheme {
  scheme: "light" | "dark";
  statusBar: "dark" | "light";
  page: string;
  panel: string;
  card: string;
  raised: string;
  inset: string;
  border: string;
  ink: string;
  secondary: string;
  accent: string;
  primary: string;
  primaryInk: string;
  userBubble: string;
  warning: string;
  danger: string;
  dangerSurface: string;
}

export const COMPANION_THEMES: Record<CompanionTheme["scheme"], CompanionTheme> = {
  dark: {
    scheme: "dark", statusBar: "light",
    page: "#111111", panel: "#141414", card: "#191919", raised: "#242424", inset: "#191919",
    border: "#3a3a3a", ink: "#f5f5f5", secondary: "#adadad",
    accent: "#00bbff", primary: "#0066cc", primaryInk: "#ffffff", userBubble: "#013f56",
    warning: "#e9a75b", danger: "#ffb4ab", dangerSurface: "#351b1b",
  },
  light: {
    scheme: "light", statusBar: "dark",
    page: "#ffffff", panel: "#fafafa", card: "#ffffff", raised: "#f3f3f3", inset: "#f5f5f5",
    border: "#dddddd", ink: "#161616", secondary: "#626262",
    accent: "#0066cc", primary: "#0066cc", primaryInk: "#ffffff", userBubble: "#eaf7fc",
    warning: "#916329", danger: "#b42332", dangerSurface: "#fff0ee",
  },
};

export function useCompanionTheme(): CompanionTheme {
  return COMPANION_THEMES[useColorScheme() === "dark" ? "dark" : "light"];
}

/** Create both small style maps once; streaming renders only select a map. */
export function createThemedStyles<T>(create: (theme: CompanionTheme) => T) {
  return { dark: create(COMPANION_THEMES.dark), light: create(COMPANION_THEMES.light) };
}
