/** Shared owned browser fixtures. Each test gets independent servers,
 * accounts and contexts; no real provider authentication is exercised.
 *
 * The pairing fixture takes a real server-issued session from the sign-in API rather than from
 * the password form, so specs that need an authenticated pairing page do not each depend on
 * password entry. Password entry itself is covered in e2e/auth-entry.spec.ts. */
import { expect, test as baseTest, type BrowserContext, type Page } from "@playwright/test";
import { startPairingHarness, type FixtureEngineMode } from "./pairing-harness.ts";

type Harness = Awaited<ReturnType<typeof startPairingHarness>>;
/** How the send's acknowledgement is lost. `true` (or a bare boolean) fails
 * BEFORE forwarding — the server never hears the send. `{ afterCommit: true }`
 * forwards the POST to the real server first, so the durable layer records
 * the words, and only then answers 503 — the committed-send-whose-ack-was-
 * lost case, which exercises replay from the durable record itself. */
type PageFailure = boolean | { messageSend503: true | { afterCommit: true } };
interface MessageSendFailure { url: string | null; consoleErrors: number; fulfilled503: number; afterCommit: boolean }
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
      const send503Spec = expectedFailure && expectedFailure !== true ? expectedFailure.messageSend503 : false;
      const failedSend: MessageSendFailure | null = send503Spec
        ? { url: null, consoleErrors: 0, fulfilled503: 0, afterCommit: send503Spec !== true }
        : null;
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
          // Pin the exact request before responding. In the default mode this
          // is a failure BEFORE forwarding — the server never hears the send.
          // In the afterCommit mode the POST is FORWARDED first (the server's
          // durable layer genuinely records the words) and only the response
          // is replaced: the acknowledgement is lost after acceptance, which
          // is the stronger replay case. Neither mode fabricates acceptance.
          failedSend.url = url.href;
          if (failedSend.afterCommit) {
            const response = await route.fetch();
            if (response.status() < 400) {
              await route.fulfill({ status: 503, contentType: "application/json",
                body: JSON.stringify({ error: "Owned fixture: the send was accepted but its acknowledgement was lost. Please retry." }) });
              failedSend.fulfilled503 += 1;
            } else {
              await route.fulfill({ response });
            }
            return;
          }
          await route.fulfill({ status: 503, contentType: "application/json",
            body: JSON.stringify({ error: "Owned fixture: first task was not sent. Please retry." }) });
          failedSend.fulfilled503 += 1;
          return;
        }
        await route.continue();
      });
      const page = await context.newPage();
      // These fixtures exercise task flows, not the optional product tour.
      // Acknowledge its actual visible Skip control so a first-visit overlay
      // cannot intercept later approvals; leave account onboarding untouched.
      const productTour = page.getByRole("dialog", { name: "Product tour", exact: true });
      await page.addLocatorHandler(productTour, async (dialog) => {
        await dialog.getByRole("button", { name: "Skip", exact: true }).click();
      });
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
        expect(failure.url, "The expected message failure was exercised").not.toBeNull();
        expect(failure.fulfilled503, "Exactly one deliberate message HTTP 503 was fulfilled").toBe(1);
        // Navigation may cancel browser console reporting after fulfillment.
        // Fault delivery is asserted above; only one exact resource error is
        // optional, and any repeated or unrelated error stays in errors.
        expect(failure.consoleErrors).toBeLessThanOrEqual(1);
      }
      if (errors.length) await testInfo.attach("browser-errors", { body: errors.join("\n"), contentType: "text/plain" });
      expect(errors, "Unexpected browser errors or external requests").toEqual([]);
    } finally {
      await Promise.all(contexts.map((context) => context.close()));
    }
  },
  pairCodeFromCloud: async ({ harness, newPage }, use) => {
    // A REAL cloud session, taken from the sign-in API rather than by driving the password form.
    //
    // Twenty-one specs need an authenticated pairing page as a PRECONDITION. Having each of them
    // reach it through the direct-password UI conflated two unrelated contracts: the pairing
    // contract those specs actually assert, and password entry, which belongs to the dedicated
    // auth-entry and direct-sign-in specs. That conflation had a cost beyond tidiness - a failure
    // anywhere in password entry failed 21 unrelated specs, so a real entry regression was reported
    // as dozens of unrelated failures.
    //
    // Nothing here is faked: the session is issued by the real server and the code read below is a
    // real, redeemable pairing code. Only the route taken to obtain them changed. The
    // unauthenticated redirect this fixture used to assert moved to e2e/auth-entry.spec.ts, which
    // owns the entry contract, so no coverage is lost in the move.
    const signIn = await fetch(`${harness.cloudUrl}/api/auth/sign-in/email`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: { "content-type": "application/json", origin: harness.cloudUrl },
      body: JSON.stringify({ email: harness.email, password: harness.password }),
    });
    if (!signIn.ok) throw new Error(`Pairing fixture sign-in failed (${signIn.status})`);
    await signIn.arrayBuffer();
    const setCookies = signIn.headers.getSetCookie();
    if (setCookies.length === 0) throw new Error("Pairing fixture sign-in returned no session cookie");
    const page = await newPage();
    for (const header of setCookies) {
      const pair = cookiePair(header.split(";")[0] ?? "");
      if (!pair) continue;
      await page.context().addCookies([{ ...pair, url: harness.cloudUrl }]);
    }
    await page.goto(`${harness.cloudUrl}/pair`);
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

/** Splits one cookie header into the name/value pair `addCookies` expects. */
function cookiePair(header: string): { name: string; value: string } | null {
  const separator = header.indexOf("=");
  if (separator <= 0) return null;
  return { name: header.slice(0, separator), value: header.slice(separator + 1) };
}

export async function pairDesktop(page: Page, harness: Harness, code: string): Promise<void> {
  await page.goto(`${harness.desktopUrl}/sign-in`);
  await page.getByLabel("Pairing code", { exact: true }).fill(code);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page).toHaveURL(`${harness.desktopUrl}/app`);
  const response = await page.context().request.get(`${harness.desktopUrl}/api/auth/get-session`, { maxRedirects: 0 });
  expect(response.status()).toBe(200);
  expect((await response.json()).user?.email).toBe(harness.email);
}
