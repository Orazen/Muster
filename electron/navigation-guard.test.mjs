import { describe, expect, it } from "vitest";
import { isAppOrigin, isTrustedAppSender, navigationDecision, safeExternalUrl } from "./navigation-guard.mjs";

const APP = ["http://127.0.0.1:8799"];
const DEV = ["http://127.0.0.1:8799", "http://127.0.0.1:5199"];

describe("safeExternalUrl", () => {
  it.each(["https://example.com/a?b=1", "http://example.com", "mailto:someone@example.com"])("opens %s", (url) => {
    expect(safeExternalUrl(url)).toBe(new URL(url).toString());
  });

  it.each([
    "file:///etc/passwd",
    "smb://attacker/share",
    "javascript:alert(1)",
    "data:text/html,hi",
    "vscode://file/x",
    "ms-msdt:/id",
    "x-apple.systempreferences:com.apple.preference.security",
    "about:blank",
    "not a url",
    "",
    null,
    42,
  ])("refuses %s", (url) => {
    expect(safeExternalUrl(url)).toBeNull();
  });
});

describe("navigationDecision", () => {
  it("keeps app-origin routes in the window", () => {
    expect(navigationDecision("http://127.0.0.1:8799/app/settings", APP)).toBe("allow");
    expect(navigationDecision("http://127.0.0.1:5199/app", DEV)).toBe("allow");
  });

  it("never loads non-web schemes in a bridge window", () => {
    expect(navigationDecision("file:///Users/me/.ssh/id_rsa", APP)).toBe("deny");
    expect(navigationDecision("smb://host/share", APP)).toBe("deny");
    expect(navigationDecision("mailto:a@b.co", APP)).toBe("external");
  });

  it("lets the main window follow web sign-in flows (bridge is withheld by the sender check)", () => {
    expect(navigationDecision("https://accounts.google.com/o/oauth2/v2/auth", APP)).toBe("allow");
  });

  it("pins strict windows to the app origin", () => {
    expect(navigationDecision("https://example.com", APP, { strict: true })).toBe("external");
    expect(navigationDecision("http://127.0.0.1:8800/", APP, { strict: true })).toBe("external");
    expect(navigationDecision("file:///x", APP, { strict: true })).toBe("deny");
    expect(navigationDecision("http://127.0.0.1:8799/tray.html", APP, { strict: true })).toBe("allow");
  });

  it("does not treat lookalike origins as the app", () => {
    expect(isAppOrigin("http://localhost:8799/app", APP)).toBe(false);
    expect(isAppOrigin("https://127.0.0.1:8799/app", APP)).toBe(false);
    expect(isAppOrigin("http://user:pw@127.0.0.1:8799/app", APP)).toBe(false);
  });
});

describe("isTrustedAppSender", () => {
  function fixture(url = "http://127.0.0.1:8799/app") {
    const mainFrame = { url };
    const sender = { mainFrame, isDestroyed: () => false };
    return { sender, senderFrame: mainFrame };
  }

  it("accepts the app's own top-level frame", () => {
    expect(isTrustedAppSender(fixture(), APP)).toBe(true);
    expect(isTrustedAppSender(fixture("http://127.0.0.1:8799/tray.html"), APP)).toBe(true);
  });

  it.each([
    "https://accounts.google.com/signin",
    "https://evil.example/app",
    "http://127.0.0.1:8800/app",
    "data:text/html,hello",
    "file:///app/index.html",
  ])("refuses a window that navigated to %s", (url) => {
    expect(isTrustedAppSender(fixture(url), APP)).toBe(false);
  });

  it("refuses subframes, destroyed senders and missing frames", () => {
    const event = fixture();
    expect(isTrustedAppSender({ ...event, senderFrame: { url: event.senderFrame.url } }, APP)).toBe(false);
    event.sender.isDestroyed = () => true;
    expect(isTrustedAppSender(event, APP)).toBe(false);
    expect(isTrustedAppSender({ sender: fixture().sender, senderFrame: null }, APP)).toBe(false);
    expect(isTrustedAppSender(null, APP)).toBe(false);
  });
});
