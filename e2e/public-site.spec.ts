/** Actual public documents, isolated browser contexts and an owned GET-only server.
 * Catalog and release responses are synthetic fixtures; no account API is used. */
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test as baseTest, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import { z } from "zod";
import { legalPageFor } from "../server/legal-pages.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WWW = resolve(ROOT, "www");
const DOCS = ["", "quick-start", "install", "setup", "engines", "goals", "automation", "approvals", "agents", "security"];
const MIME = new Map([[".html", "text/html"], [".css", "text/css"], [".js", "text/javascript"], [".mjs", "text/javascript"], [".svg", "image/svg+xml"], [".png", "image/png"], [".jpg", "image/jpeg"], [".woff2", "font/woff2"]]);
const SENTINELS = { local: "keep-public-preference", session: "unsent-note", cookie: "muster_public_fixture=keep-owned-session" };
const CHECKSUM = "ab".repeat(32);
const RELEASE = { version: "9.8.7", files: { "muster-cli.mjs": { size: 65536 } }, checksums: { "Muster.dmg": CHECKSUM, "Muster-setup.exe": "cd".repeat(32) } };
const TEAMS = [
  { slug: "alpha-research", name: "Alpha Research", summary: "Read and compare source material", category: "Research", members: 2, skills: ["sources"], requires: { apps: ["web"] }, featured: true },
  { slug: "beta-writers", name: "Beta Writers", summary: "Prepare an editorial draft", category: "Writing", members: 3, skills: ["editing"], requires: { apps: [] }, featured: false },
  { slug: "gamma-planning", name: "Gamma Planning", summary: "Compare project priorities", category: "Research", members: 1, skills: ["planning"], requires: { apps: [] }, featured: false },
];
interface PublicOptions {
  width?: number; javaScriptEnabled?: boolean; reducedMotion?: boolean;
  seedState?: boolean; theme?: "dark" | "light";
  clipboard?: "success" | "failure" | "missing";
  manifest?: unknown; manifestBody?: string; manifestStatus?: number;
  catalogStatus?: number; detailStatus?: number;
  expectedDocumentStatus?: number;
  userAgent?: string; platform?: string;
}
declare global { interface Window { __publicClipboard: string[] } }

const test = baseTest.extend<{
  openPublic: (path: string, options?: PublicOptions) => Promise<Page>;
}, { publicOrigin: string }>({
  publicOrigin: [async ({ browserName: _browserName }, use) => {
    // Render the exact existing server's literal 404 document; do not invent a
    // replacement shell. Real route semantics remain in docs-static.test.ts.
    const source = await readFile(resolve(ROOT, "server/index.ts"), "utf8");
    const docsHandler = /\/\/ Product docs at pretty URLs:[\s\S]*?\/\/ legal pages:/.exec(source)?.[0] ?? "";
    const expression = /return res\.end\(\s*(`[\s\S]*?)\n\s*\);/.exec(docsHandler)?.[1] ?? "";
    const fragments = [...expression.matchAll(/`([^`]*)`/g)].map((match) => match[1]);
    if (!fragments.length || expression.replace(/`[^`]*`/g, "").replace(/[+\s]/g, "") || fragments.some((part) => part.includes("${"))) throw new Error("Docs 404 is no longer a literal template; update the owned fixture extraction");
    const docs404 = fragments.join("");
    const server = createServer(async (request, response) => {
      try {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        if (request.method !== "GET") { response.writeHead(405).end(); return; }
        if (url.pathname === "/__public_state_fixture") { response.writeHead(200, { "content-type": "text/html" }).end('<!doctype html><link rel="icon" href="data:,">Owned fixture'); return; }
        const legal = legalPageFor(url.pathname);
        if (legal) { response.writeHead(200, { "content-type": "text/html" }).end(legal); return; }
        if (["/docs/self-host", "/docs/self-host/", "/docs/self-host.html"].includes(url.pathname)) { response.writeHead(308, { location: "/docs/setup" }).end(); return; }
        let path = url.pathname;
        if (path === "/docs" || path === "/docs/") path = "/docs/index.html";
        else if (/^\/docs\/[^/.]+$/.test(path)) path += ".html";
        else if (path === "/teams") path = "/teams.html";
        else if (path === "/") path = "/index.html";
        const target = resolve(WWW, `.${decodeURIComponent(path)}`);
        if (!target.startsWith(`${WWW}${sep}`)) { response.writeHead(403).end(); return; }
        const body = await readFile(target);
        response.writeHead(200, { "content-type": MIME.get(extname(target)) ?? "application/octet-stream" }).end(body);
      } catch {
        const isDocs = (request.url ?? "").startsWith("/docs/");
        response.writeHead(404, { "content-type": isDocs ? "text/html" : "text/plain" }).end(isDocs ? docs404 : "Not found");
      }
    });
    await new Promise<void>((ready, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", ready); });
    const { port } = z.object({ port: z.number() }).parse(server.address());
    try { await use(`http://127.0.0.1:${port}`); } finally {
      server.closeAllConnections();
      await new Promise<void>((closed, reject) => server.close((error) => error ? reject(error) : closed()));
    }
  }, { scope: "worker" }],
  openPublic: async ({ browser, publicOrigin }, use, testInfo) => {
    const contexts: BrowserContext[] = [], errors: string[] = [];
    try {
      await use(async (path, options = {}) => {
        const context = await browser.newContext({ viewport: { width: options.width ?? 1440, height: 900 },
          javaScriptEnabled: options.javaScriptEnabled ?? true, reducedMotion: options.reducedMotion ? "reduce" : "no-preference", userAgent: options.userAgent });
        contexts.push(context);
        await context.addInitScript(({ mode, platform }) => {
          window.__publicClipboard = [];
          if (platform) Object.defineProperty(navigator, "platform", { configurable: true, value: platform });
          Object.defineProperty(navigator, "clipboard", { configurable: true, value: mode === "missing" ? undefined : {
            writeText: async (value: string) => {
              if (mode === "failure") throw new Error("Owned clipboard refusal");
              window.__publicClipboard.push(value);
            },
          } });
        }, { mode: options.clipboard ?? "success", platform: options.platform });
        await context.route("**/*", async (route) => {
          const request = route.request(), url = new URL(request.url());
          if (url.origin !== publicOrigin || request.method() !== "GET") {
            errors.push(`Unexpected request: ${request.method()} ${url.origin}${url.pathname}`); return route.abort("blockedbyclient");
          }
          if (url.pathname === "/downloads/latest.json") return route.fulfill({ status: options.manifestStatus ?? 200, contentType: "application/json", body: options.manifestBody ?? JSON.stringify(options.manifest ?? RELEASE) });
          if (url.pathname === "/api/directory/teams") return route.fulfill({ status: options.catalogStatus ?? 200, json: { teams: TEAMS } });
          const entry = TEAMS.find((team) => url.pathname === `/api/directory/teams/${team.slug}`);
          if (entry) return route.fulfill({ status: options.detailStatus ?? 200, json: {
            team: { team: { name: entry.name, description: entry.summary, members: [{ key: "quill", name: "Quill", title: "Researcher" }] } },
            readme: "## A reviewable first step\nUse **sources** and ask before sending.\n\n<script>window.unexpected = true</script>",
          } });
          if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/assets/") || url.pathname === "/landing-workroom/v1/app.js") {
            errors.push(`Unexpected application dependency: ${url.pathname}`); return route.abort("blockedbyclient");
          }
          await route.continue();
        });
        const page = await context.newPage();
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("console", (message) => {
          if (message.type() !== "error") return;
          const expected = [
            { suffix: path.split("#")[0], status: options.expectedDocumentStatus },
            { suffix: "/downloads/latest.json", status: options.manifestStatus },
            { suffix: "/api/directory/teams", status: options.catalogStatus },
            ...TEAMS.map((entry) => ({ suffix: `/api/directory/teams/${entry.slug}`, status: options.detailStatus })),
          ];
          if (expected.some(({ suffix, status }) => (status ?? 0) >= 400 && message.location().url === publicOrigin + suffix && message.text().includes(`status of ${status}`))) return;
          errors.push(`${message.location().url}: ${message.text()}`);
        });
        if (options.seedState || options.theme) {
          await page.goto(`${publicOrigin}/__public_state_fixture`);
          await page.evaluate(({ sentinels, theme }) => {
            localStorage.setItem("muster-public:preference", sentinels.local);
            sessionStorage.setItem("muster-public:draft", sentinels.session);
            if (theme) localStorage.setItem("muster-docs-theme", theme);
          }, { sentinels: SENTINELS, theme: options.theme });
          await context.addCookies([{ name: "muster_public_fixture", value: "keep-owned-session", url: publicOrigin }]);
        }
        await page.goto(`${publicOrigin}${path}`, { waitUntil: "networkidle" });
        return page;
      });
      if (errors.length) await testInfo.attach("public-site-errors", { body: errors.join("\n"), contentType: "text/plain" });
      expect(errors, "Only owned static resources and explicitly controlled catalog/release reads are allowed").toEqual([]);
    } finally { await Promise.all(contexts.map((context) => context.close())); }
  },
});

async function expectFits(page: Page, width: number) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  const h1 = page.getByRole("heading", { level: 1 });
  await expect(h1).toHaveCount(1); await expect(h1).toBeVisible(); await expect(h1).toHaveText(/\S/);
}
async function expectState(page: Page, theme: string) {
  expect(await page.evaluate(() => ({ local: Object.entries(localStorage).sort(), session: Object.entries(sessionStorage).sort(), cookie: document.cookie }))).toEqual({
    local: [["muster-docs-theme", theme], ["muster-public:preference", SENTINELS.local]].sort(),
    session: [["muster-public:draft", SENTINELS.session]], cookie: SENTINELS.cookie,
  });
}
async function reviewImage(page: Page, name: string, testInfo: TestInfo) {
  await page.evaluate(() => document.fonts.ready);
  const output = process.env.MUSTER_PUBLIC_REVIEW_MEDIA_DIR;
  if (output) { await mkdir(resolve(output), { recursive: true }); await page.screenshot({ path: resolve(output, `${name}-after.png`) }); }
  await testInfo.attach(name, { body: await page.screenshot(), contentType: "image/png" });
}

for (const slug of DOCS) {
  test(`docs destination /docs${slug ? `/${slug}` : ""} is readable and identifies the current page`, async ({ openPublic }) => {
    const path = slug ? `/docs/${slug}` : "/docs", page = await openPublic(path);
    await expectFits(page, 1440);
    await expect(page.locator('#docs-navigation a[aria-current="page"]')).toHaveAttribute("href", path);
    await expect(page.locator("#docs-navigation a")).toHaveCount(DOCS.length);
    for (const href of ["/", "/download.html", "/app"]) await expect(page.locator(`a[href="${href}"]`).first()).toBeVisible();
    await expect(page.locator(".docs-toc a").first()).toBeVisible();
  });
}
test("docs links, direct fragments, reload and history retain the intended section", async ({ openPublic, publicOrigin }) => {
  const page = await openPublic("/docs/agents");
  const toc = page.locator(".docs-toc a");
  const href = await toc.nth(1).getAttribute("href"); expect(href).toMatch(/^#[\w-]+$/);
  const anchor = page.locator(href!);
  await toc.nth(1).click(); await expect(anchor).toBeInViewport();
  await page.goto(`${publicOrigin}/docs/agents${href}`, { waitUntil: "networkidle" }); await expect(anchor).toBeInViewport();
  await page.reload({ waitUntil: "networkidle" }); await expect(anchor).toBeInViewport();
  await page.locator('#docs-navigation a[href="/docs/goals"]').click();
  await expect(page).toHaveURL(`${publicOrigin}/docs/goals`);
  await page.goBack({ waitUntil: "networkidle" }); await expect(anchor).toBeInViewport();
  const ids = await page.locator(".docs-content h2,.docs-content h3").evaluateAll((heads) => heads.map((heading) => heading.id));
  expect(ids.every(Boolean)).toBe(true); expect(new Set(ids).size).toBe(ids.length);
});
test("retired setup bookmarks still reach the account and device guide", async ({ openPublic }) => {
  const page = await openPublic("/docs/self-host"); await expect(page).toHaveURL(/\/docs\/setup$/);
  await expect(page.locator('#docs-navigation a[aria-current="page"]')).toHaveAttribute("href", "/docs/setup");
});
test("docs theme survives navigation and reload without altering other saved state", async ({ openPublic }) => {
  const page = await openPublic("/docs/goals", { theme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark"); await expectState(page, "dark");
  await page.locator(".theme-toggle").click(); await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.locator('#docs-navigation a[href="/docs/setup"]').click(); await expectState(page, "light");
  await page.reload({ waitUntil: "networkidle" }); await expectState(page, "light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});
for (const mode of ["success", "failure"] as const) {
  test(`docs code copy reports ${mode} and preserves exact code whitespace`, async ({ openPublic }) => {
    const page = await openPublic("/docs/agents", { clipboard: mode });
    const code = page.locator("pre").first(), expected = await code.locator("code").textContent();
    const copy = code.getByRole("button", { name: "Copy code to clipboard" }); await copy.focus(); await page.keyboard.press("Enter");
    await expect(copy).toHaveText(mode === "success" ? "Copied" : "Failed");
    expect(await page.evaluate(() => window.__publicClipboard)).toEqual(mode === "success" ? [expected] : []);
    await expect(copy).toBeFocused();
  });
}
for (const width of [320, 390, 768, 1440]) {
  test(`public documents remain usable at ${width}px`, async ({ openPublic }, testInfo) => {
    for (const [path, label] of [["/docs", "docs-hub"], ["/docs/agents", "docs"], ["/download.html", "download"], ["/privacy-policy", "legal"], ["/teams", "teams"], ["/templates.html", "templates"], ["/switch.html", "switch"]]) {
      const page = await openPublic(path, { width }); await expectFits(page, width);
      await page.evaluate(() => window.scrollTo(0, 0));
      if ([390, 1440].includes(width) && ["docs-hub", "docs", "download", "legal"].includes(label)) await reviewImage(page, `${label}-${width === 390 ? "mobile" : "desktop"}`, testInfo);
    }
  });
}
test("mobile docs navigation works from the keyboard and restores focus on Escape", async ({ openPublic }) => {
  const page = await openPublic("/docs", { width: 320 }); const menu = page.locator("#docs-menu-toggle"), nav = page.locator("#docs-navigation");
  await expect(nav).toBeHidden(); await menu.focus(); await page.keyboard.press("Enter");
  await expect(menu).toHaveAttribute("aria-expanded", "true"); await expect(nav).toBeVisible();
  await nav.locator('a[href="/docs/agents"]').focus(); await page.keyboard.press("Escape");
  await expect(nav).toBeHidden(); await expect(menu).toBeFocused();
  await page.keyboard.press("Enter"); await nav.locator('a[href="/docs/agents"]').click();
  await expect(page).toHaveURL(/\/docs\/agents$/); await expectFits(page, 320);
});
test("the current server docs404 retains shared readable styling and recovery links", async ({ openPublic }) => {
  const normal = await openPublic("/docs/agents", { width: 320 });
  const appearance = (page: Page) => page.evaluate(() => {
    const body = getComputedStyle(document.body), heading = getComputedStyle(document.querySelector("h1")!);
    return { background: body.backgroundColor, text: body.color, bodyFont: body.fontFamily, headingFont: heading.fontFamily };
  });
  const page = await openPublic("/docs/owned-missing-page", { width: 320, expectedDocumentStatus: 404 });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Page not found");
  await expectFits(page, 320);
  expect(await appearance(page)).toEqual(await appearance(normal));
  await expect(page.locator('a[href="/"]').first()).toBeVisible();
  await page.locator('a[href="/docs"]').click();
  await expect(page.locator('#docs-navigation a[aria-current="page"]')).toHaveAttribute("href", "/docs");
});
for (const width of [320, 1440]) {
  test(`without JavaScript public content and real destinations remain available at ${width}px`, async ({ openPublic }) => {
    for (const path of ["/docs/agents", "/download.html", "/privacy-policy", "/Terms-of-Service"] ) {
      const page = await openPublic(path, { width, javaScriptEnabled: false }); await expectFits(page, width);
      await expect(page.locator('a[href="/app"]').first()).toBeVisible();
      if (path.startsWith("/docs")) { await expect(page.locator("#docs-navigation")).toBeVisible(); await expect(page.locator("pre code").first()).toBeVisible(); }
      if (/policy|Service/.test(path)) await expect(page.locator(".legal-copy h2")).not.toHaveCount(0);
    }
  });
}
test("reduced motion retains navigation and readable code", async ({ openPublic }) => {
  const page = await openPublic("/docs/agents", { width: 390, reducedMotion: true });
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe("auto");
  await page.locator("#docs-menu-toggle").click(); await page.locator('#docs-navigation a[href="/docs/goals"]').click();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible(); await expectFits(page, 390);
});
const DOWNLOADS = { "dl-mac-arm64": "Muster.dmg", "dl-mac-x64": "Muster-intel.dmg", "dl-windows": "Muster-setup.exe", "dl-linux-deb": "Muster.deb", "dl-linux-appimage": "Muster.AppImage" };
for (const device of [
  { name: "ambiguous Mac", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36", platform: "MacIntel", label: /choose Apple Silicon or Intel/i, recommendation: null },
  { name: "Android", userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36", platform: "Linux armv8l", label: /mobile device.*browser workspace/i, recommendation: null },
  { name: "Windows", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36", platform: "Win32", label: /Detected: Windows/, recommendation: "windows" },
  { name: "Linux", userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36", platform: "Linux x86_64", label: /Detected: Linux/, recommendation: "linux" },
]) {
  test(`download platform detection handles ${device.name} without guessing an unsupported installer`, async ({ openPublic }) => {
    const page = await openPublic("/download.html", { width: 390, userAgent: device.userAgent, platform: device.platform });
    await expect(page.locator("#detected-label")).toHaveText(device.label);
    if (device.recommendation) await expect(page.locator(".dl-card--primary")).toHaveAttribute("data-os", device.recommendation);
    else await expect(page.locator(".dl-card--primary")).toHaveCount(0);
    if (device.name === "Android") { await expect(page.locator("#mobile-workspace")).toBeVisible(); await expect(page.locator("#mobile-workspace")).toHaveAttribute("href", "/app"); }
    for (const [id, filename] of Object.entries(DOWNLOADS)) await expect(page.locator(`#${id}`)).toHaveAttribute("href", `https://muster.today/downloads/${filename}`);
  });
}
for (const variant of ["valid", "missing", "malformed", "unavailable"] as const) {
  test(`download ${variant} metadata preserves explicit destinations`, async ({ openPublic }) => {
    const options: PublicOptions = variant === "missing" ? { manifest: {} } : variant === "malformed" ? { manifestBody: "{broken" } : variant === "unavailable" ? { manifestStatus: 503 } : {};
    const page = await openPublic("/download.html", options);
    for (const [id, filename] of Object.entries(DOWNLOADS)) await expect(page.locator(`#${id}`)).toHaveAttribute("href", `https://muster.today/downloads/${filename}`);
    await page.locator("#checksums summary").click();
    if (variant === "valid") {
      await expect(page.locator("#dl-version")).toHaveText("v9.8.7"); await expect(page.locator("#cli-size")).toHaveText("~64 KB");
      await expect(page.locator("#checksums-list")).toContainText(`${CHECKSUM}  Muster.dmg`);
    } else {
      await expect(page.locator("#dl-version")).not.toHaveText("v9.8.7");
      await expect(page.locator("#checksums-list")).not.toContainText(CHECKSUM);
      await expect(page.locator("#checksums-list")).not.toContainText(/loading/i);
      await expect(page.locator("#checksums-list")).toHaveText(/\S/);
    }
    await expect(page.locator('a[href="/app"]').first()).toBeVisible();
    await expect(page.locator("main")).not.toContainText(/signed\s*(?:&|and)\s*notarized by Apple|right-click the app|no workaround needed/i);
  });
}
test("team catalog search, category and ordering use controlled read-only data", async ({ openPublic }) => {
  const page = await openPublic("/teams"); const cards = page.locator("#grid .card"); await expect(cards).toHaveCount(3);
  await page.getByRole("searchbox", { name: "Search teams" }).fill("editorial"); await expect(cards).toHaveCount(1); await expect(cards.first()).toContainText("Beta Writers");
  await page.locator("#q").fill("no-such-fixture"); await expect(cards).toHaveCount(0); await expect(page.locator("#grid")).toContainText(/no teams match/i);
  await page.locator("#q").fill(""); await page.locator("#cat").selectOption("Research"); await expect(cards).toHaveCount(2);
  await page.locator("#cat").selectOption(""); await page.locator("#sort").selectOption("bots"); await expect(cards.first()).toContainText("Beta Writers");
  await page.locator("#sort").selectOption("az"); await expect(cards.first()).toContainText("Alpha Research");
});
test("team details support keyboard close, related teams and an explicit app handoff", async ({ openPublic }) => {
  const page = await openPublic("/teams"); const card = page.locator('.card[data-slug="alpha-research"]');
  await card.focus(); await page.keyboard.press("Enter"); const dialog = page.locator("#detail");
  await expect(dialog).toBeVisible(); await expect(dialog.getByRole("heading", { name: "Alpha Research" })).toBeVisible();
  await expect(dialog.locator('a[href="/app"]')).toBeVisible(); await expect(dialog.locator("script")).toHaveCount(0);
  await page.keyboard.press("Escape"); await expect(dialog).toBeHidden(); await expect(card).toBeFocused();
  await card.click(); const related = dialog.locator('.rel[data-slug="gamma-planning"]'); await related.focus(); await page.keyboard.press("Enter");
  await expect(dialog.getByRole("heading", { name: "Gamma Planning" })).toBeVisible();
  await dialog.getByRole("button", { name: "Close", exact: true }).click(); await expect(dialog).toBeHidden();
});
for (const failure of ["catalog", "detail"] as const) {
  test(`unavailable team ${failure} has an honest usable fallback`, async ({ openPublic }) => {
    const page = await openPublic("/teams", failure === "catalog" ? { catalogStatus: 503 } : { detailStatus: 503 });
    if (failure === "catalog") await expect(page.locator("#grid")).toContainText(/unreachable|unavailable|try again/i);
    else { await page.locator("#grid .card").first().click(); await expect(page.locator("#detail")).toContainText(/warming up|unavailable|try again/i); await page.getByRole("button", { name: "Close", exact: true }).click(); await expect(page.locator("#detail")).toBeHidden(); }
  });
}
for (const mode of ["success", "failure", "missing"] as const) {
  test(`template filtering and ${mode} clipboard preserve a reviewable hire prompt`, async ({ openPublic }) => {
    const page = await openPublic("/templates.html", { clipboard: mode });
    const filter = page.locator("#filters").getByRole("button", { name: "Engineering", exact: true });
    await filter.click(); await expect(page.locator('#filters [aria-pressed="true"]')).toHaveText("Engineering");
    const cards = page.locator("#grid article.card"); await expect(cards).toHaveCount(2);
    const card = cards.filter({ has: page.getByRole("heading", { name: "Ship Room", exact: true }) });
    await card.getByRole("button", { name: /^Copy hire prompt/ }).click();
    const prompt = 'Hire the "Ship Room" team template in Muster. Follow https://muster.today/docs/quick-start if Muster is not running yet.';
    if (mode === "success") { expect(await page.evaluate(() => window.__publicClipboard)).toEqual([prompt]); await expect(page.locator("#copy-status")).toContainText(/prompt copied/i); }
    else { expect(await page.evaluate(() => window.__publicClipboard)).toEqual([]); await expect(page.locator("#copy-fallback")).toBeVisible(); await expect(page.locator("#copy-prompt")).toHaveValue(prompt); await expect(page.locator("#copy-status")).not.toContainText(/prompt copied/i); }
  });
}
