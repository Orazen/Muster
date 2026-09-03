/**
 * Real-browser E2E for the approval-card loop — the OpenMausBot headline
 * UX this product inherited, pinned at the DOM level: a bot that wants to
 * run a shell command must (1) stop with an approval card, (2) accept the
 * composer's Allow decision, and (3) finish the turn afterward.
 *
 * Topology: ONE harness server with an instance riding the fake ACP CLI in
 * `permission` mode (asks for echo hi, completes once answered). The user
 * creates a bot on that instance through the real UI, sends a message, and
 * the card must appear; clicking "Allow once" must resolve it.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { expect, test as baseTest, type Page } from "@playwright/test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_TS = join(ROOT, "server", "index.ts");
const FAKE_CLI = join(ROOT, "server", "testing", "fake-acp-cli.ts");
const PORT = 8951;
const BASE = `http://127.0.0.1:${PORT}`;

let home: string;
let server: ChildProcess | null = null;
let sessionCookie = "";
const consoleErrors: string[] = [];

async function waitHealthy(): Promise<void> {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("harness never became healthy");
}

/** Boot the harness with one instance on the fake ACP CLI (permission
 * mode), then create + sign in the desktop user. Kept in a plain async
 * helper so the extended `test` can be hoisted above its use. */
async function bootHarness(): Promise<void> {
  home = mkdtempSync(join(tmpdir(), "muster-approval-e2e-"));
  const dataDir = join(home, ".muster");
  mkdirSync(dataDir, { recursive: true });
  chmodSync(FAKE_CLI, 0o755);
  // Preseed config.json BEFORE boot: one instance on the fake ACP CLI in
  // permission mode. The comms suite proves this exact wiring server-side;
  // here it is the engine a real browser session will drive.
  writeFileSync(
    join(dataDir, "config.json"),
    JSON.stringify({
      instances: {
        grok: {
          driver: "grokAgent",
          environment: { FAKE_ACP_MODE: "permission" },
          config: { cli: FAKE_CLI, fullAuto: false },
        },
      },
    }),
  );
  server = spawn(process.execPath, ["--experimental-strip-types", SERVER_TS], {
    cwd: ROOT,
    env: {
      ...process.env,
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      OMB_PORT: String(PORT),
      OMB_DATA_DIR: dataDir,
      OMB_STATIC_DIR: join(ROOT, "dist"),
      OMB_DESKTOP_APP: "true",
      BETTER_AUTH_SECRET: "e2e-approval-secret-not-a-production-value",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr?.on("data", (d) => {
    const line = String(d);
    if (/error|Error/i.test(line)) consoleErrors.push(`[srv] ${line.trimEnd().slice(0, 200)}`);
  });
  await waitHealthy();

  const signup = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email: "approval-e2e@e2e.example.com", password: "approval-e2e-password-123", name: "Approval E2E" }),
  });
  if (!signup.ok) throw new Error(`sign-up failed: ${signup.status}`);
  const signin = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email: "approval-e2e@e2e.example.com", password: "approval-e2e-password-123" }),
  });
  if (!signin.ok) throw new Error(`sign-in failed: ${signin.status}`);
  const raw = signin.headers.getSetCookie().find((c) => c.startsWith("better-auth.session_token="));
  if (!raw) throw new Error("no session cookie");
  const pair = raw.split(";")[0]!;
  const eq = pair.indexOf("=");
  sessionCookie = `${pair.slice(0, eq)}=${pair.slice(eq + 1)}`;
}

const test = baseTest.extend<{ appPage: Page }>({
  appPage: async ({ browser }, use) => {
    const ctx = await browser.newContext();
    const [name, value] = sessionCookie.split("=");
    await ctx.addCookies([{ name: name!, value: value!, domain: "127.0.0.1", path: "/" }]);
    const page = await ctx.newPage();
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(`[browser] ${m.text().slice(0, 200)}`);
    });
    await page.goto(`${BASE}/app`);
    await use(page);
    await ctx.close();
  },
});
export { test, expect };

test.beforeAll(async () => {
  await bootHarness();
});

test.afterAll(async () => {
  server?.kill();
  rmSync(home, { recursive: true, force: true });
});

/** Dismiss the full-screen onboarding wizard (mounts once the store
 * connects; racing it from Playwright loses — see the pairing spec). */
async function dismissOnboarding(page: Page): Promise<void> {
  for (let round = 0; round < 4; round++) {
    const appeared = await page
      .waitForSelector(".fixed.inset-0.z-50 button", { timeout: 8_000 })
      .then(() => true)
      .catch(() => false);
    if (!appeared) break;
    await page.waitForFunction(
      () => {
        const overlay = document.querySelector(".fixed.inset-0.z-50");
        if (!overlay) return true;
        const buttons = overlay.querySelectorAll<HTMLElement>("button");
        const skip = [...buttons].find(
          (b) => /maybe later|skip/i.test(b.textContent ?? "") && b.offsetParent !== null,
        );
        skip?.click();
        return false;
      },
      undefined,
      { timeout: 20_000, polling: 300 },
    );
    await page.waitForTimeout(2_500);
  }
  await expect(page.locator(".fixed.inset-0.z-50")).toHaveCount(0, { timeout: 10_000 });
}

test.describe("approval cards (the OpenMausBot inheritance, pinned)", () => {
  test("a tool-hungry bot stops at a card and Allow resolves the turn", async ({ appPage }) => {
    const page = appPage;
    await dismissOnboarding(page);

    // The fresh roster's two seeded bots ride the preseeded `grok`
    // instance already (it is the only engine the config carries). Their
    // names are randomized from a pool (server/names.ts), so the sidebar
    // locator targets structure: the two member buttons under the roster,
    // minus the fixed workspace controls.
    const rosterButtons = page
      .locator("aside button[aria-label], nav.os-dock button, .os-dock-item")
      .filter({ hasText: /Rename |Archive / });
    void rosterButtons;
    const firstBot = page.getByRole("button", { name: /^Rename / }).first();
    await expect(firstBot).toBeVisible({ timeout: 15_000 });
    await firstBot.click();

    // Send the turn. The fake CLI immediately asks permission for `echo hi`.
    await page.getByRole("textbox", { name: /^Message / }).fill("run the thing");
    await page.keyboard.press("Enter");

    // The card MUST appear and the composer must be taken over by the
    // decision panel — this is the beat the whole product hangs on.
    const allow = page.getByRole("button", { name: "Allow once" });
    await expect(allow).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Waiting for your answer below/i).first()).toBeVisible();

    // Allow once → the fake CLI completes → the bot settles idle and the
    // card records the decision. The strongest end-state is the REPLY:
    // the fake ACP CLI's completion text, rendered in the transcript.
    await allow.click();
    await expect(page.getByText(/hello from fake acp/).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Waiting for your answer below/i)).toHaveCount(0);
  });
});
