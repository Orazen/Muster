import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearStashedReferral, stashReferral, type AuthCapabilities } from "@/lib/auth";
import { LoginPage } from "./LoginPage";
import { SignupPage } from "./SignupPage";

const mocks = vi.hoisted(() => {
  // `auth.tsx` reads `window.location.origin` as it evaluates, and the referral stash lives in
  // `sessionStorage`; both must exist before that module is imported, which `vi.hoisted` is the
  // only ordering that guarantees in a file whose environment is node.
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "window", {
    value: { location: { origin: "http://127.0.0.1:5199" } },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
    },
    configurable: true,
    writable: true,
  });
  return { useAuth: vi.fn() };
});

// SSR checks page markup only; it does not verify real provider or session behavior. Everything
// except the session hook stays real: the OAuth-error referral restore under test lives in this
// module, and mocking it would mean asserting against the mock rather than the behaviour.
// oxlint-disable-next-line anti-slop/no-module-mocking -- isolate browser/auth I/O from Node-only markup tests
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  useAuth: mocks.useAuth,
}));

const baseCapabilities: AuthCapabilities = {
  emailVerification: false,
  passwordReset: false,
  socialProviders: [],
  googleOnlySignup: false,
  cloudPairing: false,
  desktopOAuth: false,
  pairingCloudUrl: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  // A stash is tab-scoped state; leaving one behind would let it satisfy the next test's page.
  clearStashedReferral();
});

interface ContextOverrides {
  /** Mirrors a failed /api/auth-capabilities read: capabilities stay at their initial value. */
  readonly capabilitiesError?: boolean;
  readonly retryCapabilities?: () => Promise<boolean>;
}

function renderPage(Page: ComponentType, capabilities: Partial<AuthCapabilities> = {}, path = "/sign-in", sessionError: string | null = null, overrides: ContextOverrides = {}) {
  mocks.useAuth.mockReturnValue({
    capabilities: { ...baseCapabilities, ...capabilities },
    capabilitiesError: false,
    retryCapabilities: vi.fn(() => Promise.resolve(true)),
    ...overrides,
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

  // Regression: the OAuth failure route rewrites the return down to `authError=<code>`, so the URL
  // this page renders from carries neither the referral nor the destination. Both were stashed by
  // the attempt that redirected, so the page has to put them back — reading the empty query string
  // alone was what dropped the code and sent every retry to the default destination.
  it("restores the referral and destination the OAuth error route stripped from the URL", () => {
    stashReferral("REF-9", "/pair", "attempt-1");
    const markup = renderPage(LoginPage, {}, "/sign-in?authError=state_mismatch");
    expect(markup).toContain("That sign-in expired");
    // `&` is entity-escaped by renderToStaticMarkup, so the separator arrives as `&amp;`.
    expect(markup).toContain(`href="/sign-up?next=${encodeURIComponent("/pair")}&amp;ref=REF-9"`);
  });

  it("restores nothing when the failed attempt never carried a referral", () => {
    const markup = renderPage(LoginPage, {}, "/sign-in?authError=state_mismatch");
    expect(markup).toContain(`href="/sign-up?next=${encodeURIComponent("/app")}"`);
    expect(markup).not.toContain("&amp;ref=");
  });

  it("hides the one-time-code path unless the server advertises it", () => {
    const markup = renderPage(LoginPage);
    expect(markup).not.toContain("Email me a code");
    expect(markup).not.toContain("or get a one-time code");
    expect(markup).not.toContain('id="otp-email"');
  });

  it("offers the one-time-code panel as its own form when the server advertises it", () => {
    const markup = renderPage(LoginPage, { emailOtp: true });
    expect(markup).toContain("Use a password instead");
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
    // Password remains available in a disclosure without discarding its fields.
    expect(markup).toContain("Sign in with email");
  });
});

// These markup cases cover platform availability; browser tests exercise the
// handoff and delivery recovery transitions with explicit fixture responses.
it("offers the same Google handoff on desktop account creation", () => {
  const markup = renderPage(SignupPage, { desktopOAuth: true });
  expect(markup).toContain("Continue with Google");
});

it("makes email codes primary while keeping the password choice discoverable", () => {
  const markup = renderPage(LoginPage, { emailOtp: true });
  expect(markup.indexOf('id="otp-email"')).toBeLessThan(markup.indexOf('id="password"'));
  expect(markup).toMatch(/<details class="auth-password-option"><summary>Use a password instead/);
});

// A capability read that fails is not the same claim as "this server offers no optional flows":
// the first is something we could not find out, the second is a fact. The page must say which,
// because the only difference a user can act on is the one that offers a retry.
describe("capability failure is visible and recoverable", () => {
  it.each([LoginPage, SignupPage])("%s offers a retry and withholds methods it could not confirm", (Page) => {
    const markup = renderPage(Page, {}, "/sign-in", null, { capabilitiesError: true });
    expect(markup).toContain("Could not load which sign-in methods this server offers");
    expect(markup).toContain("Check again</button>");
    expect(markup).not.toContain("Continue with Google");
    expect(markup).not.toContain('id="otp-email"');
  });

  it.each([LoginPage, SignupPage])("%s shows the methods again once the retry succeeds", (Page) => {
    const failed = renderPage(Page, {}, "/sign-in", null, { capabilitiesError: true });
    expect(failed).not.toContain("Continue with Google");
    expect(failed).not.toContain("Email me a code");

    const recovered = renderPage(
      Page,
      { socialProviders: ["google"], emailOtp: true },
      "/sign-in",
      null,
      { capabilitiesError: false },
    );
    expect(recovered).toContain("Continue with Google");
    expect(recovered).not.toContain("Check again</button>");
  });

  it("does not nag when the server simply has no optional flows", () => {
    const markup = renderPage(LoginPage, {}, "/sign-in", null, { capabilitiesError: false });
    expect(markup).not.toContain("Check again</button>");
    expect(markup).toContain("Sign in with email");
  });
});
