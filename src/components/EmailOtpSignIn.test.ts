import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  EmailOtpCodeForm,
  attemptOtpSend,
  newOtpIdempotencyKey,
  otpDigits,
  otpErrorMessage,
  otpRetryAfterSeconds,
  otpSendFallback,
  type OtpErrorBody,
  type OtpPost,
  type OtpPostResult,
} from "./EmailOtpSignIn";

// SSR/markup + pure-helper contracts for the one-time-code panel; the
// two-stage wiring on the login page itself is pinned in
// src/pages/AuthPages.test.ts. attemptOtpSend drives a fake post() so the
// one-attempt + one-transport-retry contract (same Idempotency-Key across
// the retry) is provable without a browser.

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
    // No message on the body: the priced seconds still make the copy.
    [{ code: "RESEND_COOLDOWN", retryAfterSeconds: 17 }, /Wait 17 seconds/],
    [{ code: "RESEND_COOLDOWN" }, /Wait a moment/],
    // The wrapper's per-IP window quotes its own seconds…
    [{ code: "RATE_LIMITED", retryAfterSeconds: 42 }, /wait 42 seconds/i],
    // …and still reads sanely if a 429 arrives bare.
    [{ code: "RATE_LIMITED" }, /Too many code requests/],
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

describe("otpRetryAfterSeconds", () => {
  const cases: Array<[OtpErrorBody | null, number]> = [
    [{ retryAfterSeconds: 42 }, 42],
    [{ retryAfterSeconds: 1 }, 1],
    [{ retryAfterSeconds: 0 }, 0],
    // Negative waits clamp to "go now"; fractions round UP — a wait must
    // never round the client into an early retry.
    [{ retryAfterSeconds: -5 }, 0],
    [{ retryAfterSeconds: 12.4 }, 13],
    // Strings and junk read as no countdown (checked, never trusted).
    [{ retryAfterSeconds: "60" }, 0],
    [{ retryAfterSeconds: "soon" }, 0],
    [{ retryAfterSeconds: null }, 0],
    [{ code: "RESEND_COOLDOWN" }, 0],
    [null, 0],
  ];
  it.each(cases)("reads %j as %i seconds", (body, expected) => {
    expect(otpRetryAfterSeconds(body)).toBe(expected);
  });
});

describe("otpSendFallback", () => {
  it("quotes the server's priced wait on a 429 and stays generic otherwise", () => {
    expect(otpSendFallback(429, 42)).toMatch(/wait 42 seconds/i);
    // A bare plugin 429 carries no seconds — honest wording, no fake minute.
    expect(otpSendFallback(429, 0)).toBe("Too many code requests. Please wait and try again.");
    expect(otpSendFallback(400, 0)).toMatch(/could not send/i);
    expect(otpSendFallback(502, 0)).toMatch(/could not send/i);
  });
});

describe("attemptOtpSend", () => {
  const accepted: OtpPostResult = { ok: true, status: 200, json: null };

  it("sends exactly one keyed request per attempt", async () => {
    const calls: Array<{ path: string; body: Record<string, string>; headers?: Record<string, string> }> = [];
    const post: OtpPost = async (path, body, headers) => {
      calls.push({ path, body, headers });
      return accepted;
    };
    const result = await attemptOtpSend(post, "dev@example.test", "key-1");
    expect(result).toBe(accepted);
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe("/api/auth/email-otp/send-verification-otp");
    expect(calls[0].body).toEqual({ email: "dev@example.test", type: "sign-in" });
    expect(calls[0].headers).toEqual({ "idempotency-key": "key-1" });
  });

  it("retries a transport failure once with the SAME key", async () => {
    const keysSeen: Array<string | undefined> = [];
    let calls = 0;
    const post: OtpPost = async (_path, _body, headers) => {
      keysSeen.push(headers?.["idempotency-key"]);
      calls += 1;
      if (calls === 1) throw new Error("network dropped mid-flight");
      return accepted;
    };
    const result = await attemptOtpSend(post, "dev@example.test", "key-2");
    expect(result).toBe(accepted);
    expect(calls).toBe(2);
    // Both attempts carried ONE key — the server can replay instead of double-send.
    expect(keysSeen).toEqual(["key-2", "key-2"]);
  });

  it("never retries an answered rejection — the server priced that wait", async () => {
    const limited: OtpPostResult = {
      ok: false,
      status: 429,
      json: { code: "RATE_LIMITED", retryAfterSeconds: 42 },
    };
    let calls = 0;
    const post: OtpPost = async () => {
      calls += 1;
      return limited;
    };
    const result = await attemptOtpSend(post, "dev@example.test", "key-3");
    expect(result).toBe(limited);
    expect(result.status).toBe(429);
    expect(calls).toBe(1);
  });

  it("propagates a second transport failure instead of looping", async () => {
    let calls = 0;
    const post: OtpPost = async () => {
      calls += 1;
      throw new Error("still down");
    };
    await expect(attemptOtpSend(post, "dev@example.test", "key-4")).rejects.toThrow("still down");
    expect(calls).toBe(2);
  });
});

describe("newOtpIdempotencyKey", () => {
  it("mints a fresh key per user-initiated attempt", () => {
    const first = newOtpIdempotencyKey();
    const second = newOtpIdempotencyKey();
    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBeGreaterThan(0);
    expect(first).not.toBe(second);
    // Within the server's accepted bound (oversized keys read as "no key").
    expect(first.length).toBeLessThanOrEqual(128);
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
