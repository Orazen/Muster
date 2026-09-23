/**
 * Keyboard shortcuts catalog and platform-specific key resolution.
 * The searchable cheat sheet reads this catalog; every entry mirrors a
 * binding that actually ships (keydown handlers in App.tsx and the
 * conversation views). Catalog shape adapts OpenMausBot's keyboard-shortcuts
 * lib (© OpenMausBot contributors, Apache License 2.0); the entries and
 * wording are Muster's own.
 */

/** Single keyboard shortcut entry with platform-specific keycaps. */
export interface ShortcutItem {
  /** Stable identifier for the shortcut. */
  id: string;
  /** Human-readable explanation of what the shortcut does. */
  description: string;
  /** Keycaps shown on macOS (e.g. ["⌘", "K"]). A lowercase "or" token is
   * rendered as a plain separator between alternative chords. */
  macKeys: string[];
  /** Keycaps shown on Windows and Linux (e.g. ["Ctrl", "K"]). */
  winKeys: string[];
}

/** Group of related shortcuts displayed under a section heading. */
export interface ShortcutGroup {
  /** Category display name (e.g. "Anywhere"). */
  category: string;
  /** List of shortcuts belonging to this group. */
  items: ShortcutItem[];
}

/** Every binding the cheat sheet documents — nine rows, two groups. */
export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  {
    category: "Anywhere",
    items: [
      {
        id: "command-palette",
        description: "Command palette",
        macKeys: ["⌘", "K"],
        winKeys: ["Ctrl", "K"],
      },
      {
        id: "new-teammate",
        description: "New teammate",
        macKeys: ["⌘", "N"],
        winKeys: ["Ctrl", "N"],
      },
      {
        id: "jump-teammate",
        description: "Jump to teammate",
        macKeys: ["⌘", "1–9"],
        winKeys: ["Ctrl", "1–9"],
      },
      {
        id: "switch-teammate",
        description: "Previous / next teammate",
        macKeys: ["⌘", "⇧", "[ / ]"],
        winKeys: ["Ctrl", "Shift", "[ / ]"],
      },
      {
        id: "shortcuts-sheet",
        description: "This cheat sheet",
        macKeys: ["?", "or", "⌘", "/"],
        winKeys: ["?", "or", "Ctrl", "/"],
      },
    ],
  },
  {
    category: "In a conversation",
    items: [
      {
        id: "find-conversation",
        description: "Find in conversation",
        macKeys: ["⌘", "F"],
        winKeys: ["Ctrl", "F"],
      },
      {
        id: "send-message",
        description: "Send",
        macKeys: ["Enter"],
        winKeys: ["Enter"],
      },
      {
        id: "new-line",
        description: "New line",
        macKeys: ["⇧", "Enter"],
        winKeys: ["Shift", "Enter"],
      },
      {
        id: "close-find",
        description: "Close find, cancel edit",
        macKeys: ["Esc"],
        winKeys: ["Esc"],
      },
    ],
  },
];

/**
 * Detect whether the current host platform is macOS.
 * Electron's window.ogb bridge first (authoritative in the desktop app),
 * falling back to navigator.userAgent in the browser.
 */
export function isMacPlatform(): boolean {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- probing host globals at the platform I/O boundary; both globals are absent in Node tests
  if (typeof window !== "undefined" && window.ogb?.platform) {
    return window.ogb.platform === "darwin";
  }
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- same host-global probe; navigator exists in browsers, absent in Node tests
  if (typeof navigator !== "undefined" && navigator.userAgent) {
    return navigator.userAgent.includes("Mac");
  }
  return true;
}

/** Resolve the keycaps for a shortcut item on the given host OS. */
export function shortcutKeysForPlatform(
  item: ShortcutItem,
  isMac: boolean = isMacPlatform(),
): string[] {
  return isMac ? item.macKeys : item.winKeys;
}

/**
 * Filter shortcut groups by query, matching descriptions, category names,
 * and keycaps. Key matching ignores whitespace and "+" separators so "⌘k"
 * and "ctrl+k" both find their row.
 * Groups whose category matches keep all their items; empty groups are
 * dropped so the sheet can render a clean empty state.
 */
export function filterShortcutGroups(
  groups: readonly ShortcutGroup[],
  query: string,
  isMac: boolean = isMacPlatform(),
): ShortcutGroup[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [...groups];
  const compact = normalized.replace(/[\s+]+/g, "");

  return groups
    .map((group) => {
      const items = group.items.filter((item) => {
        const keys = shortcutKeysForPlatform(item, isMac).join(" ").toLowerCase();
        return (
          item.description.toLowerCase().includes(normalized) ||
          group.category.toLowerCase().includes(normalized) ||
          keys.includes(normalized) ||
          keys.replace(/[\s+]+/g, "").includes(compact)
        );
      });
      return { ...group, items };
    })
    .filter((group) => group.items.length > 0);
}
