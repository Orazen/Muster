/** Auth entry acceptance on owned cloud/desktop servers. Provider/OTP answers
 * are explicitly synthetic; password sessions and pairing use the real routes. */
import { expect, test as baseTest, type BrowserContext, type Page, type Route } from "@playwright/test";
import { startPairingHarness } from "./pairing-harness.ts";

type Harness = Awaited<ReturnType<typeof startPairingHarness>>;
type AuthCapabilities = ReturnType<typeof import("../server/auth.ts").authCapabilities>;
type OpenOptions = {
  width?: number;
  reducedMotion?: boolean;
  expectedHttpErrors?: Array<{ path: string; status: number; count: number }>;
};

const test = baseTest.extend<{
  harness: Harness;
  openAuth: (origin: string, options?: OpenOptions) => Promise<Page>;
}>({
  harness: async ({ browserName: _browserName }, use) => {
    const harness = await startPairingHarness();
    try { await use(harness); } finally { await harness.stop(); }
  },
  openAuth: async ({ browser, harness }, use, testInfo) => {
    const contexts: BrowserContext[] = [];
    const unexpected: string[] = [];
    const budgets: Array<{ url: string; status: number; expected: number; seen: number }> = [];
    try {
      await use(async (origin, options = {}) => {
        const allowed = new Set([harness.cloudUrl, harness.desktopUrl]);
        expect(allowed.has(origin), "Auth pages must use this test's owned server").toBe(true);
        const context = await browser.newContext({
          viewport: { width: options.width ?? 390, height: 900 },
          reducedMotion: options.reducedMotion ? "reduce" : "no-preference",
        });
        contexts.push(context);
        await context.addInitScript(() => {
          try { localStorage.setItem("muster:analytics-opt-out", "1"); } catch { /* opaque initial document */ }
        });
        await context.route("**/*", async (route) => {
          const url = new URL(route.request().url());
          if (allowed.has(url.origin)) return route.continue();
          unexpected.push(`External request: ${url.origin}${url.pathname}`);
          await route.abort("blockedbyclient");
        });
        const page = await context.newPage();
        const pageBudgets = (options.expectedHttpErrors ?? []).map((entry) => ({
          url: origin + entry.path, status: entry.status, expected: entry.count, seen: 0,
        }));
        budgets.push(...pageBudgets);
        page.on("pageerror", (error) => unexpected.push(error.message));
        page.on("console", (message) => {
          if (message.type() !== "error") return;
          const budget = pageBudgets.find((entry) => entry.url === message.location().url
            && new RegExp(`^Failed to load resource:.*\\b${entry.status}\\b`).test(message.text())
            && entry.seen < entry.expected);
          if (budget) budget.seen += 1;
          else unexpected.push(`${message.location().url}: ${message.text()}`);
        });
        return page;
      });
      for (const budget of budgets) expect(budget.seen, `Expected HTTP ${budget.status} at ${budget.url}`).toBe(budget.expected);
      if (unexpected.length) await testInfo.attach("auth-browser-errors", { body: unexpected.join("\n"), contentType: "text/plain" });
      expect(unexpected, "No unhandled errors or external authentication traffic").toEqual([]);
    } finally {
      await Promise.all(contexts.map((context) => context.close()));
    }
  },
});

async function showPassword(page: Page) {
  const switcher = page.getByText("Use a password instead", { exact: true });
  if (await switcher.count() && !await page.getByLabel("Password", { exact: true }).isVisible()) await switcher.click();
  await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
}

async function signIn(page: Page, harness: Harness) {
  await showPassword(page);
  await page.getByLabel("Email address", { exact: true }).fill(harness.email);
  await page.getByLabel("Password", { exact: true }).fill(harness.password);
  await page.getByRole("button", { name: "Sign in with email", exact: true }).click();
}

async function overrideCapabilities(page: Page, origin: string, patch: Partial<AuthCapabilities>) {
  await page.route(`${origin}/api/auth-capabilities`, async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), ...patch } });
  });
}

async function expectFits(page: Page, width: number) {
  const geometry = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    shell: document.querySelector(".auth-shell")?.scrollWidth ?? 0,
  }));
  for (const [name, value] of Object.entries(geometry)) expect(value, `${name} horizontal extent`).toBeLessThanOrEqual(width + 1);
}

for (const width of [320, 390, 768, 1440]) {
  test(`auth entry remains usable at ${width}px with reduced motion`, async ({ harness, openAuth }, testInfo) => {
    const page = await openAuth(harness.cloudUrl, { width, reducedMotion: true });
    await overrideCapabilities(page, harness.cloudUrl, { emailOtp: true });
    await page.goto(`${harness.cloudUrl}/sign-in`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue with Google", exact: true })).toBeVisible();
    await expect(page.getByLabel("Email address for a sign-in code", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Password", { exact: true })).not.toBeVisible();
    await showPassword(page);
    await expect(page.getByRole("button", { name: "Sign in with email", exact: true })).toBeVisible();
    await expectFits(page, width);
    const moving = await page.locator(".auth-shell").evaluate((shell) => shell.getAnimations({ subtree: true })
      .filter((animation) => animation.playState === "running" && animation.effect?.getComputedTiming().duration !== 0).length);
    expect(moving, "Reduced motion stops decorative animations").toBe(0);
    const screenshot = testInfo.outputPath(`auth-entry-${width}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    await testInfo.attach(`auth-entry-${width}`, { path: screenshot, contentType: "image/png" });
  });
}

test("keyboard visitors can skip the welcome artwork and greet the mascot without submitting", async ({ harness, openAuth }) => {
  const page = await openAuth(harness.cloudUrl, { width: 320, reducedMotion: true });
  await overrideCapabilities(page, harness.cloudUrl, { emailOtp: true });
  let submits = 0;
  page.on("request", (request) => { if (request.method() === "POST") submits += 1; });
  await page.goto(`${harness.cloudUrl}/sign-in`);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to form", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#auth-form")).toBeFocused();
  const email = page.getByLabel("Email address for a sign-in code", { exact: true });
  await email.fill("keep-this-draft@example.test");
  const mascot = page.getByRole("button", { name: "Wave to Muster", exact: true });
  await mascot.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status")).toHaveText("Hello from Muster.");
  await expect(email).toHaveValue("keep-this-draft@example.test");
  await page.getByRole("link", { name: "Get the desktop app", exact: false }).scrollIntoViewIfNeeded();
  await expect(page.getByRole("link", { name: "Get the desktop app", exact: false })).toBeInViewport();
  await expectFits(page, 320);
  expect(submits).toBe(0);
});

test("the welcome layout keeps signup and recovery reachable on a small screen", async ({ harness, openAuth }) => {
  const page = await openAuth(harness.cloudUrl, { width: 320 });
  await page.goto(`${harness.cloudUrl}/sign-up`);
  await expect(page.getByRole("heading", { name: "Create your account", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue with Google", exact: true })).toBeVisible();
  await expectFits(page, 320);
  await page.goto(`${harness.cloudUrl}/reset-password`);
  await expect(page.getByText("This link is missing its reset token", { exact: false })).toBeVisible();
  await page.getByRole("link", { name: "Request a new one", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Reset your password", exact: true })).toBeVisible();
  await expect(page.getByText("Password reset is not available here.", { exact: false })).toBeVisible();
  await expectFits(page, 320);
  await page.getByRole("link", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your day, with Muster.", exact: true })).toBeVisible();
});

test("unconfigured optional methods leave the password path available", async ({ harness, openAuth }) => {
  const page = await openAuth(harness.cloudUrl);
  await overrideCapabilities(page, harness.cloudUrl, { socialProviders: [], desktopOAuth: false, emailOtp: false });
  await page.goto(`${harness.cloudUrl}/sign-in`);
  await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue with Google", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Email address for a sign-in code", { exact: true })).toHaveCount(0);
});

for (const outcome of ["reject", "refuse"] as const) {
  test(`desktop Google ${outcome} returns to an actionable sign-in`, async ({ harness, openAuth }) => {
    const page = await openAuth(harness.desktopUrl, { width: 320 });
    await page.addInitScript((mode) => {
      Object.defineProperty(window, "ogb", { value: {
        openAuthHandoff: async (url: string) => {
          sessionStorage.setItem("auth-fixture:handoff-url", url);
          if (mode === "reject") throw new Error("Owned handoff fixture rejection");
          return false;
        },
      } });
    }, outcome);
    const next = "/pair?return=%2Fapp#owned";
    await page.goto(`${harness.desktopUrl}/sign-in?ref=REF-DESKTOP&next=${encodeURIComponent(next)}`);
    await page.getByRole("button", { name: "Continue with Google", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Could not open Google sign-in. Please try again.");
    await expect(page.getByRole("button", { name: "Continue with Google", exact: true })).toBeEnabled();
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem("muster.referral"))).toBeNull();
    const opened = new URL(await page.evaluate(() => sessionStorage.getItem("auth-fixture:handoff-url")) ?? "");
    expect(opened.origin).toBe(harness.cloudUrl);
    expect(opened.searchParams.get("redirect")).toBe(harness.desktopUrl);
    expect(opened.searchParams.get("next")).toBe(next);
    await expect(page.getByLabel("Pairing code", { exact: true })).toBeVisible();
    await expectFits(page, 320);
  });
}

test("desktop Google begin failure clears the referral held for that attempt", async ({ harness, openAuth }) => {
  const page = await openAuth(harness.desktopUrl, {
    width: 320,
    expectedHttpErrors: [{ path: "/oauth/attempt/begin", status: 503, count: 1 }],
  });
  await page.route(`${harness.desktopUrl}/oauth/attempt/begin`, (route) =>
    route.fulfill({ status: 503, json: { error: "attempt store unavailable" } }),
  );
  await page.goto(`${harness.desktopUrl}/sign-in?ref=REF-BEGIN&next=${encodeURIComponent("/pair")}`);
  await page.getByRole("button", { name: "Continue with Google", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Could not start Google sign-in. Please try again.");
  await expect(page.getByRole("button", { name: "Continue with Google", exact: true })).toBeEnabled();
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("muster.referral"))).toBeNull();
  await expectFits(page, 320);
});

test("existing session continues to its local next target without another sign-in", async ({ harness, openAuth }) => {
  const page = await openAuth(harness.cloudUrl);
  const response = await page.request.post(`${harness.cloudUrl}/api/auth/sign-in/email`, { data: { email: harness.email, password: harness.password } });
  expect(response.status()).toBe(200);
  let signInRequests = 0;
  page.on("request", (request) => { if (request.method() === "POST" && new URL(request.url()).pathname.startsWith("/api/auth/sign-in/")) signInRequests += 1; });
  await page.goto(`${harness.cloudUrl}/sign-in?next=${encodeURIComponent("/pair#owned")}`);
  await expect(page.getByText(`Already signed in as ${harness.email}.`, { exact: false })).toBeVisible();
  await page.getByRole("button", { name: /^Continue as / }).click();
  await expect(page).toHaveURL(`${harness.cloudUrl}/pair#owned`);
  expect(signInRequests).toBe(0);
});

test("password sign-in rejects an external next destination", async ({ harness, openAuth }) => {
  const page = await openAuth(harness.cloudUrl);
  await page.goto(`${harness.cloudUrl}/sign-in?next=${encodeURIComponent("/a/..//example.invalid/account")}`);
  await signIn(page, harness);
  await expect(page).toHaveURL(`${harness.cloudUrl}/app`);
  const session = await page.request.get(`${harness.cloudUrl}/api/auth/get-session`);
  expect((await session.json()).user.email).toBe(harness.email);
});

test("OTP error recovery preserves the address and verifies before local navigation", async ({ harness, openAuth }) => {
  const sendPath = "/api/auth/email-otp/send-verification-otp";
  const verifyPath = "/api/auth/sign-in/email-otp";
  const page = await openAuth(harness.cloudUrl, { width: 320, expectedHttpErrors: [{ path: verifyPath, status: 400, count: 1 }] });
  await overrideCapabilities(page, harness.cloudUrl, { emailOtp: true });
  await page.clock.install();
  const sends: Array<{ email: string; key: string | undefined }> = [];
  const verifications: string[] = [];
  await page.route(harness.cloudUrl + sendPath, async (route) => {
    sends.push({ email: route.request().postDataJSON().email, key: route.request().headers()["idempotency-key"] });
    await route.fulfill({ json: { success: true } });
  });
  await page.route(harness.cloudUrl + verifyPath, async (route: Route) => {
    verifications.push(route.request().postDataJSON().otp);
    if (verifications.length === 1) {
      await route.fulfill({ status: 400, json: { code: "INVALID_OTP", message: "Invalid OTP" } });
      return;
    }
    // Synthetic OTP acceptance uses a real password-created fixture session.
    // No mail delivery or provider OTP validation is claimed by this test.
    const response = await route.fetch({ url: `${harness.cloudUrl}/api/auth/sign-in/email`,
      postData: JSON.stringify({ email: harness.email, password: harness.password }) });
    expect(response.status()).toBe(200);
    await route.fulfill({ response });
  });
  await page.goto(`${harness.cloudUrl}/sign-in?next=${encodeURIComponent("/pair#otp-verified")}`);
  await page.getByLabel("Email address for a sign-in code", { exact: true }).fill(harness.email);
  await page.getByRole("button", { name: "Email me a code", exact: true }).click();
  const code = page.getByLabel("6-digit code", { exact: true });
  await expect(code).toBeVisible();
  await expect(code).toHaveAttribute("autocomplete", "one-time-code");
  await expect(code).toHaveAttribute("inputmode", "numeric");
  await code.evaluate((element) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text", "111 111");
    element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
  });
  await expect(code).toHaveValue("111111");
  await page.getByRole("button", { name: "Verify and sign in", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("That code isn’t right.");
  await expect(code).toHaveValue("111111");
  await expect(page).toHaveURL(/\/sign-in\?/);
  await expectFits(page, 320);
  await page.getByRole("button", { name: "Use a different email", exact: true }).click();
  await expect(page.getByLabel("Email address for a sign-in code", { exact: true })).toHaveValue(harness.email);
  await expect(page.getByRole("button", { name: /^Try again in \d+s$/ })).toBeDisabled();
  await page.clock.runFor(61_000);
  await page.getByRole("button", { name: "Email me a code", exact: true }).click();
  await code.fill("222222");
  await page.getByRole("button", { name: "Verify and sign in", exact: true }).click();
  await expect(page).toHaveURL(`${harness.cloudUrl}/pair#otp-verified`);
  expect(verifications).toEqual(["111111", "222222"]);
  expect(sends.map((send) => send.email)).toEqual([harness.email, harness.email]);
  expect(sends.every((send) => Boolean(send.key))).toBe(true);
  expect(sends[0].key).not.toBe(sends[1].key);
});

test("OTP initial rate limit enforces the server wait before another send", async ({ harness, openAuth }) => {
  const sendPath = "/api/auth/email-otp/send-verification-otp";
  const page = await openAuth(harness.cloudUrl, { expectedHttpErrors: [{ path: sendPath, status: 429, count: 1 }] });
  await overrideCapabilities(page, harness.cloudUrl, { emailOtp: true });
  await page.clock.install();
  let sends = 0;
  await page.route(harness.cloudUrl + sendPath, async (route) => {
    sends += 1;
    await route.fulfill(sends === 1
      ? { status: 429, json: { code: "RATE_LIMITED", retryAfterSeconds: 3 } }
      : { json: { success: true } });
  });
  await page.goto(`${harness.cloudUrl}/sign-in`);
  await page.getByLabel("Email address for a sign-in code", { exact: true }).fill(harness.email);
  await page.getByRole("button", { name: "Email me a code", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Please wait 3 seconds");
  await expect(page.getByRole("button", { name: "Try again in 3s", exact: true })).toBeDisabled();
  await page.getByLabel("Email address for a sign-in code", { exact: true }).fill("another-mailbox@example.test");
  await expect(page.getByRole("button", { name: /^Try again in \d+s$/ })).toBeDisabled();
  expect(sends).toBe(1);
  await page.clock.runFor(4_000);
  await page.getByRole("button", { name: "Email me a code", exact: true }).click();
  await expect(page.getByLabel("6-digit code", { exact: true })).toBeVisible();
  expect(sends).toBe(2);
});

test("desktop handoff waits for a verified session and can be cancelled", async ({ harness, openAuth }) => {
  const page = await openAuth(harness.desktopUrl);
  await page.addInitScript(() => {
    Object.defineProperty(window, "ogb", { value: {
      openAuthHandoff: async () => {
        sessionStorage.setItem("auth-fixture:launches", String(Number(sessionStorage.getItem("auth-fixture:launches") ?? 0) + 1));
        return true;
      },
    } });
  });
  await page.goto(`${harness.desktopUrl}/sign-in?next=%2Fpair`);
  await page.getByRole("button", { name: "Continue with Google", exact: true }).click();
  await expect(page.getByRole("button", { name: "Finish Google sign-in…", exact: true })).toBeDisabled();
  await expect(page).toHaveURL(`${harness.desktopUrl}/sign-in?next=%2Fpair`);
  await page.getByRole("button", { name: "Cancel waiting", exact: true }).click();
  await expect(page.getByRole("button", { name: "Continue with Google", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => sessionStorage.getItem("auth-fixture:launches"))).toBe("1");
  await page.getByRole("button", { name: "Continue with Google", exact: true }).click();
  await expect(page.getByRole("button", { name: "Cancel waiting", exact: true })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("auth-fixture:launches"))).toBe("2");
  await page.getByRole("button", { name: "Cancel waiting", exact: true }).click();
});

test("desktop Google discards an old cookie even while initial session discovery is pending", async ({ harness, openAuth }) => {
  const page = await openAuth(harness.desktopUrl);
  const created = await page.request.post(`${harness.desktopUrl}/api/pair/claim/create`);
  expect(created.status()).toBe(201);
  const claimed = await page.request.post(`${harness.desktopUrl}/api/pair/claim`, { data: { code: (await created.json()).code } });
  expect(claimed.status()).toBe(200);
  expect((await (await page.request.get(`${harness.desktopUrl}/api/auth/get-session`)).json()).user.id).toBeTruthy();
  await page.addInitScript(() => {
    Object.defineProperty(window, "ogb", { value: { openAuthHandoff: async () => true } });
  });
  let release!: () => void;
  let observed!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const initialObserved = new Promise<void>((resolve) => { observed = resolve; });
  let reads = 0;
  let emptyPolls = 0;
  await page.route(`${harness.desktopUrl}/api/auth/get-session`, async (route) => {
    const initial = reads++ === 0;
    const response = await route.fetch();
    const body = await response.json();
    if (initial) {
      expect(body.user.id).toBeTruthy();
      observed();
      await held;
    } else if (body === null) emptyPolls += 1;
    await route.fulfill({ response, json: body });
  });
  try {
    await page.goto(`${harness.desktopUrl}/sign-in?next=%2Fpair`);
    await initialObserved;
    await page.getByRole("button", { name: "Continue with Google", exact: true }).click();
    await expect(page.getByRole("button", { name: "Cancel waiting", exact: true })).toBeVisible();
    await expect.poll(() => emptyPolls).toBeGreaterThan(0);
    release();
    expect(await (await page.request.get(`${harness.desktopUrl}/api/auth/get-session`)).json()).toBeNull();
    await expect(page).toHaveURL(`${harness.desktopUrl}/sign-in?next=%2Fpair`);
    await expect(page.getByRole("button", { name: /^Continue as / })).toHaveCount(0);
    await page.getByRole("button", { name: "Cancel waiting", exact: true }).click();
  } finally { release(); }
});

test("OTP mailbox cooldown permits a corrected address but remembers the original mailbox", async ({ harness, openAuth }) => {
  const page = await openAuth(harness.cloudUrl);
  await overrideCapabilities(page, harness.cloudUrl, { emailOtp: true });
  const addresses: string[] = [];
  await page.route(`${harness.cloudUrl}/api/auth/email-otp/send-verification-otp`, async (route) => {
    addresses.push(route.request().postDataJSON().email);
    await route.fulfill({ json: { success: true } });
  });
  await page.goto(`${harness.cloudUrl}/sign-in`);
  const email = page.getByLabel("Email address for a sign-in code", { exact: true });
  const original = "first-mailbox@example.test";
  const corrected = "corrected-mailbox@example.test";
  await email.fill(original);
  await page.getByRole("button", { name: "Email me a code", exact: true }).click();
  await expect(page.getByLabel("6-digit code", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Use a different email", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Try again in \d+s$/ })).toBeDisabled();
  await email.fill(corrected);
  await page.getByRole("button", { name: "Email me a code", exact: true }).click();
  await expect(page.getByLabel("6-digit code", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Use a different email", exact: true }).click();
  await email.fill(original.toUpperCase());
  await expect(page.getByRole("button", { name: /^Try again in \d+s$/ })).toBeDisabled();
  expect(addresses).toEqual([original, corrected]);
});

test("Google initiation alone never signs the login or signup page into a workspace", async ({ harness, openAuth }) => {
  const page = await openAuth(harness.cloudUrl);
  let initiated = 0;
  await page.route(`${harness.cloudUrl}/api/auth/sign-in/social`, async (route) => {
    expect(route.request().postDataJSON().callbackURL).toBe("/pair");
    initiated += 1;
    await route.fulfill({ json: { redirect: false } });
  });
  for (const path of ["/sign-in", "/sign-up"]) {
    await page.goto(`${harness.cloudUrl}${path}?next=%2Fpair`);
    const response = page.waitForResponse(`${harness.cloudUrl}/api/auth/sign-in/social`);
    await page.getByRole("button", { name: "Continue with Google", exact: true }).click();
    await response;
    await expect(page.getByRole("button", { name: "Continue with Google", exact: true })).toBeEnabled();
    await expect(page).toHaveURL(`${harness.cloudUrl}${path}?next=%2Fpair`);
  }
  expect(initiated).toBe(2);
});

test("an in-flight OTP send freezes its address and submits only once", async ({ harness, openAuth }) => {
  const page = await openAuth(harness.cloudUrl);
  await overrideCapabilities(page, harness.cloudUrl, { emailOtp: true });
  let sends = 0;
  let release!: () => void;
  const heldResponse = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`${harness.cloudUrl}/api/auth/email-otp/send-verification-otp`, async (route) => {
    sends += 1;
    await heldResponse;
    await route.fulfill({ json: { success: true } });
  });
  try {
    await page.goto(`${harness.cloudUrl}/sign-in`);
    const email = page.getByLabel("Email address for a sign-in code", { exact: true });
    await email.fill(harness.email);
    await email.evaluate((element) => {
      const form = element.closest("form");
      form?.requestSubmit();
      form?.requestSubmit();
    });
    await expect.poll(() => sends).toBe(1);
    await expect(email).toBeDisabled();
    await expect(page.getByRole("button", { name: "Sending…", exact: true })).toBeDisabled();
    release();
    await expect(page.getByLabel("6-digit code", { exact: true })).toBeVisible();
    expect(sends).toBe(1);
  } finally { release(); }
});

test("the pairing page sends a visitor to sign-in and keeps the local next target, then shows a real code", async ({ harness, openAuth }) => {
  // This redirect assertion used to live inside the shared pairCodeFromCloud fixture, which now
  // takes its session from the sign-in API and so can no longer reach the unauthenticated page.
  // It is the entry contract, so it is asserted here rather than dropped.
  const page = await openAuth(harness.cloudUrl);
  await page.goto(`${harness.cloudUrl}/pair`);
  await expect(page).toHaveURL(`${harness.cloudUrl}/sign-in?next=%2Fpair`);
  await signIn(page, harness);
  await expect(page).toHaveURL(`${harness.cloudUrl}/pair`);
  await expect(page.getByText(`Signed in as ${harness.email}.`, { exact: true })).toBeVisible();
  // The code reached by the direct-password route is a real redeemable code, not a stand-in, so
  // the fixture's move to the API did not weaken what these specs depend on.
  await expect(page.getByLabel("Pairing code", { exact: true })).toHaveValue(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
  await expect(page.getByRole("button", { name: "Copy code", exact: true })).toBeEnabled();
});

// ── Referral ref: preserved across navigation, redeemed only after a session ───

test("a referral survives the hand-off from sign-up to sign-in and is redeemed only after sign-in", async ({ harness, openAuth }) => {
  const page = await openAuth(harness.cloudUrl);
  const codes: string[] = [];
  await page.route(`${harness.cloudUrl}/api/referral/redeem`, async (route) => {
    codes.push(route.request().postDataJSON().code);
    await route.fulfill({ status: 200, json: { ok: true } });
  });

  await page.goto(`${harness.cloudUrl}/sign-up?ref=REF-42&next=${encodeURIComponent("/pair")}`);
  // Nothing may be redeemed before there is a session: the server answers 401 and the code is lost.
  expect(codes).toEqual([]);

  // The visitor already has an account, so the referral must follow them to sign-in rather than
  // being dropped at the boundary.
  await page.getByRole("link", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`ref=REF-42`));
  expect(codes).toEqual([]);

  await signIn(page, harness);
  await expect.poll(() => codes).toEqual(["REF-42"]);
  // A safe next is still honoured: the referral must not swallow the destination.
  await expect(page).toHaveURL(`${harness.cloudUrl}/pair`);
});

// Retitled with the feature: the previous name claimed the rejection is *reported*, which nothing
// does — the outcome is returned to the caller and no UI surfaces it. What is actually guaranteed
// (and what this asserts) is that a rejected code costs nobody their sign-in.
test("a rejected referral does not strand the sign-in it followed", async ({ harness, openAuth }) => {
  const page = await openAuth(harness.cloudUrl, { expectedHttpErrors: [{ path: "/api/referral/redeem", status: 400, count: 1 }] });
  await page.route(`${harness.cloudUrl}/api/referral/redeem`, (route) =>
    route.fulfill({ status: 400, json: { error: "that referral code isn't valid" } }),
  );
  await page.goto(`${harness.cloudUrl}/sign-in?ref=BAD-1&next=${encodeURIComponent("/pair")}`);
  await signIn(page, harness);
  // The whole point: a referral is a bonus, not an entitlement. A rejected code must not strand
  // someone who has just signed in.
  await expect(page).toHaveURL(`${harness.cloudUrl}/pair`);
  await expect(page.getByRole("button", { name: "Copy code", exact: true })).toBeEnabled();
});

// ── A stalled referral can never cost an authenticated user their navigation ───

const STALL_BUDGET_MS = 8000;

test("a referral endpoint that never answers cannot block password sign-in", async ({ harness, openAuth }) => {
  const page = await openAuth(harness.cloudUrl);
  await page.route(`${harness.cloudUrl}/api/referral/redeem`, () => { /* held open on purpose */ });

  await page.goto(`${harness.cloudUrl}/sign-in?ref=SLOW-1&next=${encodeURIComponent("/pair")}`);
  const started = Date.now();
  await signIn(page, harness);
  await expect(page).toHaveURL(`${harness.cloudUrl}/pair`, { timeout: STALL_BUDGET_MS });
  expect(Date.now() - started).toBeLessThan(STALL_BUDGET_MS);
});

test("a referral endpoint that never answers cannot block one-time-code sign-in", async ({ harness, openAuth }) => {
  const sendPath = "/api/auth/email-otp/send-verification-otp";
  const verifyPath = "/api/auth/sign-in/email-otp";
  const page = await openAuth(harness.cloudUrl);
  await overrideCapabilities(page, harness.cloudUrl, { emailOtp: true });
  await page.route(`${harness.cloudUrl}/api/referral/redeem`, () => { /* held open on purpose */ });
  await page.route(harness.cloudUrl + sendPath, (route) => route.fulfill({ json: { success: true } }));
  await page.route(harness.cloudUrl + verifyPath, async (route: Route) => {
    // Synthetic OTP acceptance backed by a real password-created fixture session. No mail delivery
    // or provider OTP validation is claimed.
    const response = await route.fetch({ url: `${harness.cloudUrl}/api/auth/sign-in/email`,
      postData: JSON.stringify({ email: harness.email, password: harness.password }) });
    await route.fulfill({ response });
  });

  await page.goto(`${harness.cloudUrl}/sign-in?ref=SLOW-2&next=${encodeURIComponent("/pair")}`);
  await page.getByLabel("Email address for a sign-in code", { exact: true }).fill(harness.email);
  await page.getByRole("button", { name: "Email me a code", exact: true }).click();
  const code = page.getByLabel("6-digit code", { exact: true });
  await expect(code).toBeVisible();
  await code.fill("111111");

  const started = Date.now();
  await page.getByRole("button", { name: "Verify and sign in", exact: true }).click();
  await expect(page).toHaveURL(`${harness.cloudUrl}/pair`, { timeout: STALL_BUDGET_MS });
  expect(Date.now() - started).toBeLessThan(STALL_BUDGET_MS);
});

test("a referral endpoint that never answers cannot block account creation", async ({ harness, openAuth }) => {
  const page = await openAuth(harness.cloudUrl);
  await page.route(`${harness.cloudUrl}/api/referral/redeem`, () => { /* held open on purpose */ });

  const email = `referral-stall-${Date.now()}@example.test`;
  await page.goto(`${harness.cloudUrl}/sign-up?ref=SLOW-3&next=${encodeURIComponent("/pair")}`);
  await page.getByLabel("Your name", { exact: true }).fill("Referral Stall");
  await page.getByLabel("Email address", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(harness.password);

  const started = Date.now();
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page).toHaveURL(`${harness.cloudUrl}/pair`, { timeout: STALL_BUDGET_MS });
  expect(Date.now() - started).toBeLessThan(STALL_BUDGET_MS);
});

// ── Google first-account signup: the one path that used to drop the code ───────

test("a Google first-account signup carries the referral across the return and redeems it once a session exists", async ({ harness, openAuth }) => {
  const page = await openAuth(harness.cloudUrl);
  const codes: string[] = [];
  await page.route(`${harness.cloudUrl}/api/referral/redeem`, async (route) => {
    codes.push(route.request().postDataJSON().code);
    await route.fulfill({ status: 200, json: { ok: true } });
  });
  // No real provider is contacted: initiation is answered locally, exactly as the existing
  // initiation spec does, so this stays a synthetic OAuth round trip.
  await page.route(`${harness.cloudUrl}/api/auth/sign-in/social`, (route) =>
    route.fulfill({ json: { redirect: false } }));

  await page.goto(`${harness.cloudUrl}/sign-up?ref=REF-G&next=${encodeURIComponent("/pair")}`);
  await page.getByRole("button", { name: "Continue with Google", exact: true }).click();

  // The carry: the code is held for the duration of the redirect, because the OAuth return carries
  // only the callback path and nothing else would still know it existed. The stash is a record now
  // (ref + destination + attempt + expiry), so read the code back out of it.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const raw = sessionStorage.getItem("muster.referral");
        if (!raw) return "";
        try {
          // SAFETY: this key is written only by stashReferral in src/lib/auth.tsx, which
          // serialises a schema-validated record whose `ref` is a non-empty string.
          const record = JSON.parse(raw) as { ref?: string };
          return record.ref ?? "";
        } catch {
          return "";
        }
      }),
    )
    .toBe("REF-G");
  expect(codes).toEqual([]);

  // The return itself: session already established, landing on `next`, no `ref` in the URL. That is
  // precisely the state in which the code used to be unrecoverable.
  await page.evaluate(async ({ email, password }) => {
    const response = await fetch("/api/auth/sign-in/email", {
      method: "POST", headers: { "content-type": "application/json" }, credentials: "include",
      body: JSON.stringify({ email, password }),
    });
    if (!response.ok) throw new Error(`fixture sign-in failed: ${response.status}`);
  }, { email: harness.email, password: harness.password });

  await page.goto(`${harness.cloudUrl}/pair`);
  await expect.poll(() => codes).toEqual(["REF-G"]);
});

// ── Capability failure, visible retry, repeated failure, successful recovery ────

test("a failed session discovery stays recoverable across two failures and a retry reveals methods without a reload", async ({ harness, openAuth }) => {
  const page = await openAuth(harness.cloudUrl, {
    expectedHttpErrors: [
      { path: "/api/auth/get-session", status: 503, count: 2 },
      { path: "/api/auth-capabilities", status: 503, count: 2 },
    ],
  });
  let failing = true;
  await page.route(`${harness.cloudUrl}/api/auth/get-session`, (route) =>
    failing
      ? route.fulfill({ status: 503, json: { error: "session store unavailable" } })
      : route.continue(),
  );
  await page.route(`${harness.cloudUrl}/api/auth-capabilities`, (route) =>
    failing
      ? route.fulfill({ status: 503, json: { error: "capabilities unavailable" } })
      : route.continue(),
  );

  await page.goto(`${harness.cloudUrl}/sign-in?next=${encodeURIComponent("/pair")}`);
  // A genuine failure is VISIBLE, with a retry control rather than a dead page. Both reads fail
  // here and each now reports on its own terms: the session error, and the capability error that
  // used to be swallowed. Naming both is the point — one generic `alert` locator stopped
  // resolving the moment a second, independently actionable notice could appear.
  const retry = page.getByRole("button", { name: "Check sign-in again", exact: true });
  await expect(page.getByRole("alert").filter({ hasText: "Muster couldn" })).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "Could not load which sign-in" })).toBeVisible();
  await expect(retry).toBeVisible();

  // A second failure must leave the visitor recoverable: still on the page, retry still offered.
  await retry.click();
  await expect(retry).toBeVisible();

  // Successful recovery makes the available methods visible with NO reload.
  failing = false;
  await retry.click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  const signInButton = page.getByRole("button", { name: "Sign in with email", exact: true });
  await expect(signInButton).toBeVisible();
  await signIn(page, harness);
  await expect(page).toHaveURL(`${harness.cloudUrl}/pair`);
});

test("a capability-only failure offers a retry, and that retry brings the hidden methods back", async ({ harness, openAuth }) => {
  // Rewritten with the feature it documents. The previous version asserted that a failed
  // /api/auth-capabilities read is swallowed on purpose - correct when written, because the code did
  // swallow it, and it is exactly the gap the review raised: a silent failure left no way to tell
  // "this server has no optional flows" from "the request never arrived". The failure is now
  // surfaced on its own, distinct from the session, with a retry whose success restores visibility.
  let failing = true;
  const page = await openAuth(harness.cloudUrl, {
    expectedHttpErrors: [{ path: "/api/auth-capabilities", status: 503, count: 1 }],
  });
  await page.route(`${harness.cloudUrl}/api/auth-capabilities`, (route) =>
    failing
      ? route.fulfill({ status: 503, json: { error: "capabilities unavailable" } })
      : route.continue(),
  );

  await page.goto(`${harness.cloudUrl}/sign-in?next=${encodeURIComponent("/pair")}`);
  await showPassword(page);

  // The password path survives untouched: it does not depend on the capabilities read.
  await expect(page.getByRole("button", { name: "Sign in with email", exact: true })).toBeVisible();
  // The SESSION is not claimed to be broken — that control belongs to session discovery.
  await expect(page.getByRole("button", { name: "Check sign-in again", exact: true })).toHaveCount(0);
  // The CAPABILITY failure is visible and actionable instead of silent.
  const capabilityRetry = page.getByRole("button", { name: "Check again", exact: true });
  await expect(capabilityRetry).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("Could not load which sign-in methods");

  // Methods the server could not vouch for stay withheld while the read is failing.
  await expect(page.getByRole("button", { name: "Continue with Google", exact: true })).toHaveCount(0);

  // One retry, no reload, and the previously hidden method is offered again.
  failing = false;
  await capabilityRetry.click();
  await expect(page.getByRole("button", { name: "Continue with Google", exact: true })).toBeVisible();
  await expect(capabilityRetry).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);

  await signIn(page, harness);
  await expect(page).toHaveURL(`${harness.cloudUrl}/pair`);
});

test("a real displayed pairing code signs the desktop into the same account at 320px", async ({ harness, openAuth }) => {
  const cloud = await openAuth(harness.cloudUrl, { width: 320 });
  await cloud.goto(`${harness.cloudUrl}/sign-in?next=%2Fpair`);
  await signIn(cloud, harness);
  await expect(cloud).toHaveURL(`${harness.cloudUrl}/pair`);
  const code = cloud.getByLabel("Pairing code", { exact: true });
  await expect(code).toHaveValue(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
  await expectFits(cloud, 320);
  const desktop = await openAuth(harness.desktopUrl, { width: 320 });
  await desktop.goto(`${harness.desktopUrl}/sign-in`);
  await desktop.getByLabel("Pairing code", { exact: true }).fill(await code.inputValue());
  await expectFits(desktop, 320);
  await desktop.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(desktop).toHaveURL(`${harness.desktopUrl}/app`);
  const session = await desktop.request.get(`${harness.desktopUrl}/api/auth/get-session`);
  expect((await session.json()).user.email).toBe(harness.email);
});
