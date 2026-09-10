/** Real cloud/desktop servers and a local fake ACP engine. Each test owns
 * its ports, accounts and data; no real provider authentication is exercised. */
import { randomUUID } from "node:crypto";
import { expect, test as baseTest, type BrowserContext, type Page } from "@playwright/test";
import { startPairingHarness } from "./pairing-harness.ts";

type Harness = Awaited<ReturnType<typeof startPairingHarness>>;
type Fixtures = {
  harness: Harness;
  newPage: (expectedPairFailure?: boolean) => Promise<Page>;
  pairCodeFromCloud: string;
};

const test = baseTest.extend<Fixtures>({
  // Playwright inspects the destructured argument to resolve fixture dependencies.
  // oxlint-disable-next-line no-empty-pattern
  harness: async ({}, use) => {
    const harness = await startPairingHarness();
    try { await use(harness); } finally { await harness.stop(); }
  },
  newPage: async ({ browser, harness }, use, testInfo) => {
    const contexts: BrowserContext[] = [];
    const errors: string[] = [];
    const allowedOrigins = new Set([harness.cloudUrl, harness.desktopUrl]);
    const open = async (expectedPairFailure = false) => {
      const context = await browser.newContext();
      contexts.push(context);
      // A server fetch guard cannot stop the browser following OAuth or
      // third-party page resources. Only these two owned origins are allowed.
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (allowedOrigins.has(url.origin)) await route.continue();
        else {
          errors.push(`Unexpected browser request: ${url.origin}${url.pathname}`);
          await route.abort("blockedbyclient");
        }
      });
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() !== "error") return;
        // This test deliberately redeems an already-consumed code. Only
        // that endpoint's expected HTTP 400 resource message is exempted.
        if (expectedPairFailure && message.location().url === `${harness.desktopUrl}/api/pair/redeem`
          && /^Failed to load resource:.*\b400\b/.test(message.text())) return;
        errors.push(`${message.location().url}: ${message.text()}`);
      });
      return page;
    };
    try {
      await use(open);
      if (errors.length) await testInfo.attach("browser-errors", { body: errors.join("\n"), contentType: "text/plain" });
      expect(errors, "Unexpected browser errors or external requests").toEqual([]);
    } finally {
      await Promise.all(contexts.map((context) => context.close()));
    }
  },
  pairCodeFromCloud: async ({ harness, newPage }, use) => {
    const page = await newPage();
    await page.goto(`${harness.cloudUrl}/pair`);
    await expect(page).toHaveURL(/\/sign-in\?next=%2Fpair$/);
    await page.getByLabel("Email address", { exact: true }).fill(harness.email);
    await page.getByLabel("Password", { exact: true }).fill(harness.password);
    await page.getByRole("button", { name: "Sign in with email", exact: true }).click();
    await expect(page).toHaveURL(`${harness.cloudUrl}/pair`);
    await expect(page.getByText(`Signed in as ${harness.email}.`, { exact: true })).toBeVisible();
    const codeField = page.getByLabel("Pairing code", { exact: true });
    await expect(codeField).toHaveValue(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
    await expect(page.getByRole("button", { name: "Copy code", exact: true })).toBeEnabled();
    // A network response alone must never let a broken pairing page pass.
    await use(await codeField.inputValue());
  },
});
export { test, expect };

async function pairDesktop(page: Page, harness: Harness, code: string): Promise<void> {
  await page.goto(`${harness.desktopUrl}/sign-in`);
  await page.getByLabel("Pairing code", { exact: true }).fill(code);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page).toHaveURL(`${harness.desktopUrl}/app`);
  const response = await page.context().request.get(`${harness.desktopUrl}/api/auth/get-session`);
  expect(response.status()).toBe(200);
  expect((await response.json()).user?.email).toBe(harness.email);
}

async function expectTranscript(page: Page, message: string): Promise<void> {
  const userRow = page.locator("[data-mid]").filter({ hasText: message });
  const replyRow = page.locator("[data-mid]").filter({ hasText: "hello from fake acp" });
  await expect(userRow).toHaveCount(1);
  await expect(replyRow).toHaveCount(1);
  // The row wrappers use display:contents. Require the actual text inside
  // each row to be visible, not a bounding box on the wrapper itself.
  await expect(userRow.getByText(message, { exact: true })).toBeVisible();
  await expect(replyRow.getByText("hello from fake acp", { exact: true })).toBeVisible();
}

test.describe("desktop and cloud pairing", () => {
  test("the desktop exposes the pairing bridge", async ({ harness, newPage }) => {
    const page = await newPage();
    await page.goto(`${harness.desktopUrl}/sign-in`);
    await expect(page.getByLabel("Pairing code", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect", exact: true })).toBeVisible();
  });

  test("a displayed cloud code pairs the exact account", async ({ harness, newPage, pairCodeFromCloud }) => {
    await pairDesktop(await newPage(), harness, pairCodeFromCloud);
  });

  test("paired messages and the engine reply render and survive reload", async ({ harness, newPage, pairCodeFromCloud }) => {
    const page = await newPage();
    await pairDesktop(page, harness, pairCodeFromCloud);
    await page.getByRole("button", { name: "Quick start — skip setup, just get me in", exact: true }).click();
    const composer = page.getByRole("textbox", { name: /^Message / });
    await expect(composer).toBeVisible();
    const message = `Pairing transcript ${randomUUID()}`;
    await composer.fill(message);
    await composer.press("Enter");
    await expectTranscript(page, message);
    await page.reload();
    await expectTranscript(page, message);
  });

  test("OAuth start constructs a Google redirect without following it", async ({ harness, request }) => {
    const query = new URLSearchParams({ redirect: harness.desktopUrl });
    const response = await request.get(`${harness.cloudUrl}/desktop-auth/start?${query}`, { maxRedirects: 0 });
    expect(response.status()).toBe(302);
    const destination = new URL(response.headers().location ?? "");
    expect(destination.origin).toBe("https://accounts.google.com");
    expect(destination.searchParams.get("client_id")).toBeTruthy();
    expect(response.headers()["set-cookie"]).toContain("better-auth.state=");
  });

  test("a consumed code is rejected without a desktop session", async ({ harness, newPage, pairCodeFromCloud, request }) => {
    const consumed = await request.post(`${harness.cloudUrl}/api/pair/verify`, { data: { code: pairCodeFromCloud } });
    expect(consumed.status()).toBe(200);
    expect((await consumed.json()).email).toBe(harness.email);
    const page = await newPage(true);
    await page.goto(`${harness.desktopUrl}/sign-in`);
    await page.getByLabel("Pairing code", { exact: true }).fill(pairCodeFromCloud);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(page.getByText(/isn't valid/)).toBeVisible();
    await expect(page).toHaveURL(`${harness.desktopUrl}/sign-in`);
    const session = await page.context().request.get(`${harness.desktopUrl}/api/auth/get-session`);
    expect(session.status()).toBe(200);
    expect(await session.json()).toBeNull();
  });
});
