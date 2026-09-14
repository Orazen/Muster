// The web workspace list is a browser bookmark with a strict front door:
// these tests pin the https-only / no-private-literal validation and the
// per-account storage round-trip.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { addWorkspace, forgetWorkspace, loadWorkspaces, parseWorkspaceInput, switchTarget } from "./workspaces";

// jsdom gives us localStorage; the probe's fetch is never called here.
describe("parseWorkspaceInput", () => {
  it("accepts bare hosts and full https origins", () => {
    expect(parseWorkspaceInput("bots.example.com")).toEqual({ origin: "https://bots.example.com", code: null });
    expect(parseWorkspaceInput("https://muster.today/")).toMatchObject({ origin: "https://muster.today" });
  });
  it("carries a pairing code from the fragment or the query", () => {
    expect(parseWorkspaceInput("https://bots.example.com/pair#code=ABCD-1234")).toMatchObject({
      origin: "https://bots.example.com",
      code: "ABCD-1234",
    });
    expect(parseWorkspaceInput("muster://pair?address=https://bots.example.com&code=XYZW123")).toMatchObject({
      origin: "https://bots.example.com",
      code: "XYZW123",
    });
  });
  it("refuses http, localhost, dotless hosts, and private/reserved literals", () => {
    for (const bad of [
      "http://bots.example.com",
      "https://localhost:28821",
      "https://127.0.0.1",
      "https://0.0.0.0",
      "https://10.1.2.3",
      "https://172.16.0.9",
      "https://192.168.1.56",
      "https://169.254.169.254",
      "https://100.64.0.1",
      "https://[fd00::1]",
      "Muster cloud",
      "https://myserver",
      "https://muster.local",
      "https://box.internal",
    ]) {
      const result = parseWorkspaceInput(bad);
      expect("error" in result, `${bad} must be refused`).toBe(true);
    }
  });
  it("refuses empty and garbage", () => {
    expect("error" in parseWorkspaceInput("   ")).toBe(true);
    expect("error" in parseWorkspaceInput("not a url at all %%%")).toBe(true);
  });
});

describe("workspace storage", () => {
  const ACCOUNT = "acct-test";
  beforeEach(() => {
    // the suite runs in a node environment (vite.config test.environment),
    // so localStorage is stubbed the way the sibling storage tests do
    const backing = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => void backing.set(key, value),
      removeItem: (key: string) => void backing.delete(key),
      clear: () => backing.clear(),
    });
    vi.stubGlobal("crypto", { randomUUID: () => "fixed-id" });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("adds, dedupes, loads, forgets, and isolates per account", () => {
    const first = addWorkspace(ACCOUNT, "https://a.example.com", "");
    expect(first.list).toHaveLength(1);
    expect(first.list[0].name).toBe("a.example.com");
    const dupe = addWorkspace(ACCOUNT, "https://a.example.com", "again");
    expect(dupe.error).toMatch(/already connected/);
    expect(loadWorkspaces(ACCOUNT)).toHaveLength(1);
    expect(loadWorkspaces("other-account")).toHaveLength(0);
    expect(forgetWorkspace(ACCOUNT, first.list[0].id)).toHaveLength(0);
  });

  it("survives corrupt storage without throwing", () => {
    localStorage.setItem(`muster:workspaces:v1:${ACCOUNT}`, "{not json");
    expect(loadWorkspaces(ACCOUNT)).toEqual([]);
  });

  it("switchTarget carries the pairing code to the other host", () => {
    expect(switchTarget("https://a.example.com")).toBe("https://a.example.com/app");
    expect(switchTarget("https://a.example.com", "ABCD-12")).toBe("https://a.example.com/pair#ABCD-12");
  });
});
