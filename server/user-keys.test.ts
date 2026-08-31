import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.BETTER_AUTH_SECRET = "test-secret-at-least-32-chars-long-ok";

const { setUserProviderKey, clearUserProviderKey, userProviderFlags, resolveUserProviderKey, seal, open } =
  await import("./user-keys.ts");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "user-keys-"));
});

describe("seal/open", () => {
  it("round-trips a secret", () => {
    expect(open(seal("sk-test-123"))).toBe("sk-test-123");
  });

  it("never stores plaintext in the vault file", () => {
    setUserProviderKey(dir, "u1", "deepseek", "sk-live-value");
    const raw = readFileSync(join(dir, "user-keys.json"), "utf8");
    expect(raw).not.toContain("sk-live-value");
  });

  it("fails closed (returns null) on a tampered ciphertext", () => {
    const sealed = seal("secret");
    const [iv, , tag] = sealed.split(":");
    expect(open(`${iv}:${Buffer.from("tampered").toString("base64")}:${tag}`)).toBeNull();
  });
});

describe("per-user isolation", () => {
  it("one user's key is invisible to another user's resolution", () => {
    setUserProviderKey(dir, "user-a", "deepseek", "sk-key-of-a");
    expect(resolveUserProviderKey(dir, "user-b", "deepseek")).toBeNull();
    expect(resolveUserProviderKey(dir, "user-a", "deepseek")).toBe("sk-key-of-a");
  });

  it("flags are scoped per user", () => {
    setUserProviderKey(dir, "user-a", "openai", "sk-a");
    expect(userProviderFlags(dir, "user-a").openai).toEqual({ configured: true });
    expect(userProviderFlags(dir, "user-b").openai).toBeUndefined();
  });

  it("overwrites and clears cleanly", () => {
    setUserProviderKey(dir, "u", "google", "first");
    setUserProviderKey(dir, "u", "google", "second");
    expect(resolveUserProviderKey(dir, "u", "google")).toBe("second");
    clearUserProviderKey(dir, "u", "google");
    expect(resolveUserProviderKey(dir, "u", "google")).toBeNull();
  });
});
