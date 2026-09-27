import { afterEach, describe, expect, it, vi } from "vitest";
import { authDestination, authGateReturnPath, stashPairReturn, takeStashedPairReturn } from "./auth-navigation";

describe("auth return destinations", () => {
  it("returns desktop root sign-in to the workspace instead of public marketing", () => {
    expect(authGateReturnPath({ pathname: "/", search: "", hash: "" })).toBe("/app");
  });
  it("retains a protected OS destination, template and fragment", () => {
    expect(authGateReturnPath({ pathname: "/os", search: "?template=research", hash: "#work" })).toBe("/os?template=research#work");
  });
  it("retains root query intent while targeting the app", () => {
    expect(authGateReturnPath({ pathname: "/", search: "?bot=fixture", hash: "#reply" })).toBe("/app?bot=fixture#reply");
  });
  it.each([null, "", "app", "https://example.org/app", "javascript:alert(1)"])(
    "falls back to the app for a nonlocal destination: %s", (value) => {
      expect(authDestination(value)).toBe("/app");
    },
  );

  it.each(["//example.org/app", "///example.org/app", "/\\example.org/app", "\\example.org/app", "/a/..//example.org/app", "/a/%2e%2e//example.org/app"])(
    "rejects browser-normalized external destinations: %s", (value) => {
      expect(authDestination(value)).toBe("/app");
    },
  );

  it.each(["/", "/app", "/app?view=approvals#latest", "/pair?return=%2Fapp&mode=desktop"])(
    "preserves a local pathname, query, and fragment: %s", (value) => {
      expect(authDestination(value)).toBe(value);
    },
  );
});

describe("pair return stash", () => {
  // A minimal same-tab storage shim: the round trip these tests model is
  // sign-in in this tab, including full-page provider redirects, which
  // sessionStorage survives.
  const shim = () => {
    const store = new Map<string, string>();
    return {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    };
  };
  afterEach(() => vi.unstubAllGlobals());

  it("carries a /pair fragment across the round trip and consumes it on read", () => {
    vi.stubGlobal("sessionStorage", shim());
    expect(stashPairReturn("/pair", "#ABCD2345")).toBe("/pair");
    expect(takeStashedPairReturn()).toBe("/pair#ABCD2345");
    // one round trip, one read — a stale stash must never restore later
    expect(takeStashedPairReturn()).toBeNull();
  });

  it("never restores a stash that is not a /pair path", () => {
    vi.stubGlobal("sessionStorage", shim());
    try {
      globalThis.sessionStorage.setItem("muster.pair-return", "/app#sneaky");
      expect(takeStashedPairReturn()).toBeNull();
      // the refused entry is still consumed, not left behind
      expect(globalThis.sessionStorage.getItem("muster.pair-return")).toBeNull();
    } finally {
      globalThis.sessionStorage.removeItem("muster.pair-return");
    }
  });

  it("loses the stash rather than throwing when storage is unavailable", () => {
    vi.stubGlobal("sessionStorage", {
      setItem: () => { throw new Error("quota"); },
      getItem: () => { throw new Error("blocked"); },
      removeItem: () => {},
    });
    expect(stashPairReturn("/pair", "#ABCD2345")).toBe("/pair");
    expect(takeStashedPairReturn()).toBeNull();
  });
});
