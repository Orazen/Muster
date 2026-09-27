import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstanceInfo } from "@/state/store";
import { OnboardingProviders } from "./OnboardingProviders";

// oxlint-disable-next-line anti-slop/no-module-mocking -- Node markup tests isolate Store/browser I/O; browser interaction remains an E2E gate.
vi.mock("@/state/store", () => ({ api: vi.fn(), useStore: () => ({ state: { config: {} }, dispatch: vi.fn(), refreshInstances: vi.fn() }) }));
afterEach(() => vi.unstubAllGlobals());

const codex: InstanceInfo = {
  instanceId: "codex", driverKind: "codex", displayName: "Codex", hostPlatform: "darwin",
  snapshot: { state: "available", authenticated: false }, models: { default: "model", options: [] },
  install: { command: { darwin: "install-codex-fixture" }, signInCommand: "codex login", docsUrl: "https://github.com/openai/codex" },
};

describe("onboarding provider markup boundaries", () => {
  it("shows the three account choices on web without a fabricated local sign-in", () => {
    const other: InstanceInfo = { ...codex, instanceId: "gemini", driverKind: "google", displayName: "Gemini fixture", snapshot: { state: "available" } };
    const html = renderToStaticMarkup(createElement(OnboardingProviders, { instances: [codex, other], isDesktop: false }));
    for (const label of ["Claude", "ChatGPT via Codex", "OpenCode", "Bring your own API key", "Download Muster desktop"]) expect(html).toContain(label);
    expect(html).not.toContain("codex login");
    expect(html).not.toContain("github.com");
    expect(html).toContain("Connecting AI does not grant Gmail or Drive access");
    expect(html).toContain('aria-label="Engine status"');
    expect(html).toContain("Gemini fixture");
    expect(html).toContain("Add a provider key");
    expect(html).toContain("https://muster.today/download.html");
  });

  it("reuses real desktop sign-in instructions and omits repository links", () => {
    vi.stubGlobal("window", { ogb: { platform: "darwin" } });
    const html = renderToStaticMarkup(createElement(OnboardingProviders, { instances: [codex], isDesktop: true }));
    expect(html).toContain("codex login");
    expect(html).not.toContain("github.com");
    expect(html).not.toContain("Installed and signed in.");
  });

  it("does not run a remote host's instructions in a different desktop platform", () => {
    vi.stubGlobal("window", { ogb: { platform: "win32" } });
    const html = renderToStaticMarkup(createElement(OnboardingProviders, { instances: [codex], isDesktop: true }));
    expect(html).toContain("This engine runs on another machine");
    expect(html).not.toContain("codex login");
  });
});
