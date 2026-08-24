import { describe, expect, it } from "vitest";
import {
  isLoopbackRedirect,
  issueDesktopGrant,
  issueHandoffCode,
  redeemHandoffCode,
} from "./desktop-auth.ts";

describe("isLoopbackRedirect", () => {
  it("accepts 127.0.0.1 and localhost over http", () => {
    expect(isLoopbackRedirect("http://127.0.0.1:8799")).toBe(true);
    expect(isLoopbackRedirect("http://localhost:8799")).toBe(true);
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
