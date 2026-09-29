/** Same-page recovery with real owned-server admissions. Only transport
 * timing/acknowledgements are controlled; the mounted app, transcripts,
 * receipts, task switches and fake ACP turns remain the actual product. */
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { APIResponse, Page, Route } from "@playwright/test";
import { test, expect, pairDesktop } from "./browser-fixtures.ts";

const sendSchema = z.object({ text: z.string(), clientIntentId: z.string().min(8), reconcile: z.boolean().optional() });
const ackSchema = z.object({
  message: z.object({ id: z.string(), text: z.string() }),
  intent: z.object({ intentId: z.string(), messageId: z.string(), threadId: z.string(), state: z.enum(["accepted", "dispatched", "unknown"]) }),
});
type Ack = z.infer<typeof ackSchema>;
const switchedSchema = z.object({ bot: z.object({ threadId: z.string(), tasks: z.array(z.object({ threadId: z.string(), title: z.string() })) }) });
const wire = "**/api/bots/*/messages";
const initialHeader = "x-muster-owned-initial-intent";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => { resolve = finish; });
  return { promise, resolve };
}

/** Keep the real EventSource and roster reads. A non-resumable hello is the
 * product's reconnect/hydration boundary; replay it on the SAME mounted page
 * so reload cannot accidentally clear the in-flight bookkeeping under test.
 * The MessageChannel marker runs after response JSON consumers' microtasks,
 * giving the test an acknowledgement-settlement barrier without a sleep. */
async function installTransportBarriers(page: Page) {
  await page.addInitScript(() => {
    const NativeEventSource = window.EventSource;
    const streams = new Set<EventSource>();
    window.EventSource = class extends NativeEventSource {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        if (new URL(String(url), location.href).pathname === "/api/events") streams.add(this);
      }
      override close() { streams.delete(this); super.close(); }
    };
    window.addEventListener("muster-owned-rehydrate", () => {
      for (const stream of streams) {
        if (stream.readyState !== NativeEventSource.CLOSED) {
          stream.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ kind: "hello", resumed: false }) }));
        }
      }
    });
    const fetchOriginal = window.fetch.bind(window);
    const settled = new Set<string>();
    window.fetch = async (input, init) => {
      const response = await fetchOriginal(input, init);
      const intentId = response.headers.get("x-muster-owned-initial-intent");
      if (intentId) {
        const jsonOriginal = response.json.bind(response);
        response.json = async () => {
          const value = await jsonOriginal();
          const channel = new MessageChannel();
          channel.port1.onmessage = () => {
            settled.add(intentId);
            document.documentElement.setAttribute("data-owned-settled-intents", JSON.stringify([...settled]));
            channel.port1.close(); channel.port2.close();
          };
          channel.port2.postMessage(null);
          return value;
        };
      }
      return response;
    };
  });
}

async function settled(page: Page, intentId: string) {
  await expect.poll(async () => z.array(z.string()).parse(JSON.parse(
    await page.locator("html").getAttribute("data-owned-settled-intents") ?? "[]",
  )).includes(intentId), { message: "The original response body settled in this mounted page" }).toBe(true);
}

async function fulfillInitial(route: Route, response: APIResponse, intentId: string) {
  await route.fulfill({ response, headers: { ...response.headers(), [initialHeader]: intentId } });
}

async function samePageHydrate(page: Page) {
  const snapshot = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/bots"
    && new URL(response.url()).search === "" && response.request().method() === "GET", { timeout: 15_000 });
  await page.evaluate(() => window.dispatchEvent(new Event("muster-owned-rehydrate")));
  expect((await snapshot).ok()).toBe(true);
}

async function readyComposer(page: Page) {
  await page.getByRole("button", { name: "Quick start — skip setup, just get me in", exact: true }).click();
  const composer = page.getByRole("textbox", { name: /^Message / });
  await expect(composer).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Product tour", exact: true })).toHaveCount(0);
  return composer;
}

function persisted(rootDirectory: string) {
  const database = new DatabaseSync(join(rootDirectory, "desktop", "data", "messages.db"), { readOnly: true });
  return {
    assertOne(ack: Ack) {
      expect(database.prepare("SELECT intent_id, thread_id, message_id FROM message_intents WHERE intent_id = ?").all(ack.intent.intentId))
        .toEqual([{ intent_id: ack.intent.intentId, thread_id: ack.intent.threadId, message_id: ack.intent.messageId }]);
      expect(database.prepare("SELECT id, thread_id FROM messages WHERE text = ? AND role = 'user'").all(ack.message.text))
        .toEqual([{ id: ack.message.id, thread_id: ack.intent.threadId }]);
    },
    close() { database.close(); },
  };
}

test("an incomplete 200 acknowledgement recovers on the same page with its original intent", async ({ harness, newPage, pairCodeFromCloud }, testInfo) => {
  const page = await newPage();
  await installTransportBarriers(page);
  await pairDesktop(page, harness, pairCodeFromCloud);
  const composer = await readyComposer(page);
  const text = `Incomplete acknowledgement ${randomUUID()}`;
  const admission = deferred<Ack>();
  const originals: string[] = [];
  const lookups: string[] = [];
  await page.route(wire, async (route) => {
    const send = sendSchema.parse(route.request().postDataJSON());
    if (send.reconcile) { lookups.push(send.clientIntentId); await route.continue(); return; }
    originals.push(send.clientIntentId);
    const response = await route.fetch();
    expect(response.status()).toBe(202);
    const ack = ackSchema.parse(await response.json());
    admission.resolve(ack);
    await route.fulfill({ status: 200, contentType: "application/json", headers: { [initialHeader]: send.clientIntentId }, body: "{}" });
  });
  try {
    await composer.fill(text); await composer.press("Enter");
    const ack = await admission.promise;
    await settled(page, ack.intent.intentId);
    await expect(page.getByRole("status").filter({ hasText: `Checking delivery — ${text}` })).toBeVisible();
    await samePageHydrate(page);
    await expect.poll(() => lookups, { message: "A settled incomplete acknowledgement must be eligible without reloading" }).toContain(ack.intent.intentId);
    const row = page.locator("[data-mid]").filter({ hasText: text });
    await expect(row).toHaveCount(1);
    await expect(row.locator('[data-delivery="sent"]')).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: text })).toHaveCount(0);
    await expect(page.locator("[data-mid]").filter({ hasText: "hello from fake acp" })).toHaveCount(1);
    expect(originals).toEqual([ack.intent.intentId]);
    expect(lookups.every((id) => id === ack.intent.intentId)).toBe(true);
    const db = persisted(harness.rootDirectory);
    try { db.assertOne(ack); } finally { db.close(); }
  } finally {
    await testInfo.attach("intent-transport", { body: JSON.stringify({ originals, lookups }), contentType: "application/json" });
  }
});

test.describe("same-thread recovery skips an original request still in flight", () => {
  test.use({ engineMode: "peer-capability" });
  test("accepted A and later sentinel C do not reconcile pending B until B settles", async ({ harness, newPage, pairCodeFromCloud }, testInfo) => {
    const page = await newPage();
    await installTransportBarriers(page);
    await pairDesktop(page, harness, pairCodeFromCloud);
    const composer = await readyComposer(page);
    const token = randomUUID();
    const texts = [`Hold engine ${token}`, `Accepted A ${token}`, `Pending B ${token}`, `Sentinel C ${token}`];
    const heldResponse = deferred<void>();
    const admitted = new Map(texts.map((text) => [text, deferred<Ack>()]));
    const originals: string[] = [];
    const lookups: string[] = [];
    let sentinelPassed = false;
    let sentinelId = "";
    await page.route(wire, async (route) => {
      const send = sendSchema.parse(route.request().postDataJSON());
      if (send.reconcile) {
        lookups.push(send.clientIntentId);
        const response = await route.fetch();
        expect(response.status()).toBe(202);
        await route.fulfill({ response });
        // C follows B in the persisted per-thread order. Its lookup is a
        // positive barrier proving the sweep passed B, not an early zero.
        if (send.clientIntentId === sentinelId) sentinelPassed = true;
        return;
      }
      originals.push(send.clientIntentId);
      const response = await route.fetch();
      expect(response.status()).toBe(202);
      const ack = ackSchema.parse(await response.json());
      admitted.get(send.text)?.resolve(ack);
      if (send.text === texts[2]) await heldResponse.promise;
      await fulfillInitial(route, response, send.clientIntentId);
    });
    const acknowledgements: Ack[] = [];
    try {
      for (const [index, text] of texts.entries()) {
        await composer.fill(text); await composer.press("Enter");
        const ack = await admitted.get(text)!.promise;
        acknowledgements.push(ack);
        if (index === 2) continue;
        await settled(page, ack.intent.intentId);
        if (index === 0) await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
        else expect(ack.intent.state).toBe("accepted");
      }
      const pending = acknowledgements[2];
      sentinelId = acknowledgements[3].intent.intentId;
      expect(acknowledgements[1].intent.threadId).toBe(pending.intent.threadId);
      expect(acknowledgements[3].intent.threadId).toBe(pending.intent.threadId);
      await samePageHydrate(page);
      await expect.poll(() => sentinelPassed, { message: "The later C lookup proves this sweep passed B" }).toBe(true);
      expect(lookups.filter((id) => id === pending.intent.intentId), "B must have zero receipt lookups while its original response remains held").toEqual([]);
      heldResponse.resolve();
      await settled(page, pending.intent.intentId);
      await samePageHydrate(page);
      await expect.poll(() => lookups).toContain(pending.intent.intentId);
      expect(originals).toEqual(acknowledgements.map((ack) => ack.intent.intentId));
      const db = persisted(harness.rootDirectory);
      try { acknowledgements.forEach((ack) => db.assertOne(ack)); } finally { db.close(); }
      // One owned engine process recorded a prompt while the first turn
      // holds. This per-PID marker is not a turn count; exact admission and
      // transcript uniqueness are checked against SQLite above.
      await expect.poll(async () => (await readdir(join(harness.rootDirectory, "desktop", "peer-receipts"))).filter((name) => name.endsWith(".prompt.json")).length).toBe(1);
    } finally {
      heldResponse.resolve();
      await testInfo.attach("intent-transport", { body: JSON.stringify({ originals, lookups, acknowledgements: acknowledgements.map((ack) => ack.intent) }), contentType: "application/json" });
    }
  });
});

test("a late original acknowledgement cannot move its message into the bot's new task", async ({ harness, newPage, pairCodeFromCloud }, testInfo) => {
  const page = await newPage();
  await installTransportBarriers(page);
  await pairDesktop(page, harness, pairCodeFromCloud);
  const composer = await readyComposer(page);
  const text = `Original destination ${randomUUID()}`;
  const admission = deferred<Ack>();
  const heldResponse = deferred<void>();
  const originals: string[] = [];
  await page.route(wire, async (route) => {
    const send = sendSchema.parse(route.request().postDataJSON());
    if (send.reconcile) { await route.continue(); return; }
    originals.push(send.clientIntentId);
    const response = await route.fetch();
    expect(response.status()).toBe(202);
    admission.resolve(ackSchema.parse(await response.json()));
    await heldResponse.promise;
    await fulfillInitial(route, response, send.clientIntentId);
  });
  try {
    await composer.fill(text); await composer.press("Enter");
    const ack = await admission.promise;
    await expect(page.locator("[data-mid]").filter({ hasText: "hello from fake acp" })).toHaveCount(1);
    const newTask = page.getByTitle("New task — a fresh context on this bot", { exact: true });
    await expect(newTask).toBeEnabled();
    const switchResponse = page.waitForResponse((response) => response.request().method() === "POST" && /\/api\/bots\/[^/]+\/tasks$/.test(new URL(response.url()).pathname));
    await newTask.click();
    const switched = switchedSchema.parse(await (await switchResponse).json());
    expect(switched.bot.threadId).not.toBe(ack.intent.threadId);
    await expect(page.locator("[data-mid]").filter({ hasText: text })).toHaveCount(0);
    heldResponse.resolve();
    await settled(page, ack.intent.intentId);
    // A visible task picker is a positive React render boundary after the
    // acknowledgement settled, before asserting absence in the new task.
    await page.getByRole("button", { name: "Switch task", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Tasks", exact: true })).toBeVisible();
    await expect(page.locator("[data-mid]").filter({ hasText: text }), "The settled old acknowledgement must not appear in the newly selected task").toHaveCount(0);
    const originalTask = switched.bot.tasks.find((task) => task.threadId === ack.intent.threadId);
    expect(originalTask).toBeDefined();
    await page.getByRole("dialog", { name: "Tasks", exact: true }).getByRole("button").filter({ has: page.getByText(originalTask!.title, { exact: true }) }).click();
    const row = page.locator("[data-mid]").filter({ hasText: text });
    await expect(row).toHaveCount(1);
    await expect(row.locator('[data-delivery="sent"]')).toBeVisible();
    expect(originals).toEqual([ack.intent.intentId]);
    const db = persisted(harness.rootDirectory);
    try { db.assertOne(ack); } finally { db.close(); }
  } finally {
    heldResponse.resolve();
    await testInfo.attach("initial-admissions", { body: JSON.stringify(originals), contentType: "application/json" });
  }
});
