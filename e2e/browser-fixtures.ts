/** Shared owned browser fixtures. Each test gets independent servers,
 * accounts and contexts; no real provider authentication is exercised. */
import { expect, test as baseTest, type BrowserContext, type Page } from "@playwright/test";
import { startPairingHarness, type FixtureEngineMode } from "./pairing-harness.ts";

type Harness = Awaited<ReturnType<typeof startPairingHarness>>;
type Fixtures = {
  engineMode: FixtureEngineMode;
  harness: Harness;
  newPage: (expectedPairFailure?: boolean) => Promise<Page>;
  pairCodeFromCloud: string;
};

const test = baseTest.extend<Fixtures>({
  engineMode: ["happy", { option: true }],
  harness: async ({ engineMode }, use) => {
    const harness = await startPairingHarness({ engineMode });
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

export async function pairDesktop(page: Page, harness: Harness, code: string): Promise<void> {
  await page.goto(`${harness.desktopUrl}/sign-in`);
  await page.getByLabel("Pairing code", { exact: true }).fill(code);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page).toHaveURL(`${harness.desktopUrl}/app`);
  const response = await page.context().request.get(`${harness.desktopUrl}/api/auth/get-session`, { maxRedirects: 0 });
  expect(response.status()).toBe(200);
  expect((await response.json()).user?.email).toBe(harness.email);
}
