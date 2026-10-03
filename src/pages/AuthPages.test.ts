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

describe("passwordless sign-in contracts", () => {
  it.each([false, true])("never offers password or separate signup when emailOtp=%s", (emailOtp) => {
    const markup = renderPage(LoginPage, { emailOtp, passwordReset: true });
    expect(markup).not.toContain('type="password"');
    expect(markup).not.toContain("Use a password instead");
    expect(markup).not.toContain("Create an account");
    expect(markup).not.toContain('href="/forgot-password"');
  });

  it("keeps a labeled email form with native Enter submission when OTP is available", () => {
    const markup = renderPage(LoginPage, { emailOtp: true });
    expectLabel(markup, "otp-email", "Email address for a sign-in code");
    expect(input(markup, "otp-email")).toContain('type="email"');
    expect(input(markup, "otp-email")).toContain('autoComplete="email"');
    expect(input(markup, "otp-email")).toContain('required=""');
    expect(markup).toContain("Email me a code");
    const forms = markup.match(/<form\b[^>]*>[\s\S]*?<\/form>/g) ?? [];
    expect(forms).toHaveLength(1);
    expect(forms[0]).toContain('type="submit"');
  });

  it("explains unavailable OTP without silently falling back to a password", () => {
    const markup = renderPage(LoginPage);
    expect(markup).toContain("Email code sign-in is currently unavailable.");
    expect(markup).toContain("Please try again later.");
    expect(markup).not.toContain('id="otp-email"');
    expect(markup).not.toContain("or use your email");
  });

  it("preserves direct Google and desktop handoff as a single choice", () => {
    const markup = renderPage(LoginPage, { socialProviders: ["google"], desktopOAuth: true });
    expect(markup.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)?.filter((button) => button.includes("Continue with Google"))).toHaveLength(1);
    expect(markup).toContain("Continue with Google above.");
    expect(markup).not.toContain("GOOGLE_CLIENT_SECRET");
  });

  it("keeps pairing separate from email code submission", () => {
    const markup = renderPage(LoginPage, { emailOtp: true, cloudPairing: true });
    const forms = markup.match(/<form\b[^>]*>[\s\S]*?<\/form>/g) ?? [];
    expect(forms).toHaveLength(2);
    for (const form of forms) expect(form.match(/<form\b/g)).toHaveLength(1);
    expect(forms.some((form) => form.includes('id="otp-email"'))).toBe(true);
    const pairingForm = forms.find((form) => form.includes('aria-label="Pairing code"'));
    expect(pairingForm).toContain('maxLength="12"');
    expect(pairingForm).toContain('type="submit"');
  });

  it("preserves session recovery", () => {
    const markup = renderPage(LoginPage, {}, "/sign-in?next=%2Fos", "Temporary sign-in check failure");
    expect(markup).toContain("Temporary sign-in check failure");
    expect(markup).toContain("Check sign-in again</button>");
  });
});

describe("legacy signup remains unchanged pending referral migration", () => {
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

});
