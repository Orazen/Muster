import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
let card:typeof import("./VisibleDriveCard");let auth:typeof import("@/lib/auth");
beforeAll(async()=>{vi.stubGlobal("window",{location:{origin:"http://127.0.0.1:43902"}});card=await import("./VisibleDriveCard");auth=await import("@/lib/auth");});
afterAll(()=>vi.unstubAllGlobals());
it("renders unavailable apply without a live capability and keeps optional copy/session layout",()=>{
  const html=renderToStaticMarkup(createElement(auth.AuthProvider,null,createElement(card.VisibleDriveCard)));
  expect(html).toContain("Inspection only. Restoring a copy into a live workspace is unavailable.");
  expect(html).toContain("Capture current preferences");expect(html).toContain('type="password"');expect(html).not.toContain("Restore as new teammates");
});
it("enabled copy explains verified target backup, additive scope, paused work and pending-only rollback",()=>{
  const text=card.visibleDriveRestoreText({available:true,connected:true,scope:"account-owned",restoreApply:"additive",settingsCaptured:true,viewRevision:"v".repeat(43),grantRevision:"g".repeat(43)});
  expect(text).toContain("first creates and verifies an encrypted recovery copy");expect(text).toContain("adds new teammates");expect(text).toContain("Tasks stay paused");
  expect(text).toContain("archive-only");expect(text).toContain("Pending failures roll back");expect(text).toContain("committed restores cannot be undone");
});
