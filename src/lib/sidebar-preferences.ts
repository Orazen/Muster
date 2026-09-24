// Sidebar density + section-collapse preferences — the benchmark's
// "comfortable / compact / icons-only" system. Global per browser (not
// per account): it describes how THIS window is arranged, not who you are.
// localStorage is untrusted input, so every read validates.

export type SidebarDensity = "comfortable" | "compact" | "icons";
export type SidebarSection = "rooms" | "teammates" | `section:${string}`;

import { z } from "zod";

const COLLAPSED_SECTIONS = z.array(
  z.union([z.literal("rooms"), z.literal("teammates"), z.string().regex(/^section:.{1,64}$/)]),
);

const DENSITY_KEY = "muster:sidebar-density";
const SECTIONS_KEY = "muster:sidebar-sections";

function isDensity(value: string | null): value is SidebarDensity {
  return value === "comfortable" || value === "compact" || value === "icons";
}

export function loadDensity(): SidebarDensity {
  try {
    const raw = localStorage.getItem(DENSITY_KEY);
    return isDensity(raw) ? raw : "comfortable";
  } catch {
    return "comfortable";
  }
}

export function saveDensity(density: SidebarDensity): void {
  try {
    localStorage.setItem(DENSITY_KEY, density);
  } catch {
    // a blocked storage area costs persistence only, never the layout
  }
}

/** Sections the user collapsed; anything unrecognized is open. */
export function loadCollapsedSections(): SidebarSection[] {
  try {
    const decoded = COLLAPSED_SECTIONS.safeParse(JSON.parse(localStorage.getItem(SECTIONS_KEY) ?? "[]"));
    if (!decoded.success) return [];
    // SAFETY: the union's regex arm validates exactly the `section:${string}`
    // shape, so every decoded member is a SidebarSection.
    return decoded.data as SidebarSection[];
  } catch {
    return [];
  }
}

export function saveCollapsedSections(sections: SidebarSection[]): void {
  try {
    localStorage.setItem(SECTIONS_KEY, JSON.stringify(sections));
  } catch {
    // see saveDensity
  }
}

/** Tailwind width per mode — the sidebar's only layout switch. */
export const DENSITY_WIDTH = {
  comfortable: "w-[320px]",
  compact: "w-[272px]",
  icons: "w-[80px]",
} as const satisfies Record<SidebarDensity, string>;

/** Avatar pixel size per mode (icons keeps a generous dot so the flower's
 * eyes stay readable at the rail width). */
export const DENSITY_AVATAR = {
  comfortable: 56,
  compact: 40,
  icons: 44,
} as const satisfies Record<SidebarDensity, number>;
