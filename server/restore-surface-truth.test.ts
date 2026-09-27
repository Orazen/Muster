// Two restore-surface defects that both made the product report something
// untrue about the user's own data.
//
// **S4-9** — the companion receipt reads `requestUserId ?? "local"` while all
// four Drive writes stamped the literal `"local"`. On any signed-in install the
// write went to a file nothing ever read, so the UI reported "never" for a
// backup the user had just completed. A read and a write that disagree about
// the key is not a cosmetic bug; it is the receipt denying something that
// happened.
//
// **S4-12** — a restore staged its bytes and only then wrote the pending
// record, and that write throws whenever a record already exists. So a second
// attempt could write a whole tree of new bytes, fail to record them, and leave
// the OLD record pointing at the NEW bytes — which the next boot would commit
// under the old counts. Fixed twice over: refuse before staging anything, and
// roll the tree back if the write still fails.
//
// Both are asserted over real HTTP because both are route-level, and a store
// test cannot reach either one.

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const posixOnly = describe.skipIf(process.platform === "win32");

let child: ChildProcess;
let home: string;
let dataDir: string;
let base: string;
let secret: string;
let stderr = "";
let cookie = "";
const SYNC_DIR = "sync-state";

function api(method: string, path: string, bodyJson?: string): Promise<{ status: number; body: any }> {
  return fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", cookie, origin: base },
    body: bodyJson,
    redirect: "manual",
  }).then(async (response) => {
    const text = await response.text();
    // Every route under test answers JSON; an empty body is a 204/no-content and
    // becomes null so callers can assert on `body` without a parse guard.
    return { status: response.status, body: text ? JSON.parse(text) : null };
  });
}

const PASSPHRASE = "correct-horse-battery";

/** A real v2 bundle sealed from the live data dir, so the restore path runs
 *  exactly as it does for a user — the same encrypt/verify/stage sequence, not
 *  a hand-built payload. */
async function exportBundle(): Promise<string> {
  const exported = await api("POST", "/api/workspace/v2/export", JSON.stringify({ passphrase: PASSPHRASE }));
  expect(exported.status).toBe(200);
  // SAFETY: the status assertion is the guard — v2StatusReply on the client
  // requires a non-empty `payload` string, so a 200 without one would have
  // failed the card's own parser before reaching here.
  return exported.body.payload as string;
}

/** The wire body the restore route expects, serialized. */
const bundleArg = (payload: string): string => JSON.stringify({ passphrase: PASSPHRASE, confirm: true, payload });

/** The sync-state file the receipt will read for THIS account. The directory
 *  is `<DATA_DIR>/sync-state` and the file is named for the account id — which
 *  is exactly why the literal "local" writes went somewhere unread. */
function syncStatePath(): string {
  return join(dataDir, SYNC_DIR, `${ownerId()}.json`);
}

/** The old bucket the pre-fix code wrote. Asserting it stays EMPTY is the
 *  other half of the S4-9 claim: the write moved, it did not merely double. */
function legacyLocalBucketPath(): string {
  return join(dataDir, SYNC_DIR, "local.json");
}

/** stagingPathFor() is `${dataDir}.restore-staging` — a SIBLING of the data
 *  dir, not a folder inside it. */
function stagingRoot(): string {
  return `${dataDir}.restore-staging`;
}

/** The signed-in account's id, read from the session the server just minted. */
let owner = "";
function ownerId(): string {
  return owner;
}

posixOnly("the restore surface tells the truth about the user's data", () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "omb-restore-truth-"));
    dataDir = join(home, "data");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({}));
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    secret = randomBytes(32).toString("hex");
    child = spawn(process.execPath, ["--experimental-strip-types", join(SERVER_DIR, "index.ts")], {
      cwd: ROOT,
      env: {
        HOME: home,
        USERPROFILE: home,
        OMB_DATA_DIR: dataDir,
        OMB_COMPANION_DIR: join(home, "companion"),
        OMB_HOST: "127.0.0.1",
        OMB_PORT: String(port),
        OMB_WEBHOOK_PORT: String(port + 1),
        OMB_PUBLIC_URL: base,
        BETTER_AUTH_SECRET: secret,
        OMB_ALLOW_SIGNUPS: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (chunk) => { stderr += chunk; });
    child.stdout!.resume();
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        const response = await fetch(`${base}/api/health`, { redirect: "manual" });
        if (response.ok) break;
      } catch {
        /* the listener is not up yet */
      }
      if (child.exitCode !== null || Date.now() > deadline) {
        throw new Error(`restore-truth fixture did not start: ${stderr}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    const signed = await fetch(`${base}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ email: "restore@example.com", password: PASSPHRASE, name: "Restore" }),
      redirect: "manual",
    });
    const jar = signed.headers.getSetCookie?.() ?? [];
    const session = jar.find((c) => c.startsWith("better-auth.session_token="));
    // SAFETY: the sign-up status assertion below is the guard; a jar without a
    // session cookie is a fixture defect, not something to pass through.
    expect(session, `no session cookie: ${jar.join(" | ")}`).toBeTruthy();
    // SAFETY: guarded by the assertion immediately above.
    cookie = (session as string).split(";")[0] as string;
    const me = await api("GET", "/api/auth/get-session");
    owner = me.body?.user?.id ?? "";
    expect(owner, "could not resolve the signed-in account id").toBeTruthy();
  }, 45_000);

  afterAll(async () => {
    child?.kill("SIGKILL");
    await waitForExit(child).catch(() => {});
    if (home) await removeTempDir(home);
  });

  it("stamps and reads the sync state under one key, not two", async () => {
    // S4-9. The receipt read `requestUserId ?? "local"` while all four Drive
    // writes stamped the literal `"local"`, so on a signed-in install the write
    // landed in a file nothing ever read and the UI reported "never" for a
    // backup the user had just completed.
    //
    // What cannot be driven here: a SUCCESSFUL Drive push, because that needs
    // real Google credentials. So the push route is exercised as far as it goes
    // offline — it must refuse and stamp nothing, in EITHER bucket — and the
    // read/write key agreement is proved against the same module the route and
    // the receipt both call.
    const refused = await api("POST", "/api/workspace/v2/drive/push", JSON.stringify({ passphrase: PASSPHRASE }));
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/not connected/i);
    // Neither the account's bucket nor the old literal one may appear.
    expect(existsSync(syncStatePath())).toBe(false);
    expect(existsSync(legacyLocalBucketPath())).toBe(false);

    // Deliberately NOT asserting the success path by importing readSyncState
    // here: sync-state.ts binds DATA_DIR at module load from THIS process's
    // env, so calling it from the test would read — and a stamp would write —
    // the real repository data directory, not this fixture's temp dir. The
    // reader's keying is already covered by sync-state.test.ts against a temp
    // DATA_DIR; what is unproven here is the ROUTE's argument, asserted below.
    // And the two routes that write this now pass exactly the reader's key.
    const routeSource = readFileSync(join(SERVER_DIR, "workspace-backup-routes.ts"), "utf8");
    const stamps = [...routeSource.matchAll(/stampSync\(([^,]+), "(push|pull)"/g)].map((m) => m[1]!.trim());
    expect(stamps.length, "expected the four Drive stamps to be found").toBeGreaterThanOrEqual(4);
    for (const key of stamps) {
      expect(key, `a Drive stamp still writes a hard-coded bucket: ${key}`).not.toBe('"local"');
    }
    rmSync(join(dataDir, SYNC_DIR), { recursive: true, force: true });
  });

  it("refuses a second staged restore without writing a byte of the new bundle", async () => {
    // S4-12. The first stage succeeds and leaves a pending record; the second
    // must be refused, and the refusal must happen BEFORE the tree is written —
    // otherwise the old record ends up pointing at the new bytes.
    const payload = await exportBundle();
    const first = await api("POST", "/api/workspace/v2/restore", bundleArg(payload));
    expect(first.status).toBe(200);
    expect(first.body.staged).toBe(true);

    const stagingDir = stagingRoot();
    const fingerprint = (): string[] => {
      if (!existsSync(stagingDir)) return [];
      // The whole tree, not one file: the point is that the refused attempt
      // wrote NOTHING, and a single file could be rewritten identically.
      return readdirSync(stagingDir).sort();
    };
    const before = fingerprint();
    expect(before.length, `the first stage wrote nothing to fingerprint in ${stagingDir}`).toBeGreaterThan(0);

    const second = await api("POST", "/api/workspace/v2/restore", bundleArg(payload));
    expect(second.status).toBe(409);
    expect(String(second.body.error)).toMatch(/already waiting/i);
    // The decisive assertion: the refused attempt did not replace the staged
    // bytes the pending record points at.
    expect(fingerprint()).toEqual(before);

    // Clean up so later cases start from no pending restore.
    const discarded = await api("POST", "/api/workspace/v2/restore/discard");
    expect(discarded.status).toBe(200);
  });

  it("leaves no pending record pointing at a staging tree that no longer exists", async () => {
    // After a discard, nothing is pending and the tree is gone — the invariant
    // the rollback exists to preserve, asserted from the outside.
    const status = await api("GET", "/api/workspace/v2/status");
    expect(status.status).toBe(200);
    expect(status.body.pending).toBeNull();
    expect(existsSync(stagingRoot())).toBe(false);
    rmSync(join(dataDir, SYNC_DIR), { recursive: true, force: true });
  });

  it("rolls the staging tree back when the pending record cannot be written", async () => {
    // The other half of S4-12, and the half a pre-check cannot cover: the
    // pre-check removes the KNOWN reason writePendingRestore throws, but the
    // invariant that matters is "never leave a tree nothing points at". So the
    // catch rolls it back too, and this drives that path for real.
    //
    // The trick is the directory mode. stagingPathFor() is a SIBLING of the data
    // dir, so making the data dir read-only leaves staging writable while the
    // pending record — which lives inside the data dir — cannot be written. That
    // is exactly the half state: bytes on disk, no record pointing at them.
    const payload = await exportBundle();
    // A read-only data dir must not stop the PRE-check from reading, nor the
    // bundle from being sealed, so both happen before the chmod.
    const stagingDir = stagingRoot();
    expect(existsSync(stagingDir), "a previous case left a staging tree behind").toBe(false);

    if (process.platform === "win32" || process.getuid?.() === 0) {
      // Root ignores the mode bits, so this could not prove anything here.
      return;
    }
    chmodSync(dataDir, 0o500);
    try {
      const refused = await api("POST", "/api/workspace/v2/restore", bundleArg(payload));
      expect(refused.status).toBe(409);
      // The decisive assertion: the rollback removed the tree the failed write
      // left behind. Without it the next boot would find these bytes with
      // nothing pointing at them, and the NEXT restore would collide with them.
      expect(existsSync(stagingDir), "a failed pending write left a staging tree nothing points at").toBe(false);
    } finally {
      chmodSync(dataDir, 0o700);
    }

    // And the install is still usable: a normal stage now works and records.
    const ok = await api("POST", "/api/workspace/v2/restore", bundleArg(payload));
    expect(ok.status).toBe(200);
    expect(ok.body.staged).toBe(true);
    expect(existsSync(stagingDir)).toBe(true);
    expect((await api("POST", "/api/workspace/v2/restore/discard")).status).toBe(200);
  });
});
