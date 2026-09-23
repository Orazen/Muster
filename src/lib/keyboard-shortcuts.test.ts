// The cheat sheet's catalog must track the bindings App.tsx actually
// ships, and the filter/platform resolution must behave on both OSes.
import { afterEach, expect, it, vi } from "vitest";
import {
  SHORTCUT_GROUPS,
  filterShortcutGroups,
  isMacPlatform,
  shortcutKeysForPlatform,
} from "./keyboard-shortcuts";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("ships two groups with nine uniquely-identified rows", () => {
  expect(SHORTCUT_GROUPS).toHaveLength(2);
  expect(SHORTCUT_GROUPS[0].category).toBe("Anywhere");
  expect(SHORTCUT_GROUPS[0].items).toHaveLength(5);
  expect(SHORTCUT_GROUPS[1].category).toBe("In a conversation");
  expect(SHORTCUT_GROUPS[1].items).toHaveLength(4);

  const ids = SHORTCUT_GROUPS.flatMap((group) => group.items.map((item) => item.id));
  expect(new Set(ids).size).toBe(ids.length);
  expect([...ids].sort()).toEqual(
    [
      "close-find",
      "command-palette",
      "find-conversation",
      "jump-teammate",
      "new-line",
      "new-teammate",
      "send-message",
      "shortcuts-sheet",
      "switch-teammate",
    ].sort(),
  );
});

it("gives every row a description and both platforms' keycaps", () => {
  for (const group of SHORTCUT_GROUPS) {
    for (const item of group.items) {
      expect(item.description.length).toBeGreaterThan(0);
      expect(item.macKeys.length).toBeGreaterThan(0);
      expect(item.winKeys.length).toBeGreaterThan(0);
    }
  }
});

it("resolves keycaps per platform", () => {
  const palette = SHORTCUT_GROUPS[0].items.find((item) => item.id === "command-palette")!;
  expect(shortcutKeysForPlatform(palette, true)).toEqual(["⌘", "K"]);
  expect(shortcutKeysForPlatform(palette, false)).toEqual(["Ctrl", "K"]);
});

it("prefers the Electron bridge for platform detection", () => {
  vi.stubGlobal("window", { ogb: { platform: "darwin" } });
  expect(isMacPlatform()).toBe(true);

  vi.stubGlobal("window", { ogb: { platform: "win32" } });
  expect(isMacPlatform()).toBe(false);
});

it("falls back to the user agent in the browser", () => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X)" });
  expect(isMacPlatform()).toBe(true);

  vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Windows NT 10.0)" });
  expect(isMacPlatform()).toBe(false);
});

it("returns every group unchanged for an empty query", () => {
  const result = filterShortcutGroups(SHORTCUT_GROUPS, "   ", true);
  expect(result).not.toBe(SHORTCUT_GROUPS);
  expect(result).toEqual([...SHORTCUT_GROUPS]);
});

it("matches descriptions", () => {
  const result = filterShortcutGroups(SHORTCUT_GROUPS, "palette", true);
  expect(result).toHaveLength(1);
  expect(result[0].items.map((item) => item.id)).toEqual(["command-palette"]);
});

it("matches keycaps without caring about whitespace", () => {
  const mac = filterShortcutGroups(SHORTCUT_GROUPS, "⌘k", true);
  expect(mac.flatMap((group) => group.items).map((item) => item.id)).toEqual(["command-palette"]);

  const win = filterShortcutGroups(SHORTCUT_GROUPS, "ctrl+k", false);
  expect(win.flatMap((group) => group.items).map((item) => item.id)).toEqual(["command-palette"]);
});

it("keeps a whole group when the category matches", () => {
  const result = filterShortcutGroups(SHORTCUT_GROUPS, "conversation", true);
  expect(result).toHaveLength(1);
  expect(result[0].items).toHaveLength(4);
});

it("drops every group when nothing matches", () => {
  expect(filterShortcutGroups(SHORTCUT_GROUPS, "zzz-no-such-shortcut", true)).toEqual([]);
});
