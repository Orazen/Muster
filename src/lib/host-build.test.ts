import { describe, expect, it } from "vitest";
import { initialDesktopCapabilities, type DesktopBridge } from "@/lib/desktop";
import { hostBuild, operatorSectionAllowed, settingsSectionAllowed, turnFixAllowed } from "./host-build";

describe("host build", () => {
  it("reads the browser build from the capability fallback, not from a preload global", () => {
    // No bridge at all is exactly the browser case, and it is what a surface
    // sees on its very first render — before any async fetch resolves. If
    // the answer were not "browser" here, the desktop-only surfaces would
    // flash into view for a moment in every browser session.
    expect(hostBuild(initialDesktopCapabilities(undefined))).toBe("browser");
  });

  it.each([
    { platform: "darwin" as const, label: "macOS" },
    { platform: "linux" as const, label: "Linux" },
    { platform: "win32" as const, label: "Windows" },
  ])("reads a $label desktop as the desktop build", ({ platform, label }) => {
    const bridge: DesktopBridge = { platform };
    expect(initialDesktopCapabilities(bridge).host.label).toBe(label);
    expect(hostBuild(initialDesktopCapabilities(bridge))).toBe("desktop");
  });

  it("does not confuse a desktop with computer access switched off", () => {
    // initialDesktopCapabilities seeds localComputer.available false for every
    // build. A gate written on that field would hide the Local VM surfaces
    // from a desktop that has simply not enabled access — the exact users
    // who open Settings to enable it. Assert the field is false and the
    // build is still "desktop", so the two can never be swapped again.
    const capabilities = initialDesktopCapabilities({ platform: "darwin" });
    expect(capabilities.localComputer.available).toBe(false);
    expect(hostBuild(capabilities)).toBe("desktop");
    expect(settingsSectionAllowed("computer", hostBuild(capabilities), true)).toBe(true);
  });
});

describe("settings sections by build", () => {
  const ids = ["general", "computer", "localFirst", "billing", "account"];

  it("keeps the Local VM section out of a browser nav", () => {
    const shown = ids.filter((id) => settingsSectionAllowed(id, "browser", false));
    expect(shown).toEqual(["general", "billing", "account"]);
  });

  it("keeps the Local VM section on a desktop nav even with no preload marker", () => {
    // The desktop gate is the capability; localFirst's preload test is
    // separate and unchanged. A desktop nav must never lose Local VM.
    expect(ids.filter((id) => settingsSectionAllowed(id, "desktop", false))).toContain("computer");
  });

  it("leaves the preload-marked section on exactly the same rule as before", () => {
    // localFirst keeps its original synchronous window.ogb test in both
    // builds — this change did not move it onto the capability path.
    expect(settingsSectionAllowed("localFirst", "desktop", true)).toBe(true);
    expect(settingsSectionAllowed("localFirst", "desktop", false)).toBe(false);
    expect(settingsSectionAllowed("localFirst", "browser", true)).toBe(true);
    expect(settingsSectionAllowed("localFirst", "browser", false)).toBe(false);
  });

  it("passes every other section through untouched in both builds", () => {
    for (const id of ["general", "billing", "account", "why", "audit", "anything-new-later"]) {
      expect(settingsSectionAllowed(id, "browser", false)).toBe(true);
      expect(settingsSectionAllowed(id, "desktop", false)).toBe(true);
    }
  });
});

describe("turn failure repairs by build", () => {
  it("withholds the one-click Local VM setup from a browser", () => {
    // It starts containers and pulls a desktop image on whatever machine
    // answers /api/local-computer, which in a browser is the server.
    expect(turnFixAllowed("open-vm-settings", "browser")).toBe(false);
  });

  it("keeps it on a desktop, where the machine is the reader's own", () => {
    expect(turnFixAllowed("open-vm-settings", "desktop")).toBe(true);
  });

  it("keeps switching a bot to the cloud computer in both builds", () => {
    // That is a bot setting stored server-side; it is correct in either.
    expect(turnFixAllowed("switch-computer-cloud", "browser")).toBe(true);
    expect(turnFixAllowed("switch-computer-cloud", "desktop")).toBe(true);
  });

  it("does not fail closed on an action it has never heard of", () => {
    expect(turnFixAllowed("some-future-server-side-fix", "browser")).toBe(true);
  });
});

describe("operator-only sections", () => {
  it("omits People for a reader who does not administer the deployment", () => {
    // /api/people answers 403 here, permanently — not a transient failure
    // the user can retry or fix, so the nav entry itself is the defect.
    expect(operatorSectionAllowed("people", false)).toBe(false);
  });

  it("keeps People for the operator and on a desktop install", () => {
    expect(operatorSectionAllowed("people", true)).toBe(true);
  });

  it("keeps People while the config has not said either way", () => {
    // undefined covers a server that predates the flag and the window
    // before /api/config lands. Defaulting to hidden would make the section
    // blink out for the operator on every load.
    expect(operatorSectionAllowed("people", undefined)).toBe(true);
  });

  it("leaves every other section alone, operator or not", () => {
    for (const id of ["general", "activity", "backups", "vault", "billing", "anything-new"]) {
      expect(operatorSectionAllowed(id, false)).toBe(true);
      expect(operatorSectionAllowed(id, true)).toBe(true);
      expect(operatorSectionAllowed(id, undefined)).toBe(true);
    }
  });

  it("does not confuse this axis with the build — an operator may be in a browser", () => {
    // The desktop gate and the operator gate are independent: a hosted
    // operator is a browser reader and still gets People, while a desktop
    // user who somehow is not the operator is excluded by role rather than
    // by platform.
    const build = hostBuild(initialDesktopCapabilities(undefined));
    expect(build).toBe("browser");
    expect(operatorSectionAllowed("people", true)).toBe(true);
    expect(settingsSectionAllowed("computer", build, false)).toBe(false);
  });
});
