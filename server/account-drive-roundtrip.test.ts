// Acceptance for the account-linked Drive round trip over the real routes:
// connect (opaque single-use state → callback → tokens stored only on the
// separate Drive grant) → encrypted v2 push to the user's Drive
// appData → pull restoring a byte-identical bundle. Every file is owned; the
// child preload refuses outbound connections, so "Google" here is the owned
// synthetic transport while Muster builds, encrypts, decrypts and restores
// for real.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { disconnectDrive } from "./drive-grants.ts";
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
  const email = `drive-${randomBytes(6).toString("hex")}@example.test`;
  const password = randomBytes(24).toString("base64url");
  let loginBefore: ReturnType<typeof googleRow>;
  let successfulState = "";

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
  const driveRow = () => {
    const db = new DatabaseSync(join(dataDirectory, "auth.db"));
    try { return z.object({ accessToken: z.string(), refreshToken: z.string(), expiresAt: z.number(), googleSub: z.string() }).parse(db.prepare("SELECT * FROM drive_grants WHERE userId = ?").get(userId)); }
    finally { db.close(); }
  };
  const consent = async (patch: { googleSub?: string; scope?: string } = {}) => {
    const response = await api("/api/workspace/google/connect", { headers: { cookie } });
    expect(response.status).toBe(200);
    const target = new URL(z.object({ url: z.string() }).parse(await response.json()).url);
    const state = target.searchParams.get("state") ?? "";
    const db = new DatabaseSync(join(dataDirectory, "auth.db"));
    try {
      const binding = z.object({ nonce: z.string(), codeVerifier: z.string() }).parse(db.prepare("SELECT nonce, codeVerifier FROM drive_oauth_states WHERE userId = ?").get(userId));
      transport.setConsent({ nonce: binding.nonce, verifier: binding.codeVerifier, ...patch });
      expect(target.searchParams.get("nonce")).toBe(binding.nonce);
      expect(target.searchParams.get("code_challenge")).toBe(createHash("sha256").update(binding.codeVerifier).digest("base64url"));
      expect(target.searchParams.get("code_challenge_method")).toBe("S256");
    } finally { db.close(); }
    return { target, state };
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
      body: JSON.stringify({ email, password, name: "Owned Drive Round Trip" }),
    });
    expect(signup.status).toBe(200);
    cookie = (signup.headers.getSetCookie?.() ?? []).find((c) => c.startsWith("better-auth.session_token="))?.split(";")[0] ?? "";
    expect(cookie).not.toBe("");
    // SAFETY: the sign-up endpoint answers {user:{id}} on success; asserted
    // via the non-empty check immediately after.
    userId = ((await signup.json()) as { user?: { id?: string } }).user?.id ?? "";
    expect(userId).not.toBe("");

    // Login identity exists, but its legacy token must not authorize backup.
    const db = new DatabaseSync(join(dataDirectory, "auth.db"));
    try {
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO account (id,accountId,providerId,userId,accessToken,refreshToken,scope,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(randomBytes(16).toString("hex"), transport.googleSubject, "google", userId,
          randomBytes(12).toString("hex"), transport.refreshToken, "https://www.googleapis.com/auth/drive.appdata", now, now);
    } finally { db.close(); }
    loginBefore = googleRow();
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
    // Login credentials alone are never a backup permission.
    expect(await authed.json()).toMatchObject({ workspaceBackupAvailable: true, accountDrive: { available: true, connected: false } });
  });

  it("connects with PKCE and signed identity into a separate grant without modifying login credentials", async () => {
    const { target, state } = await consent(); successfulState = state;
    expect(target.origin + target.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(target.searchParams.get("scope")?.split(" ")).toContain("https://www.googleapis.com/auth/drive.appdata");
    expect(target.searchParams.get("redirect_uri")).toBe(`${url}/api/workspace/google/callback`);
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await expectRedirect(`/api/workspace/google/callback?code=owned-consent-code&state=${encodeURIComponent(state)}`, cookie)).toBe(true);
    expect(driveRow()).toMatchObject({ refreshToken: transport.refreshToken, accessToken: transport.accessToken, googleSub: transport.googleSubject });
    expect(driveRow().expiresAt).toBeGreaterThan(Date.now());
    expect(googleRow()).toEqual(loginBefore);
    const before = transport.entries().length;
    await expectRedirect(`/api/workspace/google/callback?code=replay&state=${encodeURIComponent(successfulState)}`, cookie);
    expect(operationsSince(before)).toEqual([]);
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
    expect(googleRow()).toEqual(loginBefore);
  });

  it("pushes the encrypted v2 bundle, reusing the token the exchange stored", async () => {
    const offset = transport.entries().length;
    const push = await api("/api/workspace/google/push", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ passphrase }) });
    expect(push.status).toBe(200);
    // SAFETY: the push receipt shape is pinned by the toMatchObject below.
    const receipt = (await push.json()) as { uploaded: string; counts: { threads: number } };
    expect(receipt.uploaded).toMatch(/^snap-[0-9a-f]+$/);
    expect(receipt.counts.threads).toBeGreaterThanOrEqual(1);
    // Token continuity: the callback persisted a fresh access token with its
    // expiry, so push reuses it — a single immutable snapshot upload, no list.
    expect(operationsSince(offset)).toEqual(["upload"]);
    expect(transport.entries().slice(offset).every((entry) => entry.credentialsMatch)).toBe(true);

    const uploaded = readFileSync(join(rootDirectory, "google", "snapshots", `${receipt.uploaded}.payload`), "utf8");
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
      db.prepare("UPDATE drive_grants SET expiresAt = 1 WHERE userId = ?").run(userId);
    } finally { db.close(); }
    const offset = transport.entries().length;
    const push = await api("/api/workspace/google/push", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ passphrase }) });
    expect(push.status).toBe(200);
    expect(operationsSince(offset)).toEqual(["refresh", "upload"]);
    const expiry = driveRow().expiresAt;
    expect(googleRow()).toEqual(loginBefore);
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
  it("does not stage a download after its requesting session is revoked", async () => {
    const signin = await api("/api/auth/sign-in/email", { method: "POST", headers: { "content-type": "application/json", origin: url }, body: JSON.stringify({ email, password }) });
    expect(signin.status).toBe(200); await signin.arrayBuffer();
    const temporary = signin.headers.getSetCookie().find(value => value.startsWith("better-auth.session_token="))?.split(";")[0] ?? "";
    expect(temporary).not.toBe("");
    const staged = join(`${dataDirectory}.restore-staging`, "memory", "canary.md");
    // Distinguish the existing staging tree from the downloaded payload:
    // a forbidden restage would otherwise write identical bytes unnoticed.
    writeFileSync(staged, "existing-staging-must-survive-revoked-download", { mode: 0o600 });
    const before = readFileSync(staged, "utf8");
    transport.setMode("hold-download");
    const pulling = api("/api/workspace/google/pull", { method: "POST", headers: { "content-type": "application/json", cookie: temporary }, body: JSON.stringify({ passphrase }) });
    try {
      await expect.poll(() => existsSync(transport.heldDownloadPath), { timeout: 5000 }).toBe(true);
      const signout = await api("/api/auth/sign-out", { method: "POST", headers: { "content-type": "application/json", origin: url, cookie: temporary }, body: "{}" });
      expect(signout.status).toBe(200); await signout.arrayBuffer();
    } finally { transport.setMode("ok"); }
    const response = await pulling;
    expect(response.status).toBe(502); await response.arrayBuffer();
    expect(readFileSync(staged, "utf8")).toBe(before);
  });

  it("binds consent to the exact browser session, not just the account", async () => {
    const { state } = await consent();
    const signin = await api("/api/auth/sign-in/email", { method: "POST", headers: { "content-type": "application/json", origin: url }, body: JSON.stringify({ email, password }) });
    expect(signin.status).toBe(200); await signin.arrayBuffer();
    const second = signin.headers.getSetCookie().find(value => value.startsWith("better-auth.session_token="))?.split(";")[0] ?? "";
    expect(second).not.toBe(""); expect(second).not.toBe(cookie);
    const before = transport.entries().length;
    await expectRedirect(`/api/workspace/google/callback?code=wrong-session&state=${encodeURIComponent(state)}`, second);
    expect(operationsSince(before)).toEqual([]);
    await expectRedirect(`/api/workspace/google/callback?code=correct-session&state=${encodeURIComponent(state)}`, cookie);
    expect(driveRow().googleSub).toBe(transport.googleSubject);
    expect(googleRow()).toEqual(loginBefore);
  });

  it.each([
    { googleSub: "different-google-subject" },
    { scope: "openid https://www.googleapis.com/auth/calendar.readonly" },
  ])("rejects verified but unauthorized Google consent %j", async patch => {
    const { state } = await consent(patch);
    await expectRedirect(`/api/workspace/google/callback?code=invalid-grant&state=${encodeURIComponent(state)}`, cookie);
    const status = await api("/api/workspace/google/status", { headers: { cookie } });
    expect(await status.json()).toMatchObject({ accountDrive: { connected: false } });
    expect(googleRow()).toEqual(loginBefore);
  });

  it("does not restore a revoked grant when an in-flight exchange finishes", async () => {
    const { state } = await consent();
    transport.setMode("hold-exchange");
    const callback = expectRedirect(`/api/workspace/google/callback?code=held&state=${encodeURIComponent(state)}`, cookie);
    try {
      await expect.poll(() => existsSync(transport.heldExchangePath), { timeout: 5000 }).toBe(true);
      const db = new DatabaseSync(join(dataDirectory, "auth.db"));
      try { disconnectDrive(db, userId); } finally { db.close(); }
    } finally { transport.setMode("ok"); }
    await callback;
    const status = await api("/api/workspace/google/status", { headers: { cookie } });
    expect(await status.json()).toMatchObject({ accountDrive: { connected: false } });
    expect(googleRow()).toEqual(loginBefore);
  });

});
