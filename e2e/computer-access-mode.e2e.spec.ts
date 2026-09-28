/** Owned account + bot persistence, with synthetic computer/preview transports.
 * No OS permissions, containers, external pages or user sessions are touched. */
import { z } from "zod";
import type { Page } from "@playwright/test";
import { test, expect, pairDesktop } from "./browser-fixtures.ts";
import type { BrowserPreviewState } from "../src/components/browser-preview-session.ts";

const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1kAAAAASUVORK5CYII=";
const rosterSchema = z.object({ bots: z.array(z.object({ id: z.string(), name: z.string(), computer: z.string().optional() })) });

declare global {
  interface Window {
    musterComputerFixture: {
      enableCalls: number;
      frameCalls: number;
      panes: string[];
      grantOnRetry: boolean;
      granted: boolean;
    };
  }
}

async function mockMac(page: Page) {
  await page.addInitScript(image => {
    const fixture: Window["musterComputerFixture"] = window.musterComputerFixture = {
      enableCalls: 0, frameCalls: 0, panes: [], grantOnRetry: false, granted: false,
    };
    Object.defineProperty(window, "ogb", { configurable: true, value: {
      platform: "darwin",
      getCapabilities: async () => ({
        host: { platform: "darwin", label: "macOS", session: "unknown", packaged: true },
        windowChrome: "mac-inset",
        screenPreview: { available: fixture.granted, interaction: fixture.granted ? "direct" : "none" },
        dictation: { available: false, engine: "none", onDevice: false },
        localComputer: { available: fixture.granted, support: fixture.granted ? "supported" : "unsupported",
          reasonCode: fixture.enableCalls ? "cua-driver-unavailable" : "computer-access-off" },
      }),
      enableComputerAccess: async () => {
        fixture.enableCalls += 1;
        if (fixture.grantOnRetry) { fixture.granted = true; return { mode: "embedded" }; }
        return { mode: "unavailable", reason: "embedded host failed: Accessibility and Screen Recording required; grant access in System Settings, then try again" };
      },
      permOpenSettings: async (pane: string) => { fixture.panes.push(pane); },
      screenFrame: async () => { fixture.frameCalls += 1; return `data:image/png;base64,${image}`; },
    } });
  }, pixel);
}

async function dismissSetup(page: Page) {
  const setup = page.getByRole("region", { name: "Set up Muster", exact: true });
  await expect(setup).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(setup).toHaveCount(0);
}

async function openTool(page: Page, name: "Bot's computer" | "Browser") {
  // Tools collapse by conversation-column width, including at desktop
  // viewport sizes when the sidebar leaves less than 1020px for the chat.
  const header = page.locator('header[aria-label="Conversation controls"]');
  const toggle = header.getByRole("button", { name: "Tools", exact: true });
  if (await toggle.isVisible() && await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
  await header.getByRole("button", { name, exact: true }).click();
}

async function seedMode(page: Page, desktopUrl: string, computer: "vm" | "off" | "local") {
  const roster = rosterSchema.parse(await (await page.request.get(`${desktopUrl}/api/bots`)).json());
  expect(roster.bots.length).toBeGreaterThan(0);
  const bot = roster.bots[0]!;
  const response = await page.request.patch(`${desktopUrl}/api/bots/${bot.id}`, { data: { computer } });
  expect(response.status()).toBe(200);
  await page.reload();
  await dismissSetup(page);
  return bot;
}

async function mockVm(page: Page, ready: boolean, mode: "shared" | "perBot" = "shared", missing = false) {
  const calls: string[] = [];
  await page.route(url => url.pathname === "/api/local-computer" || url.pathname.startsWith("/api/local-computer/"), async route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    calls.push(`${route.request().method()} ${path}${url.search}`);
    if (path.endsWith("/screenshot")) {
      expect(route.request().method()).toBe("POST");
      await route.fulfill({ json: { image: `data:image/png;base64,${pixel}` } });
      return;
    }
    expect(route.request().method()).toBe("GET");
    await route.fulfill({ json: {
      platform: "darwin", runtime: "podman", available: ["podman"], daemonUp: true,
      image: true, imageMatches: true, managed: true, container: missing ? "missing" : ready ? "running" : "stopped",
      network: "loopback", security: "hardened", persistence: "durable", desktopReady: ready,
      desktop_starting: false, ready, problem: ready ? null : "The Local VM is stopped",
      image_ref: "owned-image", base_image_ref: "owned-base", driver_version: "fixture",
      container_name: "owned-vm", workspace_path: "/owned/workspace", workspace_guest_path: "/home/cua/workspace",
      viewer_url: "http://127.0.0.1:6090/vnc.html", idle_timeout_ms: 28_800_000,
      mode, max_instances: 4, runtime_install: { installable: true, manager: "Homebrew" },
      commands: { install: null, runtimeStart: null, pull: null, run: null, start: null, stop: null, remove: null, view: "http://127.0.0.1:6090/vnc.html" },
    } });
  });
  return calls;
}

for (const width of [320, 1280]) {
  test(`Local VM preview is independent of Mac access and Off stops it at ${width}px`, async ({ harness, newPage, pairCodeFromCloud }) => {
    const page = await newPage();
    await page.setViewportSize({ width, height: 900 });
    await mockMac(page);
    const vmCalls = await mockVm(page, true);
    const cloudCalls: string[] = [];
    page.on("request", request => { if (/\/api\/bots\/[^/]+\/computer(?:\/|$)/.test(new URL(request.url()).pathname)) cloudCalls.push(request.url()); });
    await pairDesktop(page, harness, pairCodeFromCloud);
    const bot = await seedMode(page, harness.desktopUrl, "vm");
    await openTool(page, "Bot's computer");
    const panel = page.locator("aside").filter({ hasText: "Runs on" });
    await expect(panel.getByRole("img", { name: `${bot.name}'s screen`, exact: true })).toBeVisible();
    await expect(panel.getByRole("region", { name: "This Mac access", exact: true })).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "Enable for this session", exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => window.musterComputerFixture.enableCalls)).toBe(0);
    expect(await page.evaluate(() => window.musterComputerFixture.frameCalls)).toBe(0);
    expect(vmCalls).toContain(`POST /api/local-computer/screenshot?botId=${bot.id}`);
    expect(vmCalls.every(call => call.endsWith(`?botId=${bot.id}`))).toBe(true);
    expect(cloudCalls).toEqual([]);
    // The existing entrance animation translates the panel 28px for 240ms.
    // Wait for its real layout to settle; retain the strict 1px tolerance.
    await expect.poll(() => panel.evaluate(node => {
      const bounds = node.getBoundingClientRect();
      return Math.max(-bounds.left, bounds.right - innerWidth, node.scrollWidth - node.clientWidth);
    })).toBeLessThanOrEqual(1);
    const saved = page.waitForResponse(response => response.request().method() === "PATCH" && new URL(response.url()).pathname === `/api/bots/${bot.id}`);
    await panel.getByRole("button", { name: "Off", exact: true }).click();
    expect((await saved).status()).toBe(200);
    await expect(panel.getByText("This bot's computer is off", { exact: true })).toBeVisible();
    await expect(panel.getByRole("img")).toHaveCount(0);
    await expect(panel.getByRole("region", { name: "This Mac access", exact: true })).toHaveCount(0);
    // Cross the actual 3-second VM poll boundary: Off must cancel it.
    const afterOff = [...vmCalls];
    await page.waitForTimeout(3_200);
    expect(vmCalls).toEqual(afterOff);
    expect(cloudCalls).toEqual([]);
    expect(await page.evaluate(() => window.musterComputerFixture.enableCalls)).toBe(0);
    const persisted = rosterSchema.parse(await (await page.request.get(`${harness.desktopUrl}/api/bots`)).json());
    expect(persisted.bots.find(item => item.id === bot.id)?.computer).toBe("off");
  });
}

test("an unavailable VM offers VM setup without requesting Mac permissions", async ({ harness, newPage, pairCodeFromCloud }) => {
  const page = await newPage();
  await mockMac(page);
  await mockVm(page, false);
  await pairDesktop(page, harness, pairCodeFromCloud);
  await seedMode(page, harness.desktopUrl, "vm");
  await openTool(page, "Bot's computer");
  await expect(page.getByRole("button", { name: "Enable for this session", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Open Local VM setup", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(settings.getByRole("button", { name: "Set up automatically", exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.musterComputerFixture.enableCalls)).toBe(0);
  expect(await page.evaluate(() => window.musterComputerFixture.panes)).toEqual([]);
});

test("a per-bot VM waits for its first task without probing the shared desktop or creating a container", async ({ harness, newPage, pairCodeFromCloud }) => {
  const page = await newPage();
  await mockMac(page);
  const calls = await mockVm(page, false, "perBot", true);
  await pairDesktop(page, harness, pairCodeFromCloud);
  const bot = await seedMode(page, harness.desktopUrl, "vm");
  await openTool(page, "Bot's computer");
  const panel = page.locator("aside").filter({ hasText: "Runs on" });
  await expect(panel.getByText("This bot’s Local VM starts with its next task.", { exact: true })).toBeVisible();
  await expect(panel.getByRole("region", { name: "This Mac access", exact: true })).toHaveCount(0);
  await page.waitForTimeout(3_200);
  expect(calls.length).toBeGreaterThanOrEqual(2);
  expect(calls.every(call => call === `GET /api/local-computer?botId=${bot.id}`)).toBe(true);
  expect(await page.evaluate(() => window.musterComputerFixture.enableCalls)).toBe(0);
});

test("packaged Mac permission denial opens the two exact privacy panes and can retry", async ({ harness, newPage, pairCodeFromCloud }) => {
  const page = await newPage();
  await mockMac(page);
  await pairDesktop(page, harness, pairCodeFromCloud);
  const bot = await seedMode(page, harness.desktopUrl, "off");
  await openTool(page, "Bot's computer");
  const selected = page.waitForResponse(response => response.request().method() === "PATCH" && new URL(response.url()).pathname === `/api/bots/${bot.id}`);
  await page.getByRole("button", { name: "This Mac", exact: true }).click();
  expect((await selected).status()).toBe(200);
  const access = page.getByRole("region", { name: "This Mac access", exact: true });
  await expect(access).toBeVisible();
  expect(await page.evaluate(() => window.musterComputerFixture.enableCalls)).toBe(0);
  await access.getByRole("button", { name: "Enable for this session", exact: true }).click();
  await expect(access.getByRole("alert")).toContainText("Screen Recording");
  await expect(access.getByRole("alert")).toContainText("Accessibility");
  await expect(access.getByRole("alert")).toContainText("Muster");
  await expect(access).toContainText("Muster");
  await access.getByRole("button", { name: "Open Screen Recording settings", exact: true }).click();
  await access.getByRole("button", { name: "Open Accessibility settings", exact: true }).click();
  expect(await page.evaluate(() => window.musterComputerFixture.panes)).toEqual(["screen", "accessibility"]);
  expect(await page.evaluate(() => window.musterComputerFixture.enableCalls)).toBe(1);
  expect(await page.evaluate(() => window.musterComputerFixture.frameCalls)).toBe(0);
  // A synthetic OS grant is confirmed only by the bridge after an explicit retry.
  await page.evaluate(() => { window.musterComputerFixture.grantOnRetry = true; });
  await access.getByRole("button", { name: "Enable for this session", exact: true }).click();
  await expect(access.getByRole("status")).toHaveText("This Mac is enabled for this session.");
  await expect(access.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("img", { name: `${bot.name}'s screen`, exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.musterComputerFixture.enableCalls)).toBe(2);
});

test("Auto with a configured cloud provider but no existing box never provisions a computer merely by opening the panel", async ({ harness, newPage, pairCodeFromCloud }) => {
  const page = await newPage();
  await mockMac(page);
  const calls: string[] = [];
  await page.route(url => /^\/api\/bots\/[^/]+\/computer(?:\/|$)/.test(url.pathname), async route => {
    const path = new URL(route.request().url()).pathname;
    calls.push(`${route.request().method()} ${path}`);
    // Keep every unexpected write inside the synthetic boundary; assert none
    // below, without provisioning any actual cloud resource on a regression.
    await route.fulfill({ json: route.request().method() === "GET" ? { configured: true, box: null } : { state: "running" } });
  });
  await pairDesktop(page, harness, pairCodeFromCloud);
  await dismissSetup(page);
  const roster = rosterSchema.parse(await (await page.request.get(`${harness.desktopUrl}/api/bots`)).json());
  const bot = roster.bots[0]!;
  expect(bot.computer).toBeUndefined();
  await openTool(page, "Bot's computer");
  const access = page.getByRole("region", { name: "This Mac access", exact: true });
  await expect(access.getByRole("button", { name: "Enable for this session", exact: true })).toBeEnabled();
  await expect.poll(() => calls.length).toBeGreaterThan(0);
  // Observe one full old screenshot timer interval so the previous eager
  // provision/preview path cannot pass from a merely early assertion.
  await page.waitForTimeout(4_100);
  expect(calls).toEqual([`GET /api/bots/${bot.id}/computer`]);
  expect(await page.evaluate(() => window.musterComputerFixture.enableCalls)).toBe(0);
  expect(await page.evaluate(() => window.musterComputerFixture.frameCalls)).toBe(0);
});

test("browser preview opens and navigates with computer Off and no Mac permission", async ({ harness, newPage, pairCodeFromCloud }) => {
  const page = await newPage();
  await mockMac(page);
  const calls: string[] = [];
  const preview: BrowserPreviewState = {
    running: false, url: null, title: null, profile: "bot", error: null,
  };
  await page.route("**/api/bots/*/browser-panel/**", async route => {
    const path = new URL(route.request().url()).pathname;
    calls.push(`${route.request().method()} ${path}`);
    if (path.endsWith("/frame")) { await route.fulfill({ json: { state: preview, frame: null } }); return; }
    expect(route.request().method()).toBe("POST");
    if (path.endsWith("/start")) { preview.running = true; expect(route.request().postDataJSON()).toEqual({ profile: "bot" }); }
    else if (path.endsWith("/navigate")) {
      const data = z.object({ url: z.string() }).parse(route.request().postDataJSON());
      preview.url = data.url; preview.title = "Owned browser page";
    } else throw new Error(`Unexpected preview action: ${path}`);
    await route.fulfill({ json: preview });
  });
  await pairDesktop(page, harness, pairCodeFromCloud);
  await seedMode(page, harness.desktopUrl, "off");
  await openTool(page, "Browser");
  const panel = page.getByTestId("browser-panel");
  await panel.getByRole("button", { name: "Open preview", exact: true }).click();
  await expect(panel.getByRole("status")).toHaveText("Preview open");
  await panel.getByRole("textbox", { name: "Web address", exact: true }).fill(`${harness.desktopUrl}/owned-browser-page`);
  await panel.getByRole("button", { name: "Go", exact: true }).click();
  await expect(panel.getByText("Owned browser page", { exact: true })).toBeVisible();
  expect(calls.filter(call => call.startsWith("POST ")).map(call => call.split("/").at(-1))).toEqual(["start", "navigate"]);
  expect(await page.evaluate(() => window.musterComputerFixture.enableCalls)).toBe(0);
  expect(await page.evaluate(() => window.musterComputerFixture.frameCalls)).toBe(0);
  expect(await page.evaluate(() => window.musterComputerFixture.panes)).toEqual([]);
});
