// Exercise the actual Electron platform wire value and permission identity.
import { describe, expect, it } from "vitest";

import { localComputerRepair } from "./desktop";

describe("localComputerRepair", () => {
  it("names Muster for an embedded permission failure with the actual darwin platform", () => {
    const repair = localComputerRepair({ platform: "darwin", packaged: true, reasonCode: "cua-driver-unavailable",
      failure: "embedded host failed: Accessibility and Screen Recording required for Muster (com.muster.app)" });
    expect(repair.message).toContain("for Muster");
    expect(repair.message).not.toContain("CuaDriver");
    expect(repair.message).toContain("System Settings");
    expect(repair.panes).toEqual(["screen", "accessibility"]);
  });

  it("offers no privacy buttons when computer access is simply switched off", () => {
    const repair = localComputerRepair({ platform: "darwin", reasonCode: "computer-access-off" });
    expect(repair.panes).toEqual([]);
    expect(repair.message).toContain("off for this session");
  });

  it("sends a non-mac host to the generic message, with no macOS panes", () => {
    const repair = localComputerRepair({ platform: "linux", reasonCode: "whatever" });
    expect(repair.panes).toEqual([]);
    expect(repair.message).toContain("CUA Driver isn't ready");
  });

  it("tells a browser user what is actually missing", () => {
    const repair = localComputerRepair({ platform: "darwin", reasonCode: "desktop-upgrade-required" });
    expect(repair.panes).toEqual([]);
    expect(repair.message).toContain("desktop app");
  });

  it("uses CuaDriver only when the actual failure identifies a standalone driver", () => {
    const repair = localComputerRepair({ platform: "darwin", packaged: false, reasonCode: "cua-driver-unavailable",
      failure: "Screen Recording must be granted to CuaDriver (com.trycua.driver)" });
    expect(repair.message).toContain("for CuaDriver");
    expect(repair.panes).toEqual(["screen"]);
  });

  it("does not invent a permission diagnosis for a missing binary", () => {
    const repair = localComputerRepair({ platform: "darwin", packaged: true, reasonCode: "cua-driver-unavailable",
      failure: "cua-driver binary not found" });
    expect(repair.message).toBe("cua-driver binary not found");
    expect(repair.panes).toEqual([]);
  });

  it("preserves a failed permission attempt even if the initial capability snapshot still says off", () => {
    const repair = localComputerRepair({ platform: "darwin", packaged: true, reasonCode: "computer-access-off",
      failure: "embedded host failed: Accessibility required" });
    expect(repair.message).toContain("Accessibility for Muster");
    expect(repair.panes).toEqual(["accessibility"]);
  });
});
