/** Actual app/server backup capability checks. Only Google transport and the
 * explicitly named status-failure seams are simulated; no successful product
 * write response, session, OAuth grant or portable restore is fabricated. */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test as base, type Locator, type Page, type TestInfo } from "@playwright/test";
import { z } from "zod";
import { pairingServerEnvironment, waitForOwnedServer } from "./pairing-harness.ts";
import { waitForExit } from "../server/testing/cleanup.ts";
import { freePortBlock } from "../server/testing/ports.ts";
import { createWorkspaceDriveFixture } from "../server/testing/workspace-drive-fixture.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const statusPath = "/api/workspace/google/status";
const pushPath = "/api/workspace/drive/push";
const hostedReason = "Workspace backups are available on local desktop installs only for now.";
const canary = "Owned browser workspace memory, never a real user file.";
const shortViewport = { width: 320, height: 568 };
const wideViewport = { width: 1440, height: 900 };
const sessionSchema = z.object({ user: z.object({ id: z.string(), email: z.string() }) });
const pushSchema = z.object({ uploaded: z.literal("owned-workspace-file"), counts: z.object({ memoryFiles: z.number() }).passthrough() });

function deferred() {
  let resolvePromise!: () => void;
  return { promise: new Promise<void>((done) => { resolvePromise = done; }), resolve: () => resolvePromise() };
}

async function portClosed(port: number): Promise<boolean> {
  return new Promise((done, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.setTimeout(1_000);
    socket.once("connect", () => { socket.destroy(); done(false); });
    socket.once("timeout", () => { socket.destroy(); reject(new Error(`Port ${port} observation timed out`)); });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === "ECONNREFUSED") done(true); else reject(error);
    });
  });
}

interface OwnedFixture {
  url: string;
  directory: string;
  email: string;
  password: string;
  drive: ReturnType<typeof createWorkspaceDriveFixture>;
}
type StatusResponse = "actual" | "error" | "malformed";
interface StatusSeam {
  response: StatusResponse;
  held: boolean;
  entered: ReturnType<typeof deferred>;
  release: ReturnType<typeof deferred>;
  finished: ReturnType<typeof deferred>;
  used: boolean;
}
interface GuardedPage {
  page: Page;
  writes: string[];
  statusRequests: string[];
  expectResourceError(path: string, status: number): void;
  statusSeam(response: StatusResponse, held?: boolean): StatusSeam;
}

const test = base.extend<{ deployment: "local" | "hosted"; fixture: OwnedFixture; guarded: GuardedPage }>({
  deployment: ["local", { option: true }],
  fixture: async ({ deployment }, use, testInfo) => {
    await access(join(ROOT, "dist", "index.html"));
    const directory = await mkdtemp(join(tmpdir(), "muster-workspace-browser-"));
    const home = join(directory, "home"), dataDirectory = join(directory, "data"), companionDirectory = join(directory, "companion");
    const drive = createWorkspaceDriveFixture(join(directory, "synthetic-drive"));
    const ports: number[] = [];
    let child: ChildProcess | undefined;
    let output = "";
    let stopping = false;
    let childFailure: string | null = null;
    try {
      for (const path of [home, dataDirectory, companionDirectory, join(dataDirectory, "memory")]) {
        await mkdir(path, { recursive: true, mode: 0o700 });
      }
      await writeFile(join(dataDirectory, "memory", "owned-browser.md"), canary, { mode: 0o600 });
      await writeFile(join(dataDirectory, "config.json"), JSON.stringify({
        instances: { ghost: { driver: "not-a-real-driver", displayName: "Offline browser fixture" } },
        driveSync: { refreshToken: drive.refreshToken },
      }), { mode: 0o600 });
      const port = await freePortBlock([0, 1], 42_000, 8_000);
      ports.push(port, port + 1);
      const url = `http://127.0.0.1:${port}`;
      const env = pairingServerEnvironment({ home, dataDirectory, companionDirectory, staticDir: join(ROOT, "dist"),
        port, webhookPort: port + 1, secret: randomBytes(32).toString("hex") });
      Object.assign(env, drive.env);
      if (deployment === "hosted") env.OMB_PUBLIC_HOST = `127.0.0.1:${port}`;
      child = spawn(process.execPath, ["--import", drive.preloadPath, "--experimental-strip-types", join(ROOT, "server/index.ts")], {
        cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"],
      });
      const append = (chunk: Buffer | string) => { output = (output + String(chunk)).slice(-32_768); };
      child.stdout?.on("data", append);
      child.stderr?.on("data", append);
      child.on("error", (error) => { childFailure = error.message; });
      child.on("exit", (code, signal) => { if (!stopping) childFailure = `Server exited before cleanup: ${signal ?? code}`; });
      await waitForOwnedServer(child, url);
      const email = `backup-${randomBytes(10).toString("hex")}@example.test`;
      const password = randomBytes(32).toString("base64url");
      const signup = await fetch(`${url}/api/auth/sign-up/email`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
        headers: { "content-type": "application/json", origin: url },
        body: JSON.stringify({ name: "Owned backup browser", email, password }),
      });
      expect(signup.status).toBe(200);
      sessionSchema.parse(await signup.json());
      if (deployment === "hosted") {
        // Storage sovereignty (decision 14): a hosted user's workspace opens
        // only behind their own Drive connection. These specs exercise the
        // backup surfaces as an EXISTING connected user, so seed the token row
        // the real consent flow would have written — with the fixture's
        // refresh token, so transport credential checks stay exact.
        const db = new DatabaseSync(join(dataDirectory, "auth.db"));
        try {
          // SAFETY: better-auth schema: user.id TEXT PRIMARY KEY, read by email.
          const user = db.prepare(`SELECT "id" FROM "user" WHERE "email" = ?`).get(email) as { id: string };
          const now = new Date().toISOString();
          db.prepare(`INSERT INTO account (id,accountId,providerId,userId,accessToken,refreshToken,scope,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)`)
            .run(randomBytes(16).toString("hex"), randomBytes(16).toString("hex"), "google", user.id, null, drive.refreshToken, "", now, now);
        } finally { db.close(); }
      }
      await use({ url, directory, email, password, drive });
    } finally {
      stopping = true;
      await waitForExit(child, { signal: "SIGTERM" });
      const exited = !child || child.exitCode !== null || child.signalCode !== null;
      const closedPorts = await Promise.all(ports.map(portClosed));
      const noOutbound = !existsSync(drive.networkLog);
      const noHeldDownload = !existsSync(drive.heldDownloadPath);
      const journal = drive.entries();
      const payload = existsSync(drive.payloadPath) ? readFileSync(drive.payloadPath) : null;
      // Receipt omits synthetic credentials, passphrases and encrypted bytes.
      await testInfo.attach("owned-drive-evidence", { contentType: "application/json", body: JSON.stringify({
        deployment, directory, pid: child?.pid, ports, exited, closedPorts, noOutbound, noHeldDownload, childFailure,
        journal, payload: payload ? { bytes: payload.byteLength, sha256: createHash("sha256").update(payload).digest("hex") } : null,
      }, null, 2) });
      await testInfo.attach("owned-server-log", { contentType: "text/plain", body: output });
      if (exited && closedPorts.every(Boolean)) await rm(directory, { recursive: true, force: true });
      const rootRemoved = !existsSync(directory);
      console.info(JSON.stringify({ scope: "workspace browser cleanup", pid: child?.pid, ports, exited, closedPorts, noOutbound, noHeldDownload, rootRemoved }));
      expect({ exited, closedPorts, noOutbound, noHeldDownload, rootRemoved, childFailure })
        .toEqual({ exited: true, closedPorts: ports.map(() => true), noOutbound: true, noHeldDownload: true, rootRemoved: true, childFailure: null });
    }
  },
  guarded: async ({ browser, fixture }, use, testInfo) => {
    const context = await browser.newContext({ serviceWorkers: "block", viewport: wideViewport });
    const errors: string[] = [];
    const resourceErrors: { url: string; status: number; seen: number }[] = [];
    const seams: StatusSeam[] = [];
    const writes: string[] = [], statusRequests: string[] = [];
    let shuttingDown = false;
    const expectResourceError = (path: string, status: number) => resourceErrors.push({ url: fixture.url + path, status, seen: 0 });
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== fixture.url) {
        // The consent redirect must complete without leaving the machine: a
        // stub page stands in for Google's consent screen. Any other origin
        // is an unexpected browser request.
        if (url.origin.endsWith("accounts.google.com")) {
          await route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Owned consent stub</title>" });
        } else {
          errors.push(`Unexpected browser request: ${url.origin}${url.pathname}`);
          await route.abort("blockedbyclient");
        }
        return;
      }
      if (url.pathname === statusPath && !url.search && request.method() === "GET") {
        statusRequests.push(url.href);
        const seam = seams.find((item) => !item.used);
        if (seam) {
          seam.used = true;
          // Only "actual" fetches the actual current server capability. A
          // held response proves retirement, not a fabricated stale account.
          const actual = seam.response === "actual" ? await route.fetch({ maxRedirects: 0 }) : null;
          seam.entered.resolve();
          try {
            if (seam.held) await seam.release.promise;
            if (actual) await route.fulfill({ response: actual });
            else await route.fulfill({ status: seam.response === "error" ? 503 : 200, contentType: "application/json",
              body: JSON.stringify(seam.response === "error" ? { error: "Owned fixture backup status unavailable" } : { drive: true }) });
          } catch (error) {
            if (!shuttingDown) errors.push(`Status seam failed: ${String(error)}`);
          } finally { seam.finished.resolve(); }
          return;
        }
      }
      await route.continue();
    });
    const page = await context.newPage();
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.origin === fixture.url && url.pathname.startsWith("/api/workspace/") && request.method() !== "GET") {
        writes.push(`${request.method()} ${url.pathname}`);
      }
      if (url.origin === fixture.url && url.pathname === "/api/workspace/google/connect") writes.push(`GET ${url.pathname}`);
    });
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const budget = resourceErrors.find((entry) => entry.seen === 0 && message.location().url === entry.url
        && new RegExp(`^Failed to load resource:.*\\b${entry.status}\\b`).test(message.text()));
      if (budget) { budget.seen += 1; return; }
      errors.push(`${message.location().url}: ${message.text()}`);
    });
    const statusSeam = (response: StatusResponse, held = false) => {
      const seam = { response, held, entered: deferred(), release: deferred(), finished: deferred(), used: false };
      seams.push(seam);
      if (response === "error") expectResourceError(statusPath, 503);
      return seam;
    };
    try {
      await use({ page, writes, statusRequests, expectResourceError, statusSeam });
      expect(seams.map((seam) => seam.used), "Every explicitly requested status seam was exercised").toEqual(seams.map(() => true));
      expect(resourceErrors.map((entry) => entry.seen), "Consume exactly one pinned HTTP resource error per expected failure")
        .toEqual(resourceErrors.map(() => 1));
      expect(errors, "Unexpected page errors, resource failures or external requests").toEqual([]);
    } finally {
      shuttingDown = true;
      for (const seam of seams) seam.release.resolve();
      await context.close();
      await testInfo.attach("browser-boundary", { contentType: "application/json", body: JSON.stringify({ errors, resourceErrors,
        writes, statusRequests, seams: seams.map(({ response, held, used }) => ({ response, held, used })) }, null, 2) });
    }
  },
});

function backup(page: Page): Locator { return page.getByRole("region", { name: "Workspace backup", exact: true }); }

async function signIn(page: Page, fixture: OwnedFixture) {
  await page.goto(`${fixture.url}/sign-in`);
  await page.getByLabel("Email address", { exact: true }).fill(fixture.email);
  await page.getByLabel("Password", { exact: true }).fill(fixture.password);
  await page.getByRole("button", { name: "Sign in with email", exact: true }).click();
  await expect(page).toHaveURL(`${fixture.url}/app`);
  const session = await page.context().request.get(`${fixture.url}/api/auth/get-session`, { maxRedirects: 0 });
  expect(session.status()).toBe(200);
  expect(sessionSchema.parse(await session.json()).user.email).toBe(fixture.email);
  // Desktop first-run mounts the classic wizard; a hosted first-run mounts
  // the conversational onboarding instead. These specs exercise an EXISTING
  // user, so dismiss whichever mounted — and loop: marking the chat done
  // makes the wizard eligible on a no-bot account, so settle only when no
  // first-run surface remains.
  const wizard = page.getByRole("region", { name: "Set up Muster", exact: true });
  const chat = page.getByRole("region", { name: "Set up Muster with your assistant", exact: true });
  for (let round = 0; round < 4; round += 1) {
    // The first-run decision is async (SSE connect, then a server gate round
    // trip), so a single count races the mount: on a cold fixture the surface
    // can appear AFTER the check and the closing assertion fails. Wait for a
    // surface inside each round; no surface within the window means the app
    // has settled with none.
    const surfaced = await wizard.or(chat).first()
      .waitFor({ state: "visible", timeout: 2_500 })
      .then(() => true, () => false);
    if (!surfaced) break;
    if (await wizard.count()) {
      await page.keyboard.press("Escape");
      await expect(wizard).toHaveCount(0);
      break;
    }
    await page.evaluate(() => {
      localStorage.setItem("muster.onboarding-chat.done", "1");
      localStorage.setItem("muster.team-templates.dismissed", "1");
    });
    await page.reload();
    await expect(page).toHaveURL(`${fixture.url}/app`);
  }
  await expect(wizard).toHaveCount(0);
}

async function openBackup(page: Page) {
  // Open the real Settings surface before reducing the viewport; mobile
  // assertions below exercise the actual responsive component and controls.
  await page.setViewportSize(wideViewport);
  await page.getByRole("button", { name: "App settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await settings.getByRole("button", { name: "Connections", exact: true }).click();
  await expect(backup(page)).toBeVisible();
}

async function allWritesDisabled(page: Page) {
  const card = backup(page);
  for (const label of ["Export file", "Back up to Drive", "Restore from Drive", "Back up to Telegram", "Restore from Telegram", "Connect Telegram…"]) {
    await expect(card.getByRole("button", { name: label, exact: true })).toBeDisabled();
  }
  await expect(card.getByLabel("Restore from file", { exact: true })).toBeDisabled();
  await expect(card.getByLabel("Backup passphrase", { exact: true })).toBeDisabled();
  await expect(card.getByRole("link", { name: /Connect.*Drive/ })).toHaveCount(0);
}

async function visibleBounds(locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  await expect(locator).toBeVisible();
  const bounds = await locator.evaluate((node) => {
    const r = node.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: innerWidth, height: innerHeight,
      documentWidth: document.documentElement.scrollWidth, uncovered: hit === node || (hit !== null && node.contains(hit)) };
  });
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(bounds.width + 1);
  expect(bounds.top).toBeGreaterThanOrEqual(0);
  expect(bounds.bottom).toBeLessThanOrEqual(bounds.height + 1);
  expect(bounds.documentWidth).toBeLessThanOrEqual(bounds.width + 1);
  expect(bounds.uncovered).toBe(true);
}

async function capture(page: Page, testInfo: TestInfo, label: string, target: Locator) {
  for (const viewport of [shortViewport, wideViewport]) {
    await page.setViewportSize(viewport);
    await visibleBounds(target);
    const card = backup(page);
    const horizontal = await card.evaluate((node) => ({ left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right, width: innerWidth }));
    expect(horizontal.left).toBeGreaterThanOrEqual(0);
    expect(horizontal.right).toBeLessThanOrEqual(horizontal.width + 1);
    await page.screenshot({ path: testInfo.outputPath(`${label}-${viewport.width}.png`) });
  }
}

test.describe("hosted workspace capability", () => {
  test.use({ deployment: "hosted" });
  test("offers the user's own Drive connect while the installation bundles stay desktop-only", async ({ fixture, guarded }, testInfo) => {
    const { page } = guarded;
    await signIn(page, fixture);
    await page.setViewportSize(shortViewport);
    const response = page.waitForResponse((r) => r.url() === fixture.url + statusPath && r.request().method() === "GET");
    await openBackup(page);
    const status = await response;
    expect(status.status()).toBe(200);
    // Storage sovereignty (decision 14): a hosted session may connect its OWN
    // Drive — the connect is account-scoped and moves no workspace data. The
    // installation bundles and transports stay desktop-only behind the wall.
    expect(await status.json()).toEqual({ capabilityVersion: 1, workspaceBackupAvailable: false, unavailableReason: hostedReason, drive: false,
      installationDrive: { configured: false, operationsAvailable: false }, accountDrive: { available: true, connected: true } });
    await allWritesDisabled(page);
    await expect(backup(page)).not.toContainText("Last backed up");
    await capture(page, testInfo, "hosted-local-only", backup(page).getByText(hostedReason, { exact: true }));
    expect(guarded.writes).toEqual([]);
    expect(fixture.drive.entries()).toEqual([]);
  });
});

test("connect my Google Drive issues a consent redirect from a real button click", async ({ fixture, guarded }) => {
  const { page } = guarded;
  await signIn(page, fixture);
  // The connect affordance renders only for a signed-in user with a Google
  // login row that has no Drive grant yet. The hosted fixture seeds the row
  // CONNECTED (the storage-sovereignty default for existing users), so reach
  // the no-grant shape by revoking the grant through the real database; the
  // fixture client pair satisfies the route's configured-OAuth guard.
  const db = new DatabaseSync(join(fixture.directory, "data", "auth.db"));
  try {
    // SAFETY: auth schema creates user.id as TEXT PRIMARY KEY; seeded via real sign-up above.
    const user = db.prepare(`SELECT "id" FROM "user" WHERE "email" = ?`).get(fixture.email) as { id: string };
    db.prepare(`UPDATE "account" SET "accessToken" = NULL, "refreshToken" = NULL WHERE "userId" = ? AND "providerId" = 'google'`).run(user.id);
  } finally { db.close(); }

  await openBackup(page);
  const portable = page.getByRole("region", { name: "Full portable backup", exact: true });
  const connect = portable.getByRole("button", { name: "Connect my Google Drive", exact: true });
  await expect(connect).toBeEnabled();
  expect(guarded.writes).toEqual([]);
  const connected = page.waitForResponse((r) => r.url() === fixture.url + "/api/workspace/google/connect" && r.request().method() === "GET");
  const consentPage = page.waitForURL(/accounts\.google\.com\/o\/oauth2/);
  await connect.click();
  expect((await connected).status()).toBe(200);
  await consentPage;
  expect(guarded.writes).toEqual(["GET /api/workspace/google/connect"]);
  expect(fixture.drive.entries()).toEqual([]);
});

test("configured local backup reports transport failure, then explicitly retries the real installation route", async ({ fixture, guarded }, testInfo) => {
  const { page } = guarded;
  await signIn(page, fixture);
  await openBackup(page);
  const card = backup(page), push = card.getByRole("button", { name: "Back up to Drive", exact: true });
  await expect(card.getByText("Drive configured on this computer", { exact: true })).toBeVisible();
  await expect(card.getByText("Google sign-in does not connect desktop backup.", { exact: true })).toBeVisible();
  await expect(card.getByRole("link", { name: /Connect.*Drive/ })).toHaveCount(0);
  await card.getByLabel("Backup passphrase", { exact: true }).fill("Owned browser backup passphrase");
  expect(guarded.writes).toEqual([]);
  expect(fixture.drive.entries()).toEqual([]);
  fixture.drive.setMode("upload-error");
  guarded.expectResourceError(pushPath, 502);
  const failed = page.waitForResponse((r) => r.url() === fixture.url + pushPath && r.request().method() === "POST");
  await push.click();
  expect((await failed).status()).toBe(502);
  await expect(card.getByRole("alert")).toContainText(/upload.*failed|fixture upload refused/i);
  expect(guarded.writes).toEqual([`POST ${pushPath}`]);
  expect(fixture.drive.entries()).toEqual(["refresh", "list", "upload"].map((operation) => ({ operation, mode: "upload-error", credentialsMatch: true })));
  expect(existsSync(fixture.drive.payloadPath)).toBe(false);
  await capture(page, testInfo, "local-drive-error", card.getByRole("alert"));
  await page.setViewportSize(shortViewport);
  await visibleBounds(push);
  await push.click({ trial: true });
  await page.screenshot({ path: testInfo.outputPath("local-drive-retry-320.png") });
  fixture.drive.setMode("ok");
  const accepted = page.waitForResponse((r) => r.url() === fixture.url + pushPath && r.request().method() === "POST");
  await push.click();
  const result = await accepted;
  expect(result.status()).toBe(200);
  const receipt = pushSchema.parse(await result.json());
  expect(receipt.counts.memoryFiles).toBeGreaterThanOrEqual(1);
  await expect(card).toContainText(/Backup saved/);
  expect(guarded.writes).toEqual([`POST ${pushPath}`, `POST ${pushPath}`]);
  expect(fixture.drive.entries()).toEqual(["upload-error", "ok"].flatMap((mode) => ["refresh", "list", "upload"].map((operation) => ({ operation, mode, credentialsMatch: true }))));
  const payload = readFileSync(fixture.drive.payloadPath, "utf8");
  expect(payload).toMatch(/^muster-workspace-bundle:1:/);
  expect(payload).not.toContain(canary);
  expect(payload).not.toContain("Owned browser backup passphrase");
  await capture(page, testInfo, "local-drive-saved", push);
  await testInfo.attach("actual-drive-receipt", { contentType: "application/json", body: JSON.stringify(receipt) });
});

test("loading, failed and malformed status never enable writes before an explicit checked retry", async ({ fixture, guarded }, testInfo) => {
  const { page } = guarded;
  await signIn(page, fixture);
  const held = guarded.statusSeam("error", true);
  await openBackup(page);
  await held.entered.promise;
  await expect(backup(page).getByText("Checking backup availability…", { exact: true })).toBeVisible();
  await allWritesDisabled(page);
  held.release.resolve();
  await held.finished.promise;
  const retry = backup(page).getByRole("button", { name: "Retry backup status", exact: true });
  await expect(backup(page).getByRole("alert")).toBeVisible();
  await allWritesDisabled(page);
  await capture(page, testInfo, "status-unavailable", retry);
  const malformed = guarded.statusSeam("malformed");
  await retry.click();
  await malformed.finished.promise;
  await expect(backup(page).getByRole("alert")).toBeVisible();
  await allWritesDisabled(page);
  const actual = page.waitForResponse((r) => r.url() === fixture.url + statusPath && r.status() === 200);
  await retry.click();
  expect((await actual).status()).toBe(200);
  await expect(backup(page).getByText("Drive configured on this computer", { exact: true })).toBeVisible();
  await expect(backup(page).getByRole("button", { name: "Back up to Drive", exact: true })).toBeEnabled();
  // Two capability consumers mount on this tab (the sync card and the backup
  // card each check /api/workspace/google/status); three status rounds
  // measure 5 capability fetches here.
  expect(guarded.statusRequests).toHaveLength(5);
  expect(guarded.writes).toEqual([]);
  expect(fixture.drive.entries()).toEqual([]);
});

test("a status result from closed Settings cannot replace the reopened card's current failure", async ({ fixture, guarded }, testInfo) => {
  const { page } = guarded;
  await signIn(page, fixture);
  const old = guarded.statusSeam("actual", true);
  await openBackup(page);
  await old.entered.promise;
  await expect(backup(page).getByText("Checking backup availability…", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  await expect(backup(page)).toHaveCount(0);
  const current = guarded.statusSeam("error");
  await openBackup(page);
  await current.finished.promise;
  await expect(backup(page).getByRole("alert")).toBeVisible();
  old.release.resolve();
  await old.finished.promise;
  await allWritesDisabled(page);
  await expect(backup(page).getByRole("alert")).toBeVisible();
  await capture(page, testInfo, "retired-status-current-error", backup(page).getByRole("alert"));
  await backup(page).getByRole("button", { name: "Retry backup status", exact: true }).click();
  await expect(backup(page).getByText("Drive configured on this computer", { exact: true })).toBeVisible();
  // Two capability consumers on this tab; two card mounts + one retry
  // click = 3 rounds × 2 consumers = 6.
  expect(guarded.statusRequests).toHaveLength(6);
  expect(guarded.writes).toEqual([]);
  expect(fixture.drive.entries()).toEqual([]);
});
