import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
let card: typeof import("./VisibleDriveCard");
let auth: typeof import("@/lib/auth");
beforeAll(async () => {
  vi.stubGlobal("window", { location: { origin: "http://127.0.0.1:43901" } });
  card = await import("./VisibleDriveCard"); auth = await import("@/lib/auth");
});
afterAll(() => vi.unstubAllGlobals());
describe("optional Drive card truthfulness", () => {
  it("renders the actual initial card with optional copy and unavailable live restore wording", () => {
    const html = renderToStaticMarkup(createElement(auth.AuthProvider, null, createElement(card.VisibleDriveCard)));
    expect(html).toContain("Optional Drive copies");
    expect(html).toContain("Inspection only. Restoring a copy into a live workspace is unavailable.");
    expect(html).toContain("Existing backups stay in place.");
    expect(html).toContain("does not enable automatic sync");
    expect(html).toContain('type="password"');
    expect(html).not.toContain("synthetic-token");
    expect(html).not.toContain("Restore from Drive");
  });
  it("provider availability precedes connected state, while sign-in is never consent evidence", () => {
    const ready = { available: true, connected: false, scope: "account-owned" as const, restoreApply: "unsupported" as const, settingsCaptured: false, viewRevision: "v".repeat(43), grantRevision: "g".repeat(43) };
    expect(card.visibleDriveStatusText(null)).toContain("Checking");
    expect(card.visibleDriveStatusText(ready)).toContain("Google sign-in alone does not connect it");
    expect(card.visibleDriveStatusText({ ...ready, connected: true })).toBe("Optional Drive connection ready.");
    expect(card.visibleDriveStatusText({ ...ready, available: false, connected: true })).toContain("unavailable");
  });
});
