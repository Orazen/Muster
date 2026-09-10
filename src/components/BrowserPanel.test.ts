import { Children, createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BrowserPanelView, BrowserPreviewSurface, restoreBrowserPreviewFocus } from "./BrowserPanel";
import { emptyBrowserPreview, type BrowserPreviewSnapshot, type BrowserPreviewState } from "./browser-preview-session";

const idle: BrowserPreviewState = { running: false, url: null, title: null, profile: "bot", error: null };
const running = { ...idle, running: true, url: "https://example.com/confirmed", title: "Confirmed page", takeControl: true };
const props = (patch: Partial<BrowserPreviewSnapshot> = {}) => ({
  botName: "Basil",
  snapshot: { ...emptyBrowserPreview(), ...patch },
  address: "https://example.com/draft",
  onAddressChange: vi.fn(), onClose: vi.fn(), onRetry: vi.fn(), onStart: vi.fn(),
  onStop: vi.fn(), onNavigate: vi.fn(), onSwitchProfile: vi.fn(),
});
const render = (patch: Partial<BrowserPreviewSnapshot> = {}) => renderToStaticMarkup(createElement(BrowserPanelView, props(patch)));
const buttons = (html: string) => html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [];
const button = (html: string, label: string) => {
  const match = buttons(html).find((entry) => entry.includes(label));
  expect(match, `Missing button: ${label}`).toBeDefined();
  return match!;
};

function findClick(node: ReactNode, label: string): (() => void) | undefined {
  for (const child of Children.toArray(node)) {
    if (!isValidElement<{ children?: ReactNode; "aria-label"?: string; onClick?: () => void }>(child)) continue;
    if (child.props["aria-label"] === label) return child.props.onClick;
    const nested = findClick(child.props.children, label);
    if (nested) return nested;
  }
}

describe("Browser preview rendered states (SSR, not browser execution)", () => {
  it("uses a named modal dialog for the full overlay", () => {
    const html = renderToStaticMarkup(createElement(BrowserPreviewSurface, {
      overlay: true, onClose: vi.fn(), children: createElement(BrowserPanelView, props({ state: idle })),
    }));
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-label="Browser preview"');
    expect(html).toContain('aria-modal="true"');
    expect(button(html, "Close browser preview panel")).toBeDefined();
  });

  it("leaves the desktop side panel outside the modal focus scope", () => {
    const html = renderToStaticMarkup(createElement(BrowserPreviewSurface, {
      overlay: false, onClose: vi.fn(), children: createElement(BrowserPanelView, props({ state: idle })),
    }));
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain("aria-modal");
    expect(html).toContain("Open preview");
  });

  it("closes when the dialog requests dismissal without treating open as dismissal", () => {
    const onClose = vi.fn();
    const surface = BrowserPreviewSurface({ overlay: true, onClose, children: null });
    surface.props.onOpenChange(true);
    expect(onClose).not.toHaveBeenCalled();
    surface.props.onOpenChange(false);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("restores focus to a connected launcher without scrolling the page", () => {
    const launcher = { isConnected: true, focus: vi.fn() };
    restoreBrowserPreviewFocus(launcher);
    expect(launcher.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  });

  it("does not restore focus to a launcher removed by navigation", () => {
    const launcher = { isConnected: false, focus: vi.fn() };
    restoreBrowserPreviewFocus(launcher);
    restoreBrowserPreviewFocus(null);
    expect(launcher.focus).not.toHaveBeenCalled();
  });

  it("checks existing state before allowing a new session", () => {
    const html = render();
    expect(html).toContain("Checking preview…");
    expect(html).not.toContain("No preview open");
    expect(button(html, "Open preview")).toContain('disabled=""');
    expect(button(html, "Guest preview")).toContain('disabled=""');
  });

  it("describes address previews and their actual limitations in the idle state", () => {
    const html = render({ state: idle });
    expect(html).toContain("Browser preview");
    expect(html).toContain("No preview open");
    expect(html).toContain("This preview is separate from agent browsing.");
    expect(html).toContain("Clicking or typing on the page image is not supported.");
    expect(button(html, "Open preview")).not.toContain('disabled=""');
    expect(button(html, "Guest preview")).not.toContain('disabled=""');
  });

  it("shows the latest page image and confirmed address without takeover promises", () => {
    const html = render({ state: running, frame: "fixture-jpeg" });
    expect(html).toContain("Preview open");
    expect(html).toContain('alt="Latest received page image: Confirmed page"');
    expect(html).toContain('src="data:image/jpeg;base64,fixture-jpeg"');
    expect(html).toContain("https://example.com/confirmed");
    expect(html).toContain("Page images may lag while navigation loads.");
    expect(html).not.toMatch(/Take control|Hand back|pauses|web work live|You&#x27;re driving/);
    expect(button(html, "Basil&#x27;s profile")).toContain('aria-pressed="true"');
    expect(button(html, ">Guest<")).toContain('aria-pressed="false"');
  });

  it("shows escaped action, state and polling errors with a retry and retained frame", () => {
    const html = render({ state: { ...running, error: "Browser <closed>" }, frame: "last-image", error: "Stop <rejected>", pollError: "Refresh <failed>" });
    expect(html).toContain('role="alert"');
    for (const text of ["Browser &lt;closed&gt;", "Stop &lt;rejected&gt;", "Refresh &lt;failed&gt;", "The last received image is shown."]) expect(html).toContain(text);
    expect(html).not.toContain("<rejected>");
    expect(html).toContain("data:image/jpeg;base64,last-image");
    expect(button(html, "Retry preview")).not.toContain('disabled=""');
    expect(button(html, "Stop browser preview")).not.toContain('disabled=""');
  });

  it("reports an initial read failure without claiming an idle session", () => {
    const html = render({ pollError: "Session state unavailable" });
    expect(html).toContain("Preview refresh unavailable");
    expect(html).toContain("Session state unavailable");
    expect(html).not.toContain("No preview open");
    expect(html).not.toContain("The last received image is shown.");
    expect(button(html, "Open preview")).toContain('disabled=""');
  });

  it.each(["stop", "navigate", "profile"] as const)("disables competing actions during %s while keeping panel close available", (busy) => {
    const html = render({ state: running, busy });
    for (const label of [">Go<", "Stop browser preview", "Reload current page", "Basil&#x27;s profile", ">Guest<"]) {
      expect(button(html, label)).toContain('disabled=""');
    }
    expect(button(html, "Close browser preview panel")).not.toContain('disabled=""');
  });

  it("retains both start choices but disables them during launch", () => {
    const html = render({ state: idle, busy: "start" });
    expect(html).toContain("Opening preview…");
    for (const label of ["Open preview", "Guest preview"]) expect(button(html, label)).toContain('disabled=""');
  });

  it.each(["", "https://example.com/unsubmitted-draft"])("reloads the confirmed URL independently of draft %j", (address) => {
    const input = { ...props({ state: running }), address };
    const click = findClick(BrowserPanelView(input), "Reload current page");
    expect(click).toBeTypeOf("function");
    click!();
    expect(input.onNavigate).toHaveBeenCalledExactlyOnceWith("https://example.com/confirmed");
  });

  it("does not offer reload for a blank initial Chromium tab", () => {
    const html = render({ state: { ...running, url: "about:blank" } });
    expect(button(html, "Reload current page")).toContain('disabled=""');
    expect(html).toContain("Waiting for a page preview…");
  });

  it("preserves long bot names and profile labels as literal text", () => {
    const botName = "VeryLongBotName".repeat(18) + "<script>";
    const html = renderToStaticMarkup(createElement(BrowserPanelView, { ...props({ state: running }), botName }));
    expect(html).toContain(botName.replace("<script>", "&lt;script&gt;"));
    expect(button(html, "&#x27;s profile")).toContain("&lt;script&gt;&#x27;s profile");
    expect(html).not.toContain("<script>");
  });
});
