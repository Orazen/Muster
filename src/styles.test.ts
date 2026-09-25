import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The onboarding wizard covers the whole window during first-run. On the two
// platforms where the app has no native title bar to grab (Windows draws
// caption buttons from the titleBarOverlay; macOS-inset hides the bar for the
// traffic lights), the wizard's stage head is the ONLY surface that can move
// the window. These checks pin the contract between Onboarding.tsx (sets
// data-window-drag) and styles.css (turns it into a drag strip) so a
// stylesheet refactor cannot silently strand Windows/macOS users on an
// unmovable first-run window again.

const css = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8");
const tsx = readFileSync(fileURLToPath(new URL("./components/Onboarding.tsx", import.meta.url)), "utf8");

describe("onboarding window drag contract", () => {
  it("turns the wizard's stage head into a drag strip when the shell opts in", () => {
    expect(css).toMatch(/\.onboarding-shell\[data-window-drag="true"\] \.onboarding-stage-head \{ -webkit-app-region: drag; \}/);
  });

  it("keeps the stage title interactive above the drag strip", () => {
    // The title holds focus on every step change; it must never swallow
    // clicks as a drag handle, and no-drag must win wherever it appears.
    expect(css).toMatch(/\.onboarding-shell\[data-window-drag="true"\] \.onboarding-stage-title \{ -webkit-app-region: no-drag; \}/);
  });

  it("opts in exactly on the platforms without a draggable native bar", () => {
    // Windows overlay + macOS inset traffic lights; plain web and Linux
    // (native decorations) must stay inert.
    expect(tsx).toMatch(/data-window-drag=\{isWin \|\| macInset \? "true" : undefined\}/);
    expect(tsx).toMatch(/const isWin = window\.ogb\?\.platform === "win32";/);
    expect(tsx).toMatch(/const macInset = capabilities\.windowChrome === "mac-inset";/);
  });

  it("scopes the strip to the shell attribute, not every onboarding stage", () => {
    // A bare `.onboarding-stage-head` drag rule would also fire inside any
    // future non-drag context (hosted web, remote-client windows).
    expect(css).not.toMatch(/^\s*\.onboarding-stage-head \{[^}]*-webkit-app-region/m);
  });
});
