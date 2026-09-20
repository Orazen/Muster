import { describe, expect, it } from "vitest";
import {
  COMPANION_OAUTH_REDIRECT,
  desktopSignInRetrySeconds,
  handoffFinishURL,
  isCompanionRedirect,
  isHandoffRedirect,
  isLoopbackRedirect,
  issueDesktopGrant,
  issueDesktopGrantWithReturn,
  issueHandoffCode,
  redeemHandoffCode,
} from "./desktop-auth.ts";

describe("desktop sign-in retry delay", () => {
  it.each([["10", 10], [" 7 ", 7], ["0", 1], ["3600", 3600]])(
    "normalizes delay-seconds %j to %i",
    (value, expected) => expect(desktopSignInRetrySeconds(String(value))).toBe(expected),
  );

  it.each([null, "", "-1", "0.5", "NaN", "Infinity", "3601", "99999999999999", "10\r\nX-Test: injected", "<script>bad</script>"])(
    "uses the social window for an invalid retry value %j",
    (value) => expect(desktopSignInRetrySeconds(value)).toBe(10),
  );
});

describe("isLoopbackRedirect", () => {
  it("accepts 127.0.0.1 and localhost over http", () => {
    expect(isLoopbackRedirect("http://127.0.0.1:8799")).toBe(true);
    expect(isLoopbackRedirect("http://localhost:8799")).toBe(true);
  });

  it("accepts the bracketed IPv6 loopback form", () => {
    // WHATWG URL.hostname keeps brackets on IPv6 hosts, so this matches the
    // "[::1]" branch.
    expect(isLoopbackRedirect("http://[::1]:8799")).toBe(true);
  });

  it("rejects remote hosts, https, and garbage", () => {
    expect(isLoopbackRedirect("https://evil.example.com")).toBe(false);
    expect(isLoopbackRedirect("http://169.254.169.254/")).toBe(false);
    expect(isLoopbackRedirect("not a url")).toBe(false);
    expect(isLoopbackRedirect("")).toBe(false);
  });
});

describe("desktop handoff lifecycle", () => {
  const identity = { userId: "u1", email: "t@example.com", name: "T" };

  it("grant -> code -> redeem yields the identity", () => {
    const grant = issueDesktopGrant("http://127.0.0.1:8799");
    const handoff = issueHandoffCode(grant, identity);
    expect(handoff).not.toBeNull();
    expect(handoff?.redirect).toBe("http://127.0.0.1:8799");
    expect(redeemHandoffCode(handoff!.code)).toEqual(identity);
  });

  it("stores and returns a sanitized local next-path for desktop handoff", () => {
    const grant = issueDesktopGrantWithReturn("http://127.0.0.1:8799", "/app?tab=inbox", Date.now());
    const handoff = issueHandoffCode(grant, identity);
    expect(handoff?.returnTo).toBe("/app?tab=inbox");
  });

  it("drops absolute next URLs from desktop handoff state", () => {
    const grant = issueDesktopGrantWithReturn("http://127.0.0.1:8799", "https://evil.example.com/app");
    const handoff = issueHandoffCode(grant, identity);
    expect(handoff?.returnTo).toBeUndefined();
  });

  it("a grant can only produce one code", () => {
    const grant = issueDesktopGrant("http://127.0.0.1:8799");
    expect(issueHandoffCode(grant, identity)).not.toBeNull();
    expect(issueHandoffCode(grant, identity)).toBeNull();
  });

  it("a code redeems exactly once", () => {
    const grant = issueDesktopGrant("http://127.0.0.1:8799");
    const code = issueHandoffCode(grant, identity)!.code;
    expect(redeemHandoffCode(code)).not.toBeNull();
    expect(redeemHandoffCode(code)).toBeNull();
  });

  it("expired grants refuse to mint codes", () => {
    // SAFETY: fake timers via explicit now injection; no vi.useFakeTimers
    // needed since every lifecycle fn takes `now`.
    const t0 = Date.now();
    const grant = issueDesktopGrant("http://127.0.0.1:8799", t0 - 11 * 60_000);
    expect(issueHandoffCode(grant, identity)).toBeNull();
  });

  it("expired codes do not redeem", () => {
    const t0 = Date.now();
    const grant = issueDesktopGrant("http://127.0.0.1:8799", t0);
    const code = issueHandoffCode(grant, identity, t0)!.code;
    expect(redeemHandoffCode(code, t0 + 91_000)).toBeNull();
  });
});

describe("companion handoff redirect (muster:// scheme)", () => {
  it("accepts the exact companion finish URL", () => {
    expect(isHandoffRedirect("muster://oauth/finish")).toBe(true);
    expect(isCompanionRedirect("muster://oauth/finish")).toBe(true);
  });

  it("rejects arbitrary custom schemes and lookalikes — the allowlist is fixed", () => {
    // An open redirect into any scheme would let a hostile page fish the
    // one-time code into an app of its choosing.
    expect(isCompanionRedirect("evil://oauth/finish")).toBe(false);
    expect(isCompanionRedirect("muster://oauth/finish/extra")).toBe(false);
    expect(isCompanionRedirect("muster://evil#code=x")).toBe(false);
    expect(isCompanionRedirect("https://muster.today/oauth/finish")).toBe(false);
    expect(isCompanionRedirect("muster://oauth/finish ")).toBe(false);
  });

  it("loopback still validates through the combined gate", () => {
    expect(isHandoffRedirect("http://127.0.0.1:8799")).toBe(true);
    expect(isHandoffRedirect("https://example.com")).toBe(false);
  });

  it("finish URL keeps the /oauth/finish append for loopback only", () => {
    // Desktop: the finish page lives on the desktop's own server.
    expect(handoffFinishURL("http://127.0.0.1:8799")).toBe("http://127.0.0.1:8799/oauth/finish");
    // Companion: the scheme URL IS the finish endpoint — appending would
    // produce muster://oauth/finish/oauth/finish and iOS would never fire.
    expect(handoffFinishURL("muster://oauth/finish")).toBe("muster://oauth/finish");
  });

  it("a companion-scheme grant round-trips: grant -> code -> redeem", () => {
    const t0 = Date.now();
    const local = { userId: "u1", email: "a@b.c", name: "A" };
    const grant = issueDesktopGrant(COMPANION_OAUTH_REDIRECT, t0);
    const handoff = issueHandoffCode(grant, local, t0)!;
    expect(handoff.redirect).toBe(COMPANION_OAUTH_REDIRECT);
    expect(handoffFinishURL(handoff.redirect)).toBe(COMPANION_OAUTH_REDIRECT);
    expect(redeemHandoffCode(handoff.code, t0)).toEqual(local);
  });
});
