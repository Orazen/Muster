import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DesktopCapabilitySession, type DesktopCapabilityState } from "@/lib/desktop";
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
