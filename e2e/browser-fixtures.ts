/** Shared owned browser fixtures. Each test gets independent servers,
 * accounts and contexts; no real provider authentication is exercised. */
import { expect, test as baseTest, type BrowserContext, type Page } from "@playwright/test";
import { startPairingHarness, type FixtureEngineMode } from "./pairing-harness.ts";

type Harness = Awaited<ReturnType<typeof startPairingHarness>>;
type PageFailure = boolean | { messageSend503: true };
interface MessageSendFailure { url: string | null; consoleErrors: number }
type Fixtures = {
  engineMode: FixtureEngineMode;
  harness: Harness;
  newPage: (expectedFailure?: PageFailure) => Promise<Page>;
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
    const sendFailures: MessageSendFailure[] = [];
    const allowedOrigins = new Set([harness.cloudUrl, harness.desktopUrl]);
    const open = async (expectedFailure: PageFailure = false) => {
      const context = await browser.newContext();
      // E2E must never emit third-party requests: set the shipped analytics
      // opt-out key before any app script runs, so posthog never loads
      // (analytics.ts reads this key fresh on every check).
      await context.addInitScript(() => {
        // Opaque-origin documents (about:blank) deny storage — the app's own
        // origin does not; never log an error there.
        try { localStorage.setItem("muster:analytics-opt-out", "1"); } catch { /* no storage in this document */ }
      });
      contexts.push(context);
      const expectedPairFailure = expectedFailure === true;
      const failedSend: MessageSendFailure | null = expectedFailure && expectedFailure !== true
        ? { url: null, consoleErrors: 0 } : null;
      if (failedSend) sendFailures.push(failedSend);
      // A server fetch guard cannot stop the browser following OAuth or
      // third-party page resources. Only these two owned origins are allowed.
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (!allowedOrigins.has(url.origin)) {
          errors.push(`Unexpected browser request: ${url.origin}${url.pathname}`);
          await route.abort("blockedbyclient");
          return;
        }
        if (failedSend && failedSend.url === null && url.origin === harness.desktopUrl
          && route.request().method() === "POST" && /^\/api\/bots\/[^/]+\/messages$/.test(url.pathname) && !url.search) {
          // Pin the exact request before responding. This is explicitly a
          // failure BEFORE forwarding, never fabricated server acceptance.
          failedSend.url = url.href;
          await route.fulfill({ status: 503, contentType: "application/json",
            body: JSON.stringify({ error: "Owned fixture: first task was not sent. Please retry." }) });
          return;
        }
        await route.continue();
      });
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() !== "error") return;
        // This test deliberately redeems an already-consumed code. Only
        // that endpoint's expected HTTP 400 resource message is exempted.
        if (expectedPairFailure && message.location().url === `${harness.desktopUrl}/api/pair/redeem`
          && /^Failed to load resource:.*\b400\b/.test(message.text())) return;
        if (failedSend && message.location().url === failedSend.url
          && /^Failed to load resource:.*\b503\b/.test(message.text()) && failedSend.consoleErrors === 0) {
          failedSend.consoleErrors += 1;
          return;
        }
        errors.push(`${message.location().url}: ${message.text()}`);
      });
      return page;
    };
    try {
      await use(open);
      for (const failure of sendFailures) {
        expect(failure.url, "The expected pre-forward message failure was exercised").not.toBeNull();
        expect(failure.consoleErrors, "Exactly the intercepted message's single HTTP 503 error was consumed").toBe(1);
      }
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
