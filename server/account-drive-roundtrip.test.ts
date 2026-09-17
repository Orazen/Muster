// Acceptance for the account-linked Drive round trip over the real routes:
// connect (signed single-use state → callback → tokens stored only on the
// existing Google account row) → encrypted v2 push to the user's Drive
// appData → pull restoring a byte-identical bundle. Every file is owned; the
// child preload refuses outbound connections, so "Google" here is the owned
// synthetic transport while Muster builds, encrypts, decrypts and restores
// for real.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pairingServerEnvironment, waitForOwnedServer } from "../e2e/pairing-harness.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { createWorkspaceDriveFixture } from "./testing/workspace-drive-fixture.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const passphrase = "owned-account-drive-passphrase";
/** The callback answers 302; undici with redirect:"error" surfaces exactly this. */
const REDIRECTED = "Error: unexpected redirect";

describe.skipIf(process.platform === "win32")("account-linked Google Drive round trip", () => {
  let rootDirectory = "";
  let dataDirectory = "";
  let memoryCanaryFile = "";
  const children: ChildProcess[] = [];
  let child: ChildProcess;
  let transport: ReturnType<typeof createWorkspaceDriveFixture>;
  let url = "";
  let cookie = "";
  let userId = "";

  const api = (path: string, opts: RequestInit = {}) =>
    fetch(`${url}${path}`, { redirect: "error", signal: AbortSignal.timeout(15_000), ...opts });
  const googleRow = () => {
    const db = new DatabaseSync(join(dataDirectory, "auth.db"));
    try {
      // SAFETY: the row schema is the better-auth `account` table this test
      // seeds itself; the union captures its one legitimate null shape.
      return db.prepare(`SELECT * FROM "account" WHERE "userId" = ? AND "providerId" = 'google'`).get(userId) as
        | { accessToken: string | null; refreshToken: string | null; accessTokenExpiresAt: string | null }
        | undefined;
    } finally { db.close(); }
  };
  const expectRedirect = async (path: string, sessionCookie: string) => {
    try {
      const response = await api(path, { headers: { cookie: sessionCookie } });
      throw new Error(`expected a redirect, got ${response.status}: ${(await response.text()).slice(0, 200)}`);
    } catch (error) {
      // SAFETY: undici raises TypeError with a `cause` when redirect:"error"
      // fires; other rejections propagate unchanged below.
      const cause = String((error as { cause?: unknown }).cause);
      if (cause === REDIRECTED) return true;
      throw error;
    }
  };
  const operationsSince = (offset: number) => transport.entries().slice(offset).map((entry) => entry.operation);

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "muster-account-drive-"));
    rootDirectory = dir;
    dataDirectory = join(dir, "data");
    const home = join(dir, "home"), companion = join(dir, "companion"), ui = join(dir, "ui");
    for (const p of [dataDirectory, home, companion, ui, join(dataDirectory, "memory")]) mkdirSync(p, { recursive: true, mode: 0o700 });
    writeFileSync(join(ui, "index.html"), "<!doctype html><title>Owned account-Drive fixture</title>");
    memoryCanaryFile = join(dataDirectory, "memory", "canary.md");
    writeFileSync(memoryCanaryFile, `canary-${randomBytes(16).toString("hex")}`, { mode: 0o600 });
    writeFileSync(join(dataDirectory, "config.json"), JSON.stringify({
      instances: { ghost: { driver: "not-a-real-driver", displayName: "Offline account-Drive fixture" } },
    }), { mode: 0o600 });
    transport = createWorkspaceDriveFixture(join(dir, "google"));
    const port = await freePortBlock([0, 1, 2], 46000, 9000);
    const env = pairingServerEnvironment({ home, dataDirectory, companionDirectory: companion, staticDir: ui, port, webhookPort: port + 1, secret: randomBytes(32).toString("hex") });
    Object.assign(env, transport.env, { OMB_ALLOW_SIGNUPS: "true" });
    child = spawn(process.execPath, ["--import", transport.preloadPath, "--experimental-strip-types", join(ROOT, "server/index.ts")], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", () => {});
    url = `http://127.0.0.1:${port}`;
    await waitForOwnedServer(child, url);

    // The session: sign up through the real auth endpoint (local installs
    // keep their loopback trust, so this user is purely account-scoped).
    const signup = await api("/api/auth/sign-up/email", {
      method: "POST", headers: { "content-type": "application/json", origin: url },
      body: JSON.stringify({ email: `drive-${randomBytes(6).toString("hex")}@example.test`, password: randomBytes(24).toString("base64url"), name: "Owned Drive Round Trip" }),
    });
    expect(signup.status).toBe(200);
    cookie = (signup.headers.getSetCookie?.() ?? []).find((c) => c.startsWith("better-auth.session_token="))?.split(";")[0] ?? "";
    expect(cookie).not.toBe("");
    // SAFETY: the sign-up endpoint answers {user:{id}} on success; asserted
    // via the non-empty check immediately after.
    userId = ((await signup.json()) as { user?: { id?: string } }).user?.id ?? "";
    expect(userId).not.toBe("");

    // Mirror the Google-login world: the Drive grant attaches to an EXISTING
    // google account row. Email signup alone has none — that is the product
    // contract ("Drive connects to an account, it does not create one") — and
    // the row's refresh token must be the captured fixture's, exactly as the
    // callback would store it, or the transport's credential boundary refuses
    // every later grant.
    const db = new DatabaseSync(join(dataDirectory, "auth.db"));
    try {
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO account (id,accountId,providerId,userId,accessToken,refreshToken,scope,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(randomBytes(16).toString("hex"), randomBytes(16).toString("hex"), "google", userId,
          randomBytes(12).toString("hex"), transport.refreshToken, "https://www.googleapis.com/auth/drive.appdata", now, now);
    } finally { db.close(); }
  }, 30_000);

  afterAll(async () => {
    transport?.setMode("ok");
    await Promise.all(children.map((c) => waitForExit(c, { signal: "SIGTERM" })));
    const exited = children.every((c) => c.exitCode !== null || c.signalCode !== null);
    const closed = await Promise.all([0, 1].map((offset) => new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port: Number(new URL(url).port) + offset });
      socket.setTimeout(2_000);
      socket.once("connect", () => { socket.destroy(); resolve(false); });
      socket.once("timeout", () => { socket.destroy(); resolve(false); });
      socket.once("error", (error) => { socket.destroy(); resolve("code" in error && error.code === "ECONNREFUSED"); });
    })));
    const noOutbound = !existsSync(transport.networkLog);
    const noCredentialMismatch = transport.entries().every((entry) => entry.credentialsMatch);
    if (rootDirectory && exited) await removeTempDir(rootDirectory);
    const rootRemoved = !rootDirectory || !existsSync(rootDirectory);
    expect({ exited, noOutbound, noCredentialMismatch, rootRemoved }).toEqual({ exited: true, noOutbound: true, noCredentialMismatch: true, rootRemoved: true });
    expect(closed.every(Boolean)).toBe(true);
  }, 20_000);

  it("keeps the capability inert without a session and honest with one", async () => {
    const anon = await api("/api/workspace/google/status");
    expect(anon.status).toBe(200);
    expect(await anon.json()).toMatchObject({ workspaceBackupAvailable: true, accountDrive: { available: false, connected: false } });

    const authed = await api("/api/workspace/google/status", { headers: { cookie } });
    expect(authed.status).toBe(200);
    // The Google-login row already carries the refresh token (that is what
    // sign-in grants), so `connected` is honest before the explicit Drive
    // consent too — `available` is the gate the Drive connect opens.
    expect(await authed.json()).toMatchObject({ workspaceBackupAvailable: true, accountDrive: { available: true, connected: true } });
  });

  it("connect issues state bound to the requesting account and exchanges it for tokens on that row", async () => {
    const connect = await api("/api/workspace/google/connect", { headers: { cookie } });
    expect(connect.status).toBe(200);
    // SAFETY: the connect endpoint answers {url} — asserted by the URL parse
    // of the same value immediately after.
    const { url: consent } = (await connect.json()) as { url: string };
    const parsed = new URL(consent);
    expect(parsed.origin + parsed.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(parsed.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/drive.appdata");
    expect(parsed.searchParams.get("redirect_uri")).toBe(`${url}/api/workspace/google/callback`);
    const state = parsed.searchParams.get("state") ?? "";
    expect(state.split(".")).toHaveLength(3);
    expect(state.split(".")[0]).toBe(userId);
    expect(Number(state.split(".")[1])).toBeGreaterThan(Date.now() - 60_000);

    expect(await expectRedirect(`/api/workspace/google/callback?code=owned-consent-code&state=${encodeURIComponent(state)}`, cookie)).toBe(true);
    // The exchange must replace the row's tokens — not just re-save what the
    // seed put there — and persist the access token's expiry.
    const row = googleRow();
    expect(row?.refreshToken).toBe(transport.refreshToken);
    expect(row?.accessToken).toBe(transport.accessToken);
    expect(row?.accessTokenExpiresAt).not.toBeNull();
  });

  it("refuses a callback without a session: no state check, no exchange, no token write", async () => {
    const before = transport.entries().length;
    const response = await api("/api/workspace/google/callback?code=owned-consent-code&state=owned-forged-state");
    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({ code: "ACCOUNT_DRIVE_UNAVAILABLE" });
    expect(operationsSince(before)).toEqual([]);
  });

  it("refuses a callback state signed for another account even with a session", async () => {
    const before = transport.entries().length;
    const forged = `other-user-id.${Date.now()}.not-the-deployment-mac`;
    expect(await expectRedirect(`/api/workspace/google/callback?code=owned-consent-code&state=${encodeURIComponent(forged)}`, cookie)).toBe(true);
    // The signed-intent check fails before any consent exchange can run.
    expect(operationsSince(before)).toEqual([]);
    expect(googleRow()?.accessToken).toBe(transport.accessToken);
  });

  it("pushes the encrypted v2 bundle, reusing the token the exchange stored", async () => {
    const offset = transport.entries().length;
    const push = await api("/api/workspace/google/push", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ passphrase }) });
    expect(push.status).toBe(200);
    // SAFETY: the push receipt shape is pinned by the toMatchObject below.
    const receipt = (await push.json()) as { uploaded: string; counts: { threads: number } };
    expect(receipt.uploaded).toBe("owned-workspace-file");
    expect(receipt.counts.threads).toBeGreaterThanOrEqual(1);
    // Token continuity: the callback persisted a fresh access token with its
    // expiry, so push reuses it — list + upload, no refresh grant.
    expect(operationsSince(offset)).toEqual(["list", "upload"]);
    expect(transport.entries().slice(offset).every((entry) => entry.credentialsMatch)).toBe(true);

    const uploaded = readFileSync(join(rootDirectory, "google", "uploaded-bundle-v2.txt"), "utf8");
    expect(uploaded).toContain('"magic":"muster-workspace-bundle"');
    expect(uploaded).not.toContain("canary-");
    expect(uploaded).not.toContain(passphrase);
  });

  it("pulls the bundle back and stages a byte-identical restore on the account channel", async () => {
    const offset = transport.entries().length;
    const pull = await api("/api/workspace/google/pull", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ passphrase }) });
    expect(pull.status).toBe(200);
    expect(await pull.json()).toMatchObject({ staged: true, restartRequired: true });
    // Token continuity: the persisted fresh token is reused — no refresh grant.
    expect(operationsSince(offset)).toEqual(["list", "download"]);

    const stagedCanary = readFileSync(join(`${dataDirectory}.restore-staging`, "memory", "canary.md"), "utf8");
    expect(stagedCanary).toBe(readFileSync(memoryCanaryFile, "utf8"));
    const status = await api("/api/workspace/v2/status", { headers: { cookie } });
    expect(await status.json()).toMatchObject({ pending: { source: "google-account" } });
  });

  it("refreshes an expired access token once and persists the new one for reuse", async () => {
    // Simulate the stored token aging out: the next operation must pay
    // exactly one refresh grant and store the new token's expiry — before
    // this fix every operation re-refreshed and threw the token away.
    const db = new DatabaseSync(join(dataDirectory, "auth.db"));
    try {
      db.prepare(`UPDATE "account" SET "accessTokenExpiresAt" = '2020-01-01T00:00:00.000Z' WHERE "userId" = ? AND "providerId" = 'google'`).run(userId);
    } finally { db.close(); }
    const offset = transport.entries().length;
    const push = await api("/api/workspace/google/push", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ passphrase }) });
    expect(push.status).toBe(200);
    expect(operationsSince(offset)).toEqual(["refresh", "list", "upload"]);
    const expiry = new Date(googleRow()?.accessTokenExpiresAt ?? 0).getTime();
    expect(expiry).toBeGreaterThan(Date.now() + 30 * 60_000);
  });

  it("rejects a wrong passphrase at the pull instead of staging garbage", async () => {
    const pull = await api("/api/workspace/google/pull", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ passphrase: "wrong-passphrase-1" }) });
    expect(pull.status).toBe(400);
    // SAFETY: only the error text is read; its presence is asserted next.
    expect(((await pull.json()) as { error?: string }).error).toBeTruthy();
    // The previously staged good bundle must be untouched by the failed pull.
    expect(readFileSync(join(`${dataDirectory}.restore-staging`, "memory", "canary.md"), "utf8")).toBe(readFileSync(memoryCanaryFile, "utf8"));
  });
});
