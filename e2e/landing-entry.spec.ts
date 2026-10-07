/** Acceptance for actual marketing files served by an owned offline fixture.
 * Sample work never contacts an account, provider or application API. */
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test as baseTest, type BrowserContext, type Page } from "@playwright/test";
import { z } from "zod";

const SITE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../www");
const OPTIONAL_STAGE = "/landing-workroom/v1/mascot-stage.js";
const STATE_FIXTURE_PATH = "/__landing_state_fixture";
const SAVED_STATE = {
  local: { "muster:landing-fixture:saved-choice": "keep-my-choice", "muster:landing-fixture:preference": "existing-preference" },
  session: { "muster:landing-fixture:draft": "An unsent visitor note" },
  cookie: { name: "muster_landing_fixture", value: "keep-owned-session" },
};
const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"], [".css", "text/css"],
  [".js", "text/javascript"], [".mjs", "text/javascript"],
  [".svg", "image/svg+xml"], [".png", "image/png"],
  [".webp", "image/webp"], [".woff2", "font/woff2"], [".json", "application/json"],
]);
interface LandingOptions { controlledClock?: boolean; disableWebGL?: boolean; failOptionalImport?: boolean; seedSavedState?: boolean }

const test = baseTest.extend<{
  openLanding: (width: number, reducedMotion?: boolean, javaScriptEnabled?: boolean, options?: LandingOptions) => Promise<Page>;
}, { landingUrl: string }>({
  landingUrl: [async ({ browserName: _browserName }, use) => {
    // No API, account state or existing service is needed. Missing resources
    // remain real 404s instead of falling back to the application document.
    const server = createServer(async (request, response) => {
      try {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        const target = resolve(SITE_ROOT, `.${decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)}`);
        if (request.method !== "GET" || !target.startsWith(`${SITE_ROOT}${sep}`)) {
          response.writeHead(403).end(); return;
        }
        const body = await readFile(target);
        response.writeHead(200, { "content-type": CONTENT_TYPES.get(extname(target)) ?? "application/octet-stream" }).end(body);
      } catch { response.writeHead(404).end(); }
    });
    await new Promise<void>((ready, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", ready); });
    const { port } = z.object({ port: z.number() }).parse(server.address());
    try { await use(`http://127.0.0.1:${port}`); } finally {
      server.closeAllConnections();
      await new Promise<void>((closed, reject) => server.close((error) => error ? reject(error) : closed()));
    }
  }, { scope: "worker" }],
  openLanding: async ({ browser, landingUrl }, use, testInfo) => {
    const contexts: BrowserContext[] = [];
    const errors: string[] = [];
    try {
      await use(async (width, reducedMotion = false, javaScriptEnabled = true, options = {}) => {
        const context = await browser.newContext({ viewport: { width, height: 900 }, javaScriptEnabled,
          reducedMotion: reducedMotion ? "reduce" : "no-preference" });
        contexts.push(context);
        if (options.disableWebGL) await context.addInitScript({ content: `
          const getContext = HTMLCanvasElement.prototype.getContext;
          HTMLCanvasElement.prototype.getContext = function (type, ...args) {
            return /webgl/i.test(type) ? null : Reflect.apply(getContext, this, [type, ...args]);
          };
        ` });
        await context.route("**/*", async (route) => {
          const request = route.request(); const url = new URL(request.url());
          if (url.origin !== landingUrl || request.method() !== "GET" || url.pathname.startsWith("/api/")) {
            errors.push(`Unexpected request: ${request.method()} ${url.origin}${url.pathname}`);
            return route.abort("blockedbyclient");
          }
          if (options.seedSavedState && url.pathname === STATE_FIXTURE_PATH) {
            return route.fulfill({ status: 200, contentType: "text/html", body: '<!doctype html><html><head><link rel="icon" href="data:,"></head><body>Owned state fixture</body></html>' });
          }
          if (options.failOptionalImport && url.pathname === OPTIONAL_STAGE) {
            return route.fulfill({ status: 503, contentType: "text/javascript", body: "" });
          }
          await route.continue();
        });
        const page = await context.newPage();
        if (options.controlledClock) await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("console", (message) => {
          if (message.type() !== "error") return;
          // Only the exact resource/WebGL failures injected by fallback tests
          // are expected; unrelated asset errors and promise rejections fail.
          if (options.failOptionalImport && message.location().url === `${landingUrl}${OPTIONAL_STAGE}` && message.text().includes("503")) return;
          if (options.disableWebGL && /^THREE\.WebGLRenderer: Error creating WebGL context\.?$/.test(message.text())) return;
          errors.push(`${message.location().url}: ${message.text()}`);
        });
        if (options.seedSavedState) {
          // Populate the same origin once, before product bootstrap. An init
          // script would reseed on reload and hide a regression that clears it.
          await page.goto(`${landingUrl}${STATE_FIXTURE_PATH}`, { waitUntil: "domcontentloaded" });
          await page.evaluate(({ local, session }) => {
            for (const [key, value] of Object.entries(local)) localStorage.setItem(key, value);
            for (const [key, value] of Object.entries(session)) sessionStorage.setItem(key, value);
          }, SAVED_STATE);
          await context.addCookies([{ ...SAVED_STATE.cookie, url: landingUrl, sameSite: "Lax" }]);
        }
        await page.goto(landingUrl, { waitUntil: "networkidle" });
        if (options.controlledClock) await page.clock.pauseAt(new Date("2026-01-01T00:05:00Z"));
        return page;
      });
      if (errors.length) await testInfo.attach("landing-browser-errors", { body: errors.join("\n"), contentType: "text/plain" });
      expect(errors, "Landing has no unhandled errors, third-party requests or API calls").toEqual([]);
    } finally { await Promise.all(contexts.map((context) => context.close())); }
  },
});

async function expectReadableEntry(page: Page) {
  const heading = page.getByRole("heading", { level: 1 });
  await expect(heading).toHaveCount(1); await expect(heading).toHaveText(/\S/);
  await expect(heading).toBeInViewport();
  await expect.poll(() => heading.evaluate((element) => [element, ...element.querySelectorAll("span")]
    .every((node) => Number(getComputedStyle(node).opacity) === 1))).toBe(true);
}
async function expectNoOverflow(page: Page, width: number) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
}
async function expectSavedState(page: Page) {
  expect(await page.evaluate(() => ({
    local: Object.entries(localStorage).sort(([a], [b]) => a.localeCompare(b)),
    session: Object.entries(sessionStorage).sort(([a], [b]) => a.localeCompare(b)),
    cookie: document.cookie.split(";").map((value) => value.trim()).sort().join("; "),
  })), "The exact pre-existing values survive without new stored state").toEqual({
    local: Object.entries(SAVED_STATE.local).sort(([a], [b]) => a.localeCompare(b)),
    session: Object.entries(SAVED_STATE.session).sort(([a], [b]) => a.localeCompare(b)),
    cookie: `${SAVED_STATE.cookie.name}=${SAVED_STATE.cookie.value}`,
  });
}
async function openReview(page: Page, scenario = "update") {
  await page.locator(`#tab-${scenario}`).click();
  const panel = page.locator("#handoff-panel");
  await panel.locator('[data-action="start"]').click();
  await expect(panel).toHaveAttribute("data-phase", "preparing");
  await expect(panel.locator(".work-log li")).toHaveCount(3);
  await panel.locator('[data-action="advance"]').click();
  await expect(panel).toHaveAttribute("data-phase", "review");
  await expect(panel.locator(".review-draft")).toBeVisible();
  await expect(panel.locator(".approval-line")).toBeVisible();
  return panel;
}

for (const width of [320, 390, 768, 1440]) {
  test(`entry and workroom remain readable without overflow at ${width}px`, async ({ openLanding }, testInfo) => {
    const page = await openLanding(width);
    await expectReadableEntry(page);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await expect(page.locator("body")).toBeFocused();
    await expect(page.locator('.hero-actions a[href="/app"]')).toBeVisible();
    await expect(page.locator('.hero-actions a[href="#workbench"]')).toBeVisible();
    await expectNoOverflow(page, width);
    await testInfo.attach(`landing-${width}`, { body: await page.screenshot(), contentType: "image/png" });
    for (const selector of ["#workbench", "#team", ".model-section", "#questions", ".closing"]) {
      const section = page.locator(selector); await section.scrollIntoViewIfNeeded();
      await expect(section).toBeVisible(); await expectNoOverflow(page, width);
    }
    await openReview(page); await expectNoOverflow(page, width);
  });
}

for (const scenario of ["update", "plan", "research"]) {
  for (const decision of ["approve", "draft"] as const) {
    test(`${scenario} produces an explicit ${decision} receipt and can be reset`, async ({ openLanding }) => {
      const page = await openLanding(390); const panel = await openReview(page, scenario);
      const draft = await panel.locator(".review-draft h4").innerText();
      await panel.locator(`[data-action="${decision}"]`).click();
      await expect(panel).toHaveAttribute("data-phase", "complete");
      await expect(panel).toHaveAttribute("data-outcome", decision === "approve" ? "approved" : "draft");
      await expect(panel.locator(".review-draft h4")).toHaveText(draft);
      await expect(panel.locator(".receipt-box")).toContainText(decision === "approve" ? /approved/i : /kept as a draft/i);
      await expect(panel.locator(".receipt-box")).toContainText(/nothing|unchanged|no venue/i);
      await expect(panel.locator(".demo-disclaimer")).toContainText(/sample data/i);
      await expect(panel.locator(".demo-disclaimer")).toContainText(/nothing is sent/i);
      await expect(panel.locator("#demo-content h3")).toBeFocused();
      await panel.locator('[data-action="reset"]').click();
      await expect(panel).toHaveAttribute("data-phase", "ready");
      await expect(panel.locator(".receipt-box")).toHaveCount(0);
      await expect(page.locator(`#tab-${scenario}`)).toHaveAttribute("aria-selected", "true");
    });
  }
}

test("the decision waits for the visitor and reset cancels unfinished work", async ({ openLanding }) => {
  const page = await openLanding(390, false, true, { controlledClock: true }); const panel = await openReview(page);
  await page.clock.fastForward(60_000);
  await expect(panel).toHaveAttribute("data-phase", "review"); await expect(panel.locator(".receipt-box")).toHaveCount(0);
  await page.locator("#reset-demo").click(); await expect(panel).toHaveAttribute("data-phase", "ready");
  await panel.locator('[data-action="start"]').click(); await page.locator("#reset-demo").click();
  await page.clock.fastForward(60_000);
  await expect(panel).toHaveAttribute("data-phase", "ready"); await expect(panel.locator(".receipt-box, .review-draft")).toHaveCount(0);
});

test("scenario tabs preserve one selection and support roving keyboard navigation", async ({ openLanding }) => {
  const page = await openLanding(768); const tabs = page.getByRole("tablist", { name: "Choose an example" });
  await page.locator("#tab-update").focus();
  for (const [key, scenario] of [["ArrowRight", "plan"], ["End", "research"], ["ArrowRight", "update"], ["ArrowLeft", "research"], ["Home", "update"]] as const) {
    await page.keyboard.press(key); const tab = page.locator(`#tab-${scenario}`);
    await expect(tab).toBeFocused(); await expect(tab).toHaveAttribute("aria-selected", "true");
    await expect(tabs.locator('[aria-selected="true"]')).toHaveCount(1); await expect(tabs.locator('[tabindex="0"]')).toHaveCount(1);
    await expect(page.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", `tab-${scenario}`);
  }
  await openReview(page, "plan"); await page.locator("#tab-research").click();
  await expect(page.locator("#handoff-panel")).toHaveAttribute("data-phase", "ready");
  await expect(page.locator(".review-draft, .receipt-box")).toHaveCount(0);
});

test("keyboard entry, review, draft and replay work without pointer input", async ({ openLanding }) => {
  const page = await openLanding(390); await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  const entry = page.locator('.hero-actions a[href="#workbench"]');
  for (let step = 0; step < 20 && !await entry.evaluate((node) => node === document.activeElement); step += 1) await page.keyboard.press("Tab");
  await expect(entry).toBeFocused(); await page.keyboard.press("Enter"); await expect(page).toHaveURL(/#workbench$/);
  await page.locator('#demo-content [data-action="start"]').focus(); await page.keyboard.press("Enter");
  await expect(page.locator("#demo-content h3")).toBeFocused(); await page.keyboard.press("Tab");
  await expect(page.locator('[data-action="advance"]')).toBeFocused(); await page.keyboard.press("Enter");
  await expect(page.locator("#demo-content h3")).toBeFocused(); await page.keyboard.press("Tab");
  await expect(page.locator('[data-action="approve"]')).toBeFocused(); await page.keyboard.press("Tab");
  await expect(page.locator('[data-action="draft"]')).toBeFocused(); await page.keyboard.press("Enter");
  await expect(page.locator(".receipt-box")).toContainText(/draft/i); await page.keyboard.press("Tab");
  await expect(page.locator('[data-action="reset"]')).toBeFocused(); await page.keyboard.press("Enter");
  await expect(page.locator("#handoff-panel")).toHaveAttribute("data-phase", "ready");
});

test("mobile navigation and FAQ disclosures are keyboard operable", async ({ openLanding }) => {
  const page = await openLanding(320, true); const menu = page.locator("#menu-toggle");
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  await menu.focus(); await page.keyboard.press("Enter"); await expect(menu).toHaveAttribute("aria-expanded", "true");
  await expect(nav).toBeVisible(); await page.keyboard.press("Escape"); await expect(menu).toBeFocused();
  await expect(menu).toHaveAttribute("aria-expanded", "false"); await expect(nav).toBeHidden();
  const faq = page.locator(".faqs details").first(); await faq.locator("summary").focus(); await page.keyboard.press("Enter");
  await expect(faq).toHaveAttribute("open", ""); await expect(faq.locator("p")).toBeVisible();
  await page.keyboard.press("Enter"); await expect(faq).not.toHaveAttribute("open", "");
});

test("following a mobile navigation link closes the menu without trapping focus", async ({ openLanding }) => {
  const page = await openLanding(320);
  await page.locator("#menu-toggle").click();
  await page.locator('#site-nav a[href="#workbench"]').click();
  await expect(page).toHaveURL(/#workbench$/);
  await expect(page.locator("#menu-toggle")).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#site-nav")).toBeHidden();
  await page.locator("#tab-update").focus();
  await expect(page.locator("#tab-update")).toBeFocused();
});

test("role examples open the matching sample instead of creating or sending work", async ({ openLanding }) => {
  const page = await openLanding(768);
  for (const scenario of ["research", "plan", "update"]) {
    const row = page.locator(".role-row").filter({ has: page.locator(`[data-try="${scenario}"]`) });
    if (!await row.evaluate((node) => node.hasAttribute("open"))) await row.locator("summary").click();
    await row.locator(`[data-try="${scenario}"]`).click();
    await expect(page.locator(`#tab-${scenario}`)).toBeFocused();
    await expect(page.locator(`#tab-${scenario}`)).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#handoff-panel")).toHaveAttribute("data-phase", "ready");
    await expect(page.locator(".receipt-box")).toHaveCount(0);
  }
});

test("sample work preserves cookies and browser storage and sends no data", async ({ openLanding }) => {
  const page = await openLanding(390, false, true, { seedSavedState: true });
  await expectSavedState(page);
  const dataRequests: string[] = [];
  page.on("request", (request) => {
    // Lazy local modules/images/fonts are allowed; fetch/XHR/beacon/form
    // navigation has no role in the sample's user interaction.
    if (!["script", "image", "font", "stylesheet"].includes(request.resourceType())) dataRequests.push(`${request.method()} ${request.url()}`);
  });
  for (const scenario of ["update", "plan", "research"]) {
    for (const decision of ["approve", "draft"]) {
      const panel = await openReview(page, scenario); await expectSavedState(page);
      await panel.locator(`[data-action="${decision}"]`).click(); await expectSavedState(page);
      await page.locator("#reset-demo").click(); await expectSavedState(page);
    }
  }
  expect(dataRequests).toEqual([]);
});

test("reloading discards sample approval without changing a visitor's saved state", async ({ openLanding }) => {
  const page = await openLanding(390, false, true, { seedSavedState: true });
  await expectSavedState(page);
  const panel = await openReview(page);
  await panel.locator('[data-action="approve"]').click();
  await expect(panel.locator(".receipt-box")).toBeVisible();
  await expectSavedState(page);
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.locator("#handoff-panel")).toHaveAttribute("data-phase", "ready");
  await expect(page.locator(".receipt-box")).toHaveCount(0);
  await expectSavedState(page);
});

for (const width of [320, 1440]) {
  test(`HTML alone keeps the brief, navigation and public destinations usable at ${width}px`, async ({ openLanding }) => {
    const page = await openLanding(width, false, false); await expectReadableEntry(page);
    await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
    await expect(page.locator("#demo-content h3")).toHaveText(/\S/);
    await expect(page.locator("#demo-content .brief-box li")).toHaveCount(3);
    await expect(page.locator("#demo-content button")).toBeDisabled();
    await expect(page.locator("#hello-button")).toBeDisabled(); await expect(page.locator("#motion-toggle")).toBeDisabled();
    const image = page.locator("#hero-mascot img"); await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((node) => node instanceof HTMLImageElement && node.complete && node.naturalWidth > 0)).toBe(true);
    for (const href of ["/app", "/docs", "/privacy-policy", "/Terms-of-Service"]) await expect(page.locator(`a[href="${href}"]`).first()).toBeVisible();
    const desktopDownload = page.getByRole("link", { name: /Get the desktop app/ });
    await expect(desktopDownload).toBeVisible();
    await expect(desktopDownload).toHaveAttribute("href", "/download.html");
    const faq = page.locator(".faqs details").first(); await faq.locator("summary").click(); await expect(faq.locator("p")).toBeVisible();
    await expectNoOverflow(page, width);
  });
}

test("canonical metadata, visible FAQs and internal destinations agree", async ({ openLanding }) => {
  const page = await openLanding(1440);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", "https://muster.today/");
  await expect(page.locator('meta[property="og:url"]')).toHaveAttribute("content", "https://muster.today/");
  expect(await page.locator('meta[name="google-site-verification"]').count()).toBeGreaterThanOrEqual(2);
  const description = await page.locator('meta[name="description"]').getAttribute("content"); expect(description).toMatch(/Muster|AI|team|companion/i);
  await expect(page.locator('meta[property="og:description"]')).toHaveAttribute("content", description ?? "");
  await expect(page.locator('meta[name="twitter:description"]')).toHaveAttribute("content", description ?? "");
  const blocks = page.locator('script[type="application/ld+json"]'); await expect(blocks).toHaveCount(1);
  const graph = z.object({ "@graph": z.array(z.unknown()) }).parse(JSON.parse(await blocks.innerText()));
  const faqSchema = z.object({ "@type": z.literal("FAQPage"), mainEntity: z.array(z.object({ name: z.string(), acceptedAnswer: z.object({ text: z.string() }) })) });
  const faqs = graph["@graph"].map((entry) => faqSchema.safeParse(entry)).filter((entry) => entry.success); expect(faqs).toHaveLength(1);
  const faq = faqs[0]; if (!faq?.success) throw new Error("FAQ structured data is missing");
  expect(faq.data.mainEntity.length).toBeGreaterThan(0);
  for (const item of faq.data.mainEntity) {
    const row = page.locator(".faqs details").filter({ has: page.locator("summary", { hasText: item.name }) });
    await expect(row).toHaveCount(1); await expect(row.locator("p")).toHaveText(item.acceptedAnswer.text);
  }
  const fragments = await page.locator('a[href^="#"]').evaluateAll((links) => links.map((link) => link.getAttribute("href")?.slice(1) ?? "").filter(Boolean));
  for (const fragment of new Set(fragments)) await expect(page.locator(`[id="${fragment}"]`)).toHaveCount(1);
  await expect(page.locator('a[href*="127.0.0.1"], a[href*="localhost"], a[href*="github.com"], a[href*="/research/"]')).toHaveCount(0);
  await expect(page.locator('.closing a[href="/download.html"]')).toBeVisible();
});

test("provider costs, workspace separation and companion availability remain qualified", async ({ openLanding }) => {
  const page = await openLanding(390);
  await expect(page.locator(".cost-note")).toContainText(/AI usage is separate|provider.*separate/i);
  await expect(page.locator(".model-section")).toContainText(/availability depends|supported model/i);
  const platform = page.locator(".faqs details").filter({ has: page.locator("summary", { hasText: /where can I use/i }) });
  await platform.locator("summary").click(); await expect(platform).toContainText(/does not automatically merge|distinct/i); await expect(platform).toContainText(/beta/i);
  const actions = page.locator(".faqs details").filter({ has: page.locator("summary", { hasText: /act in my other tools/i }) });
  await actions.locator("summary").click(); await expect(actions).toContainText(/permissions/i); await expect(actions).toContainText(/depend/i);
  await expect(page.locator('a[href="/privacy-policy"]')).toBeVisible(); await expect(page.locator('a[href="/Terms-of-Service"]')).toBeVisible();
});

test("reduced motion keeps the work interactive without automatic mascot movement", async ({ openLanding }) => {
  const page = await openLanding(390, true); await expectReadableEntry(page);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe("auto");
  await expect(page.locator("#motion-toggle")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#hero-mascot")).toHaveAttribute("data-mascot-paused", "true");
  const progress = await page.locator("#hero-mascot").getAttribute("data-mascot-progress");
  await page.clock.install(); await page.clock.fastForward(5000);
  expect(await page.locator("#hero-mascot").getAttribute("data-mascot-progress")).toBe(progress);
  const panel = await openReview(page); await panel.locator('[data-action="draft"]').click();
  await expect(panel.locator(".receipt-box")).toContainText(/draft/i);
});

for (const reducedMotion of [false, true]) {
  test(`keyboard greeting is finite with reduced motion ${reducedMotion}`, async ({ openLanding }) => {
    const page = await openLanding(390, reducedMotion, true, { controlledClock: true });
    const hero = page.locator("#hero-mascot");
    await expect(hero).toHaveAttribute("data-mascot-ready", "true");
    const greeting = page.locator("#hero-state"); const initial = await greeting.innerText();
    await page.locator("#hello-button").focus(); await page.keyboard.press("Enter");
    await expect(greeting).not.toHaveText(initial);
    await expect(hero).toHaveAttribute("data-mascot-paused", String(reducedMotion));
    await page.clock.fastForward(4000);
    await expect(greeting).toHaveText(initial);
    await expect(hero).toHaveAttribute("data-mascot-state", "idle");
    await expect(page.locator("#hello-button")).toBeFocused();
  });
}

test("motion can be paused and resumed without resetting the task", async ({ openLanding }) => {
  const page = await openLanding(390, false, true, { controlledClock: true });
  const hero = page.locator("#hero-mascot");
  await expect(hero).toHaveAttribute("data-mascot-ready", "true");
  await page.locator("#motion-toggle").click();
  await expect(hero).toHaveAttribute("data-mascot-paused", "true");
  await expect(hero.locator("canvas")).toBeInViewport();
  const progress = await hero.getAttribute("data-mascot-progress");
  await page.clock.runFor(1000);
  expect(await hero.getAttribute("data-mascot-progress")).toBe(progress);
  const panel = await openReview(page);
  await page.locator("#motion-toggle").click();
  await expect(hero).toHaveAttribute("data-mascot-paused", "false");
  await expect(hero.locator("canvas")).toBeInViewport();
  // Scrolling back into view resets the first frame's delta. Run a frame
  // cadence, rather than fastForward's single callback, to observe motion.
  await expect.poll(async () => {
    await page.clock.runFor(200);
    return Number(await hero.getAttribute("data-mascot-progress"));
  }).toBeGreaterThan(Number(progress));
  await expect(panel).toHaveAttribute("data-phase", "review");
});

test("losing an initialized graphics context restores the portrait and preserves the task", async ({ openLanding }) => {
  const page = await openLanding(390);
  const hero = page.locator("#hero-mascot");
  await expect(hero).toHaveAttribute("data-mascot-ready", "true");
  const panel = await openReview(page);
  await hero.locator("canvas").evaluate((node) => {
    if (!(node instanceof HTMLCanvasElement)) throw new Error("Expected the companion canvas");
    const extension = node.getContext("webgl2")?.getExtension("WEBGL_lose_context");
    if (!extension) throw new Error("The owned browser cannot inject graphics-context loss");
    extension.loseContext();
  });
  await expect(hero.locator("img")).toBeVisible();
  await expect(page.locator("#mascot-status")).toContainText(/unavailable/i);
  await expect(page.locator("#motion-toggle")).toBeDisabled();
  await expect(page.locator("#hello-button")).toBeDisabled();
  await expect(panel).toHaveAttribute("data-phase", "review");
  await panel.locator('[data-action="draft"]').click();
  await expect(panel.locator(".receipt-box")).toContainText(/draft/i);
});

test("restoring a graphics context preserves the explicit pause and pending review", async ({ openLanding }) => {
  const page = await openLanding(390);
  const hero = page.locator("#hero-mascot");
  await expect(hero).toHaveAttribute("data-mascot-ready", "true");
  await page.locator("#motion-toggle").click();
  await expect(hero).toHaveAttribute("data-mascot-paused", "true");
  const panel = await openReview(page, "plan");
  const draft = await panel.locator(".review-draft").innerText();
  const extension = await hero.locator("canvas").evaluateHandle((node) => {
    if (!(node instanceof HTMLCanvasElement)) throw new Error("Expected the companion canvas");
    const control = node.getContext("webgl2")?.getExtension("WEBGL_lose_context");
    if (!control) throw new Error("The owned browser cannot inject graphics-context recovery");
    return control;
  });
  try {
    await extension.evaluate((control) => control.loseContext());
    await expect(hero).toHaveAttribute("data-mascot-ready", "false");
    await expect(hero.locator("img")).toBeVisible();
    await expect(page.locator("#motion-toggle")).toBeDisabled();
    await expect(panel).toHaveAttribute("data-phase", "review");
    await extension.evaluate((control) => control.restoreContext());
    await expect(hero).toHaveAttribute("data-mascot-ready", "true");
    await expect(hero.locator("img")).toHaveAttribute("aria-hidden", "true");
    await expect(hero.locator("img")).toHaveCSS("opacity", "0");
    await expect(hero.locator("canvas")).toBeVisible();
    await expect(page.locator("#mascot-status")).toContainText(/available again/i);
    await expect(page.locator("#motion-toggle")).toBeEnabled();
    await expect(page.locator("#motion-toggle")).toHaveAttribute("aria-pressed", "true");
    await expect(hero).toHaveAttribute("data-mascot-paused", "true");
    await expect(page.locator("#hello-button")).toBeEnabled();
    await expect(page.locator("#tab-plan")).toHaveAttribute("aria-selected", "true");
    await expect(panel).toHaveAttribute("data-phase", "review");
    await expect(panel.locator(".review-draft")).toHaveText(draft, { useInnerText: true });
    await expect(panel.locator(".receipt-box")).toHaveCount(0);
    await panel.locator('[data-action="approve"]').click();
    await expect(panel.locator(".receipt-box")).toContainText(/approved/i);
  } finally { await extension.dispose(); }
});

for (const failure of ["webgl", "module"] as const) {
  test(`${failure} failure keeps a static companion and the workroom usable`, async ({ openLanding }) => {
    const page = await openLanding(390, false, true, { disableWebGL: failure === "webgl", failOptionalImport: failure === "module" });
    const fallback = page.locator("#hero-mascot img"); await expect(fallback).toBeVisible();
    await expect.poll(() => fallback.evaluate((node) => node instanceof HTMLImageElement && node.complete && node.naturalWidth > 0)).toBe(true);
    await expect(page.locator("#mascot-status")).toHaveText(/unavailable|static|3D graphics|could not|couldn.t/i);
    await expect(page.locator("#hello-button")).toBeDisabled(); await expect(page.locator("#motion-toggle")).toBeDisabled();
    const panel = await openReview(page, "research"); await panel.locator('[data-action="approve"]').click();
    await expect(panel.locator(".receipt-box")).toContainText(/approved/i); await expectNoOverflow(page, 390);
  });
}
