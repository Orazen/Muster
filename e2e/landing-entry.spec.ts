/** Landing acceptance uses owned offline servers serving the actual marketing
 * source. Empty release feeds are explicit fixtures, not release evidence. */
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test as baseTest, type BrowserContext, type Page } from "@playwright/test";
import { z } from "zod";

const SITE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../www");
const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"], [".css", "text/css"],
  [".js", "text/javascript"], [".svg", "image/svg+xml"],
  [".png", "image/png"], [".webp", "image/webp"],
  [".woff2", "font/woff2"], [".json", "application/json"],
]);

const test = baseTest.extend<{
  openLanding: (width: number, reducedMotion?: boolean, javaScriptEnabled?: boolean) => Promise<Page>;
}, { landingUrl: string }>({
  landingUrl: [async ({ browserName: _browserName }, use) => {
    // The application server redirects / to authentication in this mode.
    // Serve the real www source separately; the landing needs no API or account.
    const server = createServer(async (request, response) => {
      try {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        const target = resolve(SITE_ROOT, `.${decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)}`);
        if (request.method !== "GET" || !target.startsWith(`${SITE_ROOT}${sep}`)) {
          response.writeHead(403).end();
          return;
        }
        const body = await readFile(target);
        response.writeHead(200, { "content-type": CONTENT_TYPES.get(extname(target)) ?? "application/octet-stream" }).end(body);
      } catch {
        response.writeHead(404).end();
      }
    });
    await new Promise<void>((ready, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", ready);
    });
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
      await use(async (width, reducedMotion = false, javaScriptEnabled = true) => {
        const context = await browser.newContext({
          viewport: { width, height: 900 }, javaScriptEnabled,
          reducedMotion: reducedMotion ? "reduce" : "no-preference",
        });
        contexts.push(context);
        await context.route("**/*", async (route) => {
          const url = new URL(route.request().url());
          if (url.origin !== landingUrl) {
            errors.push(`Unexpected external request: ${url.origin}${url.pathname}`);
            return route.abort("blockedbyclient");
          }
          if (url.pathname === "/downloads/latest.json" || url.pathname === "/downloads/releases.json") {
            return route.fulfill({ contentType: "application/json", body: url.pathname.endsWith("latest.json") ? "{}" : "[]" });
          }
          await route.continue();
        });
        const page = await context.newPage();
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("console", (message) => {
          if (message.type() === "error") errors.push(`${message.location().url}: ${message.text()}`);
        });
        await page.goto(landingUrl, { waitUntil: "networkidle" });
        return page;
      });
      if (errors.length) await testInfo.attach("landing-browser-errors", { body: errors.join("\n"), contentType: "text/plain" });
      expect(errors, "Landing has no unhandled errors or third-party requests").toEqual([]);
    } finally {
      await Promise.all(contexts.map((context) => context.close()));
    }
  },
});

async function expectVisibleHeadline(page: Page) {
  const heading = page.getByRole("heading", { level: 1 });
  await expect(heading).toHaveText("A personal AI team for your everyday work.");
  await expect(heading).toBeInViewport();
  // Visibility alone ignores opacity: the old animated letters occupied
  // space yet became transparent again when their entrance animation ended.
  await expect.poll(() => heading.evaluate((element) => {
    const targets = [element, ...element.querySelectorAll("span")];
    return targets.every((target) => Number(getComputedStyle(target).opacity) === 1);
  })).toBe(true);
}

for (const width of [320, 390, 1440]) {
  test(`entry stays at the hero with readable content at ${width}px`, async ({ openLanding }, testInfo) => {
    const page = await openLanding(width);
    await expect(page.locator("[data-apx-body] .apx-task")).toHaveCount(3);
    await expectVisibleHeadline(page);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    await expect(page.locator("body")).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await expect(page.locator(".hero__actions").getByRole("link", { name: "Open Muster" })).toHaveAttribute("href", "/app");
    await expect(page.locator(".hero__actions").getByRole("link", { name: "Try the demo" })).toHaveAttribute("href", "#approvals");
    const screenshot = testInfo.outputPath(`landing-${width}.png`);
    await page.screenshot({ path: screenshot });
    await testInfo.attach(`landing-${width}`, { path: screenshot, contentType: "image/png" });
  });
}

test("keyboard users can allow, deny and replay sample work without sending requests", async ({ openLanding }) => {
  const page = await openLanding(390);
  const requests: string[] = [];
  page.on("request", (request) => requests.push(`${request.method()} ${request.url()}`));
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  const demoLink = page.locator(".hero__actions").getByRole("link", { name: "Try the demo" });
  // Traverse from the page's first focus target instead of assigning focus to
  // the control, so this covers the landing's actual keyboard entry order.
  for (let step = 0; step < 18 && !await demoLink.evaluate((link) => link === document.activeElement); step += 1) {
    await page.keyboard.press("Tab");
  }
  await expect(demoLink).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#approvals$/);
  await page.keyboard.press("Tab");
  const firstTask = page.getByRole("button", { name: "Triage this morning's support inbox and draft replies", exact: true });
  await expect(firstTask).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Allow", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Reply sent to anna@fernwoodlabs.com", { exact: true })).toBeVisible();
  await expect(page.getByText("Simulated receipt", { exact: true })).toBeVisible();
  const replay = page.getByRole("button", { name: "Run another sample task", exact: true });
  await expect(replay).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(firstTask).toBeFocused();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Deny", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByText("No action taken", { exact: true })).toBeVisible();
  await expect(page.getByText("No reply was sent.", { exact: false })).toBeVisible();
  await expect(replay).toBeFocused();
  expect(requests, "The interactive sample sends no network requests").toEqual([]);
});

test("reduced motion keeps the headline readable and the mobile menu keyboard operable", async ({ openLanding }) => {
  const page = await openLanding(320, true);
  await expectVisibleHeadline(page);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe("auto");
  const menu = page.getByLabel("Menu", { exact: true });
  await menu.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("navigation", { name: "Site", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeFocused();
  await expect(page.getByRole("navigation", { name: "Site", exact: true })).toBeHidden();
});

test("headline and primary destinations work without JavaScript", async ({ openLanding }) => {
  const page = await openLanding(390, false, false);
  await expectVisibleHeadline(page);
  await expect(page.locator(".hero__actions").getByRole("link", { name: "Open Muster" })).toHaveAttribute("href", "/app");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await expect(page.locator("#hero-dl")).toHaveAttribute("href", "/download.html");
});

test("search snippets, visible FAQs and internal anchors share one product story", async ({ openLanding }) => {
  const page = await openLanding(1440);
  const fragments = await page.locator('a[href^="#"]').evaluateAll((links) => links.map((link) => link.getAttribute("href")?.slice(1) ?? "").filter(Boolean));
  for (const fragment of new Set(fragments)) await expect(page.locator(`[id="${fragment}"]`)).toHaveCount(1);
  const blocks = page.locator('script[type="application/ld+json"]');
  await expect(blocks).toHaveCount(1);
  const faqSchema = z.object({
    "@type": z.literal("FAQPage"),
    mainEntity: z.array(z.object({ name: z.string(), acceptedAnswer: z.object({ text: z.string() }) })),
  });
  const graph = z.object({ "@graph": z.array(z.unknown()) }).parse(JSON.parse(await blocks.innerText()));
  const faqs = graph["@graph"].map((entry) => faqSchema.safeParse(entry)).filter((entry) => entry.success);
  expect(faqs).toHaveLength(1);
  const faq = faqs[0];
  if (!faq?.success) throw new Error("FAQ structured data is missing");
  for (const item of faq.data.mainEntity) {
    const row = page.locator(".faq-item").filter({ has: page.locator("summary", { hasText: item.name }) });
    await expect(row).toHaveCount(1);
    await expect(row.locator(".faq-a")).toHaveText(item.acceptedAnswer.text);
  }
  const description = await page.locator('meta[name="description"]').getAttribute("content");
  expect(description).toContain("Free during beta");
  await expect(page.locator('meta[property="og:description"]')).toHaveAttribute("content", description ?? "");
  await expect(page.locator('meta[name="twitter:description"]')).toHaveAttribute("content", description ?? "");
  await expect(page.locator("#pricing")).not.toContainText(/\$20|\$192|Free forever|Self-host/);
});
