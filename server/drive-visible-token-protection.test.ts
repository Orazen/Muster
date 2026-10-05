import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { VisibleTokenProtector, type VisibleCredentialBinding } from "./drive-visible-token-protection.ts";

const binding: VisibleCredentialBinding = {
  kind: "grant", userId: "alice", googleSub: "google-a", generation: 1,
  expiresAt: 1000, scopes: ["https://www.googleapis.com/auth/drive.file"], field: "accessToken",
};
const secret = "synthetic-access-token";

describe("Explicit visible credential protection", () => {
  it("round-trips protected bytes using a fresh nonce without retaining caller's key buffer", () => {
    const key = randomBytes(32);
    const original = Buffer.from(key);
    const protector = new VisibleTokenProtector(key);
    key.fill(0);
    const first = protector.seal(secret, binding);
    const second = protector.seal(secret, binding);
    expect(first).not.toBe(second);
    expect(first).not.toContain(secret);
    expect(new VisibleTokenProtector(original).open(first, binding)).toBe(secret);
  });
  it.each([0, 1, 16, 31, 33, 64])("rejects a %s-byte key instead of inventing custody", length => {
    expect(() => new VisibleTokenProtector(randomBytes(length))).toThrow("32-byte key");
  });
  it("rejects a missing key and refuses a different key", () => {
    // @ts-expect-error exercise an untyped caller at the custody boundary
    expect(() => new VisibleTokenProtector(undefined)).toThrow("32-byte key");
    const sealed = new VisibleTokenProtector(randomBytes(32)).seal(secret, binding);
    expect(new VisibleTokenProtector(randomBytes(32)).open(sealed, binding)).toBeNull();
  });
  it.each([
    { userId: "bob" }, { googleSub: "google-b" }, { generation: 2 },
    { field: "refreshToken" as const }, { expiresAt: 2000 }, { scopes: ["openid"] },
  ])("refuses account/field/metadata substitution %j", replacement => {
    const protector = new VisibleTokenProtector(randomBytes(32));
    expect(protector.open(protector.seal(secret, binding), { ...binding, ...replacement })).toBeNull();
  });
  it("binds ephemeral PKCE to the session, attempt, nonce and lifetime", () => {
    const protector = new VisibleTokenProtector(randomBytes(32));
    const consent: VisibleCredentialBinding = {
      kind: "consent", userId: "alice", sessionId: "session-a", generation: 1,
      expiresAt: 1000, nonce: "a".repeat(43), field: "codeVerifier",
    };
    const value = "b".repeat(43);
    const sealed = protector.seal(value, consent);
    expect(protector.open(sealed, consent)).toBe(value);
    for (const replacement of [
      { userId: "bob" }, { sessionId: "session-b" }, { generation: 2 },
      { nonce: "c".repeat(43) }, { expiresAt: 2000 },
    ]) expect(protector.open(sealed, { ...consent, ...replacement })).toBeNull();
    expect(protector.open(sealed, binding)).toBeNull();
  });
  it("rejects plaintext, corrupted ciphertext, extra parts and truncated authentication tags", () => {
    const protector = new VisibleTokenProtector(randomBytes(32));
    const sealed = protector.seal(secret, binding);
    const [prefix, iv, data, tag] = sealed.split(":");
    const changed = Buffer.from(data!, "base64url");
    changed[0] = changed[0]! ^ 1;
    for (const value of [secret, `${sealed}:extra`, `${prefix}:${iv}:${changed.toString("base64url")}:${tag}`,
      `${prefix}:${iv}:${data}:${Buffer.from(tag!, "base64url").subarray(0, 12).toString("base64url")}`,
      `${prefix}:${iv}=:${data}:${tag}`, `${prefix}:invalid:${data}:${tag}`]) {
      expect(protector.open(value, binding)).toBeNull();
    }
  });
  it("rejects empty or oversized credentials", () => {
    const protector = new VisibleTokenProtector(randomBytes(32));
    expect(() => protector.seal("", binding)).toThrow("Invalid visible credential");
    expect(() => protector.seal("x".repeat(32769), binding)).toThrow("Invalid visible credential");
  });
});
