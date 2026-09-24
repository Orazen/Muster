// Loop201: the updater banner's install timer, as a pure function.
//
// The bug this pins: a signed ~180 MB macOS update takes real time to verify,
// swap and relaunch AFTER the window is gone. The banner used to declare
// "Restart didn't finish" at 15 seconds, which is inside the normal window —
// so a healthy update was reported as a hang, and the copy blamed "an
// unsigned build" for it. Two thresholds now, both beyond a real install,
// and the panic copy is only used for the state it actually describes.
import { describe, expect, it } from "vitest";

import { INSTALL_STILL_WORKING_MS, INSTALL_STUCK_MS, installPhase } from "./UpdateBanner";

describe("installPhase", () => {
  it("starts in the quiet installing phase", () => {
    expect(installPhase(0)).toBe("installing");
    expect(installPhase(14_999)).toBe("installing");
  });

  it("never calls a normal-sized install a hang at 15 seconds", () => {
    // The old threshold. A real 180 MB apply is still running here.
    expect(installPhase(15_000)).not.toBe("stuck");
  });

  it("says 'still working' well past the old 15s panic, without accusing the build", () => {
    expect(installPhase(INSTALL_STILL_WORKING_MS)).toBe("still-working");
    expect(installPhase(60_000)).toBe("still-working");
  });

  it("declares a hang only after two minutes of nothing", () => {
    expect(installPhase(INSTALL_STUCK_MS - 1)).toBe("still-working");
    expect(installPhase(INSTALL_STUCK_MS)).toBe("stuck");
    expect(installPhase(INSTALL_STUCK_MS + 30_000)).toBe("stuck");
  });

  it("keeps the thresholds in a sane order and well clear of the old one", () => {
    expect(INSTALL_STILL_WORKING_MS).toBeGreaterThan(15_000 * 2);
    expect(INSTALL_STUCK_MS).toBeGreaterThan(INSTALL_STILL_WORKING_MS);
  });
});
