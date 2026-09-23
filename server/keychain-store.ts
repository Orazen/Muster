// The trusted passphrase store — §11's flagged passphrase-store decision,
// made concrete (DESIGN.md §11 Target: automatic snapshots run "when a
// Drive connection + trusted passphrase store exist — the passphrase-store
// decision is the gate, flagged").
//
// What this is, mechanically: ONE generic-password item in this computer's
// login Keychain, addressed by service+account, read and written through
// `/usr/bin/security` as an argv array (never a shell), 10s timeouts, and
// every failure path resolving to a neutral value — this module never
// throws into a caller, so a keychain problem degrades a gate to
// "unavailable" instead of crashing a backup, a route, or a boot hook.
// Off darwin, or without the binary, status() is "unavailable" and the
// gate stays closed.
//
// What this is NOT: a security claim (the repo-wide rule stands until the
// scanner re-run lands). It is a local convenience gate that decides
// whether automatic snapshots and the sync queue are allowed to hold the
// passphrase at all.
//
// Handling rule that governs every line below: the passphrase value is
// never logged, never placed in an error message, and never returned to a
// caller that only asked WHETHER one is stored — the wire carries
// `hasPassphrase`, never the value.
import { execFile, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

export type PassphraseStoreStatus = "available" | "unavailable";

/** The injectable contract (brief: {status, get, set, clear}) plus the one
 * synchronous read the boot-time pre-migration capture needs — its caller
 * is synchronous and cannot await a subprocess before the data it protects
 * is about to be replaced. Async callers must use get(). */
export interface PassphraseStore {
  status(): PassphraseStoreStatus;
  get(): Promise<string | null>;
  /** Boot-path only: blocks briefly on one helper invocation. */
  getSync(): string | null;
  /** Existence WITHOUT the value — the Settings wire asks whether one is
   * stored; it must never need to read WHAT is stored. */
  has(): Promise<boolean>;
  set(passphrase: string): Promise<boolean>;
  clear(): Promise<boolean>;
}

/** One CLI round trip, already classified — stdout/stderr only, never the
 * invoking error's message (on `set`, that message would echo the argv
 * that carries the passphrase). */
export interface KeychainCliResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export interface KeychainStoreOptions {
  platform?: NodeJS.Platform;
  securityPath?: string;
  /** Injection seam for tests; argv-array contract, no shell either way. */
  execFile?(file: string, args: string[]): Promise<KeychainCliResult>;
  spawnSync?(file: string, args: string[]): KeychainCliResult;
  /** Item namespace — tests use a throwaway account, never a real one. */
  account?: string;
}

export const KEYCHAIN_SERVICE = "muster-workspace-backup";
export const KEYCHAIN_ACCOUNT = "muster";
/** Same floor the v2 bundle enforces (workspace-bundle-v2 MIN_PASSPHRASE_LENGTH). */
export const KEYCHAIN_MIN_PASSPHRASE_LENGTH = 8;
const HELPER_TIMEOUT_MS = 10_000;

/** "Item is absent" as the helper actually words it. Used only to classify
 * a non-zero exit — the value is never echoed anywhere. */
const missingItem = (stderr: string): boolean => /could not be found/i.test(stderr);

const defaultExecFile = (file: string, args: string[]): Promise<KeychainCliResult> =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { encoding: "utf8", timeout: HELPER_TIMEOUT_MS, windowsHide: true, shell: false },
      (error, stdout, stderr) => {
        if (error) {
          // error.message is deliberately NOT read here: on `set` the argv
          // (which carries the passphrase) is echoed into it. Neither this
          // layer nor any caller prints stdout/stderr either.
          resolve({
            ok: false,
            stdout: stdout ?? "",
            stderr: error.code === "ENOENT" ? "the keychain helper is missing" : stderr ?? "",
          });
          return;
        }
        resolve({ ok: true, stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
  });

const defaultSpawnSync = (file: string, args: string[]): KeychainCliResult => {
  try {
    const result = spawnSync(file, args, {
      encoding: "utf8",
      timeout: HELPER_TIMEOUT_MS,
      windowsHide: true,
      shell: false,
    });
    if (result.error) {
      // SAFETY: spawnSync failures are ErrnoExceptions at runtime (ENOENT
      // when the helper is absent); the typings only promise Error. The
      // message is deliberately not read — it can echo argv, which on `set`
      // carries the passphrase.
      const code = (result.error as NodeJS.ErrnoException).code;
      return {
        ok: false,
        stdout: "",
        stderr: code === "ENOENT" ? "the keychain helper is missing" : "the keychain helper could not be started",
      };
    }
    return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  } catch {
    return { ok: false, stdout: "", stderr: "the keychain helper could not be started" };
  }
};

export function createKeychainStore(options: KeychainStoreOptions = {}): PassphraseStore {
  const platform = options.platform ?? process.platform;
  const securityPath = options.securityPath ?? "/usr/bin/security";
  const service = KEYCHAIN_SERVICE;
  const account = options.account ?? KEYCHAIN_ACCOUNT;
  const execImpl = options.execFile ?? defaultExecFile;
  const spawnSyncImpl = options.spawnSync ?? defaultSpawnSync;

  const status = (): PassphraseStoreStatus => {
    if (platform !== "darwin") return "unavailable";
    try {
      return existsSync(securityPath) ? "available" : "unavailable";
    } catch {
      return "unavailable";
    }
  };

  const run = async (args: string[]): Promise<KeychainCliResult> => {
    try {
      return await execImpl(securityPath, args);
    } catch {
      return { ok: false, stdout: "", stderr: "the keychain helper could not be started" };
    }
  };

  const runSync = (args: string[]): KeychainCliResult => {
    try {
      return spawnSyncImpl(securityPath, args);
    } catch {
      return { ok: false, stdout: "", stderr: "the keychain helper could not be started" };
    }
  };

  // `-w` prints the value with a trailing newline; strip only newlines so a
  // value that itself ends in spaces survives intact.
  const valueOf = (result: KeychainCliResult): string | null => {
    if (!result.ok) return null;
    const value = result.stdout.replace(/[\r\n]+$/, "");
    return value.length > 0 ? value : null;
  };

  return {
    status,
    async get(): Promise<string | null> {
      if (status() !== "available") return null;
      return valueOf(await run(["find-generic-password", "-s", service, "-a", account, "-w"]));
    },
    getSync(): string | null {
      if (status() !== "available") return null;
      return valueOf(runSync(["find-generic-password", "-s", service, "-a", account, "-w"]));
    },
    async has(): Promise<boolean> {
      if (status() !== "available") return false;
      // deliberately WITHOUT -w: the helper answers existence from its exit
      // status and never prints the value it holds
      const result = await run(["find-generic-password", "-s", service, "-a", account]);
      return result.ok;
    },
    async set(passphrase: string): Promise<boolean> {
      if (status() !== "available") return false;
      if (passphrase.length < KEYCHAIN_MIN_PASSPHRASE_LENGTH) return false;
      // `-U`: create or update — saving twice converges on one item.
      const result = await run(["add-generic-password", "-U", "-a", account, "-s", service, "-w", passphrase]);
      return result.ok;
    },
    async clear(): Promise<boolean> {
      if (status() !== "available") return false;
      const result = await run(["delete-generic-password", "-a", account, "-s", service]);
      if (result.ok) return true;
      // Already absent counts as cleared — a DELETE that converges.
      return missingItem(result.stderr);
    },
  };
}
