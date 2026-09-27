/** Durable send receipts in the real browser: the actual composer send path,
 * an intercepted lost response, a page reload, and a second paired context —
 * against owned servers and a fake ACP engine. The intercept is a failure
 * BEFORE forwarding (never a fabricated acceptance), so the server-side
 * durable layer is only ever read, never faked. */
import { randomUUID } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { test, expect, pairDesktop } from "./browser-fixtures.ts";
import type { Page } from "@playwright/test";

const rosterSchema = z.object({ bots: z.array(z.object({ id: z.string(), threadId: z.string() })) });
const transcriptSchema = z.object({ bots: z.array(z.object({ messages: z.array(z.object({ text: z.string().optional() })).optional() })) });
const checkingRow = (page: Page, message: string) => page.getByRole("status").filter({ hasText: `Checking delivery — ${message}` });

// Parsed, not cast: these are all boundaries where untrusted or foreign-
// written data enters the test. A peer receipt is written by the desktop
// holder and a posted body comes off the wire, so each is decoded into a
// shape this test can rely on rather than asserted into one.
const peerReceiptSchema = z.object({ pid: z.number().optional() });
const clientIntentSchema = z.object({ clientIntentId: z.string().optional() });
const intentRowSchema = z.object({ intent_id: z.string(), state: z.string() });
const performanceMemorySchema = z.object({ memory: z.object({ usedJSHeapSize: z.number() }).optional() });
const peerReceipt = (raw: string) => peerReceiptSchema.parse(JSON.parse(raw));

// The queue row of the acceptance table, web-exercisable: a send accepted
// behind a busy bot must read "accepted", never "sent", and converge to a
// terminal receipt without ever resending the words. The peer-capability
// engine holds its turn until an owned release file exists, so the busy
// window is deterministic.
test.describe("a send queued behind a busy bot keeps its receipt honest", () => {
  test.use({ engineMode: "peer-capability" });

  test("accepted while queued, dispatched after the drain, sent after reload", async ({ harness, newPage, pairCodeFromCloud }) => {
    const page = await newPage();
    await pairDesktop(page, harness, pairCodeFromCloud);
    await page.getByRole("button", { name: "Quick start — skip setup, just get me in", exact: true }).click();
    const composer = page.getByRole("textbox", { name: /^Message / });
    await expect(composer).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Product tour", exact: true })).toHaveCount(0);

    // Turn 1: the engine holds until the release file exists.
    const firstSend = page.waitForRequest((request) => request.method() === "POST" && /\/api\/bots\/[^/]+\/messages$/.test(new URL(request.url()).pathname));
    const held = `Held turn ${randomUUID()}`;
    await composer.fill(held);
    await composer.press("Enter");
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
    const receipts = join(harness.rootDirectory, "desktop", "peer-receipts");
    let holderPid = 0;
    await expect.poll(async () => {
      for (const name of await readdir(receipts)) {
        if (!name.endsWith(".session.json")) continue;
        const session = peerReceipt(await readFile(join(receipts, name), "utf8"));
        if (session.pid !== undefined && session.pid > 0) holderPid = session.pid;
      }
      return holderPid;
    }).toBeGreaterThan(0);
    const heldId = clientIntentSchema.parse(await (await firstSend).postDataJSON()).clientIntentId ?? "";

    // Turn 2 arrives while the bot is busy: durable words, queued dispatch.
    const queuedSend = page.waitForRequest((request) => request.method() === "POST" && /\/api\/bots\/[^/]+\/messages$/.test(new URL(request.url()).pathname));
    const queued = `Queued probe ${randomUUID()}`;
    await composer.fill(queued);
    await composer.press("Enter");
    const queuedRow = page.locator("[data-mid]").filter({ hasText: queued });
    await expect(queuedRow).toHaveCount(1);
    // The receipt says exactly what is true: stored and waiting, NOT sent.
    await expect(queuedRow.locator('[data-delivery="accepted"]')).toBeVisible();
    await expect(queuedRow.getByText("Accepted — waiting to send", { exact: true })).toBeVisible();
    const queuedId = clientIntentSchema.parse(await (await queuedSend).postDataJSON()).clientIntentId ?? "";

    // The queue drains only when the held turn settles. In this engine mode
    // every settled turn replies "Owned held turn completed" — and every
    // turn spawns a FRESH engine child that waits for its OWN pid's release
    // file, so the poll releases each observed session (the holder included)
    // while it waits for both replies.
    await writeFile(join(receipts, `${holderPid}.release`), "", { mode: 0o600 });
    await expect.poll(async () => {
      for (const name of await readdir(receipts)) {
        if (!name.endsWith(".session.json")) continue;
        const session = peerReceipt(await readFile(join(receipts, name), "utf8"));
        if (session.pid !== undefined && session.pid > 0) {
          await writeFile(join(receipts, `${session.pid}.release`), "", { mode: 0o600 }).catch(() => {});
        }
      }
      return page.locator("[data-mid]").filter({ hasText: "Owned held turn completed" }).count();
    }).toBe(2);

    // The terminal receipt converged while the tab was away: reload replays
    // the SAME id, the dispatched receipt retires the record, and the chip
    // reads Sent — with no residue of the interim "accepted" state.
    await page.reload();
    await expect(page.locator("[data-mid]").filter({ hasText: queued })).toHaveCount(1);
    await expect(page.locator('[data-delivery="sent"]')).toHaveCount(1);
    await expect(page.locator('[data-delivery="accepted"]')).toHaveCount(0);

    // Both intents reached the durable layer exactly once, dispatched
    // (order-free: row order is an implementation detail).
    const db = new DatabaseSync(join(harness.rootDirectory, "desktop", "data", "messages.db"), { readOnly: true });
    try {
      const rows = z.array(intentRowSchema).parse(
        db.prepare("SELECT intent_id, state FROM message_intents WHERE intent_id IN (?, ?)").all(heldId, queuedId),
      );
      expect(rows.map((row) => ({ intent_id: row.intent_id, state: row.state })).sort((a, b) => a.intent_id.localeCompare(b.intent_id))).toEqual([
        { intent_id: heldId, state: "dispatched" },
        { intent_id: queuedId, state: "dispatched" },
      ].sort((a, b) => a.intent_id.localeCompare(b.intent_id)));
    } finally {
      db.close();
    }
  });
});

test("a lost send response is recovered on reload as one message and one turn", async ({ harness, newPage, pairCodeFromCloud }, testInfo) => {
  const page = await newPage({ messageSend503: true });
  await pairDesktop(page, harness, pairCodeFromCloud);
  await page.getByRole("button", { name: "Quick start — skip setup, just get me in", exact: true }).click();
  const composer = page.getByRole("textbox", { name: /^Message / });
  await expect(composer).toBeVisible();
  // The optional tour must be fully gone BEFORE the send: its late Skip
  // handler can otherwise land between the send and the focus assertion
  // below and steal focus for reasons that have nothing to do with receipts.
  await expect(page.getByRole("dialog", { name: "Product tour", exact: true })).toHaveCount(0);
  const message = `Recovery probe ${randomUUID()}`;
  const firstSend = page.waitForRequest(
    (request) => request.method() === "POST" && /\/api\/bots\/[^/]+\/messages$/.test(new URL(request.url()).pathname),
  );
  await composer.fill(message);
  await composer.press("Enter");
  // SAFETY: the wire contract names exactly this field on a send; the regex
  // below is the checked invariant that the value really is a client intent id.
  const posted = (await (await firstSend).postDataJSON()) as { clientIntentId?: string };
  const intentId = posted.clientIntentId ?? "";
  expect(intentId).toMatch(/^snd-[0-9a-f]{32}$/);
  // The acknowledgement was lost: the exact words stay visible in a compact
  // checking row, focus never moves, and nothing pretends the send failed.
  await expect(checkingRow(page, message)).toBeVisible();
  expect(await composer.evaluate((element) => element === document.activeElement)).toBe(true);
  // Reload = the disconnect. The parked record replays the SAME id and the
  // ORIGINAL bubble folds back with its sent chip — never a second send.
  await page.reload();
  const userRow = page.locator("[data-mid]").filter({ hasText: message });
  await expect(userRow).toHaveCount(1);
  await expect(userRow.locator('[data-delivery="sent"]')).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: message })).toHaveCount(0);
  await expect(page.locator("[data-mid]").filter({ hasText: "hello from fake acp" })).toHaveCount(1);
  // A second paired context reads the same durable truth.
  const cloud = await newPage();
  await cloud.goto(`${harness.cloudUrl}/pair`);
  await cloud.getByLabel("Email address", { exact: true }).fill(harness.email);
  await cloud.getByLabel("Password", { exact: true }).fill(harness.password);
  await cloud.getByRole("button", { name: "Sign in with email", exact: true }).click();
  const codeField = cloud.getByLabel("Pairing code", { exact: true });
  await expect(codeField).toHaveValue(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
  const repair = await newPage();
  await pairDesktop(repair, harness, await codeField.inputValue());
  // A fresh context gets the optional first-visit tour; dismiss it once, then
  // reload into the plain app — this account's onboarding is already done, so
  // no "Quick start" flow is involved on the repair side.
  await repair
    .getByRole("dialog", { name: "Product tour", exact: true })
    .getByRole("button", { name: "Skip", exact: true })
    .click({ timeout: 10_000 })
    .catch(() => { /* tour already dismissed or never shown */ });
  await repair.reload();
  await expect(repair.getByRole("textbox", { name: /^Message / })).toBeVisible();
  await expect(repair.locator("[data-mid]").filter({ hasText: message })).toHaveCount(1);
  await expect(repair.locator("[data-mid]").filter({ hasText: "hello from fake acp" })).toHaveCount(1);
  // The durable layer kept exactly one intent for this send, dispatched once.
  const db = new DatabaseSync(join(harness.rootDirectory, "desktop", "data", "messages.db"), { readOnly: true });
  try {
    const intents = db.prepare("SELECT intent_id, state FROM message_intents WHERE intent_id = ?").all(intentId);
    expect(intents).toEqual([{ intent_id: intentId, state: "dispatched" }]);
  } finally {
    db.close();
  }
  // Same-machine startup + idle measurement: navigation timing plus two
  // seconds of observed idleness (long tasks, heap) on the recovered page.
  const timing = await page.evaluate(() => performance.getEntriesByType("navigation")[0]?.toJSON() ?? {});
  const idle = await page.evaluate(async () => {
    // SAFETY: this callback runs in the PAGE context, where test-file
    // variables do not exist; performance.memory is a Chromium-only
    // extension whose shape is fixed by the platform, not untrusted input.
    const memory = (performance as { memory?: { usedJSHeapSize: number } }).memory;
    const longTasks = await new Promise<number>((resolveTasks) => {
      let count = 0;
      const observer = new PerformanceObserver((list) => { count += list.getEntries().length; });
      observer.observe({ type: "longtask", buffered: false });
      setTimeout(() => { observer.disconnect(); resolveTasks(count); }, 2_000);
    });
    return { longTasks, heapMB: memory !== undefined ? Math.round(memory / (1024 * 1024)) : null };
  });
  const timingSummary = JSON.stringify({ navigation: timing, idle });
  // One always-visible line: attachments only persist for failing runs.
  console.log(`app-timing ${timingSummary}`);
  await testInfo.attach("app-timing", { body: JSON.stringify({ navigation: timing, idle }, null, 2), contentType: "application/json" });
});

test("an unconfirmed send stays visibly parked across reload without reaching the durable layer", async ({ harness, newPage, pairCodeFromCloud }) => {
  const page = await newPage();
  await pairDesktop(page, harness, pairCodeFromCloud);
  await page.getByRole("button", { name: "Quick start — skip setup, just get me in", exact: true }).click();
  const composer = page.getByRole("textbox", { name: /^Message / });
  await expect(composer).toBeVisible();
  const threadId = rosterSchema.parse(await (await page.request.get(`${harness.desktopUrl}/api/bots?messages=0`)).json()).bots[0]!.threadId;
  // The endpoint answers every probe but never confirms a message id: an
  // honest "heard, unconfirmable" server. No console error is fabricated.
  let sends = 0;
  await page.route("**/api/bots/*/messages", async (route) => {
    if (route.request().method() !== "POST") return;
    sends += 1;
    await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ ok: true, threadId }) });
  });
  const message = `Held probe ${randomUUID()}`;
  await composer.fill(message);
  await composer.press("Enter");
  await expect.poll(() => sends).toBeGreaterThanOrEqual(1);
  const checking = checkingRow(page, message);
  await expect(checking).toBeVisible();
  // Nothing was admitted: no transcript row may appear for these words.
  await expect(page.locator("[data-mid]").filter({ hasText: message })).toHaveCount(0);
  // The record survives reload and stays visibly held, in role="status",
  // without stealing focus, without animating under reduced motion, and
  // without overflowing a narrow viewport.
  await page.reload();
  await expect(checking).toBeVisible();
  expect(await checking.evaluate((element) => element.closest("button, a, input, textarea, select, [tabindex]:not([tabindex='-1'])"))).toBeNull();
  await page.emulateMedia({ reducedMotion: "reduce" });
  // The app's reduced-motion contract: the spinner becomes a calm opacity
  // pulse (styles.css .animate-spin override), never a rotating wheel.
  expect(await checking.evaluate((element) => getComputedStyle(element.querySelector(".animate-spin")!).animationName)).toBe("reduced-loader-pulse");
  await page.setViewportSize({ width: 320, height: 740 });
  await expect(checking).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  // 200% text zoom (Chromium zoom is the text-scale proxy): still readable,
  // still no horizontal overflow.
  await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
  await expect(checking).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= 2 * window.innerWidth)).toBe(true);
  await page.evaluate(() => { document.documentElement.style.zoom = ""; });
  await page.setViewportSize({ width: 1280, height: 900 });
  // The durable layer never heard about this send.
  const db = new DatabaseSync(join(harness.rootDirectory, "desktop", "data", "messages.db"), { readOnly: true });
  try {
    expect(db.prepare("SELECT COUNT(*) AS n FROM message_intents").get()).toEqual({ n: 0 });
  } finally {
    db.close();
  }
  const bots = transcriptSchema.parse(await (await page.request.get(`${harness.desktopUrl}/api/bots?messages=50`)).json()).bots;
  expect(bots.some((bot) => (bot.messages ?? []).some((entry) => entry.text === message))).toBe(false);
});
