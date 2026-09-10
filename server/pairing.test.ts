// Pairing code mechanics — the desktop Google sign-in bridge. These pin
// the security properties the flow depends on: unambiguous alphabet,
// single-use redemption, expiry, one live code per user, and the per-IP
// verify throttle that makes brute-forcing a live code hopeless.
import { describe, expect, it } from "vitest";

import { createCode, getOrCreateCode, consumeCode, VerifyError, _pendingCount } from "./pairing.ts";

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

describe("idempotent pairing code refresh", () => {
  const now = T0 + 10 * 60_000;
  const ttl = 5 * 60_000;

  it("retains the same redeemable code and original deadline on every live refresh", () => {
    const user = "refresh-live-user";
    const first = getOrCreateCode(user, now);
    expect(first.expiresAt).toBe(now + ttl);
    for (const elapsed of [0, 1_000, 60_000, ttl - 1]) {
      expect(getOrCreateCode(user, now + elapsed)).toEqual(first);
    }
    expect(consumeCode(first.code, "192.0.2.101", first.expiresAt - 1)).toBe(user);
  });

  it("replaces a code at its exact expiry with a fresh five-minute deadline", () => {
    const user = "refresh-expiry-user";
    const first = getOrCreateCode(user, now);
    const replacement = getOrCreateCode(user, first.expiresAt);

    expect(replacement.code).not.toBe(first.code);
    expect(replacement.expiresAt).toBe(first.expiresAt + ttl);
    expect(() => consumeCode(first.code, "192.0.2.102", first.expiresAt)).toThrow(VerifyError);
    expect(getOrCreateCode(user, first.expiresAt + 1)).toEqual(replacement);
    expect(consumeCode(replacement.code, "192.0.2.102", first.expiresAt + 1)).toBe(user);
  });

  it("issues a fresh code after redemption without reviving the consumed code", () => {
    const user = "refresh-consumed-user";
    const first = getOrCreateCode(user, now);
    expect(consumeCode(first.code, "192.0.2.103", now + 1_000)).toBe(user);

    const replacement = getOrCreateCode(user, now + 2_000);
    expect(replacement.code).not.toBe(first.code);
    expect(replacement.expiresAt).toBe(now + 2_000 + ttl);
    expect(() => consumeCode(first.code, "192.0.2.103", now + 3_000)).toThrow(VerifyError);
    expect(consumeCode(replacement.code, "192.0.2.103", now + 3_000)).toBe(user);
  });

  it("keeps another user's live code and deadline intact when one user refreshes after redemption", () => {
    const firstUser = "refresh-independent-a";
    const secondUser = "refresh-independent-b";
    const first = getOrCreateCode(firstUser, now);
    const second = getOrCreateCode(secondUser, now + 500);
    expect(first.code).not.toBe(second.code);
    expect(consumeCode(first.code, "192.0.2.104", now + 1_000)).toBe(firstUser);

    const replacement = getOrCreateCode(firstUser, now + 2_000);
    expect(getOrCreateCode(secondUser, now + 3_000)).toEqual(second);
    expect(consumeCode(second.code, "192.0.2.105", now + 3_000)).toBe(secondUser);
    expect(consumeCode(replacement.code, "192.0.2.104", now + 3_000)).toBe(firstUser);
  });

  it("rejects an absent owner without changing an existing user's code", () => {
    const user = "refresh-owner-user";
    const first = getOrCreateCode(user, now);

    expect(() => getOrCreateCode("", now + 1_000)).toThrow(
      expect.objectContaining({ status: 401 }),
    );
    expect(getOrCreateCode(user, now + 2_000)).toEqual(first);
    expect(consumeCode(first.code, "192.0.2.106", now + 2_000)).toBe(user);
  });
});
