import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

process.env.BETTER_AUTH_SECRET = "test-secret-at-least-32-chars-long-ok";

const { setUserProviderKey, clearUserProviderKey, userProviderFlags, resolveUserProviderKey, userInstanceConfigs, allUserInstanceConfigs, mergeUserVault, seal, open } =
  await import("./user-keys.ts");

let dir: string;
const ownedDirs: string[] = [];
const diskUsersSchema = z.record(z.string(), z.record(z.string(), z.object({ sealed: z.string(), updatedAt: z.number() })));
const diskV2Schema = z.object({ version: z.literal(2), salt: z.string().min(1), users: diskUsersSchema });
const diskSchema = z.discriminatedUnion("version", [
  z.object({ version: z.literal(1), users: diskUsersSchema }), diskV2Schema,
]);
const vaultPath = () => join(dir, "user-keys.json");
const readDisk = () => diskSchema.parse(JSON.parse(readFileSync(vaultPath(), "utf8")));
const readV2 = (directory = dir) => diskV2Schema.parse(JSON.parse(readFileSync(join(directory, "user-keys.json"), "utf8")));
function ownedDirectory() {
  const path = mkdtempSync(join(tmpdir(), "user-keys-")); ownedDirs.push(path); return path;
}
beforeEach(() => {
  dir = ownedDirectory();
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const path of ownedDirs.splice(0)) rmSync(path, { recursive: true, force: true });
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
    const parsed = readV2();
    expect(parsed.version).toBe(2);
    expect(parsed.salt).toBeTruthy();
  });

  it("derives a different salt for a different vault file", () => {
    setUserProviderKey(dir, "u1", "deepseek", "sk-a");
    const a = readV2();
    const other = ownedDirectory();
    setUserProviderKey(other, "u1", "deepseek", "sk-b");
    const b = readV2(other);
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
    const parsed = readV2();
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

describe("vault preservation", () => {
  function seedLegacy() {
    writeFileSync(vaultPath(), JSON.stringify({
      version: 1,
      users: {
        alice: { deepseek: { sealed: seal("alice-key"), updatedAt: 123 } },
        bob: { openai: { sealed: seal("bob-key"), updatedAt: 456 } },
      },
    }));
  }

  function assertWritesRefused() {
    const before = readFileSync(vaultPath());
    expect(() => setUserProviderKey(dir, "alice", "new-provider", "new-key")).toThrow(/vault needs repair/);
    expect(() => clearUserProviderKey(dir, "alice", "deepseek")).toThrow(/vault needs repair/);
    expect(() => mergeUserVault(dir, "alice", "bob")).toThrow(/vault needs repair/);
    expect(readFileSync(vaultPath())).toEqual(before);
  }

  it("does not create a file during reads or an absent-key deletion", () => {
    expect(resolveUserProviderKey(dir, "alice", "deepseek")).toBeNull();
    expect(userProviderFlags(dir, "alice")).toEqual({});
    expect(userInstanceConfigs(dir, "alice", { deepseek: "API_KEY" })).toEqual({});
    expect(allUserInstanceConfigs(dir, { deepseek: "API_KEY" })).toEqual({});
    clearUserProviderKey(dir, "alice", "deepseek");
    expect(existsSync(vaultPath())).toBe(false);
  });

  it("reads a v1 vault without rewriting or migrating it", () => {
    seedLegacy(); const before = readFileSync(vaultPath()), stat = statSync(vaultPath());
    expect(resolveUserProviderKey(dir, "alice", "deepseek")).toBe("alice-key");
    expect(userProviderFlags(dir, "bob")).toEqual({ openai: { configured: true } });
    expect(userInstanceConfigs(dir, "alice", { deepseek: "DEEPSEEK_API_KEY" })).toMatchObject({
      "deepseekApi:alice": { environment: { DEEPSEEK_API_KEY: "alice-key" } },
    });
    expect(Object.keys(allUserInstanceConfigs(dir, { deepseek: "DS_KEY", openai: "OPENAI_KEY" }))).toHaveLength(2);
    expect(readFileSync(vaultPath())).toEqual(before); expect(statSync(vaultPath()).mtimeMs).toBe(stat.mtimeMs);
  });

  it("preserves existing timestamps and v2 salt through migration and later writes", () => {
    seedLegacy(); vi.spyOn(Date, "now").mockReturnValue(900);
    setUserProviderKey(dir, "alice", "openai", "new-alice-key");
    const migrated = readV2();
    expect(migrated.users.alice.deepseek.updatedAt).toBe(123); expect(migrated.users.bob.openai.updatedAt).toBe(456);
    expect(migrated.users.alice.openai.updatedAt).toBe(900);
    setUserProviderKey(dir, "bob", "deepseek", "new-bob-key");
    const later = readV2(); expect(later.salt).toBe(migrated.salt);
    expect(later.users.alice).toEqual(migrated.users.alice);
    expect(resolveUserProviderKey(dir, "alice", "deepseek")).toBe("alice-key");
    expect(resolveUserProviderKey(dir, "bob", "openai")).toBe("bob-key");
    if (process.platform !== "win32") expect(statSync(vaultPath()).mode & 0o777).toBe(0o600);
  });

  it("deletes only the requested key while leaving a v1 vault unmigrated", () => {
    seedLegacy(); const before = readDisk(); clearUserProviderKey(dir, "alice", "deepseek");
    const after = readDisk(); expect(after.version).toBe(1); expect(after.users.bob).toEqual(before.users.bob);
    expect(resolveUserProviderKey(dir, "bob", "openai")).toBe("bob-key");
    expect(resolveUserProviderKey(dir, "alice", "deepseek")).toBeNull();
  });

  it.each([
    "{truncated", JSON.stringify({ version: 9, users: {} }),
    JSON.stringify({ version: 2, salt: "", users: {} }), JSON.stringify({ version: 1, users: [] }),
  ])("preserves malformed envelopes during reads and rejected mutations (%s)", (contents) => {
    writeFileSync(vaultPath(), contents);
    expect(resolveUserProviderKey(dir, "alice", "deepseek")).toBeNull();
    expect(userProviderFlags(dir, "alice")).toEqual({});
    expect(allUserInstanceConfigs(dir, { deepseek: "KEY" })).toEqual({});
    assertWritesRefused(); expect(readFileSync(vaultPath(), "utf8")).toBe(contents);
  });

  it("distinguishes an unreadable existing path from an absent vault", () => {
    mkdirSync(vaultPath());
    expect(userProviderFlags(dir, "alice")).toEqual({});
    expect(() => setUserProviderKey(dir, "alice", "deepseek", "new-key")).toThrow(/vault needs repair/);
    expect(statSync(vaultPath()).isDirectory()).toBe(true);
  });

  it.each([1, 2])("keeps valid neighbors readable in v%s but refuses mutations around malformed entries", (version) => {
    seedLegacy();
    if (version === 2) setUserProviderKey(dir, "bob", "extra", "bob-extra");
    const valid = readDisk();
    for (const broken of [null, { sealed: 42, updatedAt: 5 }, { sealed: seal("recoverable"), updatedAt: "broken metadata" }]) {
      writeFileSync(vaultPath(), JSON.stringify({ ...valid, users: { ...valid.users, alice: { ...valid.users.alice, damaged: broken } } }));
      const before = readFileSync(vaultPath());
      expect(resolveUserProviderKey(dir, "alice", "deepseek")).toBe("alice-key");
      expect(resolveUserProviderKey(dir, "bob", "openai")).toBe("bob-key");
      expect(resolveUserProviderKey(dir, "alice", "damaged")).toBeNull();
      expect(userProviderFlags(dir, "alice")).toEqual({ deepseek: { configured: true } });
      expect(Object.keys(allUserInstanceConfigs(dir, { deepseek: "DS_KEY", openai: "OPENAI_KEY" }))).toHaveLength(2);
      assertWritesRefused(); expect(readFileSync(vaultPath())).toEqual(before);
    }
  });

  it.each([1, 2])("keeps other accounts readable in v%s when one account is not a record", (version) => {
    seedLegacy(); if (version === 2) setUserProviderKey(dir, "bob", "extra", "bob-extra");
    const valid = readDisk(); writeFileSync(vaultPath(), JSON.stringify({ ...valid, users: { ...valid.users, broken: null } }));
    expect(resolveUserProviderKey(dir, "alice", "deepseek")).toBe("alice-key");
    expect(resolveUserProviderKey(dir, "bob", "openai")).toBe("bob-key");
    expect(userProviderFlags(dir, "broken")).toEqual({}); assertWritesRefused();
  });

  it("same-account merge is a no-op before any v1 migration or write", () => {
    seedLegacy(); const before = readFileSync(vaultPath());
    expect(mergeUserVault(dir, "alice", "alice")).toEqual([[], []]);
    expect(readFileSync(vaultPath())).toEqual(before); expect(readDisk().version).toBe(1);
    expect(resolveUserProviderKey(dir, "alice", "deepseek")).toBe("alice-key");
  });

  it("merges accounts without replacing target keys or changing retained timestamps", () => {
    seedLegacy(); vi.spyOn(Date, "now").mockReturnValue(999);
    setUserProviderKey(dir, "alice", "openai", "source-conflict");
    const before = readV2();
    expect(mergeUserVault(dir, "alice", "bob")).toEqual([["deepseek"], ["openai"]]);
    const after = readV2(); expect(after.salt).toBe(before.salt);
    expect(after.users.bob.openai).toEqual(before.users.bob.openai);
    expect(after.users.bob.deepseek).toEqual(before.users.alice.deepseek);
    expect(resolveUserProviderKey(dir, "bob", "openai")).toBe("bob-key");
    expect(resolveUserProviderKey(dir, "bob", "deepseek")).toBe("alice-key");
    expect(userProviderFlags(dir, "alice")).toEqual({});
  });

  it.each(["__proto__", "constructor", "toString"])("treats %s as an own account/provider key without inheriting or aliasing records", (special) => {
    expect(resolveUserProviderKey(dir, special, special)).toBeNull();
    expect(userProviderFlags(dir, special)[special]).toBeUndefined();
    setUserProviderKey(dir, special, special, "special-key");
    setUserProviderKey(dir, "normal", "deepseek", "normal-key");
    expect(resolveUserProviderKey(dir, special, special)).toBe("special-key");
    expect(resolveUserProviderKey(dir, "normal", special)).toBeNull();
    expect(resolveUserProviderKey(dir, special, "deepseek")).toBeNull();
    const flags = userProviderFlags(dir, special); expect(Object.hasOwn(flags, special)).toBe(true);
    expect(flags[special]).toEqual({ configured: true });
    expect(userInstanceConfigs(dir, special, {})).toEqual({});
    expect(mergeUserVault(dir, special, "target")).toEqual([[special], []]);
    expect(resolveUserProviderKey(dir, "target", special)).toBe("special-key");
    expect(resolveUserProviderKey(dir, "normal", "deepseek")).toBe("normal-key");
    clearUserProviderKey(dir, "target", special); expect(resolveUserProviderKey(dir, "target", special)).toBeNull();
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
