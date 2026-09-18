import { beforeEach, describe, expect, it, vi } from "vitest";
import { isCalmMascot, setCalmMascot } from "./calm";

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
  });
});

describe("calm mascot setting", () => {
  it("defaults off", () => {
    expect(isCalmMascot()).toBe(false);
  });

  it("persists on and off", () => {
    setCalmMascot(true);
    expect(isCalmMascot()).toBe(true);
    setCalmMascot(false);
    expect(isCalmMascot()).toBe(false);
  });

  it("survives a missing storage gracefully", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(() => setCalmMascot(true)).not.toThrow();
    expect(isCalmMascot()).toBe(false);
  });
});
