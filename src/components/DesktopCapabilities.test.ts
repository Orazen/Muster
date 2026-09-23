import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DesktopCapabilitySession, initialDesktopCapabilities, permissionRequestPresentationDestination, type DesktopCapabilityState, type PrivacyPane } from "@/lib/desktop";
import { ComputerAccessView, DesktopCapabilitiesProvider } from "./DesktopCapabilities";

const base = new DesktopCapabilitySession({ platform: "darwin", enableComputerAccess: async () => ({ mode: "embedded" }) }).getSnapshot();
const render = (patch: Partial<DesktopCapabilityState> = {}) => renderToStaticMarkup(createElement(ComputerAccessView, {
  state: { ...base, ready: true, ...patch }, onEnable: vi.fn(), onRefresh: vi.fn(),
}));
const button = (html: string) => html.match(/<button\b[^>]*>[\s\S]*?<\/button>/)?.[0] ?? "";

describe("computer access consent rendering (SSR)", () => {
  it("explains the session scope, Auto, per-bot Off and OS prompts before offering explicit enablement", () => {
    const html = render();
    expect(html).toContain('aria-label="This Mac access"');
    expect(html).toContain("Computer access is off for this session.");
    for (const text of ["bots assigned This Mac", "Auto when it uses this Mac", "until you quit Muster", "Off setting still blocks", "Accessibility and Screen Recording"]) expect(html).toContain(text);
    expect(button(html)).toContain("Enable for this session");
    expect(button(html)).not.toContain('disabled=""');
  });

  it.each([{ ready: false }, { enabling: true }, { refreshing: true }])("disables duplicate or premature enablement while %j", (patch) => {
    expect(button(render(patch))).toContain('disabled=""');
  });

  it("shows the returned error as escaped alert text and retains the same retryable button", () => {
    const html = render({ enableError: "Driver <daemon> is missing" });
    expect(html).toContain('role="alert"');
    expect(html).toContain("Driver &lt;daemon&gt; is missing");
    expect(html).not.toContain("<daemon>");
    expect(button(html)).toContain("Enable for this session");
    expect(button(html)).not.toContain('disabled=""');
  });

  it("offers a separate read-only retry for capability errors and deduplicates identical messages", () => {
    const html = render({ error: "IPC unavailable", enableError: "IPC unavailable" });
    expect(html.match(/IPC unavailable/g)).toHaveLength(1);
    expect(html).toContain("Retry capability check");
    expect(html).toContain("Computer access could not be confirmed.");
    expect(html).not.toContain("Computer access is off for this session.");
  });

  it("reports confirmed session availability without another enable button", () => {
    const html = render({ capabilities: { ...base.capabilities, localComputer: { available: true, support: "supported" } } });
    expect(html).toContain("This Mac is enabled for this session.");
    expect(html).not.toContain("Enable for this session");
    expect(html).toContain("Off setting still blocks");
  });

  it.each([undefined, { platform: "darwin" as const }, { platform: "win32" as const }])("renders fallback without an unsupported activation control (%j)", (bridge) => {
    const html = render(new DesktopCapabilitySession(bridge).getSnapshot());
    expect(html).not.toContain("Enable for this session");
    expect(html).toMatch(/Update the desktop app|requires the macOS desktop app/);
  });

  it("does not invoke activation while rendering the control or provider", () => {
    const onEnable = vi.fn();
    renderToStaticMarkup(createElement(DesktopCapabilitiesProvider, null,
      createElement(ComputerAccessView, { state: base, onEnable, onRefresh: vi.fn() })));
    expect(onEnable).not.toHaveBeenCalled();
  });
});

// Permission presentation destination (tiptour integration study, slice 4):
// one path per tap — the session's own request first, System Settings after,
// nothing at all once the host reports access.
describe("permission presentation destination", () => {
  it("sequences systemPrompt → systemSettings, and short-circuits when already granted", () => {
    expect(permissionRequestPresentationDestination({ hasPermissionNow: false, hasAttemptedSystemPrompt: false })).toBe("systemPrompt");
    expect(permissionRequestPresentationDestination({ hasPermissionNow: false, hasAttemptedSystemPrompt: true })).toBe("systemSettings");
    // granted wins over every prior attempt — never re-request a grant
    expect(permissionRequestPresentationDestination({ hasPermissionNow: true, hasAttemptedSystemPrompt: false })).toBe("alreadyGranted");
    expect(permissionRequestPresentationDestination({ hasPermissionNow: true, hasAttemptedSystemPrompt: true })).toBe("alreadyGranted");
  });

  const bridgeWith = (panes: PrivacyPane[], granted = false) => {
    // no assertion: the literal is chosen here and typed where it is chosen
    const support: "supported" | "unsupported" = granted ? "supported" : "unsupported";
    return {
      platform: "darwin" as const,
      enableComputerAccess: vi.fn(async () => ({ mode: "embedded" as const })),
      getCapabilities: async () => ({
        ...initialDesktopCapabilities({ platform: "darwin" as const }),
        localComputer: { available: granted, support },
      }),
      permOpenSettings: async (pane: PrivacyPane) => { panes.push(pane); },
    };
  };

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("reports the prompt destination before any request and opens nothing", async () => {
    const panes: PrivacyPane[] = [];
    const bridge = bridgeWith(panes);
    const session = new DesktopCapabilitySession(bridge);
    session.attach();
    await settle();
    expect(session.getSnapshot().permissionRequestAttempted).toBe(false);
    expect(session.openPrivacySettings("accessibility")).toBe("systemPrompt");
    expect(panes).toEqual([]);
    expect(bridge.enableComputerAccess).not.toHaveBeenCalled(); // the request control owns that tap
  });

  it("after the session's request, the same tap deep-links to System Settings", async () => {
    const panes: PrivacyPane[] = [];
    const bridge = bridgeWith(panes);
    const session = new DesktopCapabilitySession(bridge);
    session.attach();
    await settle();
    await session.enable();
    expect(session.getSnapshot().permissionRequestAttempted).toBe(true);
    expect(session.openPrivacySettings("accessibility")).toBe("systemSettings");
    expect(panes).toEqual(["accessibility"]);
    // a second tap repeats the Settings path — never a second prompt attempt
    expect(session.openPrivacySettings("accessibility")).toBe("systemSettings");
    expect(panes).toEqual(["accessibility", "accessibility"]);
    expect(bridge.enableComputerAccess).toHaveBeenCalledTimes(1);
  });

  it("never re-requests or deep-links a permission the host reports granted", async () => {
    const panes: PrivacyPane[] = [];
    const bridge = bridgeWith(panes, true);
    const session = new DesktopCapabilitySession(bridge);
    session.attach();
    await settle();
    expect(session.getSnapshot().capabilities.localComputer.available).toBe(true);
    expect(session.openPrivacySettings("screen")).toBe("alreadyGranted");
    expect(panes).toEqual([]);
  });

  it("claims no grant of its own: the repair path only ever reports the host's state", async () => {
    const panes: PrivacyPane[] = [];
    const session = new DesktopCapabilitySession(bridgeWith(panes));
    session.attach();
    await settle();
    await session.enable();
    session.openPrivacySettings("accessibility");
    // the enable attempt failed to produce access (no real permissions here),
    // and the destination said Settings — the state still reads "off"
    expect(session.getSnapshot().capabilities.localComputer.available).toBe(false);
    expect(session.getSnapshot().permissionRequestAttempted).toBe(true);
  });

  const renderRepair = (patch: Partial<DesktopCapabilityState> = {}, onOpenSettings = vi.fn()) =>
    renderToStaticMarkup(createElement(ComputerAccessView, {
      state: { ...base, ready: true, ...patch }, onEnable: vi.fn(), onRefresh: vi.fn(), onOpenSettings,
    }));

  it("offers the repair path only after this session's request", () => {
    expect(renderRepair()).not.toContain("Open Privacy Settings");
    const html = renderRepair({ permissionRequestAttempted: true });
    expect(html.match(/Open Privacy Settings/g)).toHaveLength(1);
    expect(html).toContain("Enable for this session");
  });

  it("withholds the repair path while a request is in flight or access is on", () => {
    expect(renderRepair({ permissionRequestAttempted: true, enabling: true })).not.toContain("Open Privacy Settings");
    expect(renderRepair({ permissionRequestAttempted: true, refreshing: true })).not.toContain("Open Privacy Settings");
    expect(renderRepair({ permissionRequestAttempted: true, capabilities: { ...base.capabilities, localComputer: { available: true, support: "supported" } } }))
      .not.toContain("Open Privacy Settings");
  });

  it("renders no dead control on a surface that never offered the handler", () => {
    const html = renderToStaticMarkup(createElement(ComputerAccessView, {
      state: { ...base, ready: true, permissionRequestAttempted: true }, onEnable: vi.fn(), onRefresh: vi.fn(),
    }));
    expect(html).not.toContain("Open Privacy Settings");
  });
});
