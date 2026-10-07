import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test as base, chromium, type Page } from "@playwright/test";
import { z } from "zod";
import { startVisibleDriveHarness, visibleSessionCardFixture } from "./visible-drive-harness.ts";

type Harness = Awaited<ReturnType<typeof startVisibleDriveHarness>>;
const PREFIX = "/api/workspace/drive-visible";
const test = base.extend<{ harness: Harness }>({
  browser: async ({ browserName }, use) => {
    if (browserName !== "chromium") throw new Error("Owned fixture requires Chromium");
    // A fresh Playwright-owned profile; never attach to the user's Chrome.
    const browser = await chromium.launch({ headless: true,
      args: ["--disable-background-networking", "--disable-component-update", "--no-first-run"] });
    try { await use(browser); } finally { await browser.close(); }
  },
  harness: async ({ browserName }, use, testInfo) => {
    if (browserName !== "chromium") throw new Error("Owned fixture requires Chromium");
    const harness = await startVisibleDriveHarness();
    await testInfo.attach("owned-visible-copy-scope", { body: JSON.stringify({ directory: harness.directory, origin: harness.origin,
      pid: harness.child.pid, authority: "fresh-synthetic-users-only", transport: "JS-denial-with-synthetic-official-Google-fixture" }), contentType: "application/json" });
    try { await use(harness); } finally {
      const receipt = await harness.cleanup();
      await testInfo.attach("owned-visible-copy-evidence", { body: JSON.stringify({ ...receipt, log: undefined }), contentType: "application/json" });
      // Raw server logs remain private, and synthetic credentials are omitted.
      expect(receipt).toMatchObject({ exited: true, closedPorts: [true, true], noOutbound: true, removed: true });
    }
  },
  context: async ({ browser, harness }, use) => {
    const context = await browser.newContext();
    const refused: string[] = [];
    await context.addCookies([harness.cookie("alice")]);
    await context.addInitScript(() => {
      localStorage.setItem("muster:analytics-opt-out", "1");
      localStorage.setItem("omb-skin", "lagoon"); localStorage.setItem("muster:sidebar-density", "compact");
      localStorage.setItem("muster.onboarding-chat.done", "1"); localStorage.setItem("muster.team-templates.dismissed", "1");
      localStorage.setItem("omb-email-gate.alice", "done"); localStorage.setItem("omb-email-gate.bob", "done");
    });
    await context.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.origin === harness.origin) { await route.continue(); return; }
      if (url.origin === "https://accounts.google.com" && url.pathname === "/o/oauth2/v2/auth") {
        // Synthetic consent view only. Its callback executes the real server,
        // including signed JWT verification, PKCE, state consumption and grant.
        const code = Buffer.from(JSON.stringify({ user: "alice", nonce: url.searchParams.get("nonce"), challenge: url.searchParams.get("code_challenge") })).toString("base64url");
        const callback = new URL(url.searchParams.get("redirect_uri")!);
        if (callback.origin !== harness.origin || callback.pathname !== `${PREFIX}/callback`) throw new Error("Unexpected synthetic callback");
        callback.search = new URLSearchParams({ state: url.searchParams.get("state")!, code }).toString();
        await route.fulfill({ contentType: "text/html", body: `<!doctype html><title>Owned synthetic consent</title><a href="${callback.toString().replaceAll("&", "&amp;")}">Allow synthetic Drive</a>` }); return;
      }
      refused.push(`${url.origin}${url.pathname}`); await route.abort("blockedbyclient");
    });
    try { await use(context); expect(refused).toEqual([]); } finally { await context.close(); }
  },
});

async function openCard(page: Page, harness: Harness) {
  await page.goto(`${harness.origin}/app`);
  const tour = page.getByRole("dialog", { name: "Product tour", exact: true });
  await page.addLocatorHandler(tour, async dialog => { await dialog.getByRole("button", { name: "Skip", exact: true }).click(); });
  const wizard = page.getByRole("region", { name: "Set up Muster", exact: true });
  await page.addLocatorHandler(wizard, async () => { await page.keyboard.press("Escape"); });
  await page.getByRole("button", { name: "App settings", exact: true }).click();
  await page.getByRole("dialog", { name: "Settings", exact: true }).getByRole("button", { name: "Backups", exact: true }).click();
  const card = page.getByRole("region", { name: "Optional Drive copies", exact: true });
  await expect(card).toBeVisible();
  await expect(card.getByRole("button", { name: "Connect optional Drive", exact: true })).toBeEnabled();
  return card;
}
async function connect(page: Page) {
  const opened = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Connect optional Drive", exact: true }).click();
  const popup = await opened;
  await popup.getByRole("link", { name: "Allow synthetic Drive", exact: true }).click();
  await expect(page.getByText("Optional Drive connection confirmed.", { exact: true })).toBeVisible();
  await expect.poll(() => popup.isClosed()).toBe(true);
}

test("actual consent, explicit real preferences, immutable encrypted copy and inert inspection", async ({ page, harness }, testInfo) => {
  const card = await openCard(page, harness);
  await expect(card.getByText("Inspection only. Restoring a copy into a live workspace is unavailable.", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Workspace backup", exact: true })).toBeVisible();
  await connect(page);
  await card.getByRole("button", { name: "Capture current preferences", exact: true }).click();
  await expect(card.getByText("This browser’s current theme and sidebar density were captured for your account.", { exact: true })).toBeVisible();
  const row = harness.db.prepare("SELECT userId,workspaceId,document FROM drive_visible_settings").get();
  expect(row).toMatchObject({ userId: "alice", workspaceId: "alice-org" });
  expect(JSON.parse(String(row!.document))).toMatchObject({ settings: { theme: "lagoon", density: "compact" } });
  const fleet = z.object({ bots: z.array(z.object({ id: z.string(), name: z.string() })) }).parse(await (await harness.request("/api/bots")).json());
  expect(fleet.bots.length).toBeGreaterThan(0);
  const passphrase = "synthetic-owned-copy-passphrase";
  await card.getByLabel("Drive copy passphrase", { exact: true }).fill(passphrase);
  await card.getByRole("button", { name: "Create encrypted Drive copy", exact: true }).click();
  await expect(card.getByText(/Encrypted copy verified/)).toBeVisible();
  await expect(card.getByLabel("Drive copy passphrase", { exact: true })).toHaveValue("");
  const copyId = await card.getByLabel("Drive copy ID", { exact: true }).inputValue();
  const actual = readFileSync(join(harness.transportDir, `${copyId}.bin`));
  expect(actual.length).toBeGreaterThan(100); for (const bot of fleet.bots) expect(actual.includes(Buffer.from(bot.name))).toBe(false);
  await card.getByLabel("Drive copy passphrase", { exact: true }).fill(passphrase);
  await card.getByRole("button", { name: "Inspect Drive copy", exact: true }).click();
  await expect(card.getByText(new RegExp(`Inspection ready: ${fleet.bots.length} teammates`))).toBeVisible();
  await expect(card.getByText(/No restore was applied/).last()).toBeVisible();
  const before = harness.copies();
  await card.getByRole("button", { name: "Disconnect optional Drive", exact: true }).click();
  await expect(card.getByText(/Existing copies were preserved; Google access was not revoked/)).toBeVisible();
  expect(harness.copies()).toEqual(before); expect(readFileSync(join(harness.transportDir, `${copyId}.bin`))).toEqual(actual);
  await testInfo.attach("copy-identity", { contentType: "application/json", body: JSON.stringify({ fileId: copyId, bytes: actual.length, sha256: createHash("sha256").update(actual).digest("hex") }) });
  await page.screenshot({ path: testInfo.outputPath("optional-copy-inspection.png") });
});

test("explicit popup cancellation and re-consent preserve existing data", async ({ page, harness }) => {
  const card = await openCard(page, harness);
  const opened = page.waitForEvent("popup"); await card.getByRole("button", { name: "Connect optional Drive", exact: true }).click();
  const popup = await opened; await expect(popup.getByRole("link", { name: "Allow synthetic Drive" })).toBeVisible();
  expect(harness.db.prepare("SELECT COUNT(*) AS count FROM drive_visible_oauth_states").get()!.count).toBe(1);
  await card.getByRole("button", { name: "Cancel Drive consent", exact: true }).click();
  await expect(card.getByText("Consent cancelled. Close the Google sign-in window. Existing backups were preserved.", { exact: true })).toBeVisible();
  expect(popup.isClosed()).toBe(false); // Chrome refuses control once opener is severed.
  expect(harness.db.prepare("SELECT COUNT(*) AS count FROM drive_visible_oauth_states").get()!.count).toBe(0);
  await expect(card.getByRole("button", { name: "Connect optional Drive", exact: true })).toBeDisabled();
  await popup.getByRole("link", { name: "Allow synthetic Drive", exact: true }).click();
  await expect.poll(() => popup.isClosed()).toBe(true); // Owned same-origin refusal returns to bounded mounted tracking.
  expect(harness.db.prepare("SELECT COUNT(*) AS count FROM drive_visible_grants").get()!.count).toBe(0);
  await expect(card.getByRole("button", { name: "Connect optional Drive", exact: true })).toBeEnabled();
  await connect(page); expect(harness.db.prepare("SELECT COUNT(*) AS count FROM drive_visible_grants").get()!.count).toBe(1);
});

test("a rotated real session while exchange is held cannot publish a grant or UI success", async ({ page, harness }) => {
  const card = await openCard(page, harness); harness.setMode("hold-exchange");
  const opened = page.waitForEvent("popup"); await card.getByRole("button", { name: "Connect optional Drive", exact: true }).click();
  const popup = await opened; await popup.getByRole("link", { name: "Allow synthetic Drive" }).click({ noWaitAfter: true });
  await expect.poll(() => existsSync(join(harness.transportDir, "exchange-held"))).toBe(true);
  harness.db.exec("UPDATE session SET token='rotated-owned-token' WHERE userId='alice'"); harness.setMode("ok");
  await expect(card.getByRole("alert")).toContainText(/account|sign-in|consent/i);
  expect(harness.db.prepare("SELECT COUNT(*) AS count FROM drive_visible_grants").get()!.count).toBe(0);
  await expect(card.getByText("Optional Drive connection confirmed.", { exact: true })).toHaveCount(0);
});

test("late authenticated status cannot stamp another account and unmount clears secrets", async ({ page, context, harness }) => {
  const card = await openCard(page, harness);
  await card.getByLabel("Drive copy passphrase", { exact: true }).fill("owned-secret-to-retire");
  let release!: () => void; const held = new Promise<void>(done => { release = done; });
  let entered!: () => void; const started = new Promise<void>(done => { entered = done; });
  await page.route(`${harness.origin}${PREFIX}/status`, async route => {
    const response = await route.fetch(); entered(); await held;
    await route.fulfill({ response }).catch(() => undefined);
  });
  await card.getByRole("button", { name: "Refresh Drive status", exact: true }).click(); await started;
  await context.clearCookies(); await context.addCookies([harness.cookie("bob")]); release();
  await expect(card.getByRole("alert")).toContainText(/account or connection changed/);
  await expect(card.getByLabel("Drive copy passphrase", { exact: true })).toHaveValue("");
  await page.unroute(`${harness.origin}${PREFIX}/status`);
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  await expect(card).toHaveCount(0);
  await page.reload(); await openCard(page, harness);
  expect(harness.db.prepare("SELECT name FROM sqlite_master WHERE name='drive_visible_settings'").all()).toEqual([]);
});

test("provider-offline and malformed read seams never enable writes or mask existing backups", async ({ page, harness }) => {
  const card = await openCard(page, harness);
  // Only an explicitly labelled read failure is simulated; no successful
  // product session, grant or write response is substituted.
  await page.route(`${harness.origin}${PREFIX}/status`, route => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"provider-unavailable"}' }));
  await card.getByRole("button", { name: "Refresh Drive status", exact: true }).click();
  await expect(card.getByRole("alert")).toContainText("unavailable");
  await expect(card.getByRole("button", { name: "Create encrypted Drive copy" })).toBeDisabled();
  await page.unroute(`${harness.origin}${PREFIX}/status`);
  await card.getByRole("button", { name: "Refresh Drive status", exact: true }).click();
  await expect(card.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Workspace backup", exact: true })).toBeVisible();
});

test("a preserved grant cannot confirm a replacement popup superseded by real newer consent", async ({ page, harness }) => {
  const card = await openCard(page, harness); await connect(page);
  const opened = page.waitForEvent("popup"); await card.getByRole("button", { name: "Reconnect optional Drive", exact: true }).click();
  const popup = await opened; await expect(popup.getByRole("link", { name: "Allow synthetic Drive" })).toBeVisible();
  await expect(card.getByText("Optional Drive connection confirmed.", { exact: true })).toHaveCount(0);
  const another = await harness.request(`${PREFIX}/consent`, "alice", {}); expect(another.status).toBe(200);
  await popup.getByRole("link", { name: "Allow synthetic Drive" }).click();
  await expect(card.getByRole("alert")).toContainText("consent was not completed");
  expect(harness.db.prepare("SELECT COUNT(*) AS count FROM drive_visible_grants").get()!.count).toBe(1);
  await expect(card.getByText("Optional Drive connection confirmed.", { exact: true })).toHaveCount(0);
});

test("current-context precondition refuses actual workspace writes before settings mutation", async ({ page, harness }) => {
  const card = await openCard(page, harness);
  const created = new Date().toISOString();
  harness.db.prepare("INSERT INTO organization(id,name,slug,createdAt) VALUES(?,?,?,?)").run("alice-next", "Next", "alice-next", created);
  harness.db.prepare("INSERT INTO member(id,organizationId,userId,role,createdAt) VALUES(?,?,?,?,?)").run("alice-next-member", "alice-next", "alice", "owner", created);
  await page.route(`${harness.origin}${PREFIX}/settings`, async route => {
    expect(route.request().headers()["x-muster-visible-view"]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    harness.db.exec("UPDATE session SET activeOrganizationId='alice-next' WHERE userId='alice'");
    await route.continue();
  });
  await card.getByRole("button", { name: "Capture current preferences", exact: true }).click();
  await expect(card.getByRole("alert")).toContainText("account or connection changed");
  expect(harness.db.prepare("SELECT name FROM sqlite_master WHERE name='drive_visible_settings'").all()).toEqual([]);
  expect(harness.copies()).toEqual([]);
});


test("unmount cancels the exact state, clears secrets and measures the cross-origin window limit", async ({ page, harness }) => {
  const card = await openCard(page, harness);
  await card.getByLabel("Drive copy passphrase", { exact: true }).fill("owned-memory-secret-to-clear");
  const opened = page.waitForEvent("popup"); await card.getByRole("button", { name: "Connect optional Drive", exact: true }).click();
  const popup = await opened; await expect(popup.getByRole("link", { name: "Allow synthetic Drive" })).toBeVisible();
  expect(harness.db.prepare("SELECT COUNT(*) AS count FROM drive_visible_oauth_states").get()!.count).toBe(1);
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  await expect(card).toHaveCount(0);
  await expect.poll(() => harness.db.prepare("SELECT COUNT(*) AS count FROM drive_visible_oauth_states").get()!.count).toBe(0);
  expect(popup.isClosed()).toBe(false); // Measured browser limit, never an automatic-close pass.
  await popup.getByRole("link", { name: "Allow synthetic Drive", exact: true }).click();
  await expect(popup.locator("body")).toContainText("consent-unavailable");
  expect(harness.db.prepare("SELECT COUNT(*) AS count FROM drive_visible_grants").get()!.count).toBe(0);
  await popup.close(); // Only this fresh synthetic window is closed by the fixture.
  const reopened = await openCard(page, harness);
  await expect(reopened.getByLabel("Drive copy passphrase", { exact: true })).toHaveValue("");
  expect(harness.db.prepare("SELECT COUNT(*) AS count FROM drive_visible_grants").get()!.count).toBe(0);
});


test("a newer real grant between pre-status and action dispatch refuses settings mutation", async ({ page, harness }) => {
  const card = await openCard(page, harness); await connect(page);
  await page.route(`${harness.origin}${PREFIX}/settings`, async route => {
    const observed = route.request().headers()["x-muster-visible-grant"];
    expect(observed).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const consentResponse = await harness.request(`${PREFIX}/consent`, "alice", {});
    expect(consentResponse.status).toBe(200);
    const attempt = z.object({ state: z.string(), authorizationUrl: z.string() }).parse(await consentResponse.json());
    const url = new URL(attempt.authorizationUrl);
    const code = Buffer.from(JSON.stringify({ user: "alice", nonce: url.searchParams.get("nonce"), challenge: url.searchParams.get("code_challenge") })).toString("base64url");
    const accepted = await harness.request(`${PREFIX}/callback?${new URLSearchParams({ state: attempt.state, code })}`);
    expect(accepted.status).toBe(200);
    const current = z.object({ grantRevision: z.string() }).parse(await accepted.json());
    expect(current.grantRevision).not.toBe(observed);
    await route.continue();
  });
  await card.getByRole("button", { name: "Capture current preferences", exact: true }).click();
  await expect(card.getByRole("alert")).toContainText("account or connection changed");
  expect(harness.db.prepare("SELECT name FROM sqlite_master WHERE name='drive_visible_settings'").all()).toEqual([]);
  expect(harness.db.prepare("SELECT COUNT(*) AS count FROM drive_visible_grants").get()!.count).toBe(1);
  expect(harness.copies()).toEqual([]);
});

test("same-mounted actual AuthProvider session replacement retires pending consent and permits a new winner", async ({ page, context, harness }) => {
  const fixture = await visibleSessionCardFixture();
  await page.route(`${harness.origin}/__owned-visible-session-card`, route => route.fulfill({ contentType: "text/html", body: fixture }));
  await page.goto(`${harness.origin}/__owned-visible-session-card`);
  const card = page.getByRole("region", { name: "Optional Drive copies", exact: true });
  await expect(page.getByLabel("Owned session identity", { exact: true })).toHaveText("alice-session");
  await expect(card.getByRole("button", { name: "Connect optional Drive", exact: true })).toBeEnabled();
  await card.evaluate(node => node.setAttribute("data-owned-mounted-card", "original"));
  const opened = page.waitForEvent("popup");
  await card.getByRole("button", { name: "Connect optional Drive", exact: true }).click();
  const oldPopup = await opened;
  await expect(oldPopup.getByRole("link", { name: "Allow synthetic Drive", exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "Cancel Drive consent", exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "Refresh Drive status", exact: true })).toBeDisabled();

  const replacement = harness.replaceSession("alice");
  await context.addCookies([replacement.cookie]);
  await page.getByRole("button", { name: "Recheck owned signed session", exact: true }).click();
  await expect(page.getByLabel("Owned session identity", { exact: true })).toHaveText(replacement.id);
  await expect(card).toHaveAttribute("data-owned-mounted-card", "original"); // Same mounted card/provider, not a reload or remount.
  await expect(card.getByRole("button", { name: "Cancel Drive consent", exact: true })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Refresh Drive status", exact: true })).toBeEnabled();
  await expect(card.getByRole("button", { name: "Connect optional Drive", exact: true })).toBeEnabled();
  await expect(card.getByLabel("Drive copy passphrase", { exact: true })).toHaveValue("");
  expect(oldPopup.isClosed()).toBe(false); // Retired cross-origin window has no authority and requires manual close.
  const refused = oldPopup.waitForResponse(response => new URL(response.url()).pathname === `${PREFIX}/callback`);
  await oldPopup.getByRole("link", { name: "Allow synthetic Drive", exact: true }).click();
  expect((await refused).status()).toBeGreaterThanOrEqual(400);
  expect(harness.db.prepare("SELECT COUNT(*) AS count FROM drive_visible_grants").get()!.count).toBe(0);
  await oldPopup.close();
  await connect(page);
  await expect(card.getByRole("button", { name: "Cancel Drive consent", exact: true })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Refresh Drive status", exact: true })).toBeEnabled();
  expect(harness.db.prepare("SELECT COUNT(*) AS count FROM drive_visible_grants").get()!.count).toBe(1);
});
