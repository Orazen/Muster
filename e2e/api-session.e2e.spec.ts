/** Real owned server, password sign-in and session checks. Drive/provider
 * failures, storage availability and one unavailable session response are
 * synthetic browser boundaries; no Google consent or external request runs. */
import { test, expect, type Page, type Response } from "@playwright/test";
import { z } from "zod";
import { startOnboardingHarness } from "./onboarding-harness.ts";

let harness: Awaited<ReturnType<typeof startOnboardingHarness>>;
let externalRequests: string[];
const driveError = "Google Drive rejected the fixture permission. Please try again.";
const sessionPath = "/api/auth/get-session";
const wizard = (page: Page) => page.getByRole("region", { name: "Set up Muster", exact: true });
const drive = (page: Page) => page.getByRole("region", { name: "Google Drive setup", exact: true });

test.beforeEach(async ({ context }) => {
  harness = await startOnboardingHarness(process.env.MUSTER_ONBOARDING_UI);
  externalRequests = [];
  await context.addInitScript(() => localStorage.setItem("muster:analytics-opt-out", "1"));
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === harness.url) return route.continue();
    externalRequests.push(`${url.origin}${url.pathname}`);
    await route.abort("blockedbyclient");
  });
});
test.afterEach(async ({ page, context }) => {
  try {
    await page.unrouteAll({ behavior: "wait" });
    await page.close();
    await context.unrouteAll({ behavior: "wait" });
    expect(externalRequests).toEqual([]);
  }
  finally { await harness?.stop(); }
});

async function signIn(page: Page) {
  await page.goto(`${harness.url}/sign-in?next=${encodeURIComponent("/app?session-regression=1#keep")}`);
  await page.getByLabel("Email address", { exact: true }).fill(harness.email);
  await page.getByLabel("Password", { exact: true }).fill(harness.password);
  await page.getByRole("button", { name: "Sign in with email", exact: true }).click();
  await expect(page).toHaveURL(`${harness.url}/app?session-regression=1#keep`);
}

async function enterConnections(page: Page) {
  // Persist the actual account gate; the remaining storage setup resumes at
  // Connections without replaying the introductory interview.
  expect((await harness.api("/api/me/onboarding", {
    method: "PUT", body: JSON.stringify({ status: "submitted" }),
  })).status).toBe(200);
  const config = await harness.api("/api/config");
  expect(config.status).toBe(200);
  // The owned account's config plus an explicit storage-boundary fixture;
  // no forwarded route.fetch remains in flight during browser teardown.
  const configFixture = { ...z.record(z.string(), z.unknown()).parse(config.body), storageGate: {
      required: true, satisfied: false,
      options: { googleDrive: { available: true, connected: false }, telegram: { configured: false } },
  } };
  await page.route(`${harness.url}/api/config`, (route) => route.fulfill({ json: configFixture }));
  await page.route(`${harness.url}/api/connectors/catalog`, (route) => route.fulfill({ json: {
    configured: false, mode: "unavailable", cards: [], reason: "Gmail is disabled in this fixture.",
  } }));
  await signIn(page);
  await expect(wizard(page).getByTestId("onboarding-stage-title")).toHaveText("Connections");
  await expect(drive(page).getByRole("button", { name: "Connect Google Drive", exact: true })).toBeEnabled();
  // Independent positive control: read the real session from the page's actual
  // origin and cookie jar. No route fixture intercepts this endpoint, and no
  // session token is logged.
  const session = await page.evaluate(async (path) => {
    const response = await fetch(path, { credentials: "include" });
    return { status: response.status, bodyText: await response.text() };
  }, sessionPath);
  expect(session.status).toBe(200);
  const sessionBody = z.object({ user: z.object({ email: z.string() }) }).parse(JSON.parse(session.bodyText));
  expect(sessionBody.user.email).toBe(harness.email);
  await page.route(`${harness.url}/api/workspace/google/connect`, (route) => route.fulfill({
    status: 401, json: { error: driveError },
  }));
}

function nextSessionCheck(page: Page): Promise<Response> {
  return page.waitForResponse((response) => new URL(response.url()).pathname === sessionPath
    && response.request().method() === "GET");
}

async function rejectDrive(page: Page) {
  const checked = nextSessionCheck(page);
  await drive(page).getByRole("button", { name: "Connect Google Drive", exact: true }).click();
  return checked;
}

async function expectPreserved(page: Page) {
  await expect(page).toHaveURL(`${harness.url}/app?session-regression=1#keep`);
  await expect(wizard(page).getByTestId("onboarding-stage-title")).toHaveText("Connections");
  await expect(drive(page).getByRole("alert")).toHaveText(driveError);
  await expect(drive(page).getByRole("button", { name: "Connect Google Drive", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Sign in with email", exact: true })).toHaveCount(0);
}

test("provider 401 keeps the verified account, route and mounted setup flow", async ({ page }) => {
  await enterConnections(page);
  const mounted = await wizard(page).elementHandle();
  const checked = await rejectDrive(page);
  expect(checked.status()).toBe(200);
  expect((await checked.json()).user.email).toBe(harness.email);
  await expectPreserved(page);
  expect(await mounted!.evaluate((element) => element.isConnected)).toBe(true);
});

test("confirmed expiry redirects through AuthGate with the original destination", async ({ page, context }) => {
  await enterConnections(page);
  // Expire only this owned browser's cookies. The following null comes from
  // the real auth server, not a synthetic get-session response or sign-out UI.
  await context.clearCookies();
  const checked = await rejectDrive(page);
  expect(checked.status()).toBe(200);
  expect(await checked.json()).toBeNull();
  await expect(page).toHaveURL(`${harness.url}/sign-in?next=${encodeURIComponent("/app?session-regression=1#keep")}`);
  await expect(page.getByRole("button", { name: "Sign in with email", exact: true })).toBeVisible();
  await expect(wizard(page)).toHaveCount(0);
});

test("unavailable session check preserves setup and permits a later verified retry", async ({ page }) => {
  await enterConnections(page);
  const mounted = await wizard(page).elementHandle();
  await page.route(`${harness.url}${sessionPath}`, (route) => route.fulfill({
    status: 503, json: { error: "Synthetic temporary session service outage" },
  }));
  expect((await rejectDrive(page)).status()).toBe(503);
  await expectPreserved(page);
  expect(await mounted!.evaluate((element) => element.isConnected)).toBe(true);

  await page.unroute(`${harness.url}${sessionPath}`);
  const recovered = await rejectDrive(page);
  expect(recovered.status()).toBe(200);
  expect((await recovered.json()).user.email).toBe(harness.email);
  await expectPreserved(page);
  expect(await mounted!.evaluate((element) => element.isConnected)).toBe(true);
});

test("first workspace hydration binds the signed-in account before a config 401", async ({ page }) => {
  let rejectedConfig = false;
  const afterFailure: Response[] = [];
  page.on("response", (response) => {
    if (rejectedConfig && new URL(response.url()).pathname === sessionPath) afterFailure.push(response);
  });
  await page.route(`${harness.url}/api/config`, async (route) => {
    rejectedConfig = true;
    await route.fulfill({ status: 401, json: { error: "Synthetic initial config rejection" } });
  });
  await signIn(page);
  await expect.poll(() => afterFailure.length).toBeGreaterThan(0);
  expect(afterFailure[0].status()).toBe(200);
  expect((await afterFailure[0].json()).user.email).toBe(harness.email);
  await expect(page).toHaveURL(`${harness.url}/app?session-regression=1#keep`);
  await expect(page.getByRole("button", { name: "Sign in with email", exact: true })).toHaveCount(0);
});
