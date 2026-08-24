import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { setUserProviderKey, mergeUserVault, userProviderFlags } from "./user-keys.ts";
import { startAccountMerge, spendAccountMergeToken } from "./account-merge.ts";

const dir = mkdtempSync(join(tmpdir(), "muster-merge-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("account merge tokens", () => {
  it("spends a valid token to its minting target", () => {
    const token = startAccountMerge("usr_target");
    const intent = spendAccountMergeToken(token, "usr_source");
    expect(intent).toEqual({ targetUserId: "usr_target" });
  });

  it("is single-use", () => {
    const token = startAccountMerge("usr_target");
    expect(spendAccountMergeToken(token, "usr_a")).not.toBeNull();
    expect(spendAccountMergeToken(token, "usr_b")).toBeNull();
  });

  it("refuses self-merge without burning anything else", () => {
    const token = startAccountMerge("usr_same");
    expect(spendAccountMergeToken(token, "usr_same")).toBeNull();
  });
});

describe("mergeUserVault", () => {
  it("moves keys, keeps target's conflicting ones, empties source", () => {
    setUserProviderKey(dir, "src", "openrouter", "sk-or-src");
    setUserProviderKey(dir, "src", "deepseek", "sk-ds-src");
    setUserProviderKey(dir, "dst", "openrouter", "sk-or-dst");
    const [moved, kept] = mergeUserVault(dir, "src", "dst");
    expect(moved).toEqual(["deepseek"]);
    expect(kept).toEqual(["openrouter"]);
    // target's openrouter value survived
    expect(userProviderFlags(dir, "dst").openrouter.configured).toBe(true);
    // source has nothing left — flags read empty and re-merge is a no-op
    expect(Object.keys(userProviderFlags(dir, "src"))).toHaveLength(0);
    const [moved2, kept2] = mergeUserVault(dir, "src", "dst");
    expect(moved2).toEqual([]);
    expect(kept2).toEqual([]);
  });
});
