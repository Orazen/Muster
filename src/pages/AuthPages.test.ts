import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthCapabilities } from "@/lib/auth";
import { LoginPage } from "./LoginPage";
import { SignupPage } from "./SignupPage";

const mocks = vi.hoisted(() => ({ useAuth: vi.fn() }));
// SSR checks page markup only; it does not verify real provider or session behavior.
// oxlint-disable-next-line anti-slop/no-module-mocking -- isolate browser/auth I/O from Node-only markup tests
vi.mock("@/lib/auth", () => ({ useAuth: mocks.useAuth }));

const baseCapabilities: AuthCapabilities = {
  emailVerification: false,
  passwordReset: false,
  socialProviders: [],
  googleOnlySignup: false,
  cloudPairing: false,
  desktopOAuth: false,
  pairingCloudUrl: null,
};

beforeEach(() => vi.clearAllMocks());

function renderPage(Page: ComponentType, capabilities: Partial<AuthCapabilities> = {}, path = "/sign-in", sessionError: string | null = null) {
  mocks.useAuth.mockReturnValue({
    capabilities: { ...baseCapabilities, ...capabilities },
    user: null,
    session: null,
    loading: false,
    sessionError,
    retrySession: vi.fn(),
    signIn: vi.fn(),
    signUp: vi.fn(),
    signOut: vi.fn(),
    signInWithProvider: vi.fn(),
  });
  return renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [path] }, createElement(Page)));
}

function input(markup: string, id: string) {
  const element = markup.match(/<input\b[^>]*>/g)?.find((candidate) => candidate.includes(`id="${id}"`));
  expect(element, `input ${id} exists`).toBeDefined();
  return element ?? "";
}

function expectLabel(markup: string, id: string, text: string) {
  expect(markup).toMatch(new RegExp(`<label\\b[^>]*for="${id}"[^>]*>${text}</label>`));
}

describe("auth form contracts", () => {
  it.each([LoginPage, SignupPage])("offers an existing-session check after a temporary failure", (Page) => {
    const markup = renderPage(Page, {}, "/sign-up?next=%2Fos", "Temporary sign-in check failure");
    expect(markup).toContain("Temporary sign-in check failure");
    expect(markup).toContain("Check sign-in again</button>");
    if (Page === SignupPage) expect(markup).toMatch(/<button type="submit" disabled=""[^>]*>Create account<\/button>/);
  });
  it("keeps visible labels and password-manager hints on sign-in fields", () => {
    const markup = renderPage(LoginPage);
    expectLabel(markup, "email", "Email address");
    expectLabel(markup, "password", "Password");
    expect(input(markup, "email")).toContain('type="email"');
    expect(input(markup, "email")).toContain('autoComplete="email"');
    expect(input(markup, "email")).toContain('required=""');
    expect(input(markup, "password")).toContain('autoComplete="current-password"');
    expect(input(markup, "password")).not.toContain("minLength");
  });

  it("labels signup fields and identifies a new password for password managers", () => {
    const markup = renderPage(SignupPage);
    expectLabel(markup, "name", "Your name");
    expectLabel(markup, "email", "Email address");
    expectLabel(markup, "password", "Password");
    expect(input(markup, "name")).toContain('autoComplete="name"');
    expect(input(markup, "email")).toContain('autoComplete="email"');
    expect(input(markup, "password")).toContain('autoComplete="new-password"');
    for (const id of ["name", "email", "password"]) {
      expect(input(markup, id)).toContain('required=""');
    }
  });

  it("connects the signup password requirement to the field and enforces twelve characters", () => {
    const markup = renderPage(SignupPage);
    expect(input(markup, "password")).toContain('minLength="12"');
    expect(input(markup, "password")).toContain('aria-describedby="password-hint"');
    expect(markup).toMatch(/<p\b[^>]*id="password-hint"[^>]*>Use at least 12 characters\.<\/p>/);
  });

  it.each([
    { name: "sign-in", Page: LoginPage },
    { name: "signup", Page: SignupPage },
  ])("keeps $name password reveal separate from form submission", ({ Page }) => {
    const markup = renderPage(Page);
    const reveal = markup.match(/<button\b[^>]*>/g)?.find((element) => element.includes('aria-label="Show password"'));
    expect(reveal).toBeDefined();
    expect(reveal).toContain('type="button"');
    expect(reveal).toContain('aria-controls="password"');
    expect(reveal).toContain('aria-pressed="false"');
    expect(input(markup, "password")).toContain('type="password"');
  });

  it.each([true, false])("offers password recovery only when delivery is available: %s", (passwordReset) => {
    const markup = renderPage(LoginPage, { passwordReset });
    expect(markup.includes('href="/forgot-password"')).toBe(passwordReset);
  });

  it("offers the desktop Google handoff without requiring local Google credentials", () => {
    const markup = renderPage(LoginPage, { desktopOAuth: true, pairingCloudUrl: "https://cloud.example" });
    expect(markup).toContain("Continue with Google");
    expect(markup).toContain("Sign in with email");
    expect(markup).not.toContain("GOOGLE_CLIENT_SECRET");
  });

  it("keeps email sign-in available when no social provider or handoff is configured", () => {
    const markup = renderPage(LoginPage);
    expect(markup).not.toContain("Continue with Google");
    expect(markup).toContain("Sign in with email");
  });

  it("renders a single Google choice when direct OAuth and the desktop handoff are both available", () => {
    const markup = renderPage(LoginPage, { socialProviders: ["google"], desktopOAuth: true });
    expect(markup.match(/Continue with Google/g)).toHaveLength(1);
  });

  it("gives pairing its own submit form without nesting it in email sign-in", () => {
    const markup = renderPage(LoginPage, { cloudPairing: true });
    const forms = markup.match(/<form\b[^>]*>[\s\S]*?<\/form>/g) ?? [];
    expect(forms).toHaveLength(2);
    for (const form of forms) expect(form.match(/<form\b/g)).toHaveLength(1);
    const emailForm = forms.find((form) => form.includes('autoComplete="current-password"'));
    const pairingForm = forms.find((form) => form.includes('aria-label="Pairing code"'));
    expect(emailForm).toBeDefined();
    expect(pairingForm).toBeDefined();
    expect(emailForm).not.toBe(pairingForm);
    expect(pairingForm).toContain('maxLength="12"');
    expect(pairingForm).toMatch(/<button\b[^>]*type="submit"[^>]*>Connect<\/button>/);
  });

  it("preserves the return destination in the link between sign-in and signup", () => {
    const next = "/app?view=approvals#latest";
    const markup = renderPage(LoginPage, {}, `/sign-in?next=${encodeURIComponent(next)}`);
    expect(markup).toContain(`href="/sign-up?next=${encodeURIComponent(next)}"`);
  });

  it("hides the one-time-code path unless the server advertises it", () => {
    const markup = renderPage(LoginPage);
    expect(markup).not.toContain("Email me a code");
    expect(markup).not.toContain("or get a one-time code");
    expect(markup).not.toContain('id="otp-email"');
  });

  it("offers the one-time-code panel as its own form when the server advertises it", () => {
    const markup = renderPage(LoginPage, { emailOtp: true });
    expect(markup).toContain("or get a one-time code");
    expect(markup).toContain("Email me a code");
    expect(input(markup, "otp-email")).toMatch(/type="email"/);
    expect(input(markup, "otp-email")).toMatch(/autoComplete="email"/i);
    // Its own top-level form, never nested inside the password form — the
    // same no-nesting contract the pairing form is pinned to above.
    const forms = markup.match(/<form\b[^>]*>[\s\S]*?<\/form>/g) ?? [];
    expect(forms).toHaveLength(2);
    for (const form of forms) expect(form.match(/<form\b/g)).toHaveLength(1);
    const otpForm = forms.find((form) => form.includes('id="otp-email"'));
    expect(otpForm).toBeDefined();
    expect(otpForm).not.toContain('autoComplete="current-password"');
    const passwordForm = forms.find((form) => form.includes('autoComplete="current-password"'));
    expect(passwordForm).toBeDefined();
    // The existing password path is untouched and still present alongside.
    expect(markup).toContain("Sign in with email");
  });
});
