import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { AuthGate } from "./AuthGate";
import { SESSION_UNAVAILABLE } from "@/lib/session-recovery";

const mocks = vi.hoisted(() => ({ useAuth: vi.fn() }));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Node markup test isolates the browser session provider
vi.mock("@/lib/auth", () => ({ useAuth: mocks.useAuth }));
function render(overrides = {}) {
  mocks.useAuth.mockReturnValue({ user: null, loading: false, sessionError: null, retrySession: vi.fn(), ...overrides });
  return renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ["/os?template=research#work"] },
    createElement(AuthGate, { children: createElement("p", null, "Private workspace") })));
}
describe("auth gate recovery markup", () => {
  it("announces a pending session check without showing private content", () => {
    const html = render({ loading: true });
    expect(html).toContain('role="status"');
    expect(html).toContain("Checking your sign-in");
    expect(html).not.toContain("Private workspace");
  });
  it.each([null, { id: "previously-known" }])("offers recovery for an unavailable check with prior user %j", (user) => {
    const html = render({ user, sessionError: SESSION_UNAVAILABLE });
    expect(html).toContain('role="alert"');
    expect(html).toContain("Try again</button>");
    expect(html).not.toContain("Private workspace");
    expect(html).not.toContain("Continue with Google");
  });
  it("renders private content after a confirmed session", () => {
    expect(render({ user: { id: "verified-owner" } })).toContain("Private workspace");
  });
});
