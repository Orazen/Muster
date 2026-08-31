// Pairing code mechanics — the desktop Google sign-in bridge. These pin
// the security properties the flow depends on: unambiguous alphabet,
// single-use redemption, expiry, one live code per user, and the per-IP
// verify throttle that makes brute-forcing a live code hopeless.
import { describe, expect, it } from "vitest";

import { createCode, consumeCode, VerifyError, _pendingCount } from "./pairing.ts";

const T0 = 1_700_000_000_000;

describe("pairing codes", () => {
  it("issues 8 characters from the unambiguous alphabet", () => {
    const { code } = createCode("user-a", T0);
    expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
  });

  it("redeems the exact code exactly once", () => {
    const { code } = createCode("user-a", T0);
    expect(consumeCode(code.toLowerCase(), "1.2.3.4", T0 + 1000)).toBe("user-a");
    // gone after first redemption
    expect(() => consumeCode(code, "1.2.3.4", T0 + 2000)).toThrow(VerifyError);
  });

  it("rejects expired codes and sweeps them", () => {
    const { code } = createCode("user-a", T0);
    expect(() => consumeCode(code, "1.2.3.4", T0 + 5 * 60_000 + 1)).toThrow(/fresh one/);
    expect(_pendingCount()).toBe(0);
  });

  it("invalidates a user's previous code when a new one is generated", () => {
    const first = createCode("user-a", T0).code;
    const second = createCode("user-a", T0 + 1000).code;
    expect(first).not.toBe(second);
    expect(() => consumeCode(first, "1.2.3.4", T0 + 2000)).toThrow(VerifyError);
    expect(consumeCode(second, "1.2.3.4", T0 + 2000)).toBe("user-a");
  });

  it("keeps different users' codes independent", () => {
    const a = createCode("user-a", T0).code;
    const b = createCode("user-b", T0).code;
    expect(consumeCode(a, "1.2.3.4", T0 + 1000)).toBe("user-a");
    expect(consumeCode(b, "5.6.7.8", T0 + 1000)).toBe("user-b");
  });

  it("throttles redemption attempts per IP before a valid guess can land", () => {
    const { code } = createCode("user-a", T0);
    const ip = "9.9.9.9";
    for (let i = 0; i < 20; i++) {
      try {
        consumeCode("WRONGCOD", ip, T0 + 1000 + i);
      } catch (e) {
        expect(e).toBeInstanceOf(VerifyError);
      }
    }
    // the real code arrives attempt #21 — locked out anyway
    expect(() => consumeCode(code, ip, T0 + 2000)).toThrow(/too many attempts/);
    // another IP is unaffected
    expect(consumeCode(code, "other-ip", T0 + 2000)).toBe("user-a");
  });

  it("refuses to mint a code without an owning user", () => {
    expect(() => createCode("", T0)).toThrow();
  });
});
