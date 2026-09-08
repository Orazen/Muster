// Claim code mechanics — the `muster up` QR front door. These pin the
// security properties the flow depends on: unambiguous alphabet, single-use
// redemption, expiry, exactly one live code per deployment (the QR is the
// only door), and the per-IP throttle that makes brute-forcing a live code
// hopeless. Namespace isolation vs pairing codes is structural (separate
// store files, separate maps) — these tests also pin that a claim code
// never redeems as a pairing code and vice versa.
import { describe, expect, it } from "vitest";

import { createClaimCode, consumeClaimCode, _pendingClaimCount } from "./claim.ts";
import { createCode, consumeCode, VerifyError } from "./pairing.ts";

const T0 = 1_700_000_000_000;

describe("claim codes", () => {
  it("issues 8 characters from the unambiguous alphabet", () => {
    const { code } = createClaimCode(T0);
    expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
  });

  it("redeems the exact code exactly once", () => {
    const { code } = createClaimCode(T0);
    expect(() => consumeClaimCode(code.toLowerCase(), "1.2.3.4", T0 + 1000)).not.toThrow();
    // gone after first redemption — a sniffed or screenshotted code is dead
    expect(() => consumeClaimCode(code, "1.2.3.4", T0 + 2000)).toThrow(VerifyError);
  });

  it("rejects expired codes (5-minute TTL) and sweeps them", () => {
    const { code } = createClaimCode(T0);
    // still live at minute 4
    expect(() => consumeClaimCode(code, "1.2.3.4", T0 + 4 * 60_000)).not.toThrow();
    const second = createClaimCode(T0).code;
    expect(() => consumeClaimCode(second, "1.2.3.4", T0 + 5 * 60_000 + 1)).toThrow(/fresh QR/);
    expect(_pendingClaimCount()).toBe(0);
  });

  it("keeps exactly one live code — a new QR kills the old one", () => {
    const first = createClaimCode(T0).code;
    const second = createClaimCode(T0 + 1000).code;
    expect(first).not.toBe(second);
    expect(() => consumeClaimCode(first, "1.2.3.4", T0 + 2000)).toThrow(VerifyError);
    expect(() => consumeClaimCode(second, "1.2.3.4", T0 + 2000)).not.toThrow();
  });

  it("locks an IP out for ten minutes after five failed attempts, before a valid guess can land", () => {
    const { code } = createClaimCode(T0);
    const ip = "9.9.9.9";
    for (let i = 0; i < 5; i++) {
      try {
        consumeClaimCode("WRONGCOD", ip, T0 + 1000 + i);
      } catch (e) {
        expect(e).toBeInstanceOf(VerifyError);
      }
    }
    // the real code arrives as attempt #6 — locked out anyway
    expect(() => consumeClaimCode(code, ip, T0 + 2000)).toThrow(/too many failed attempts/);
    // and the lockout outlives the code's own 5-minute TTL
    expect(() => consumeClaimCode("WRONGCOD", ip, T0 + 6 * 60_000)).toThrow(/too many failed attempts/);
    // another IP is unaffected (the phone on the LAN still gets in)
    expect(() => consumeClaimCode(code, "other-ip", T0 + 2000)).not.toThrow();
  });

  it("a successful redemption clears the IP's failed-attempt slate", () => {
    for (let i = 0; i < 4; i++) {
      try {
        consumeClaimCode("WRONGCOD", "8.8.8.8", T0 + 1000 + i);
      } catch {
        // four wrong guesses — one below the lockout
      }
    }
    const { code } = createClaimCode(T0 + 100);
    expect(() => consumeClaimCode(code, "8.8.8.8", T0 + 2000)).not.toThrow();
    // the slate is clean: five fresh misses are needed before a lockout
    const next = createClaimCode(T0 + 3000).code;
    for (let i = 0; i < 5; i++) {
      try {
        consumeClaimCode("WRONGCOD", "8.8.8.8", T0 + 4000 + i);
      } catch {
        // the fifth lands the lockout, asserted below
      }
    }
    expect(() => consumeClaimCode(next, "8.8.8.8", T0 + 5000)).toThrow(/too many failed attempts/);
  });

  it("refuses an empty code with a pointer back to muster up", () => {
    expect(() => consumeClaimCode("", "1.2.3.4", T0)).toThrow(/muster up/);
    expect(() => consumeClaimCode("   ", "1.2.3.4", T0)).toThrow(/muster up/);
  });

  it("never lets a claim code redeem as a pairing code or the reverse", () => {
    const claim = createClaimCode(T0).code;
    const pair = createCode("user-a", T0).code;
    expect(() => consumeCode(claim, "1.2.3.4", T0 + 1000)).toThrow(VerifyError);
    expect(() => consumeClaimCode(pair, "1.2.3.4", T0 + 1000)).toThrow(VerifyError);
    // each still redeems in its own namespace
    expect(consumeCode(pair, "1.2.3.4", T0 + 1500)).toBe("user-a");
    expect(() => consumeClaimCode(claim, "5.6.7.8", T0 + 1500)).not.toThrow();
  });
});
