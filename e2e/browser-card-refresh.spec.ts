/** Mounted acceptance for the per-bot browser capability card's refresh.
 *
 * Owned single server, owned fixture account, owned data dir, an explicitly
 * probed free port block. Port 8845 and every user session/app are untouched.
 *
 * The point of this spec is the REFRESH, not the endpoint: the old card read
 * /api/browser-status once on mount and never again, so a toggle, an engine
 * change or a completed install left the copy describing a configuration the
 * user had already left behind. Every assertion therefore pairs a real user
 * interaction with the copy it must produce, and the run is additionally
 * bounded by a count of how many status reads actually happened.
 */
import { rmSync, unlinkSync } from "node:fs";
import { test as baseTest, expect, type BrowserContext, type Page } from "@playwright/test";
import { startOwnedFixture, SUPPORTED_ENGINE, TOOL_COUNT, UNSUPPORTED_ENGINE, type BrowserCardFixture } from "./browser-card-harness.ts";

type Counter = { statusReads: number; installPosts: number };
const INSTALL_DECLINED = "Owned fixture: install declined.";

type Owned = { server: BrowserCardFixture; counter: Counter };

const test = baseTest.extend<{ owned: Owned; newPage: () => Promise<Page> }>({
  // Server and counter in one fixture: the counter counts requests against
  // this server, so their lifetimes are the same lifetime.
  // oxlint-disable-next-line eslint/no-empty-pattern -- no fixture dependencies
  owned: async ({}, use) => {
    const server = await startOwnedFixture();
    try {
      await use({ server, counter: { statusReads: 0, installPosts: 0 } });
    } finally {
      if (server.pid) { try { process.kill(server.pid, "SIGKILL"); } catch { /* already gone */ } }
      rmSync(server.root, { recursive: true, force: true });
    }
  },
  newPage: async ({ browser, owned }, use, testInfo) => {
    const { counter, server: fixture } = owned;
    const contexts: BrowserContext[] = [];
    const errors: string[] = [];
    const open = async (): Promise<Page> => {
      const context = await browser.newContext();
      contexts.push(context);
      // The shipped analytics opt-out is set before any app script runs, so
      // this fixture can emit no third-party request at all.
      await context.addInitScript(() => {
        try { localStorage.setItem("muster:analytics-opt-out", "1"); } catch { /* opaque origin */ }
      });
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== fixture.base) {
          errors.push(`Unexpected browser request: ${url.origin}${url.pathname}`);
          await route.abort("blockedbyclient");
          return;
        }
        if (url.pathname === "/api/browser-status" && route.request().method() === "GET") {
          counter.statusReads += 1;
          await route.continue();
          return;
        }
        if (url.pathname === "/api/browser-install" && route.request().method() === "POST") {
          // Answered here, in the one handler that owns the counters: a
          // page-level route would take precedence and the request would never
          // be counted. This spec must not pull a real release archive; the
          // refresh under test happens whether the install succeeds or not.
          counter.installPosts += 1;
          await route.fulfill({ json: { ok: false, error: INSTALL_DECLINED } });
          return;
        }
        await route.continue();
      });
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(`console: ${message.location().url}: ${message.text()}`);
      });
      return page;
    };
    try {
      await use(open);
      if (errors.length) await testInfo.attach("browser-errors", { body: errors.join("\n"), contentType: "text/plain" });
      expect(errors, "Unexpected browser errors or external requests").toEqual([]);
    } finally { await Promise.all(contexts.map((context) => context.close())); }
  },
});

/** The owned fixture account, signed in and landed on the app. */
async function signIn(page: Page, fixture: BrowserCardFixture): Promise<void> {
  await page.goto(`${fixture.base}/sign-up`);
  await page.getByLabel("Your name", { exact: true }).fill("Browser Card Audit");
  await page.getByLabel("Email address", { exact: true }).fill(`browser-card-${Math.random().toString(36).slice(2)}@example.test`);
  await page.getByLabel("Password", { exact: true }).fill(`${Math.random().toString(36).slice(2)}abcdefgh`);
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await page.waitForURL(/\/app/, { timeout: 30_000 });
}

/** Clear the first-run overlays with their own visible controls. They mount
 *  asynchronously after the app shell, so this polls rather than sampling once:
 *  a single early check would leave a transparent overlay swallowing the first
 *  click on the switch, failing the toggle check for the wrong reason. */
async function dismissOverlays(page: Page): Promise<void> {
  const tour = page.getByRole("dialog", { name: "Product tour", exact: true });
  const later = page.getByRole("button", { name: "Maybe later", exact: true });
  const guide = page.getByRole("region", { name: "Set up Muster", exact: true });
  const visible = (l: typeof tour) => l.isVisible().catch(() => false);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (await visible(tour)) { await tour.getByRole("button", { name: "Skip", exact: true }).click(); await expect(tour).toHaveCount(0, { timeout: 15_000 }); continue; }
    if (await visible(later)) { await later.click(); await expect(later).toHaveCount(0, { timeout: 15_000 }); continue; }
    if (await visible(guide)) { await page.keyboard.press("Escape"); await expect(guide).toHaveCount(0, { timeout: 15_000 }); continue; }
    // One settled beat, then a confirming re-check: an overlay that mounts a
    // moment later must not be counted as "already clear".
    await page.waitForTimeout(500);
    if (!(await Promise.all([tour, later, guide].map(visible))).some(Boolean)) return;
  }
  throw new Error("first-run overlays never cleared");
}

/** Create the bot under test, pinned to the named engine. The server assigns
 *  its own display name, so the caller uses the name the server reports. */
async function seedBot(page: Page, fixture: BrowserCardFixture, instanceId: string): Promise<{ id: string; name: string }> {
  const created = await page.request.post(`${fixture.base}/api/bots`, { data: { name: "Scout" } });
  expect(created.status()).toBe(201);
  // SAFETY: the 201 assertion above throws first, so the body is the created
  // bot record and both `id` and `name` are present on it.
  const bot = (await created.json()).bot as { id: string; name: string };
  expect(bot.name, "the created bot must have a name to select it by").toBeTruthy();
  const pinned = await page.request.patch(`${fixture.base}/api/bots/${bot.id}`, { data: { modelSelection: { instanceId } } });
  expect(pinned.status()).toBe(200);
  return bot;
}

/** Select the bot under test. A fresh workspace already has greeting bots, so
 *  the card must be opened for a named bot — otherwise the assertions below
 *  would quietly run against whichever bot the app happened to select.
 *
 *  The sidebar row and the name chip inside it share a "Rename <name>" prefix,
 *  so the row is matched with the trailing description and the confirmation is
 *  read from the conversation header rather than the sidebar. */
async function selectBot(page: Page, name: string): Promise<void> {
  const header = page.locator('header[aria-label="Conversation controls"]');
  await page.getByRole("button", { name: new RegExp(`^Rename ${name} `) }).first().click();
  await expect(header.getByRole("button", { name: `Rename ${name}`, exact: true })).toBeVisible({ timeout: 20_000 });
}

const panel = (page: Page) => page.getByRole("complementary", { name: "Bot settings", exact: true });
const browserSwitch = (page: Page) => page.getByRole("switch", { name: "Web browser for this bot", exact: true });
const readyCopy = (page: Page) => panel(page).getByText(`This bot gets ${TOOL_COUNT} browser tools on its next task`, { exact: false });
const offCopy = (page: Page) => panel(page).getByText("Turn on to let this bot drive a real headless browser", { exact: false });

async function openBotSettings(page: Page): Promise<void> {
  await page.getByTitle("Bot settings", { exact: true }).first().click();
  await expect(panel(page)).toBeVisible();
}

test("the card re-reads status after a toggle, an engine change, rapid panel churn and an install", async ({ newPage, owned }) => {
  // Four real rounds against a real server, two full page loads and a bounded
  // overlay poll: the shared 120s budget is the config default, not a target.
  test.setTimeout(300_000);
  const { counter, server: fixture } = owned;
  const page = await newPage();
  await signIn(page, fixture);
  await dismissOverlays(page);
  const bot = await seedBot(page, fixture, SUPPORTED_ENGINE);
  await page.reload();
  await dismissOverlays(page);
  await selectBot(page, bot.name);

  // ── mount: supporting engine, toggle off, real per-machine copy ─────────
  await openBotSettings(page);
  await expect(panel(page).getByText("Web browser", { exact: true })).toBeVisible();
  await expect(browserSwitch(page)).toHaveAttribute("aria-checked", "false");
  await expect(offCopy(page)).toBeVisible({ timeout: 20_000 });
  await expect(panel(page).getByText("Ready on this machine", { exact: true })).toBeVisible();
  expect(counter.statusReads, "the card must read status on mount").toBeGreaterThan(0);

  // The real endpoint's envelope is what the card must be describing.
  const wire = await (await page.request.get(`${fixture.base}/api/browser-status`)).json();
  expect(wire.tools).toBe(TOOL_COUNT);
  expect(wire.available).toBe(true);
  expect(wire.status.find((row: { id: string }) => row.id === bot.id)).toMatchObject({
    engineId: SUPPORTED_ENGINE, engineSupportsBrowser: true, effective: false, reason: "off", enabled: false,
  });

  // ── 1. toggle off -> on -> off -> on, with no reload anywhere ──────────
  // The old card fetched once on mount, so it would still read OFF here.
  const readsAtMount = counter.statusReads;
  const toggle = browserSwitch(page);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(readyCopy(page)).toBeVisible({ timeout: 20_000 });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(offCopy(page)).toBeVisible({ timeout: 20_000 });
  await toggle.click();
  await expect(readyCopy(page)).toBeVisible({ timeout: 20_000 });
  expect(counter.statusReads, "each toggle must produce a new status read").toBeGreaterThan(readsAtMount);

  // ── 2. engine change: a real server round trip and a real bot frame ────
  // The server broadcasts a `bot` frame carrying a NEW modelSelection object.
  // That frame — not an optimistic click — is what has to trigger the re-read,
  // because the settings PATCH is debounced and a toggle-only fetch can read
  // the old server setting.
  const readsBeforeEngine = counter.statusReads;
  const moved = await page.request.patch(`${fixture.base}/api/bots/${bot.id}`, {
    data: { modelSelection: { instanceId: UNSUPPORTED_ENGINE } },
  });
  expect(moved.status()).toBe(200);
  await expect(panel(page).getByText("This bot's engine can't run a browser.", { exact: false }))
    .toBeVisible({ timeout: 20_000 });
  await expect(panel(page).getByText(UNSUPPORTED_ENGINE, { exact: true })).toBeVisible();
  await expect.poll(() => counter.statusReads, { timeout: 20_000 }).toBeGreaterThan(readsBeforeEngine);

  const restored = await page.request.patch(`${fixture.base}/api/bots/${bot.id}`, {
    data: { modelSelection: { instanceId: SUPPORTED_ENGINE } },
  });
  expect(restored.status()).toBe(200);
  await expect(readyCopy(page)).toBeVisible({ timeout: 20_000 });

  // ── 3. rapid panel open/close must not wedge or stale the card ─────────
  for (let round = 0; round < 5; round += 1) {
    await page.getByRole("button", { name: "Close bot settings", exact: true }).click();
    await expect(panel(page)).toHaveCount(0);
    await page.getByTitle("Bot settings", { exact: true }).first().click();
    await expect(panel(page)).toBeVisible();
  }
  await expect(readyCopy(page)).toBeVisible({ timeout: 20_000 });
  await expect(browserSwitch(page)).toHaveAttribute("aria-checked", "true");
  await expect(panel(page).getByText("Ready on this machine", { exact: true })).toBeVisible();

  // ── 4. install completion refreshes through the same effect boundary ───
  // Remove the stand-in so the real endpoint reports the binary missing. The
  // install POST is answered by the fixture's own route handler (see newPage),
  // so no release archive is ever fetched.
  unlinkSync(fixture.obscura);
  await page.reload();
  await dismissOverlays(page);
  await selectBot(page, bot.name);
  await openBotSettings(page);
  await expect(panel(page).getByText("Not installed", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(panel(page).getByRole("button", { name: "Install automatically", exact: true })).toBeVisible();

  const readsBeforeInstall = counter.statusReads;
  await panel(page).getByRole("button", { name: "Install automatically", exact: true }).click();
  await expect(panel(page).getByText(INSTALL_DECLINED, { exact: true }))
    .toBeVisible({ timeout: 20_000 });
  expect(counter.installPosts).toBe(1);
  await expect.poll(() => counter.statusReads, { timeout: 20_000 }).toBeGreaterThan(readsBeforeInstall);

  // The card is still a card, not an error screen, and the switch survived.
  await expect(browserSwitch(page)).toHaveAttribute("aria-checked", "true");
  await expect(panel(page).getByText("Web browser", { exact: true })).toBeVisible();
});
