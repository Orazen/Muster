// Loop201: the computer-access repair copy, as a pure function.
//
// The failure this prevents: macOS grants privacy per BINARY, and the
// screenshots for local computer control are taken by CuaDriver
// (com.trycua.driver) — a separately signed app — not by Muster. A person
// who grants Screen Recording to Muster, as the old copy invited them to,
// changes nothing for the driver and concludes the app is broken. The
// repair has to name the app that needs the grant, open the exact panes,
// and stay silent about privacy when the real problem is an off toggle.
import { describe, expect, it } from "vitest";

import { localComputerRepair } from "./desktop";

describe("localComputerRepair", () => {
  it("names CuaDriver and both privacy panes on a mac permission block", () => {
    const repair = localComputerRepair({ platform: "mac", reasonCode: "screen-recording-denied" });
    expect(repair.message).toContain("CuaDriver");
    expect(repair.message).toContain("System Settings");
    expect(repair.panes).toEqual(["screen", "accessibility"]);
  });

  it("offers no privacy buttons when computer access is simply switched off", () => {
    const repair = localComputerRepair({ platform: "mac", reasonCode: "computer-access-off" });
    expect(repair.panes).toEqual([]);
    expect(repair.message).toContain("off for this session");
  });

  it("sends a non-mac host to the generic message, with no macOS panes", () => {
    const repair = localComputerRepair({ platform: "linux", reasonCode: "whatever" });
    expect(repair.panes).toEqual([]);
    expect(repair.message).toContain("CUA Driver isn't ready");
  });

  it("tells a browser user what is actually missing", () => {
    const repair = localComputerRepair({ platform: "mac", reasonCode: "desktop-upgrade-required" });
    expect(repair.panes).toEqual([]);
    expect(repair.message).toContain("desktop app");
  });
});
