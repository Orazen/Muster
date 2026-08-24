/**
 * Real-browser E2E for the desktop↔cloud pairing flow, modeled on gstack's
 * /qa loop: spawn the real servers, drive a real Chromium, collect console
 * errors, screenshot failures.
 *
 * Topology:
 *   cloud   (port CLOUD_PORT)   — standalone muster; email sign-up allowed;
 *                                 this is where /pair lives and codes are born
 *   desktop (port DESKTOP_PORT) — OMB_PAIR_CLOUD_URL points at the cloud
 *                                 instance, exactly like the shipped app's
 *                                 relay; its login page redeems chip codes
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { expect, test as baseTest, type Page } from "@playwright/test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_TS = join(ROOT, "server", "index.ts");
const CLOUD_PORT = 8931;
const DESKTOP_PORT = 8941;
const CLOUD = `http://127.0.0.1:${CLOUD_PORT}`;
const DESKTOP = `http://127.0.0.1:${DESKTOP_PORT}`;

let home: string;
let cloudProc: ChildProcess | null = null;
let desktopProc: ChildProcess | null = null;

const consoleErrors: string[] = [];

function spawnServer(port: number, dataDir: string, extraEnv: Record<string, string>): ChildProcess {
  const child = spawn(process.execPath, ["--experimental-strip-types", SERVER_TS], {
    cwd: ROOT,
    env: {
      ...process.env,
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      OMB_PORT: String(port),
      OMB_DATA_DIR: dataDir,
      BETTER_AUTH_SECRET: "e2e-fixed-secret-not-a-production-value",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (d) => {
    const line = String(d);
    if (/error|Error/i.test(line)) consoleErrors.push(`[srv${port}] ${line.trimEnd().slice(0, 200)}`);
  });
  return child;
}

async function waitHealthy(base: string): Promise<void> {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) {
        // SAFETY: /api/health is this repo's own endpoint; it replies {app:"muster"}.
        const body = (await res.json()) as { app?: string };
        if (body.app === "muster") return;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server at ${base} never became healthy`);
}

/** Sign up + sign in on the cloud instance; hand back the session cookie
 * string so Playwright can inject it into a browser context. */
async function cloudSessionCookie(email: string): Promise<string> {
  const signup = await fetch(`${CLOUD}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: CLOUD },
    body: JSON.stringify({ email, password: "e2e-pairing-pass-123", name: "E2E Owner" }),
  });
  const upBody = await signup.text();
  if (!signup.ok && !upBody.includes("USER_ALREADY_EXISTS")) {
    throw new Error(`sign-up failed: ${signup.status} ${upBody.slice(0, 300)}`);
  }
  const signin = await fetch(`${CLOUD}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: CLOUD },
    body: JSON.stringify({ email, password: "e2e-pairing-pass-123" }),
  });
  if (!signin.ok) throw new Error(`sign-in failed: ${signin.status}`);
  const raw = signin.headers.getSetCookie().find((c) => c.startsWith("better-auth.session_token="));
  if (!raw) throw new Error("no session cookie on sign-in response");
  const pair = raw.split(";")[0]!;
  const eq = pair.indexOf("=");
  return `${pair.slice(0, eq)}=${pair.slice(eq + 1)}`;
}

const test = baseTest.extend<{ pairCodeFromCloud: string }>({
  // The chip code is read from the network layer, not the DOM text — the DOM
  // may lag or re-render, but the create response IS what the server knows.
  pairCodeFromCloud: async ({ browser }, use) => {
    const ctxB = await browser.newContext();
    const cookie = await cloudSessionCookie(`owner-${Date.now()}@e2e.test`);
    const [name, value] = cookie.split("=");
    await ctxB.addCookies([{ name: name!, value: value!, domain: "127.0.0.1", path: "/" }]);
    const pageB = await ctxB.newPage();
    let code = "";
    pageB.on("response", async (res) => {
      if (res.url().includes("/api/pair/create")) {
        // SAFETY: /api/pair/create is this repo's own endpoint; it replies {code}.
        const body = (await res.json().catch(() => null)) as { code?: string } | null;
        if (body?.code) code = body.code;
      }
    });
    await pageB.goto(`${CLOUD}/pair`);
    await expect.poll(() => code, { timeout: 20_000 }).not.toBe("");
    await use(code);
    await ctxB.close();
  },
});
export { test, expect };

test.beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "muster-e2e-home-"));
  const cloudData = mkdtempSync(join(tmpdir(), "muster-e2e-cloud-"));
  const desktopData = mkdtempSync(join(tmpdir(), "muster-e2e-desktop-"));
  mkdirSync(home, { recursive: true });
  // The emergency signups-closed stopgap guards SHARED deployments; the
  // e2e cloud is a throwaway sandbox, so reopen it explicitly.
  const uiDir = join(ROOT, "dist");
  cloudProc = spawnServer(CLOUD_PORT, cloudData, {
    OMB_ALLOW_SIGNUPS: "true",
    OMB_STATIC_DIR: uiDir,
  });
  desktopProc = spawnServer(DESKTOP_PORT, desktopData, {
    OMB_DESKTOP_APP: "true",
    OMB_PAIR_CLOUD_URL: CLOUD,
    OMB_STATIC_DIR: uiDir,
  });
  await waitHealthy(CLOUD);
  await waitHealthy(DESKTOP);
});

test.afterAll(async () => {
  cloudProc?.kill();
  desktopProc?.kill();
  rmSync(home, { recursive: true, force: true });
});

async function watchConsole(page: Page): Promise<void> {
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(`[browser] ${m.text().slice(0, 200)}`);
  });
}

test.describe("desktop ↔ cloud pairing", () => {
  test("login page shows the pairing bridge, not a dead Google button", async ({ browser }) => {
    const ctx = await browser.newContext();
    const pageA = await ctx.newPage();
    await watchConsole(pageA);
    await pageA.goto(DESKTOP);
    await expect(pageA.getByLabel("Pairing code")).toBeVisible();
    await expect(pageA.getByRole("button", { name: /connect/i })).toBeVisible();
    await ctx.close();
  });

  test("a live chip code pairs the desktop into the cloud account", async ({ browser, pairCodeFromCloud }) => {
    const ctx = await browser.newContext();
    const pageA = await ctx.newPage();
    await watchConsole(pageA);
    await pageA.goto(DESKTOP);

    await pageA.getByLabel("Pairing code").fill(pairCodeFromCloud);
    // ONE click. The double-click error-overwrite bug taught us that.
    await pageA.getByRole("button", { name: "Connect" }).click();

    // Success = hard navigation to the app shell with a session cookie set.
    await pageA.waitForURL(/\/app/, { timeout: 20_000 });
    const session = await fetch(`${DESKTOP}/api/auth/get-session`, {
      headers: { cookie: await cookieHeader(ctx) },
    }).then((r) => r.json());
    expect(session?.user?.email).toContain("@e2e.test");
    await ctx.close();
  });

  test("a consumed code fails honestly and never logs anyone in", async ({ browser, pairCodeFromCloud }) => {
    const ctx = await browser.newContext();
    const pageA = await ctx.newPage();
    await watchConsole(pageA);
    await pageA.goto(DESKTOP);
    // The fixture already consumed THIS code? No — fixture mints fresh per
    // test via getOrCreateCode idempotency; burn it once through the API to
    // simulate the second click of an over-eager user.
    await fetch(`${CLOUD}/api/pair/verify?code=${pairCodeFromCloud}`).then((r) => r.json());
    await pageA.getByLabel("Pairing code").fill(pairCodeFromCloud);
    await pageA.getByRole("button", { name: "Connect" }).click();
    await expect(pageA.getByText(/isn't valid/i)).toBeVisible({ timeout: 15_000 });
    await expect(pageA).not.toHaveURL(/\/app/);
    await ctx.close();
  });
});

async function cookieHeader(ctx: import("@playwright/test").BrowserContext): Promise<string> {
  const cookies = await ctx.cookies(DESKTOP);
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}
