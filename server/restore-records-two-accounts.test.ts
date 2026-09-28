// Two accounts, one installation, one Google Drive each — over real HTTP.
//
// The product promises encrypted Google Drive recovery, and the part of that
// promise nobody had ever tested is the part that decides whether it is
// believable: can account A see, or restore, account B's backup? Until now the
// owned Drive fixture handed every account the SAME bearer token over the SAME
// app-data store, so a two-account test could not have failed for the right
// reason — the two accounts shared a filing cabinet. The fixture now models
// Drive's actual boundary (appDataFolder is per Google account), which is what
// makes this suite possible at all, and this suite is what makes the property
// real rather than assumed.
//
// Asserted, in order:
//   1. no session, no records, and no Drive call at all;
//   2. two accounts hold two grants with two different tokens, and two app-data
//      folders — checked against the transport's own stores, not a route's claims;
//   3. each account's catalog names ITSELF and offers only its own records,
//      newest first, and building it moved no bytes (one list, no download);
//   4. the catalog names the credential and grant files, and the bytes that were
//      uploaded contain neither account's OAuth tokens nor the installation
//      secret;
//   5. Zoe cannot SELECT Ada's record — no staging tree, no pending restore;
//   6. and Ada can still select her own older record, because a test where
//      "refuses everything" passes is not an exclusion test.
//
// The status code in (5) is 502, which is the wrong answer — a snapshot id that
// is not in the caller's own Drive is a 404, not a Drive outage. It is pinned as
// observed rather than fixed here: telling the two apart means classifying the
// transport's error text, and guessing at it inside a recovery path is exactly
// the kind of change that makes a receipt lie.

import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { pairingServerEnvironment, waitForOwnedServer } from "../e2e/pairing-harness.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { createWorkspaceDriveFixture } from "./testing/workspace-drive-fixture.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PASSPHRASE = "correct-horse-battery";

const catalogSchema = z.object({
  version: z.literal(1),
  accountId: z.string().min(1),
  drive: z.object({ state: z.string(), grantGeneration: z.number().int().nullable() }),
  records: z.array(z.object({
    id: z.string().min(1),
    source: z.literal("google-account"),
    name: z.string().min(1),
    createdAt: z.number().int().nullable(),
    sizeBytes: z.number().int().nonnegative().nullable(),
    selectable: z.literal(true),
  })),
  truncated: z.boolean(),
  excludes: z.object({
    files: z.array(z.string()),
    botFields: z.array(z.string()),
    disabledBotFields: z.array(z.string()),
    taskFields: z.array(z.string()),
    groupFields: z.array(z.string()),
  }),
  snapshots: z.array(z.object({ id: z.string().min(1), name: z.string().min(1) })),
});

describe.skipIf(process.platform === "win32")("an account can only see and select its own portable records", () => {
  let rootDirectory = "";
  let dataDirectory = "";
  let memoryCanary = "";
  let installationSecret = "";
  let child: ChildProcess;
  let transport: ReturnType<typeof createWorkspaceDriveFixture>;
  let url = "";
  const ada = { key: "ada", cookie: "", id: "" };
  const zoe = { key: "zoe", cookie: "", id: "" };

  const api = (path: string, opts: RequestInit = {}) =>
    fetch(`${url}${path}`, { redirect: "manual", signal: AbortSignal.timeout(20_000), ...opts });

  /** The catalog reply, parsed against the server's own contract. */
  const catalogOf = async (cookie: string) => {
    const response = await api("/api/workspace/google/snapshots", { headers: { cookie } });
    expect(response.status, await response.clone().text()).toBe(200);
    // A listing of the user's Drive contents must never be cached or referrable.
    expect(response.headers.get("cache-control")).toBe("no-store");
    return catalogSchema.parse(await response.json());
  };

  const push = async (cookie: string): Promise<string> => {
    const response = await api("/api/workspace/google/push", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ passphrase: PASSPHRASE }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    // SAFETY: the receipt shape is pinned by the parse below, which throws
    // before an empty id could be used on the next line.
    return z.object({ uploaded: z.string().min(1) }).parse(await response.json()).uploaded;
  };

  const stagingRoot = () => `${dataDirectory}.restore-staging`;

  /** Sign up an email-only account and connect it to its OWN Google account in
   *  the fixture. The whole PKCE dance runs for real; only "Google" is owned. */
  const connect = async (account: { key: string; cookie: string; id: string }, email: string) => {
    const signup = await api("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: url },
      body: JSON.stringify({ email, password: PASSPHRASE, name: email.split("@")[0] }),
    });
    expect(signup.status, await signup.clone().text()).toBe(200);
    account.cookie = (signup.headers.getSetCookie() ?? []).find((c) => c.startsWith("better-auth.session_token="))?.split(";")[0] ?? "";
    expect(account.cookie, `no session cookie for ${email}`).not.toBe("");
    // SAFETY: the sign-up endpoint answers {user:{id}}; the non-empty check
    // immediately after throws before a blank id could be compared.
    account.id = ((await signup.json()) as { user?: { id?: string } }).user?.id ?? "";
    expect(account.id, `no account id for ${email}`).not.toBe("");

    const consentUrl = await api("/api/workspace/google/connect", { headers: { cookie: account.cookie } });
    expect(consentUrl.status).toBe(200);
    const target = new URL(z.object({ url: z.string() }).parse(await consentUrl.json()).url);
    const state = target.searchParams.get("state") ?? "";
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const db = new DatabaseSync(join(dataDirectory, "auth.db"));
    try {
      const binding = z.object({ nonce: z.string(), codeVerifier: z.string() })
        .parse(db.prepare("SELECT nonce, codeVerifier FROM drive_oauth_states WHERE userId = ?").get(account.id));
      expect(target.searchParams.get("code_challenge")).toBe(createHash("sha256").update(binding.codeVerifier).digest("base64url"));
      // Point the consent at THIS account, so the exchange mints this account's
      // own Google subject and tokens — and therefore its own app-data folder.
      transport.setConsent({ nonce: binding.nonce, verifier: binding.codeVerifier, account: account.key });
    } finally { db.close(); }
    const callback = await api(`/api/workspace/google/callback?code=owned-consent&state=${encodeURIComponent(state)}`, { headers: { cookie: account.cookie } });
    expect(callback.status).toBe(302);
    await callback.arrayBuffer();
  };

  /** The OAuth tokens Muster stored for an account. Real credentials, and the
   *  point of the exclusion assertion: a grant must not travel in a record. */
  const grantTokensFor = (userId: string): { accessToken: string; refreshToken: string } => {
    const db = new DatabaseSync(join(dataDirectory, "auth.db"));
    try {
      return z.object({ accessToken: z.string(), refreshToken: z.string() })
        .parse(db.prepare("SELECT accessToken, refreshToken FROM drive_grants WHERE userId = ?").get(userId));
    } finally { db.close(); }
  };

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "muster-restore-records-"));
    rootDirectory = dir;
    dataDirectory = join(dir, "data");
    const home = join(dir, "home"), companion = join(dir, "companion"), ui = join(dir, "ui");
    for (const p of [dataDirectory, home, companion, ui, join(dataDirectory, "memory")]) mkdirSync(p, { recursive: true, mode: 0o700 });
    writeFileSync(join(ui, "index.html"), "<!doctype html><title>Owned restore-records fixture</title>");
    memoryCanary = join(dataDirectory, "memory", "canary.md");
    writeFileSync(memoryCanary, "ada-canary-one", { mode: 0o600 });
    // The installation signing secret, seeded with a recognisable value. This
    // deployment supplies BETTER_AUTH_SECRET, so the server would never write
    // one of its own; the exclusion claim is about the FILE, so the test
    // provides it.
    writeFileSync(join(dataDirectory, "auth.secret"), "canary-installation-secret", { mode: 0o600 });
    // A declared offline instance, exactly as account-drive-roundtrip does: with
    // no instances the server goes looking for an engine at boot, and that
    // lookup is not offline.
    writeFileSync(join(dataDirectory, "config.json"), JSON.stringify({
      instances: { ghost: { driver: "not-a-real-driver", displayName: "Offline restore-records fixture" } },
    }), { mode: 0o600 });
    transport = createWorkspaceDriveFixture(join(dir, "google"));
    // Registered BEFORE the child boots: the transport reads its account list
    // once, at preload, exactly as it reads settings.json.
    transport.createAccount(ada.key);
    transport.createAccount(zoe.key);
    const port = await freePortBlock([0, 1, 2], 46000, 9000);
    const env = pairingServerEnvironment({ home, dataDirectory, companionDirectory: companion, staticDir: ui, port, webhookPort: port + 1, secret: randomBytes(32).toString("hex") });
    Object.assign(env, transport.env, { OMB_ALLOW_SIGNUPS: "true" });
    child = spawn(process.execPath, ["--import", transport.preloadPath, "--experimental-strip-types", join(ROOT, "server/index.ts")], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", () => {});
    url = `http://127.0.0.1:${port}`;
    await waitForOwnedServer(child, url);
    installationSecret = readFileSync(join(dataDirectory, "auth.secret"), "utf8");

    await connect(ada, "ada@example.test");
    await connect(zoe, "zoe@example.test");
  }, 60_000);

  afterAll(async () => {
    transport?.setMode("ok");
    await waitForExit(child, { signal: "SIGTERM" }).catch(() => {});
    const exited = child.exitCode !== null || child.signalCode !== null;
    const closed = await Promise.all([0, 1].map((offset) => new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port: Number(new URL(url).port) + offset });
      socket.setTimeout(2_000);
      socket.once("connect", () => { socket.destroy(); resolve(false); });
      socket.once("timeout", () => { socket.destroy(); resolve(false); });
      socket.once("error", () => { socket.destroy(); resolve(true); });
    })));
    const noOutbound = !existsSync(transport.networkLog);
    // Every Drive call carried the credentials of the account it was made for.
    // This is the layer under the whole suite: if a route ever reached Drive
    // with a token that was not the caller's, this is where it would show.
    const noCredentialMismatch = transport.entries().every((entry) => entry.credentialsMatch);
    if (rootDirectory && exited) await removeTempDir(rootDirectory);
    expect({ exited, noOutbound, noCredentialMismatch }).toEqual({ exited: true, noOutbound: true, noCredentialMismatch: true });
    expect(closed.every(Boolean)).toBe(true);
  }, 20_000);

  it("answers no session with nothing to look at, and never reaches Drive", async () => {
    const before = transport.entries().length;
    const response = await api("/api/workspace/google/snapshots");
    expect(response.status).toBe(501);
    // SAFETY: the status assertion immediately above pins the contained-501
    // answer, whose only shape is {code, error}.
    expect(((await response.json()) as { code?: string }).code).toBe("ACCOUNT_DRIVE_UNAVAILABLE");
    // A request with no account row must not be able to list anything, and the
    // transport journal is the only place that would show it trying.
    expect(transport.entries().length).toBe(before);
  });

  it("gives two accounts two grants and two Drive app-data folders", async () => {
    // The precondition for everything after this, checked against the transport's
    // own stores rather than a route's answer: with one shared store the
    // exclusion cases below would be unfalsifiable.
    expect(transport.accountRecordIds(ada.key)).toEqual([]);
    expect(transport.accountRecordIds(zoe.key)).toEqual([]);
    const adaGrant = grantTokensFor(ada.id);
    const zoeGrant = grantTokensFor(zoe.id);
    expect(adaGrant.accessToken).not.toBe(zoeGrant.accessToken);
    expect(adaGrant.refreshToken).not.toBe(zoeGrant.refreshToken);
  });

  it("shows an account only its own records, and moves no bytes to build the list", async () => {
    // Ada pushes twice with different workspace bytes; Zoe pushes once. All three
    // records live in the same synthetic transport, in different folders.
    const adaFirst = await push(ada.cookie);
    await push(zoe.cookie);
    writeFileSync(memoryCanary, "ada-canary-two", { mode: 0o600 });
    const adaSecond = await push(ada.cookie);
    expect(new Set([adaFirst, adaSecond]).size).toBe(2);
    expect(transport.accountRecordIds(ada.key)).toEqual([adaFirst, adaSecond]);
    const zoeRecords = transport.accountRecordIds(zoe.key);
    expect(zoeRecords).toHaveLength(1);
    writeFileSync(memoryCanary, "ada-canary-one", { mode: 0o600 });

    const adaOffset = transport.entries().length;
    const adaCatalog = await catalogOf(ada.cookie);
    // One Drive call, and it is a list. A download here would mean the listing
    // moved bytes, and "what can I restore" must cost nothing to answer.
    expect(transport.entries().slice(adaOffset).map((entry) => entry.operation)).toEqual(["list"]);

    const zoeOffset = transport.entries().length;
    const zoeCatalog = await catalogOf(zoe.cookie);
    expect(transport.entries().slice(zoeOffset).map((entry) => entry.operation)).toEqual(["list"]);

    // Each document is about the account that asked for it.
    expect(adaCatalog.accountId).toBe(ada.id);
    expect(zoeCatalog.accountId).toBe(zoe.id);
    expect(adaCatalog.drive.state).toBe("connected");

    // Ada sees her two, newest first.
    expect(adaCatalog.records.map((record) => record.id)).toEqual([adaSecond, adaFirst]);
    // Zoe sees her one, and neither of Ada's.
    expect(zoeCatalog.records.map((record) => record.id)).toEqual(zoeRecords);
    for (const id of [adaFirst, adaSecond]) {
      expect(zoeCatalog.records.map((record) => record.id), `Zoe's catalog offered Ada's record ${id}`).not.toContain(id);
      expect(zoeCatalog.snapshots.map((row) => row.id)).not.toContain(id);
    }
    // The shipped client contract is untouched by the catalog beside it.
    expect(adaCatalog.snapshots.map((row) => row.id)).toEqual([adaSecond, adaFirst]);
  });

  it("names the credentials and grants a restore will not bring back, and the uploaded bytes carry none of them", async () => {
    const catalog = await catalogOf(ada.cookie);
    // The exclusion, read from the bundle module's own list rather than copied
    // into a second place that could be forgotten.
    expect(catalog.excludes.files).toEqual(["auth.db", "auth.secret", "config.json"]);
    expect(catalog.excludes.botFields).toContain("alwaysAllow");
    expect(catalog.excludes.botFields).toContain("autoApprove");
    expect(catalog.excludes.disabledBotFields).toEqual(["composio", "browser"]);

    // And the promise holds on the bytes that actually moved: neither account's
    // OAuth tokens, nor the installation secret, are in any uploaded record.
    const adaGrant = grantTokensFor(ada.id);
    const zoeGrant = grantTokensFor(zoe.id);
    const uploaded = [...transport.accountRecordIds(ada.key), ...transport.accountRecordIds(zoe.key)];
    expect(uploaded.length, "the fixture stored fewer records than were pushed").toBe(3);
    for (const id of uploaded) {
      const stored = transport.snapshotPayload(id);
      expect(stored, `the fixture holds no payload for ${id}`).not.toBeNull();
      for (const secret of [adaGrant.accessToken, adaGrant.refreshToken, zoeGrant.accessToken, zoeGrant.refreshToken, installationSecret]) {
        expect(stored, `an uploaded record carried ${secret.slice(0, 8)}`).not.toContain(secret);
      }
    }
  });

  it("refuses to restore a record that is not the caller's own, and stages nothing", async () => {
    const adaRecord = transport.accountRecordIds(ada.key)[0]!;
    const zoeCatalog = await catalogOf(zoe.cookie);
    expect(zoeCatalog.records.map((record) => record.id)).not.toContain(adaRecord);
    expect(existsSync(stagingRoot()), "a previous case left a staging tree behind").toBe(false);

    const offset = transport.entries().length;
    const response = await api("/api/workspace/google/pull", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: zoe.cookie },
      body: JSON.stringify({ passphrase: PASSPHRASE, snapshotId: adaRecord }),
    });
    // Not a success, and not a redirect into one. See the file header: 502 is
    // the wrong code for this and is pinned as observed, not endorsed.
    expect(response.status).toBe(502);
    await response.arrayBuffer();
    // It did try to fetch the record — with Zoe's own token, against Zoe's own
    // folder, where that id does not exist. That is the whole boundary.
    expect(transport.entries().slice(offset).map((entry) => entry.operation)).toEqual(["download"]);

    // The decisive part: nothing was staged, and nothing is waiting to apply.
    expect(existsSync(stagingRoot()), "a cross-account restore left a staging tree").toBe(false);
    const status = await api("/api/workspace/v2/status", { headers: { cookie: zoe.cookie } });
    // SAFETY: the v2 status route answers 200 with {pending, receipt} for any
    // signed-in caller, which is exactly the shape asserted just below.
    expect(((await status.json()) as { pending: unknown }).pending).toBeNull();
  });

  it("still restores the account's own older record, so the refusal above is an exclusion and not a blanket denial", async () => {
    const catalog = await catalogOf(ada.cookie);
    const older = catalog.records[1]!;
    expect(older.id).toBe(transport.accountRecordIds(ada.key)[0]);

    const pull = await api("/api/workspace/google/pull", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: ada.cookie },
      body: JSON.stringify({ passphrase: PASSPHRASE, snapshotId: older.id }),
    });
    expect(pull.status, await pull.clone().text()).toBe(200);
    // SAFETY: the status assertion immediately above pins a staged-restore
    // receipt, whose only shape is the StageOkBody this asserts one field of.
    expect(((await pull.json()) as { staged?: boolean }).staged).toBe(true);
    // The older bytes, not the live ones — so this is a real selection and not
    // the default newest-restore path wearing a different label.
    expect(readFileSync(join(stagingRoot(), "memory", "canary.md"), "utf8")).toBe("ada-canary-one");
    const status = await api("/api/workspace/v2/status", { headers: { cookie: ada.cookie } });
    // SAFETY: same 200 {pending, receipt} shape as the read above; this one is
    // the non-null branch, so `pending` is a pending-restore view.
    expect(((await status.json()) as { pending: unknown }).pending).toMatchObject({ source: "google-account" });
  });
});
