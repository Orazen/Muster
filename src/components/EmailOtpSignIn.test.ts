import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EmailOtpCodeForm, otpDigits, otpErrorMessage, type OtpErrorBody } from "./EmailOtpSignIn";

// SSR/markup + pure-helper contracts for the one-time-code panel; the
// two-stage wiring on the login page itself is pinned in
// src/pages/AuthPages.test.ts.

describe("otpDigits", () => {
  it("reduces any paste to at most six digits", () => {
    expect(otpDigits("123 456")).toBe("123456");
    expect(otpDigits("code: 9012-3456 trailing")).toBe("901234");
    expect(otpDigits("  1111111111  ")).toBe("111111");
    expect(otpDigits("no digits here")).toBe("");
    expect(otpDigits("")).toBe("");
  });
});

describe("otpErrorMessage", () => {
  // Decoded off the wire: each row is a body the server actually answers
  // (or null when the body fails to parse), paired with the copy it must
  // surface — never a blank error box.
  const cases: Array<[OtpErrorBody | null, RegExp]> = [
    [{ code: "OTP_EXPIRED" }, /expired/i],
    [{ code: "INVALID_OTP" }, /isn’t right/i],
    [{ code: "TOO_MANY_ATTEMPTS" }, /too many attempts/i],
    [
      { code: "RESEND_COOLDOWN", message: "A code was already sent to this address. Try again in 42 seconds." },
      /Try again in 42 seconds/,
    ],
    [{ code: "SIGNUPS_CLOSED" }, /closed/i],
    [{ code: "GOOGLE_ONLY_SIGNUP" }, /Google/i],
    [{ code: "INVALID_EMAIL" }, /valid email/i],
    // Better Auth's per-IP 429 has no code — the message itself must land.
    [{ message: "Too many requests. Please try again later." }, /Too many requests/],
    // Anything unrecognised falls back, never a blank error box.
    [{ code: "SOMETHING_NEW" }, /fallback copy/],
    [null, /fallback copy/],
  ];
  it.each(cases)("maps %j to readable copy", (body, expected) => {
    expect(otpErrorMessage(body, "fallback copy")).toMatch(expected);
  });
});

describe("EmailOtpCodeForm SSR contract", () => {
  const noop = () => {};
  const base = {
    email: "dev@example.test",
    code: "",
    busy: false,
    error: "",
    resendIn: 0,
    onCodeChange: noop,
    onSubmit: noop,
    onResend: noop,
    onBack: noop,
  };
  const render = (overrides: Partial<typeof base> = {}) =>
    renderToStaticMarkup(createElement(EmailOtpCodeForm, { ...base, ...overrides }));

  it("pins the one-time-code autofill, numeric entry and six-digit cap", () => {
    const markup = render();
    const input = markup.match(/<input\b[^>]*id="otp-code"[^>]*>/)?.[0];
    expect(input, "otp-code input exists").toBeDefined();
    expect(input).toMatch(/autoComplete="one-time-code"/i);
    expect(input).toMatch(/inputMode="numeric"/i);
    expect(input).toMatch(/maxLength="6"/i);
    expect(input).toContain('required=""');
    expect(markup).toContain("dev@example.test");
    expect(markup).toMatch(/<label\b[^>]*for="otp-code"[^>]*>6-digit code<\/label>/);
  });

  it("disables resend through the cooldown and offers it again at zero", () => {
    const cooling = render({ resendIn: 42 });
    expect(cooling).toContain("Resend code in 42s");
    const coolingButton = cooling.match(/<button\b[^>]*>Resend code in 42s/)?.[0] ?? "";
    expect(coolingButton).toContain("disabled");
    const ready = render({ resendIn: 0 });
    expect(ready).toMatch(/<button\b[^>]*>Resend code<\/button>/);
    expect(ready.match(/<button\b[^>]*>Resend code<\/button>/)?.[0]).not.toContain("disabled");
  });

  it("keeps submit disabled until six digits and surfaces errors accessibly", () => {
    const partial = render({ code: "123" });
    const submit = partial.match(/<button\b[^>]*type="submit"[^>]*>/)?.[0] ?? "";
    expect(submit).toContain("disabled");
    const complete = render({ code: "123456" });
    const readySubmit = complete.match(/<button\b[^>]*type="submit"[^>]*>/)?.[0] ?? "";
    expect(readySubmit).not.toContain("disabled");
    const errored = render({ code: "123456", error: "That code isn’t right. Check the latest code and try again." });
    expect(errored).toContain('role="alert"');
    expect(errored).toContain("That code isn’t right.");
  });

  it("offers a way back to the email stage", () => {
    const markup = render();
    expect(markup).toMatch(/<button\b[^>]*>Use a different email<\/button>/);
  });
});
