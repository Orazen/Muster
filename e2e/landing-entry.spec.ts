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

interface LandingOptions {
  controlledClock?: boolean;
  userAgent?: string;
  manifest?: unknown;
  manifestBody?: string;
  manifestStatus?: number;
}

const test = baseTest.extend<{
  openLanding: (width: number, reducedMotion?: boolean, javaScriptEnabled?: boolean, options?: LandingOptions) => Promise<Page>;
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
      await use(async (width, reducedMotion = false, javaScriptEnabled = true, options = {}) => {
        const context = await browser.newContext({
          viewport: { width, height: 900 }, javaScriptEnabled,
          reducedMotion: reducedMotion ? "reduce" : "no-preference",
          userAgent: options.userAgent,
        });
        contexts.push(context);
        await context.route("**/*", async (route) => {
          const url = new URL(route.request().url());
          if (url.origin !== landingUrl) {
            errors.push(`Unexpected external request: ${url.origin}${url.pathname}`);
            return route.abort("blockedbyclient");
          }
          if (url.pathname === "/downloads/latest.json") return route.fulfill({
            status: options.manifestStatus ?? 200,
            contentType: "application/json",
            body: options.manifestBody ?? JSON.stringify(options.manifest ?? {}),
          });
          if (url.pathname === "/downloads/releases.json") return route.fulfill({ contentType: "application/json", body: "[]" });
          await route.continue();
        });
        const page = await context.newPage();
        // Install before page scripts schedule timers; mixing native and fake
        // timer IDs can make later cancellation checks undefined.
        if (options.controlledClock) await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("console", (message) => {
          // A deliberately refused metadata response emits a browser resource
          // error even when the page handles it. Keep every other error visible.
          if ((options.manifestStatus ?? 200) >= 400 && message.location().url === `${landingUrl}/downloads/latest.json`
            && message.text().includes(`status of ${options.manifestStatus}`)) return;
          if (message.type() === "error") errors.push(`${message.location().url}: ${message.text()}`);
        });
        await page.goto(landingUrl, { waitUntil: "networkidle" });
        if (options.controlledClock) await page.clock.pauseAt(new Date("2026-01-01T00:05:00Z"));
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
  await expect(heading).toHaveAccessibleName("A personal AI team for your everyday work.");
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
  expect(description).toContain("Free app");
  await expect(page.locator('meta[property="og:description"]')).toHaveAttribute("content", description ?? "");
  await expect(page.locator('meta[name="twitter:description"]')).toHaveAttribute("content", description ?? "");
  await expect(page.locator("#pricing")).not.toContainText(/\$20|\$192|Free forever|Self-host/);
});

for (const width of [320, 390, 768, 1440]) {
  test(`workspace demo fits and its controls work at ${width}px`, async ({ openLanding }, testInfo) => {
    const page = await openLanding(width);
    const demo = page.locator("#workspace-demo");
    const shell = demo.locator("[data-demo-shell]");
    await expect(shell).toBeVisible();
    await expect(demo.locator("[data-demo-fallback]")).toBeHidden();
    await expect(shell.getByRole("button", { name: "Milo · Daily planning", exact: true })).toHaveAttribute("aria-pressed", "true");
    const details = shell.locator("[data-demo-details]");
    await expect(details).toHaveAttribute("aria-expanded", String(width >= 1000));
    await details.click();
    await expect(details).toHaveAttribute("aria-expanded", String(width < 1000));
    if (width < 1000) await expect(shell.locator("[data-demo-inspector]")).toBeVisible();
    else await expect(shell.locator("[data-demo-inspector]")).toBeHidden();

    const scout = shell.getByRole("button", { name: "Scout · Email drafts", exact: true });
    await scout.click();
    await expect(scout).toHaveAttribute("aria-pressed", "true");
    await shell.locator("[data-demo-prompt]").click();
    await expect(shell.locator("[data-demo-input]")).not.toHaveValue("");
    await expect(shell.getByRole("button", { name: "Send demo message", exact: true })).toBeEnabled();
    const bounds = await demo.boundingBox();
    expect(bounds).not.toBeNull();
    if (!bounds) throw new Error("Workspace demo has no rendered bounds");
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const screenshot = testInfo.outputPath(`workspace-demo-${width}.png`);
    await demo.screenshot({ path: screenshot });
    await testInfo.attach(`workspace-demo-${width}`, { path: screenshot, contentType: "image/png" });
  });
}

test("workspace sample approval is keyboard operable and stays explicitly simulated", async ({ openLanding }) => {
  const page = await openLanding(390);
  const demo = page.locator("#workspace-demo");
  await demo.locator("[data-demo-input]").fill("Make time for writing this afternoon.");
  const send = demo.getByRole("button", { name: "Send demo message", exact: true });
  await send.focus();
  await page.keyboard.press("Enter");
  await expect(demo.locator("[data-demo-messages]")).toContainText("Make time for writing this afternoon.");
  await expect(demo.locator("[data-demo-status]")).toHaveText("Ready for your review");
  const approve = demo.getByRole("button", { name: "Approve sample", exact: true });
  await approve.focus();
  await page.keyboard.press("Enter");
  await expect(demo).toContainText("Sample approved. No real action was taken.");
  await expect(demo.getByRole("button", { name: "Skip sample", exact: true })).toHaveCount(0);
});

test("workspace messages render as text and leave network and browser storage untouched", async ({ openLanding }) => {
  const page = await openLanding(1440);
  const demo = page.locator("#workspace-demo");
  const requests: string[] = [];
  page.on("request", (request) => requests.push(`${request.method()} ${request.url()}`));
  const storageBefore = await page.evaluate(() => ({
    local: Object.entries(localStorage), session: Object.entries(sessionStorage), cookie: document.cookie,
  }));
  const input = demo.locator("[data-demo-input]");
  await expect(input).toHaveAttribute("maxlength", "500");
  const payload = '<img id="demo-injected" src="/unexpected-demo-request" onerror="document.body.dataset.demoInjected=1">';
  await input.fill(payload);
  await demo.getByRole("button", { name: "Send demo message", exact: true }).click();
  await expect(demo.locator("[data-demo-messages]")).toContainText(payload);
  await expect(demo.locator("[data-demo-status]")).toHaveText("Ready for your review");
  await demo.getByRole("button", { name: "Skip sample", exact: true }).click();
  await expect(demo.locator("#demo-injected")).toHaveCount(0);
  expect(await page.locator("body").getAttribute("data-demo-injected")).toBeNull();
  expect(await page.evaluate(() => ({
    local: Object.entries(localStorage), session: Object.entries(sessionStorage), cookie: document.cookie,
  }))).toEqual(storageBefore);
  expect(requests, "Workspace sample interactions stay on the page").toEqual([]);
});

test("workspace teammates retain separate drafts and pending replies stay in their conversation", async ({ openLanding }) => {
  const page = await openLanding(1440, false, true, { controlledClock: true });
  const demo = page.locator("#workspace-demo");
  const input = demo.locator("[data-demo-input]");
  const messages = demo.locator("[data-demo-messages]");
  const milo = demo.getByRole("button", { name: "Milo · Daily planning", exact: true });
  const scout = demo.getByRole("button", { name: "Scout · Email drafts", exact: true });
  await input.fill("Milo's unsent draft");
  await scout.click();
  await expect(input).toHaveValue("");
  await input.fill("Scout's unsent draft");
  await milo.click();
  await expect(input).toHaveValue("Milo's unsent draft");
  await demo.getByRole("button", { name: "Send demo message", exact: true }).click();
  await expect(demo.locator("[data-demo-status]")).toHaveText("Preparing a sample…");
  await scout.click();
  await expect(input).toHaveValue("Scout's unsent draft");
  await page.clock.runFor(1000);
  await expect(messages).not.toContainText("Milo's unsent draft");
  await expect(demo.getByRole("button", { name: "Approve sample", exact: true })).toHaveCount(0);
  await milo.click();
  await expect(messages).toContainText("Milo's unsent draft");
  await expect(input).toHaveValue("");
  await expect(demo.getByRole("button", { name: "Approve sample", exact: true })).toBeVisible();
});

test("reset cancels pending workspace replies and clears every teammate draft", async ({ openLanding }) => {
  const page = await openLanding(390, false, true, { controlledClock: true });
  const demo = page.locator("#workspace-demo");
  const input = demo.locator("[data-demo-input]");
  await input.fill("This pending task must disappear after reset.");
  await demo.getByRole("button", { name: "Send demo message", exact: true }).click();
  await expect(demo.locator("[data-demo-status]")).toHaveText("Preparing a sample…");
  await demo.getByRole("button", { name: "Nova · Research", exact: true }).click();
  await input.fill("Nova's draft must also disappear.");
  await demo.locator("[data-demo-reset]").click();
  await expect(demo.locator("[data-demo-notice]")).toHaveText("Demo reset. Sample messages and drafts cleared.");
  await page.clock.runFor(1000);
  await expect(demo.locator("[data-demo-status]")).toHaveText("Ready for a task");
  for (const name of ["Milo · Daily planning", "Scout · Email drafts", "Nova · Research", "Atlas · Projects"]) {
    await demo.getByRole("button", { name, exact: true }).click();
    await expect(input).toHaveValue("");
    await expect(demo.locator("[data-demo-messages]")).not.toContainText("must disappear");
    await expect(demo.getByRole("button", { name: "Approve sample", exact: true })).toHaveCount(0);
  }
});

test("reduced motion keeps workspace animation still while sample controls remain usable", async ({ openLanding }) => {
  const page = await openLanding(320, true);
  const demo = page.locator("#workspace-demo");
  await demo.locator("[data-demo-input]").fill("A calm sample task");
  await demo.getByRole("button", { name: "Send demo message", exact: true }).click();
  await expect(demo.locator("[data-demo-status]")).toHaveText("Ready for your review");
  expect(await demo.evaluate((element) => [element, ...element.querySelectorAll("*")].every((target) => {
    const style = getComputedStyle(target);
    return style.animationName === "none" || style.animationDuration.split(",").every((duration) => parseFloat(duration) === 0);
  }))).toBe(true);
  await expect(demo.getByRole("button", { name: "Approve sample", exact: true })).toBeVisible();
});

test("workspace retains its screenshot and caption when JavaScript is unavailable", async ({ openLanding }) => {
  const page = await openLanding(390, false, false);
  const demo = page.locator("#workspace-demo");
  await expect(demo.locator("[data-demo-shell]")).toBeHidden();
  const fallback = demo.locator("[data-demo-fallback]");
  await expect(fallback).toBeVisible();
  const image = fallback.locator("img");
  await expect(image).toHaveAttribute("src", "/hero.png");
  await image.scrollIntoViewIfNeeded();
  await expect.poll(() => image.evaluate((element) => element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0)).toBe(true);
  await expect(fallback.locator("p")).toContainText("Enable JavaScript to try a scripted conversation.");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

const DESKTOP_DOWNLOADS = ["Muster.dmg", "Muster-intel.dmg", "Muster-setup.exe", "Muster.deb", "Muster.AppImage"] as const;
const SAMPLE_CHECKSUM = "a".repeat(64);

function sampleManifest() {
  return {
    version: "1.20.7",
    files: Object.fromEntries(DESKTOP_DOWNLOADS.map((name) => [name, {
      size: 1024,
      sha256: SAMPLE_CHECKSUM,
      // A descriptor's URL must never override the known release location.
      url: "https://attacker.invalid/installer",
    }])),
  };
}

async function expectDownloadFallbacks(page: Page) {
  for (const name of DESKTOP_DOWNLOADS) {
    await expect(page.locator(`[data-download-file="${name}"]`)).toHaveAttribute("href", "/download.html");
    await expect(page.locator(`[data-download-checksum="${name}"]`)).toBeHidden();
  }
  await expect(page.locator("#hero-dl-version")).toBeEmpty();
}

for (const width of [320, 390, 768, 1440]) {
  test(`product showcase, templates, connections and downloads fit at ${width}px`, async ({ openLanding }, testInfo) => {
    const page = await openLanding(width);
    const sections = ["#scenes", "#use-cases", "#engines", "#download", "#meet-muster"];
    for (const selector of sections) {
      const section = page.locator(selector);
      await section.scrollIntoViewIfNeeded();
      await expect(section).toBeVisible();
      const bounds = await section.boundingBox();
      expect(bounds, `${selector} has visible bounds`).not.toBeNull();
      if (!bounds) throw new Error(`${selector} is not rendered`);
      expect(bounds.x, `${selector} stays inside the viewport`).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width, `${selector} stays inside the viewport`).toBeLessThanOrEqual(width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      const screenshot = testInfo.outputPath(`${selector.slice(1)}-${width}.png`);
      // Section portraits may be taller than the viewport. Hide only the
      // fixed navigation in the artifact, after checking the real layout.
      await section.screenshot({ path: screenshot, animations: "disabled", style: ".site-header { visibility: hidden !important; }" });
      await testInfo.attach(`${selector.slice(1)}-${width}`, { path: screenshot, contentType: "image/png" });
    }
    await expect(page.locator("#use-cases .starter-card")).toHaveCount(6);
    const android = page.locator("#download .download-card").filter({ has: page.getByRole("heading", { name: "Android", exact: true }) });
    await expect(android).toContainText("Android beta in development. Public installation is not yet listed.", { useInnerText: true });
    await expect(android.getByRole("link")).toHaveCount(0);
    await expectDownloadFallbacks(page);
  });
}

test("product tabs support roving keyboard focus without rotating on their own", async ({ openLanding }) => {
  const page = await openLanding(768, false, true, { controlledClock: true });
  const showcase = page.locator("[data-product-showcase]");
  const tabs = showcase.getByRole("tablist", { name: "Explore Muster", exact: true });
  const personal = tabs.getByRole("tab", { name: "Personal", exact: true });
  const teams = tabs.getByRole("tab", { name: "For teams", exact: true });
  const desktop = tabs.getByRole("tab", { name: "Desktop", exact: true });
  const companions = tabs.getByRole("tab", { name: "On the go", exact: true });
  await expect(personal).toHaveAttribute("aria-selected", "true");
  await expect(personal).toHaveAttribute("tabindex", "0");
  await expect(showcase.locator('[role="tabpanel"]:visible')).toHaveCount(1);
  await personal.focus();
  for (const [key, tab, panel] of [
    ["ArrowRight", teams, "product-teams"],
    ["End", companions, "product-companions"],
    ["ArrowRight", personal, "product-personal"],
    ["ArrowLeft", companions, "product-companions"],
    ["Home", personal, "product-personal"],
    ["ArrowRight", teams, "product-teams"],
    ["ArrowRight", desktop, "product-desktop"],
  ] as const) {
    await page.keyboard.press(key);
    await expect(tab).toBeFocused();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await expect(tab).toHaveAttribute("aria-controls", panel);
    await expect(showcase.locator(`#${panel}`)).toBeVisible();
    await expect(tabs.locator('[aria-selected="true"]')).toHaveCount(1);
    await expect(tabs.locator('[tabindex="0"]')).toHaveCount(1);
    await expect(showcase.locator('[role="tabpanel"]:visible')).toHaveCount(1);
  }
  await page.clock.fastForward(30_000);
  await expect(desktop).toHaveAttribute("aria-selected", "true");
  await expect(desktop).toBeFocused();
});

test("product stories, template previews and download destinations remain usable without JavaScript", async ({ openLanding }) => {
  const page = await openLanding(390, false, false);
  for (const id of ["product-personal", "product-teams", "product-desktop", "product-companions"]) {
    await expect(page.locator(`#${id}`)).toBeVisible();
  }
  await expect(page.locator("[data-mascot-greet]")).toBeHidden();
  const preview = page.locator("#use-cases .starter-card details").first();
  await preview.locator("summary").click();
  await expect(preview).toHaveAttribute("open", "");
  for (const link of await page.locator("#use-cases .starter-card a").all()) {
    await expect(link).toHaveAttribute("href", "/app");
  }
  await expectDownloadFallbacks(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("template cards preview real Agent Hub roles without installing or sending anything", async ({ openLanding }) => {
  const page = await openLanding(1440);
  const requests: string[] = [];
  page.on("request", (request) => requests.push(`${request.method()} ${request.url()}`));
  const templates = page.locator("#use-cases");
  const cards = templates.locator(".starter-card");
  await expect(cards).toHaveCount(6);
  const knownNames = ["Daylight", "Compass", "Atlas", "Forge", "Probe", "Quill", "Slate", "Anchor", "Ranger", "Ledger"];
  for (const card of await cards.all()) {
    const title = await card.getByRole("heading").innerText();
    expect(knownNames.some((name) => title.includes(name)), `Real Agent Hub persona: ${title}`).toBe(true);
    const details = card.locator("details");
    const summary = details.locator("summary");
    await summary.focus();
    await page.keyboard.press("Enter");
    await expect(details).toHaveAttribute("open", "");
    await expect(card.getByRole("link")).toHaveAttribute("href", "/app");
    await page.keyboard.press("Enter");
    await expect(details).not.toHaveAttribute("open", "");
  }
  expect(requests, "Template previews are local disclosure controls").toEqual([]);
});

test("valid release metadata enables only known downloads without guessing Mac or mobile architecture", async ({ openLanding }) => {
  for (const userAgent of [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
  ]) {
    const page = await openLanding(390, false, true, { userAgent, manifest: sampleManifest() });
    for (const name of DESKTOP_DOWNLOADS) {
      await expect(page.locator(`[data-download-file="${name}"]`)).toHaveAttribute("href", `https://muster.today/downloads/${name}`);
      const checksum = page.locator(`[data-download-checksum="${name}"]`);
      await expect(checksum).toBeVisible();
      await checksum.locator("summary").click();
      await expect(checksum.locator("code")).toHaveText(SAMPLE_CHECKSUM);
    }
    await expect(page.locator("[data-release-status]")).toContainText("1.20.7");
    await expect(page.locator("#hero-dl")).toHaveAttribute("href", "/download.html");
    await expect(page.locator('a[href*="attacker.invalid"]')).toHaveCount(0);
    expect(await page.evaluate(() => performance.getEntriesByType("resource")
      .filter((entry) => new URL(entry.name).pathname === "/downloads/latest.json").length)).toBe(1);
  }
});

test("a partial manifest leaves malformed artifacts unavailable and ignores unrecognized URLs", async ({ openLanding }) => {
  const page = await openLanding(1440, false, true, { manifest: {
    version: "1.20.7",
    files: {
      "Muster.dmg": { size: 1024, sha256: SAMPLE_CHECKSUM, url: "javascript:alert('unexpected')" },
      "Muster-intel.dmg": { size: 0, sha256: SAMPLE_CHECKSUM },
      "Muster-setup.exe": { size: 1.5, sha256: SAMPLE_CHECKSUM },
      "Muster.deb": { size: "1024", sha256: SAMPLE_CHECKSUM },
      "Muster.AppImage": { size: 1024, sha256: "g".repeat(64) },
      "https://attacker.invalid/malware.exe": { size: 1024, sha256: SAMPLE_CHECKSUM },
    },
  } });
  await expect(page.locator('[data-download-file="Muster.dmg"]')).toHaveAttribute("href", "https://muster.today/downloads/Muster.dmg");
  for (const name of DESKTOP_DOWNLOADS.slice(1)) {
    await expect(page.locator(`[data-download-file="${name}"]`)).toHaveAttribute("href", "/download.html");
    await expect(page.locator(`[data-download-checksum="${name}"]`)).toBeHidden();
  }
  await expect(page.locator("[data-download-file]")).toHaveCount(5);
  await expect(page.locator('a[href^="javascript:"], a[href*="attacker.invalid"]')).toHaveCount(0);
  await expect(page.locator("#download")).not.toContainText("attacker.invalid");
});

test("invalid release versions cannot activate downloads or inject release labels", async ({ openLanding }) => {
  for (const version of ["01.20.7", "1.20", "1.20.7-01", "1.20.7-..", '<img src="https://attacker.invalid/version" onerror="alert(1)">']) {
    const page = await openLanding(390, false, true, { manifest: { ...sampleManifest(), version } });
    await expectDownloadFallbacks(page);
    await expect(page.locator("[data-release-status]")).not.toContainText(version);
    await expect(page.locator('[src*="attacker.invalid"], [href*="attacker.invalid"]')).toHaveCount(0);
  }
});

test("unavailable or unreadable release metadata preserves useful download choices", async ({ openLanding }) => {
  for (const options of [{ manifest: {} }, { manifestStatus: 503 }, { manifestBody: "{incomplete-json" }]) {
    const page = await openLanding(320, false, true, options);
    await expectDownloadFallbacks(page);
    await expect(page.locator("#download").getByRole("link", { name: /web|browser|open muster/i }).first()).toHaveAttribute("href", "/app");
    await expect(page.locator("#download")).toContainText(/beta/i);
  }
});

test("the mascot greets from the keyboard with finite motion and respects reduced motion", async ({ openLanding }) => {
  for (const reducedMotion of [false, true]) {
    const page = await openLanding(390, reducedMotion);
    const section = page.locator("#meet-muster");
    const button = section.locator("[data-mascot-greet]");
    const greeting = section.locator("[data-mascot-greeting]");
    const initial = await greeting.textContent();
    await button.focus();
    await page.keyboard.press("Enter");
    await expect(greeting).not.toHaveText(initial ?? "");
    await expect(button).toBeFocused();
    expect(await section.evaluate((element) => element.getAnimations({ subtree: true })
      .every((animation) => animation.effect?.getTiming().iterations !== Infinity))).toBe(true);
    if (reducedMotion) expect(await section.evaluate((element) => [element, ...element.querySelectorAll("*")].every((target) => {
      const style = getComputedStyle(target);
      return style.animationName === "none" || style.animationDuration.split(",").every((duration) => parseFloat(duration) === 0);
    }))).toBe(true);
  }
});

test("hero scenes are keyboard operable and keep their sample work local", async ({ openLanding }) => {
  const page = await openLanding(390);
  const workshop = page.locator("[data-hero-workshop]");
  const plan = { key: "plan", name: "Plan my day", title: "A little room for your day.", note: "Sample plan · no calendar changes", announcement: /plan/i };
  const modes = [
    { key: "research", name: "Explore an idea", title: "A clearer picture, before you decide.", note: "Sample research · no browsing performed", announcement: /research|explore an idea/i },
    { key: "draft", name: "Draft a reply", title: "The right words. Still yours.", note: "Sample draft · no message sent", announcement: /draft/i },
    plan,
  ];
  await expect(workshop).toBeVisible();
  await expect(workshop.locator("[data-hero-role]")).toHaveCount(3);
  await expect(workshop.locator('[data-hero-role="plan"]')).toHaveAttribute("aria-pressed", "true");
  await expect(workshop.locator('[data-hero-role][aria-pressed="true"]')).toHaveCount(1);
  await expect(workshop.locator("[data-hero-task-title]")).toHaveText(plan.title);
  await expect(workshop.locator("[data-hero-task-note]")).toHaveText(plan.note);
  const feedback = workshop.locator("[data-hero-feedback]");
  await expect(feedback).toHaveAttribute("role", "status");

  const requests: string[] = [];
  page.on("request", (request) => requests.push(`${request.method()} ${request.url()}`));
  const storageBefore = await page.evaluate(() => ({
    local: Object.entries(localStorage), session: Object.entries(sessionStorage),
  }));
  const cookiesBefore = await page.context().cookies();
  const initialUrl = page.url();
  for (const mode of modes) {
    const button = workshop.getByRole("button", { name: mode.name, exact: true });
    await expect(button).toHaveAttribute("data-hero-role", mode.key);
    await button.focus();
    await page.keyboard.press("Enter");
    await expect(button).toBeFocused();
    await expect(button).toHaveAttribute("aria-pressed", "true");
    await expect(workshop.locator('[data-hero-role][aria-pressed="true"]')).toHaveCount(1);
    await expect(workshop.locator("[data-hero-task-title]")).toHaveText(mode.title);
    await expect(workshop.locator("[data-hero-task-note]")).toHaveText(mode.note);
    await expect(feedback).toContainText(mode.announcement);
  }

  const replay = workshop.getByRole("button", { name: "Replay the scene", exact: true });
  await expect(replay).toHaveAttribute("data-hero-replay", /.*/);
  await expect.poll(() => workshop.evaluate((element) => element.getAnimations({ subtree: true })
    .filter((animation) => animation.playState === "running").length)).toBe(0);
  await replay.focus();
  await page.keyboard.press("Space");
  await expect.poll(() => workshop.evaluate((element) => element.getAnimations({ subtree: true })
    .filter((animation) => animation.playState === "running").length)).toBeGreaterThan(0);
  await expect(replay).toBeFocused();
  await expect(workshop.locator('[data-hero-role="plan"]')).toHaveAttribute("aria-pressed", "true");
  await expect(workshop.locator('[data-hero-role][aria-pressed="true"]')).toHaveCount(1);
  await expect(workshop.locator("[data-hero-task-title]")).toHaveText(plan.title);
  await expect(workshop.locator("[data-hero-task-note]")).toHaveText(plan.note);
  expect(await workshop.evaluate((element) => element.getAnimations({ subtree: true })
    .every((animation) => animation.effect?.getTiming().iterations !== Infinity))).toBe(true);
  expect(page.url()).toBe(initialUrl);
  expect(await page.evaluate(() => ({
    local: Object.entries(localStorage), session: Object.entries(sessionStorage),
  }))).toEqual(storageBefore);
  expect(await page.context().cookies()).toEqual(cookiesBefore);
  expect(requests, "Changing or replaying an illustrative hero never starts a request").toEqual([]);
});

test("hero controls still work with reduced motion and introduce no animated workshop", async ({ openLanding }) => {
  const page = await openLanding(320, true);
  const workshop = page.locator("[data-hero-workshop]");
  await expect(workshop).toBeVisible();
  for (const mode of [
    { key: "research", name: "Explore an idea", title: "A clearer picture, before you decide." },
    { key: "draft", name: "Draft a reply", title: "The right words. Still yours." },
    { key: "plan", name: "Plan my day", title: "A little room for your day." },
  ]) {
    const button = workshop.getByRole("button", { name: mode.name, exact: true });
    await button.click();
    await expect(workshop.locator(`[data-hero-role="${mode.key}"]`)).toHaveAttribute("aria-pressed", "true");
    await expect(workshop.locator('[data-hero-role][aria-pressed="true"]')).toHaveCount(1);
    await expect(workshop.locator("[data-hero-task-title]")).toHaveText(mode.title);
  }
  await workshop.getByRole("button", { name: "Replay the scene", exact: true }).click();
  expect(await workshop.evaluate((element) => [element, ...element.querySelectorAll("*")].every((target) => {
    const style = getComputedStyle(target);
    return style.animationName === "none" || style.animationDuration.split(",").every((duration) => parseFloat(duration) === 0);
  }))).toBe(true);
  expect(await workshop.evaluate((element) => element.getAnimations({ subtree: true })
    .every((animation) => Number(animation.effect?.getTiming().duration ?? 0) === 0))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});

test("hero sample stays readable without JavaScript and its unavailable controls are hidden", async ({ openLanding }) => {
  const page = await openLanding(390, false, false);
  const workshop = page.locator("[data-hero-workshop]");
  await expect(workshop).toBeVisible();
  await expect(workshop.locator("[data-hero-task-title]")).toHaveText("A little room for your day.");
  await expect(workshop.locator("[data-hero-task-note]")).toHaveText("Sample plan · no calendar changes");
  for (const role of ["plan", "research", "draft"]) {
    await expect(workshop.locator(`[data-hero-role="${role}"]`)).toHaveCount(1);
    await expect(workshop.locator(`[data-hero-role="${role}"]`)).toBeHidden();
  }
  await expect(workshop.locator("[data-hero-replay]")).toHaveCount(1);
  await expect(workshop.locator("[data-hero-replay]")).toBeHidden();
  await expect(page.locator(".hero__actions").getByRole("link", { name: "Open Muster" })).toHaveAttribute("href", "/app");
});

test("the download page CLI destination opens a keyboard-operable illustrative guide", async ({ openLanding }) => {
  const page = await openLanding(390, false, false);
  const downloadHtml = await readFile(resolve(SITE_ROOT, "download.html"), "utf8");
  const cliHref = z.literal("/#cli").parse(await page.evaluate((html) => {
    const document = new DOMParser().parseFromString(html, "text/html");
    return document.querySelector('a[href="/#cli"]')?.getAttribute("href");
  }, downloadHtml));
  await page.goto(new URL(cliHref, page.url()).href, { waitUntil: "networkidle" });
  await expect(page).toHaveURL(/\/#cli$/);
  const guide = page.locator("details#cli");
  await expect(guide).toHaveCount(1);
  await expect(guide).toHaveJSProperty("open", false);
  const summary = guide.locator("summary");
  await expect(summary).toHaveAccessibleName("Prefer a terminal? A few commands, one familiar team");
  await summary.focus();
  const requests: string[] = [];
  page.on("request", (request) => requests.push(`${request.method()} ${request.url()}`));
  await page.keyboard.press("Enter");
  await expect(guide).toHaveJSProperty("open", true);
  await expect(summary).toBeFocused();
  const commands = guide.locator("pre code");
  await expect(commands).toBeVisible();
  await expect(commands).toContainText("$ muster bots");
  await expect(commands).toContainText('$ muster send atlas "Help me plan the next step"');
  await expect(commands).toContainText("$ muster receipts 2");
  await expect(guide.getByText("The CLI talks to a configured Muster host. These are illustrative commands and sample output; nothing runs on this page.", { exact: true })).toBeVisible();
  await expect(guide.getByRole("link", { name: "Read the CLI guide" })).toHaveAttribute("href", "/docs/cli");
  expect(requests, "Expanding the illustrative CLI guide executes no request").toEqual([]);
});

test("homepage presentation stays isolated from the real download page", async ({ openLanding }) => {
  const page = await openLanding(390);
  await expect(page.locator('link[rel="stylesheet"][href^="/landing-editorial.css"]')).toHaveCount(1);
  await expect(page.locator('link[rel="stylesheet"][href^="/landing-gaia.css"]')).toHaveCount(0);
  const downloadUrl = new URL("/download.html", page.url());
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  const originalStyleResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/landing-gaia.css");
  await page.goto(downloadUrl.href, { waitUntil: "networkidle" });
  const originalStyle = await originalStyleResponse;
  expect(originalStyle.ok(), "The download page loads its actual retained stylesheet").toBe(true);
  expect(await originalStyle.text()).toBe(await readFile(resolve(SITE_ROOT, "landing-gaia.css"), "utf8"));
  await expect(page.locator('link[rel="stylesheet"][href^="/landing-gaia.css"]')).toHaveCount(1);
  await expect(page.locator('link[rel="stylesheet"][href^="/landing-editorial.css"]')).toHaveCount(0);
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(17, 17, 17)");
  const heading = page.getByRole("heading", { level: 1 });
  await expect(heading).toBeVisible();
  await expect(heading).toContainText("Download Muster");
  await expect(page.getByRole("link", { name: "Muster home", exact: true })).toHaveAttribute("href", "/");
  await expect(page.locator('a[href="/#cli"]')).toHaveCount(1);
  expect(requests.every((url) => new URL(url).origin === downloadUrl.origin), "Download resources stay on the owned origin").toBe(true);
  expect(requests.some((url) => new URL(url).pathname === "/landing-editorial.css"), "The homepage-only stylesheet is never loaded by download.html").toBe(false);
});
