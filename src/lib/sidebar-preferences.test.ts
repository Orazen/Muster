// Density + collapse persistence: validation of untrusted localStorage,
// safe defaults, and silent tolerance of a blocked storage area.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  loadCollapsedSections,
  loadDensity,
  saveCollapsedSections,
  saveDensity,
} from "./sidebar-preferences";

describe("sidebar preferences", () => {
  beforeEach(() => {
    const backing = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => void backing.set(key, value),
      removeItem: (key: string) => void backing.delete(key),
      clear: () => backing.clear(),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("defaults to comfortable and round-trips a saved density", () => {
    expect(loadDensity()).toBe("comfortable");
    saveDensity("compact");
    expect(loadDensity()).toBe("compact");
  });

  it("rejects garbage values instead of trusting storage", () => {
    localStorage.setItem("muster:sidebar-density", "wide-open");
    expect(loadDensity()).toBe("comfortable");
  });

  it("survives corrupt JSON in the collapse list and rejects unknown sections", () => {
    localStorage.setItem("muster:sidebar-sections", "{oops");
    expect(loadCollapsedSections()).toEqual([]);
    // The decode is all-or-nothing: one junk element invalidates the whole
    // stored list, which then reads back as "nothing collapsed".
    localStorage.setItem("muster:sidebar-sections", JSON.stringify(["rooms", "secrets", 42]));
    expect(loadCollapsedSections()).toEqual([]);
    localStorage.setItem("muster:sidebar-sections", JSON.stringify(["rooms", "section:sec-1"]));
    expect(loadCollapsedSections()).toEqual(["rooms", "section:sec-1"]);
  });

  it("round-trips collapsed sections", () => {
    saveCollapsedSections(["teammates"]);
    expect(loadCollapsedSections()).toEqual(["teammates"]);
  });

  it("never throws when storage is blocked", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    });
    expect(loadDensity()).toBe("comfortable");
    expect(() => saveDensity("icons")).not.toThrow();
    expect(loadCollapsedSections()).toEqual([]);
    expect(() => saveCollapsedSections(["rooms"])).not.toThrow();
  });
});
