// The passphrase store contract: neutral values on every failure path, the
// argv-array helper contract, the unavailable gate off darwin, and one real
// Keychain round trip on a throwaway item (darwin only, skippable).
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { userInfo } from "node:os";

import { describe, expect, it } from "vitest";

import {
  createKeychainStore,
  KEYCHAIN_ACCOUNT,
  KEYCHAIN_MIN_PASSPHRASE_LENGTH,
  KEYCHAIN_SERVICE,
  type KeychainCliResult,
} from "./keychain-store.ts";

const ok = (stdout = ""): KeychainCliResult => ({ ok: true, stdout, stderr: "" });
const notFound: KeychainCliResult = {
  ok: false,
  stdout: "",
  stderr: "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.",
};

// securityPath must EXIST cross-platform so status() reports "available"
// and the injected helper (never actually executed) is reached on any OS.
const EXISTING_BINARY = process.execPath;

function recordingExec(result: (file: string, args: string[]) => KeychainCliResult) {
  const calls: Array<{ file: string; args: string[] }> = [];
  const execFile = async (file: string, args: string[]): Promise<KeychainCliResult> => {
    calls.push({ file, args });
    return result(file, args);
  };
  const spawnSync = (file: string, args: string[]): KeychainCliResult => {
    calls.push({ file, args });
    return result(file, args);
  };
  return { calls, execFile, spawnSync };
}

describe("createKeychainStore availability", () => {
  it("is unavailable off darwin and never invokes the helper", async () => {
    const exec = recordingExec(() => ok("should-not-run"));
    const store = createKeychainStore({ platform: "linux", execFile: exec.execFile, spawnSync: exec.spawnSync });
    expect(store.status()).toBe("unavailable");
    expect(await store.get()).toBeNull();
    expect(store.getSync()).toBeNull();
    expect(await store.has()).toBe(false);
    expect(await store.set("correct horse battery staple")).toBe(false);
    expect(await store.clear()).toBe(false);
    expect(exec.calls).toHaveLength(0);
  });

  it("is unavailable on darwin when the security binary is absent", () => {
    const store = createKeychainStore({ platform: "darwin", securityPath: "/nonexistent/security-binary-for-muster" });
    expect(store.status()).toBe("unavailable");
  });
});

describe("get / getSync", () => {
  it("reads via argv and trims only the trailing newline", async () => {
    const exec = recordingExec(() => ok("stored value with spaces  \n"));
    const store = createKeychainStore({ platform: "darwin", securityPath: EXISTING_BINARY, execFile: exec.execFile, spawnSync: exec.spawnSync });
    expect(await store.get()).toBe("stored value with spaces  ");
    expect(store.getSync()).toBe("stored value with spaces  ");
    expect(exec.calls[0]).toEqual({
      file: EXISTING_BINARY,
      args: ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"],
    });
    expect(exec.calls[1]?.args).toEqual(exec.calls[0]?.args);
  });

  it("reads null when the item is missing and when the helper fails unexpectedly", async () => {
    for (const result of [notFound, { ok: false, stdout: "", stderr: "permission denied" }, ok("")]) {
      const exec = recordingExec(() => result);
      const store = createKeychainStore({ platform: "darwin", securityPath: process.execPath, execFile: exec.execFile, spawnSync: exec.spawnSync });
      expect(await store.get()).toBeNull();
      expect(store.getSync()).toBeNull();
    }
  });

  it("never throws even when the injected helper itself rejects", async () => {
    const store = createKeychainStore({
      platform: "darwin",
      securityPath: process.execPath,
      execFile: async () => {
        throw new Error("helper exploded with a secret in it: hunter2-secret-value");
      },
      spawnSync: () => {
        throw new Error("helper exploded with a secret in it: hunter2-secret-value");
      },
    });
    expect(await store.get()).toBeNull();
    expect(store.getSync()).toBeNull();
    expect(await store.has()).toBe(false);
    expect(await store.set("correct horse battery staple")).toBe(false);
    expect(await store.clear()).toBe(false);
  });
});

describe("has", () => {
  it("answers existence from exit status, with argv that never asks for the value (no -w)", async () => {
    const present = recordingExec(() => ok(""));
    const presentStore = createKeychainStore({ platform: "darwin", securityPath: EXISTING_BINARY, execFile: present.execFile, spawnSync: present.spawnSync });
    expect(await presentStore.has()).toBe(true);
    expect(present.calls[0]).toEqual({
      file: EXISTING_BINARY,
      args: ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT],
    });
    expect(present.calls[0]?.args).not.toContain("-w");

    const missing = recordingExec(() => notFound);
    const missingStore = createKeychainStore({ platform: "darwin", securityPath: EXISTING_BINARY, execFile: missing.execFile, spawnSync: missing.spawnSync });
    expect(await missingStore.has()).toBe(false);
  });
});

describe("set / clear", () => {
  it("creates-or-updates through argv and refuses short values without invoking the helper", async () => {
    const exec = recordingExec(() => ok());
    const store = createKeychainStore({ platform: "darwin", securityPath: process.execPath, execFile: exec.execFile, spawnSync: exec.spawnSync });
    const passphrase = "correct horse battery staple";
    expect(await store.set(passphrase)).toBe(true);
    expect(exec.calls[0]).toEqual({
      file: EXISTING_BINARY,
      args: ["add-generic-password", "-U", "-a", KEYCHAIN_ACCOUNT, "-s", KEYCHAIN_SERVICE, "-w", passphrase],
    });
    expect(await store.set("short")).toBe(false);
    expect(exec.calls).toHaveLength(1);
  });

  it("reports set failure as false, never as a thrown error", async () => {
    const exec = recordingExec(() => ({ ok: false, stdout: "", stderr: "user interaction is not allowed" }));
    const store = createKeychainStore({ platform: "darwin", securityPath: process.execPath, execFile: exec.execFile, spawnSync: exec.spawnSync });
    expect(await store.set("correct horse battery staple")).toBe(false);
  });

  it("treats an already-absent item as cleared so a repeated DELETE converges", async () => {
    const absent = recordingExec(() => notFound);
    const absentStore = createKeychainStore({ platform: "darwin", securityPath: process.execPath, execFile: absent.execFile, spawnSync: absent.spawnSync });
    expect(await absentStore.clear()).toBe(true);

    const broken = recordingExec(() => ({ ok: false, stdout: "", stderr: "user interaction is not allowed" }));
    const brokenStore = createKeychainStore({ platform: "darwin", securityPath: process.execPath, execFile: broken.execFile, spawnSync: broken.spawnSync });
    expect(await brokenStore.clear()).toBe(false);
  });
});

// A real round trip against a THROWAWAY account so a developer's own stored
// passphrase (same service, real account) is never read, overwritten or
// deleted by the suite. `security` reads its own CLI-created items without
// prompting; opt out with MUSTER_SKIP_KEYCHAIN_TEST=1 where Keychain access
// is locked down.
describe.skipIf(process.platform !== "darwin" || process.env.MUSTER_SKIP_KEYCHAIN_TEST !== undefined)(
  "real Keychain round trip (darwin)",
  () => {
    it("set → get → clear → get", async () => {
      const account = `muster-test-${randomUUID()}`;
      const store = createKeychainStore({ account });
      const passphrase = `test-only-passphrase-${randomUUID()}`;
      // The suite's setup points HOME at a throwaway directory so DATA_DIR
      // never touches the real one — and `security` hangs when HOME has no
      // Library/Keychains to open. Resolve the actual home from Directory
      // Services (env-independent) and hold it for the round trip only.
      const realHome = execFileSync("/usr/bin/dscl", [".", "-read", `/Users/${userInfo().username}`, "NFSHomeDirectory"], { encoding: "utf8" })
        .split("\n")[0]
        ?.replace(/^NFSHomeDirectory:\s*/, "")
        .trim();
      const redirectedHome = process.env.HOME ?? "";
      process.env.HOME = realHome ?? redirectedHome;
      try {
        try {
          expect(store.status()).toBe("available");
          expect(await store.get()).toBeNull();
          expect(passphrase.length).toBeGreaterThanOrEqual(KEYCHAIN_MIN_PASSPHRASE_LENGTH);
          expect(await store.set(passphrase)).toBe(true);
          expect(await store.get()).toBe(passphrase);
          expect(await store.set(passphrase)).toBe(true); // -U converges
          expect(await store.get()).toBe(passphrase);
        } finally {
          expect(await store.clear()).toBe(true);
          expect(await store.get()).toBeNull();
          expect(await store.clear()).toBe(true); // idempotent
        }
      } finally {
        process.env.HOME = redirectedHome;
      }
    }, 20_000);
  },
);
