/** Real stop/cleanup HTTP + durable write failure in owned data. Browser traffic
 * and both fixture servers are isolated; no successful API result is fabricated. */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rmdir, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { test as baseTest, expect, type BrowserContext, type Page } from "@playwright/test";
import { z } from "zod";
import { startPairingHarness, type PairingHarness } from "./pairing-harness.ts";

const botSchema = z.object({ id: z.string(), threadId: z.string(), busy: z.boolean().optional() });
const rosterSchema = z.object({ bots: z.array(botSchema) });
const sessionSchema = z.object({ pid: z.number(), servers: z.array(z.object({ name: z.string(), env: z.array(z.object({ name: z.string(), value: z.string() })).optional() })) });
type Lease = { pid: number; token: string };
type Fixture = { harness: PairingHarness; page: Page; errors: { expected: Map<string, number>; observed: Map<string, number> } };
const test = baseTest.extend<Fixture>({
  // Playwright parses this parameter to resolve fixture dependencies.
  // oxlint-disable-next-line eslint/no-empty-pattern
  harness: async ({}, use, testInfo) => {
    const harness = await startPairingHarness({ engineMode: "peer-capability" });
    const healthSchema = z.object({ pid: z.number().int().positive() });
    let serverPids: number[] = [];
    try {
      serverPids = await Promise.all([harness.cloudUrl, harness.desktopUrl].map(async (url) => {
        const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(5_000) });
        expect(response.status).toBe(200); return healthSchema.parse(await response.json()).pid;
      }));
      await use(harness);
    } finally {
      const providerPids: number[] = [];
      try {
        for (const name of await readdir(receipts(harness))) {
          if (name.endsWith(".session.json")) providerPids.push(sessionSchema.parse(JSON.parse(await readFile(join(receipts(harness), name), "utf8"))).pid);
        }
      } finally { await harness.stop(); }
      const gone = (pid: number) => {
        try { process.kill(pid, 0); return false; }
        catch (error) { return error instanceof Error && "code" in error && error.code === "ESRCH"; }
      };
      const ports = [harness.cloudUrl, harness.desktopUrl].flatMap((url) => [Number(new URL(url).port), Number(new URL(url).port) + 1]);
      const closed = await Promise.all(ports.map((port) => new Promise<boolean>((resolve) => {
        const socket = createConnection({ host: "127.0.0.1", port }); socket.setTimeout(2_000);
        socket.once("connect", () => { socket.destroy(); resolve(false); });
        socket.once("timeout", () => { socket.destroy(); resolve(false); });
        socket.once("error", (error) => { socket.destroy(); resolve("code" in error && error.code === "ECONNREFUSED"); });
      })));
      const receipt = { serverPids, providerPids, ports, serversExited: serverPids.every(gone), providersExited: providerPids.every(gone), portsClosed: closed.every(Boolean), rootRemoved: !existsSync(harness.rootDirectory) };
      const receiptPath = testInfo.outputPath("owned-fixture-cleanup.json");
      await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
      await testInfo.attach("owned-fixture-cleanup", { path: receiptPath, contentType: "application/json" });
      expect(receipt).toMatchObject({ serversExited: true, providersExited: true, portsClosed: true, rootRemoved: true });
    }
  },
  // oxlint-disable-next-line eslint/no-empty-pattern -- no fixture dependencies
  errors: async ({}, use) => { await use({ expected: new Map(), observed: new Map() }); },
  page: async ({ browser, harness, errors }, use, testInfo) => {
    const contexts: BrowserContext[] = [];
    const unexpected: string[] = [];
    const open = async () => {
      const context = await browser.newContext(); contexts.push(context);
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (![harness.cloudUrl, harness.desktopUrl].includes(url.origin)) {
          unexpected.push(`Outbound ${url.origin}${url.pathname}`); await route.abort(); return;
        }
        await route.continue();
      });
      context.on("page", (page) => {
        page.on("pageerror", (error) => unexpected.push(error.message));
        page.on("console", (message) => {
          if (message.type() !== "error") return;
          const match = message.text().match(/^Failed to load resource:.*\b(503|409)\b/);
          const key = `${message.location().url} ${match?.[1] ?? ""}`;
          if (match && errors.expected.has(key)) {
            errors.observed.set(key, (errors.observed.get(key) ?? 0) + 1); return;
          }
          unexpected.push(`${message.location().url}: ${message.text()}`);
        });
      });
      return context.newPage();
    };
    try {
      const cloud = await open();
      await cloud.goto(`${harness.cloudUrl}/pair`);
      await cloud.getByLabel("Email address", { exact: true }).fill(harness.email);
      await cloud.getByLabel("Password", { exact: true }).fill(harness.password);
      await cloud.getByRole("button", { name: "Sign in with email", exact: true }).click();
      const code = cloud.getByLabel("Pairing code", { exact: true });
      await expect(code).toHaveValue(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
      const page = await open();
      await page.goto(`${harness.desktopUrl}/sign-in`);
      await page.getByLabel("Pairing code", { exact: true }).fill(await code.inputValue());
      await page.getByRole("button", { name: "Connect", exact: true }).click();
      await page.getByRole("button", { name: "Quick start — skip setup, just get me in", exact: true }).click();
      await expect(page.getByRole("textbox", { name: /^Message / })).toBeVisible();
      await use(page);
      expect(errors.observed).toEqual(errors.expected);
      if (unexpected.length) await testInfo.attach("browser-errors", { body: unexpected.join("\n"), contentType: "text/plain" });
      expect(unexpected).toEqual([]);
    } finally { await Promise.all(contexts.map((context) => context.close())); }
  },
});

async function roster(page: Page, harness: PairingHarness) {
  const response = await page.request.get(`${harness.desktopUrl}/api/bots`);
  expect(response.status()).toBe(200);
  return rosterSchema.parse(await response.json()).bots;
}
async function prepare(page: Page, harness: PairingHarness) {
  const [caller] = await roster(page, harness);
  expect(caller).toBeTruthy();
  const helperResponse = await page.request.post(`${harness.desktopUrl}/api/bots`, { data: {} });
  expect(helperResponse.status()).toBe(201);
  const helper = z.object({ bot: botSchema }).parse(await helperResponse.json()).bot;
  expect((await page.request.patch(`${harness.desktopUrl}/api/bots/${helper.id}`, { data: { name: "Cleanup helper", computer: "off" } })).status()).toBe(200);
  return { caller, helper };
}
const receipts = (harness: PairingHarness) => join(harness.rootDirectory, "desktop", "peer-receipts");
async function begin(page: Page, harness: PairingHarness, botId: string): Promise<Lease> {
  const known = new Set(await readdir(receipts(harness)));
  const composer = page.getByRole("textbox", { name: /^Message / });
  await composer.fill(`Owned stopped work ${randomUUID()}`);
  const accepted = await nextResponse(page, `${harness.desktopUrl}/api/bots/${botId}/messages`, () => composer.press("Enter"));
  expect(accepted.status()).toBe(202);
  let lease: Lease | undefined;
  await expect.poll(async () => {
    for (const name of await readdir(receipts(harness))) {
      if (!name.endsWith(".session.json") || known.has(name)) continue;
      const session = sessionSchema.parse(JSON.parse(await readFile(join(receipts(harness), name), "utf8")));
      const peer = session.servers.find((server) => server.name === "agents")?.env ?? [];
      if (peer.find((entry) => entry.name === "OMB_BOT_ID")?.value !== botId) continue;
      const token = peer.find((entry) => entry.name === "OMB_COMMS_TOKEN")?.value;
      if (token) lease = { pid: session.pid, token };
    }
    return Boolean(lease);
  }).toBe(true);
  if (!lease) throw new Error("No actual injected peer credential");
  await expect.poll(() => readFile(join(receipts(harness), `${lease!.pid}.prompt.json`), "utf8").then(() => true, () => false)).toBe(true);
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  return lease;
}
async function queueAndObstruct(page: Page, harness: PairingHarness, helperId: string, lease: Lease) {
  const response = await page.request.post(`${harness.desktopUrl}/api/internal/delegate-bot`, {
    headers: { authorization: `Bearer ${lease.token}` }, data: { toBotId: helperId, message: "Never execute this canceled handoff" },
  });
  expect(response.status()).toBe(200); expect(await response.json()).toMatchObject({ queued: true });
  const file = join(harness.rootDirectory, "desktop", "data", "delegations.json");
  const backup = join(harness.rootDirectory, "saved-delegations.json");
  const original = await readFile(file, "utf8");
  expect(original).toContain(helperId);
  await rename(file, backup); await mkdir(file);
  let restored = false;
  return { file, restore: async () => {
    if (restored) return;
    await rmdir(file); await rename(backup, file); restored = true;
    expect(await readFile(file, "utf8")).toBe(original);
  } };
}
async function release(harness: PairingHarness, lease: Lease) {
  await writeFile(join(receipts(harness), `${lease.pid}.release`), "owned fixture release", { mode: 0o600 });
}
const recovery = (page: Page) => page.getByRole("alert", { name: "Stop needs attention", exact: true });
function expectedError(errors: Fixture["errors"], url: string, status: number) {
  const key = `${url} ${status}`; errors.expected.set(key, (errors.expected.get(key) ?? 0) + 1);
}
async function nextResponse(page: Page, url: string, action: () => Promise<void>) {
  const pending = page.waitForResponse((response) => response.url() === url && response.request().method() === "POST");
  await action(); return pending;
}
async function withinViewport(page: Page) {
  const box = await recovery(page).evaluate((node) => {
    const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: innerHeight, width: innerWidth, documentWidth: document.documentElement.scrollWidth };
  });
  expect(box.left).toBeGreaterThanOrEqual(-1); expect(box.right).toBeLessThanOrEqual(box.width + 1);
  expect(box.documentWidth).toBeLessThanOrEqual(box.width + 1);
  expect(box.top).toBeGreaterThanOrEqual(-1); expect(box.bottom).toBeLessThanOrEqual(box.height + 1);
}

test("idle recovery survives six seconds and task changes, retries the exact cleanup and preserves the draft at 320px", async ({ page, harness, errors }, testInfo) => {
  const { caller, helper } = await prepare(page, harness);
  const lease = await begin(page, harness, caller.id);
  const obstruction = await queueAndObstruct(page, harness, helper.id, lease);
  const interruptUrl = `${harness.desktopUrl}/api/bots/${caller.id}/interrupt`;
  const cleanupUrl = `${harness.desktopUrl}/api/bots/${caller.id}/stop-cleanup`;
  expectedError(errors, interruptUrl, 503);
  let stoppedBody: { cleanupReceipt: string };
  const writes: string[] = [];
  page.on("request", (request) => { if ([interruptUrl, cleanupUrl].includes(request.url()) && request.method() === "POST") writes.push(request.url()); });
  try {
    const stopped = await nextResponse(page, interruptUrl, async () => {
      // Two real DOM controls in one event-loop turn, before React can render
      // disabled state, exercise the shared synchronous request lock.
      await page.getByRole("button", { name: "Stop", exact: true }).evaluate((node) => {
        // SAFETY: this role locator resolves the rendered native Stop button.
        (node as HTMLButtonElement).click();
        document.querySelector<HTMLButtonElement>('button[aria-label="Stop this turn"]')?.click();
      });
    });
    expect(stopped.status()).toBe(503);
    expect(writes).toEqual([interruptUrl]);
    await expect.poll(async () => JSON.parse(await readFile(join(receipts(harness), `${lease.pid}.cancel.json`), "utf8").catch(() => "null"))).toMatchObject({ pid: lease.pid, canceled: 1 });
    stoppedBody = z.object({ cleanupReceipt: z.string().regex(/^[a-f0-9]{64}$/) }).parse(await stopped.json());
    await release(harness, lease);
    await expect.poll(async () => (await roster(page, harness)).find((bot) => bot.id === caller.id)?.busy ?? false).toBe(false);
    await expect(recovery(page)).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    // The old shared error timer is six seconds. This proves the persistent
    // recovery surface, without replacing application clocks or state.
    await page.waitForTimeout(6_200);
    await expect(recovery(page)).toBeVisible();
    expectedError(errors, cleanupUrl, 503);
    const failedRetry = await nextResponse(page, cleanupUrl, async () => {
      await page.getByRole("button", { name: "Retry stop cleanup", exact: true }).evaluate((node) => {
        // SAFETY: this role locator resolves the native recovery button.
        const button = node as HTMLButtonElement;
        button.click(); button.click();
      });
    });
    expect(failedRetry.status()).toBe(503);
    expect(writes).toEqual([interruptUrl, cleanupUrl]);
    expect(failedRetry.request().postDataJSON()).toEqual({ receipt: stoppedBody.cleanupReceipt });
    await expect(page.getByRole("button", { name: "Retry stop cleanup", exact: true })).toBeEnabled();
  } finally { await obstruction.restore(); await release(harness, lease); }
  // Create a new task through the actual control, without starting new work.
  await page.getByRole("button", { name: "Task", exact: true }).click();
  await expect.poll(async () => (await roster(page, harness)).find((bot) => bot.id === caller.id)?.threadId).not.toBe(caller.threadId);
  await expect(recovery(page)).toBeVisible();
  const draft = "  Keep this unsent draft — café  ";
  await page.getByRole("textbox", { name: /^Message / }).fill(draft);
  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: width === 320 ? 568 : 900 });
    await withinViewport(page);
    await page.getByRole("button", { name: "Retry stop cleanup", exact: true }).click({ trial: true });
    await page.screenshot({ path: testInfo.outputPath(`stop-recovery-${width}.png`) });
  }
  const retry = await nextResponse(page, cleanupUrl, () => page.getByRole("button", { name: "Retry stop cleanup", exact: true }).click());
  expect(retry.status()).toBe(200);
  expect(retry.request().postDataJSON()).toEqual({ receipt: stoppedBody!.cleanupReceipt });
  await expect(recovery(page)).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: /^Message / })).toHaveValue(draft);
  const queues = z.record(z.string(), z.array(z.unknown())).parse(JSON.parse(await readFile(obstruction.file, "utf8")));
  expect(queues[caller.threadId] ?? []).toEqual([]);
  expect(writes).toEqual([interruptUrl, cleanupUrl, cleanupUrl]);
  expect((await roster(page, harness)).find((bot) => bot.id === helper.id)?.busy ?? false).toBe(false);
  // No helper dispatch receipt is allowed, even if a short turn already ended.
  for (const name of (await readdir(receipts(harness))).filter((entry) => entry.endsWith(".session.json"))) {
    const record = sessionSchema.parse(JSON.parse(await readFile(join(receipts(harness), name), "utf8")));
    expect(record.pid).toBe(lease.pid);
  }
});

test("a newer turn in another tab makes old cleanup inspect-only and is never interrupted by retry", async ({ page, harness, errors }) => {
  const { caller, helper } = await prepare(page, harness);
  const lease = await begin(page, harness, caller.id);
  const obstruction = await queueAndObstruct(page, harness, helper.id, lease);
  const interruptUrl = `${harness.desktopUrl}/api/bots/${caller.id}/interrupt`;
  const cleanupUrl = `${harness.desktopUrl}/api/bots/${caller.id}/stop-cleanup`;
  expectedError(errors, interruptUrl, 503);
  try {
    expect((await nextResponse(page, interruptUrl, () => page.getByRole("button", { name: "Stop", exact: true }).click())).status()).toBe(503);
    await release(harness, lease);
    await expect.poll(async () => (await roster(page, harness)).find((bot) => bot.id === caller.id)?.busy ?? false).toBe(false);
  } finally { await obstruction.restore(); await release(harness, lease); }
  await expect(recovery(page)).toBeVisible();
  const other = await page.context().newPage();
  await other.goto(`${harness.desktopUrl}/app?bot=${encodeURIComponent(caller.id)}`);
  const newer = await begin(other, harness, caller.id);
  const cancelFile = join(receipts(harness), `${newer.pid}.cancel.json`);
  const cancelBefore = await readFile(cancelFile, "utf8").catch(() => null);
  try {
    expectedError(errors, cleanupUrl, 409);
    expect((await nextResponse(page, cleanupUrl, () => page.getByRole("button", { name: "Retry stop cleanup", exact: true }).click())).status()).toBe(409);
    await expect(recovery(page)).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry stop cleanup", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Review current conversation", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Review current conversation", exact: true }).click();
    expect((await roster(page, harness)).find((bot) => bot.id === caller.id)?.busy).toBe(true);
    expect(await readFile(cancelFile, "utf8").catch(() => null)).toBe(cancelBefore);
    await expect(other.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
    await release(harness, newer);
    await expect.poll(() => readFile(join(receipts(harness), `${newer.pid}.completed.json`), "utf8").then(() => true, () => false)).toBe(true);
    expect(await readFile(cancelFile, "utf8").catch(() => null)).toBe(cancelBefore);
  } finally { await release(harness, newer); await other.close(); }
});

test("signing out discards a held Stop failure without reviving recovery in the signed-out app", async ({ page, harness }, testInfo) => {
  const { caller, helper } = await prepare(page, harness);
  const lease = await begin(page, harness, caller.id);
  const obstruction = await queueAndObstruct(page, harness, helper.id, lease);
  const interruptUrl = `${harness.desktopUrl}/api/bots/${caller.id}/interrupt`;
  let allowResponse!: () => void;
  let reportResponse!: (status: number) => void;
  let reportHandlerFinished!: () => void;
  const gate = new Promise<void>((resolve) => { allowResponse = resolve; });
  const actualStatus = new Promise<number>((resolve) => { reportResponse = resolve; });
  const handlerFinished = new Promise<void>((resolve) => { reportHandlerFinished = resolve; });
  const aborts: string[] = [];
  page.on("requestfailed", (request) => {
    if (request.url() === interruptUrl) aborts.push(request.failure()?.errorText ?? "unknown");
  });
  await page.route(interruptUrl, async (route) => {
    try {
      // Forward the real Stop, retaining its real failure until the account
      // leaves. This controls latency, never invents a server outcome.
      const response = await route.fetch();
      reportResponse(response.status());
      await gate;
      await route.fulfill({ response });
    } finally { reportHandlerFinished(); }
  });
  try {
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    expect(await actualStatus).toBe(503);
    await page.goto(`${harness.desktopUrl}/sign-in`);
    await page.getByRole("button", { name: "Use another account", exact: true }).click();
    await expect.poll(async () => {
      const response = await page.request.get(`${harness.desktopUrl}/api/auth/get-session`);
      expect(response.status()).toBe(200); return response.json();
    }).toBeNull();
    allowResponse(); await handlerFinished;
    // Chromium may suppress requestfailed for a routed request whose document
    // was destroyed. Record transport observation; assert the actual account/UI
    // boundary below instead of requiring a particular CDP event.
    const transportPath = testInfo.outputPath("late-stop-transport.json");
    await writeFile(transportPath, JSON.stringify({ serverStatus: 503, observedRequestFailures: aborts }, null, 2) + "\n");
    await testInfo.attach("late-stop-transport", { path: transportPath, contentType: "application/json" });
    expect(aborts.every((error) => error === "net::ERR_ABORTED")).toBe(true);
    await page.goto(`${harness.desktopUrl}/app`);
    await expect(page).toHaveURL(/\/sign-in\?next=%2Fapp$/);
    await expect(recovery(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Retry stop cleanup", exact: true })).toHaveCount(0);
  } finally {
    allowResponse();
    await obstruction.restore(); await release(harness, lease);
    await page.unroute(interruptUrl);
  }
});
