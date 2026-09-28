/** Rendered transport truth: real owned server/auth/Settings, synthetic desktop
 * companion bridge. No sidecar is started and no network/OS permission is used.
 * These checks do not establish installed-app or off-Wi-Fi reachability. */
import { test, expect, type Page } from "@playwright/test";
import { z } from "zod";
import { startOnboardingHarness } from "./onboarding-harness.ts";

type FixtureState = {
  enabled: boolean;
  port: number;
  devices: [];
  pairing: null | { code: string; token: string; expiresAt: number; access: "full" | "approvals" };
  lan?: string | null;
  addresses?: string[];
  tailscale?: string;
  tailnetName?: string;
};

declare global {
  interface Window {
    __remoteFixtureCalls: Array<{ action: string; access?: string }>;
    __remoteFixtureClipboard: string;
  }
}

const lan = "192.0.2.24";
const tailnet = "owned-desktop.example.ts.net";
const base: FixtureState = { enabled: true, port: 8799, devices: [], pairing: null };
let harness: Awaited<ReturnType<typeof startOnboardingHarness>>;
let external: string[];
let errors: string[];

test.beforeEach(async ({ context, page }) => {
  harness = await startOnboardingHarness(process.env.MUSTER_E2E_STATIC_DIR);
  external = [];
  errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await context.addInitScript(() => {
    localStorage.setItem("muster:analytics-opt-out", "1");
    localStorage.setItem("muster.productTour.done.v1", "1");
  });
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin === harness.url) return route.continue();
    external.push(url.origin + url.pathname);
    await route.abort("blockedbyclient");
  });
});

test.afterEach(async ({ page, context }) => {
  try {
    await page.unrouteAll({ behavior: "wait" });
    await page.close();
    await context.unrouteAll({ behavior: "wait" });
  } finally { await harness.stop(); }
  expect(external, "No request leaves the owned harness").toEqual([]);
  expect(errors, "No unexpected browser errors").toEqual([]);
});

async function openRemote(page: Page, state?: FixtureState) {
  if (state) await page.addInitScript(initial => {
    const snapshot = structuredClone(initial);
    const calls: Array<{ action: string; access?: string }> = [];
    window.__remoteFixtureCalls = calls;
    window.__remoteFixtureClipboard = "";
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async (text: string) => { window.__remoteFixtureClipboard = text; },
    } });
    Object.defineProperty(window, "ogb", { configurable: true, value: { companion: {
      state: async () => structuredClone(snapshot),
      start: async () => { calls.push({ action: "start" }); snapshot.enabled = true; return structuredClone(snapshot); },
      stop: async () => { calls.push({ action: "stop" }); snapshot.enabled = false; return structuredClone(snapshot); },
      pairing: async (open: boolean, access: "full" | "approvals" = "full") => {
        calls.push({ action: open ? "pair" : "cancel", access });
        snapshot.pairing = open ? { code: "123456", token: "omb_pair_" + "a".repeat(43), expiresAt: Date.now() + 300_000, access } : null;
        return structuredClone(snapshot);
      },
    } } });
  }, state);
  expect((await harness.api("/api/me/onboarding", { method: "PUT", body: JSON.stringify({ status: "submitted" }) })).status).toBe(200);
  const config = z.record(z.string(), z.unknown()).parse((await harness.api("/api/config")).body);
  await page.route("**/api/config", route => route.fulfill({ json: { ...config, storageGate: {
    required: true, satisfied: true, options: { googleDrive: { available: true, connected: true }, telegram: { configured: false } },
  } } }));
  await page.goto(`${harness.url}/sign-in?next=%2Fapp`);
  await page.getByLabel("Email address", { exact: true }).fill(harness.email);
  await page.getByLabel("Password", { exact: true }).fill(harness.password);
  await page.getByRole("button", { name: "Sign in with email", exact: true }).click();
  await expect(page).toHaveURL(`${harness.url}/app`);
  await page.getByRole("button", { name: "App settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await settings.getByRole("button", { name: "Remote access", exact: true }).click();
  if (state) await expect(settings.getByRole("switch", { name: "Remote access", exact: true })).toBeVisible();
  await expect(settings.getByText("Secure HTTPS pairing", { exact: true })).toHaveCount(0);
  await expect(settings.getByText(/keeps working when the paired device leaves this Wi-Fi|already points at this computer's secure address|works from anywhere on your tailnet/)).toHaveCount(0);
  await expect(settings.getByText(state ? "Connection availability" : "Remote access runs through the companion process, which only the desktop app can start. Open Muster on this computer to turn it on.", { exact: true })).toBeVisible();
  return settings;
}

async function copiedAddress(page: Page) {
  await page.getByRole("button", { name: "Copy pairing link", exact: true }).click();
  await expect(page.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
  const link = new URL(z.string().parse(await page.evaluate(() => window.__remoteFixtureClipboard)));
  expect(link.protocol).toBe("muster:");
  expect(link.hostname).toBe("pair");
  expect(link.searchParams.get("code")).toBe("123456");
  expect(link.searchParams.get("token")).toBe("omb_pair_" + "a".repeat(43));
  return link.searchParams.get("address");
}

test("browser-only Settings does not claim it can start a desktop companion", async ({ page }) => {
  const settings = await openRemote(page);
  await expect(settings.getByRole("switch", { name: "Remote access", exact: true })).toHaveCount(0);
  await expect(settings.getByRole("button", { name: "Create pairing code", exact: true })).toHaveCount(0);
});

test("disabled companion offers no existing network or HTTPS readiness", async ({ page }) => {
  const settings = await openRemote(page, { ...base, enabled: false });
  await expect(settings.getByText("Muster's companion is off on this computer.", { exact: true })).toBeVisible();
  await expect(settings.getByText("Turn on remote access to find this computer's network address.", { exact: true })).toBeVisible();
  await expect(settings.getByRole("button", { name: "Pair on this Wi-Fi", exact: true })).toBeDisabled();
  expect(await page.evaluate(() => window.__remoteFixtureCalls)).toEqual([]);
});

test("enabled companion without an address cannot copy a usable pairing link", async ({ page }) => {
  const settings = await openRemote(page, { ...base });
  await expect(settings.getByText("No network address is available yet. Connect this computer to a network and check again.", { exact: true })).toBeVisible();
  await expect(settings.getByRole("button", { name: "Pair on this Wi-Fi", exact: true })).toBeDisabled();
  await settings.getByRole("button", { name: "Create pairing code", exact: true }).click();
  await expect(settings.getByRole("button", { name: "Copy pairing link", exact: true })).toBeDisabled();
  expect(await page.evaluate(() => window.__remoteFixtureCalls)).toEqual([{ action: "pair", access: "full" }]);
});

for (const width of [320, 1440]) {
  test(`LAN pairing preserves scope and reports its actual address at ${width}px`, async ({ page }, info) => {
    const settings = await openRemote(page, { ...base, lan, addresses: [lan] });
    await page.setViewportSize({ width, height: width === 320 ? 700 : 1000 });
    await expect(settings.getByText("The pairing link uses a local network address. Keep both devices on the same network; this link does not provide access away from it.", { exact: true })).toBeVisible();
    await settings.getByRole("radio", { name: /Chat and approvals only/ }).click();
    await settings.getByRole("button", { name: "Pair on this Wi-Fi", exact: true }).click();
    expect(await copiedAddress(page)).toBe(`${lan}:8799`);
    expect(await page.evaluate(() => window.__remoteFixtureCalls)).toEqual([{ action: "pair", access: "approvals" }]);
    await expect(settings.getByText("This code grants chats and approvals only.", { exact: true })).toBeVisible();
    await settings.getByText("Connection availability", { exact: true }).evaluate(element => element.scrollIntoView({ block: "start" }));
    expect(await settings.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath(`remote-lan-${width}.png`), fullPage: true });
    await settings.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(settings.getByRole("button", { name: "Copy pairing link", exact: true })).toHaveCount(0);
  });

  test(`Tailscale link keeps a separate manual LAN fallback at ${width}px`, async ({ page }, info) => {
    const settings = await openRemote(page, { ...base, lan, addresses: [lan, "100.64.0.9"], tailscale: "100.64.0.9", tailnetName: tailnet });
    await page.setViewportSize({ width, height: width === 320 ? 700 : 1000 });
    await expect(settings.getByText("The pairing link uses Tailscale. Both devices must be on the same tailnet, with access allowed by its network rules.", { exact: true })).toBeVisible();
    await expect(settings.getByText(`The pairing link above uses Tailscale. On the same Wi-Fi, you can enter ${lan}:8799 and the pairing code in the Muster app instead.`, { exact: true })).toBeVisible();
    await expect(settings.getByRole("button", { name: "Pair on this Wi-Fi", exact: true })).toHaveCount(0);
    await settings.getByRole("button", { name: "Create pairing code", exact: true }).click();
    expect(await copiedAddress(page)).toBe(`${tailnet}:8799`);
    await expect(settings.getByText("Use the sign-in or pairing link provided by that Muster server. The companion code above pairs the Muster app with this computer; it does not sign you in to another web workspace.", { exact: true })).toBeVisible();
    await settings.getByText("Connection availability", { exact: true }).evaluate(element => element.scrollIntoView({ block: "start" }));
    expect(await settings.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath(`remote-tailnet-${width}.png`), fullPage: true });
  });
}

test("missing MagicDNS falls back to LAN without advertising a bare tailnet link", async ({ page }) => {
  const settings = await openRemote(page, { ...base, lan, addresses: ["100.64.0.9", lan], tailscale: "100.64.0.9" });
  await expect(settings.getByText("This computer is on a tailnet, but its MagicDNS name could not be read — iPhones can't dial a bare tailnet address.", { exact: true })).toBeVisible();
  await settings.getByRole("button", { name: "Pair on this Wi-Fi", exact: true }).click();
  expect(await copiedAddress(page)).toBe(`${lan}:8799`);
});
