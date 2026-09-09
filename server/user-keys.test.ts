import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

describe("per-file salt", () => {
  it("writes vaults as version 2 with a per-file salt", () => {
    setUserProviderKey(dir, "u1", "deepseek", "sk-v2");
    const parsed = JSON.parse(readFileSync(join(dir, "user-keys.json"), "utf8")) as {
      version: number;
      salt?: string;
    };
    expect(parsed.version).toBe(2);
    expect(parsed.salt).toBeTruthy();
  });

  it("derives a different salt for a different vault file", () => {
    setUserProviderKey(dir, "u1", "deepseek", "sk-a");
    const a = JSON.parse(readFileSync(join(dir, "user-keys.json"), "utf8")) as { salt?: string };
    const other = mkdtempSync(join(tmpdir(), "user-keys-"));
    setUserProviderKey(other, "u1", "deepseek", "sk-b");
    const b = JSON.parse(readFileSync(join(other, "user-keys.json"), "utf8")) as { salt?: string };
    expect(a.salt).not.toBe(b.salt);
  });

  it("re-seals legacy v1 entries under the file salt on the next write", () => {
    // A v1 file: entries sealed under the legacy source-baked salt.
    writeFileSync(
      join(dir, "user-keys.json"),
      JSON.stringify({
        version: 1,
        users: { u1: { deepseek: { sealed: seal("sk-legacy"), updatedAt: 1 } } },
      }),
    );
    setUserProviderKey(dir, "u1", "openai", "sk-new");
    const parsed = JSON.parse(readFileSync(join(dir, "user-keys.json"), "utf8")) as {
      version: number;
      salt?: string;
    };
    expect(parsed.version).toBe(2);
    expect(parsed.salt).toBeTruthy();
    // the pre-migration entry still resolves after re-sealing
    expect(resolveUserProviderKey(dir, "u1", "deepseek")).toBe("sk-legacy");
    expect(resolveUserProviderKey(dir, "u1", "openai")).toBe("sk-new");
  });

  it("drops entries that no longer open during migration (already dead to readers)", () => {
    writeFileSync(
      join(dir, "user-keys.json"),
      JSON.stringify({
        version: 1,
        users: {
          u1: {
            deepseek: { sealed: seal("sk-live"), updatedAt: 1 },
            // well-formed envelope, undecryptable under any key we derive
            broken: { sealed: "AAAA:BBBB:CCCC", updatedAt: 1 },
          },
        },
      }),
    );
    setUserProviderKey(dir, "u1", "openai", "sk-new");
    const flags = userProviderFlags(dir, "u1");
    expect(flags.deepseek).toEqual({ configured: true });
    expect(flags.openai).toEqual({ configured: true });
    expect(flags.broken).toBeUndefined();
    expect(resolveUserProviderKey(dir, "u1", "broken")).toBeNull();
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
