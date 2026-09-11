import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { desktopCapabilities, linuxSession, localComputerReady } = require("./capabilities.cjs");

describe("desktop capabilities", () => {
  it("keeps macOS native features behind a ready CUA connection", () => {
    const capabilities = desktopCapabilities({
      platform: "darwin",
      packaged: true,
      localConnection: { mode: "embedded" },
    });

    expect(capabilities).toMatchObject({
      host: { platform: "darwin", label: "macOS", session: "unknown", packaged: true },
      windowChrome: "mac-inset",
      screenPreview: { available: true, interaction: "direct" },
      dictation: { available: true, engine: "apple-speech", onDevice: true },
      localComputer: { available: true, support: "supported" },
    });
  });

  it.each(["linux", "win32", "freebsd"])("fails closed on %s", (platform) => {
    const capabilities = desktopCapabilities({
      platform,
      env: { DISPLAY: ":0" },
      localConnection: { mode: "embedded" },
    });

    expect(capabilities.windowChrome).toBe("native");
    expect(capabilities.screenPreview.available).toBe(false);
    expect(capabilities.dictation.available).toBe(false);
    expect(capabilities.localComputer).toMatchObject({
      available: false,
      support: "unsupported",
      reasonCode: "unsupported-platform",
    });
  });

  it("detects Wayland before XWayland and distinguishes X11 and headless Linux", () => {
    expect(linuxSession("linux", { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" })).toBe("wayland");
    expect(linuxSession("linux", { XDG_SESSION_TYPE: "x11", DISPLAY: ":0" })).toBe("x11");
    expect(linuxSession("linux", {})).toBe("headless");
  });

  it("never treats an embedded-looking Linux connection as local control", () => {
    expect(localComputerReady("linux", { mode: "embedded" })).toBe(false);
    expect(localComputerReady("darwin", { mode: "unavailable" })).toBe(false);
    expect(localComputerReady("darwin", { mode: "standalone" })).toBe(true);
  });

  it("distinguishes session opt-in from a failed driver without hiding other Mac features", () => {
    const off = desktopCapabilities({ platform: "darwin", localConnection: { mode: "unavailable", reason: "computer-access-off" } });
    expect(off.localComputer).toEqual({ available: false, support: "unsupported", reasonCode: "computer-access-off" });
    expect(off.screenPreview.available).toBe(true);
    expect(off.dictation.available).toBe(true);
    const failed = desktopCapabilities({ platform: "darwin", localConnection: { mode: "unavailable", reason: "permission denied" } });
    expect(failed.localComputer.reasonCode).toBe("cua-driver-unavailable");
    const linux = desktopCapabilities({ platform: "linux", localConnection: { mode: "unavailable", reason: "computer-access-off" } });
    expect(linux.localComputer.reasonCode).toBe("unsupported-platform");
  });
});
