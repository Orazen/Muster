import { z } from "zod";
import type { Locator, Page } from "@playwright/test";
import { test, expect, pairDesktop } from "./browser-fixtures.ts";

const botSchema = z.object({ id: z.string(), name: z.string() });
const rosterSchema = z.object({ bots: z.array(botSchema) });
const messageRequestSchema = z.object({
  clientIntentId: z.string().optional(),
  reconcile: z.boolean().optional(),
});

async function insideViewport(surface: Locator): Promise<void> {
  await expect.poll(async () => surface.evaluate((node) => {
    const bounds = node.getBoundingClientRect();
    return bounds.left >= -1 && bounds.right <= window.innerWidth + 1
      && node.scrollWidth <= node.clientWidth + 1;
  })).toBe(true);
}

async function openToday(page: Page, width: number): Promise<Locator> {
  if (width < 768) {
    const drawer = page.getByRole("button", { name: "Open bot list", exact: true });
    await drawer.focus();
    await drawer.press("Enter");
    await expect(drawer).toHaveAttribute("aria-expanded", "true");
  }
  const navigation = page.getByRole("button", { name: "Today", exact: true });
  await navigation.focus();
  await navigation.press("Enter");
  const today = page.getByRole("main", { name: "Today workspace", exact: true });
  await expect(today).toBeVisible();
  if (width < 768) {
    await expect(page.getByRole("button", { name: "Open bot list", exact: true })).toHaveAttribute("aria-expanded", "false");
  }
  return today;
}

for (const width of [1280, 320]) {
  test(`Today preserves the selected teammate, draft, attachments and skin; only an explicit chat send executes at ${width}px`, async ({ harness, newPage, pairCodeFromCloud }, testInfo) => {
    const page = await newPage();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await pairDesktop(page, harness, pairCodeFromCloud);
    await page.getByRole("button", { name: "Quick start — skip setup, just get me in", exact: true }).click();
    await expect(page.getByRole("region", { name: "Set up Muster", exact: true })).toBeHidden();
    await expect(page.getByRole("textbox", { name: /^Message / })).toBeVisible();
    const roster = rosterSchema.parse(await (await page.context().request.get(`${harness.desktopUrl}/api/bots`)).json());
    const original = roster.bots[0];
    expect(original).toBeDefined();

    // A different selected teammate catches accidental fallback to the first
    // roster member. These are owned fixture accounts, not user workspaces.
    const created = await page.context().request.post(`${harness.desktopUrl}/api/bots`, { data: {} });
    expect(created.ok()).toBe(true);
    const selected = z.object({ bot: botSchema }).parse(await created.json()).bot;
    expect(selected.id).not.toBe(original.id);
    const named = await page.context().request.patch(`${harness.desktopUrl}/api/bots/${selected.id}`, {
      data: { name: "Today review teammate" },
    });
    expect(named.ok()).toBe(true);
    const bot = z.object({ bot: botSchema }).parse(await named.json()).bot;
    const attachment = { kind: "paste", id: "today-preserved", text: "Existing attachment context", size: 27, lines: 1 };
    await page.evaluate(({ originalId, selectedId, attachment }) => {
      localStorage.setItem("omb-skin", "foundry");
      localStorage.setItem("omb-drafts", JSON.stringify({
        [`bot:${originalId}`]: "Keep the other teammate's draft.",
        [`bot:${selectedId}`]: "Keep my existing draft.",
      }));
      localStorage.setItem("omb-draft-attachments", JSON.stringify({ [`bot:${selectedId}`]: [attachment] }));
    }, { originalId: original.id, selectedId: bot.id, attachment });
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${harness.desktopUrl}/app?bot=${encodeURIComponent(bot.id)}`);
    const composer = page.getByRole("textbox", { name: `Message ${bot.name}`, exact: true });
    await expect(composer).toHaveValue("Keep my existing draft.");
    await expect(page.getByText("Existing attachment context", { exact: true })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "foundry");

    const messagePosts: { url: string; intentId: string; reconcile: boolean }[] = [];
    page.on("request", (request) => {
      if (request.method() !== "POST" || !/\/api\/bots\/[^/]+\/messages$/.test(new URL(request.url()).pathname)) return;
      const body = messageRequestSchema.parse(request.postDataJSON());
      messagePosts.push({ url: request.url(), intentId: body.clientIntentId ?? "", reconcile: body.reconcile ?? false });
    });

    let today = await openToday(page, width);
    // Selecting the already-current destination must also dismiss the drawer.
    if (width < 768) today = await openToday(page, width);
    await insideViewport(today);
    await expect(today.getByRole("combobox", { name: "Draft for", exact: true })).toHaveValue(bot.id);
    await today.getByRole("button", { name: "Capture idea", exact: true }).click();
    const request = today.getByRole("textbox", { name: "Request for your assistant", exact: true });
    await expect(request).toBeFocused();
    const idea = "Make room for one quiet hour tomorrow; keep this as a draft.";
    await request.fill(idea);
    await insideViewport(request);
    await today.screenshot({ path: testInfo.outputPath(`today-${width}.png`) });
    await today.getByRole("button", { name: "Prepare draft", exact: true }).click();
    await expect(today).toBeHidden();
    await expect(composer).toHaveValue(`Keep my existing draft.\n\n${idea}`);
    await expect(page.getByText("Existing attachment context", { exact: true })).toBeVisible();
    await insideViewport(composer);
    expect(messagePosts).toEqual([]);

    // Returning to Today must not change the destination or repeat an append.
    today = await openToday(page, width);
    await expect(today.getByRole("combobox", { name: "Draft for", exact: true })).toHaveValue(bot.id);
    await expect(today.getByRole("textbox", { name: "Request for your assistant", exact: true })).toHaveValue("");
    await today.getByRole("button", { name: "Review work", exact: true }).click();
    await expect(composer).toHaveValue(`Keep my existing draft.\n\n${idea}`);
    await page.reload();
    await expect(composer).toHaveValue(`Keep my existing draft.\n\n${idea}`);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "foundry");
    const retained = await page.evaluate(({ originalId, selectedId }) => ({
      otherDraft: JSON.parse(localStorage.getItem("omb-drafts") ?? "{}")[`bot:${originalId}`],
      attachments: JSON.parse(localStorage.getItem("omb-draft-attachments") ?? "{}")[`bot:${selectedId}`],
      skin: localStorage.getItem("omb-skin"),
    }), { originalId: original.id, selectedId: bot.id });
    expect(retained).toEqual({ otherDraft: "Keep the other teammate's draft.", attachments: [attachment], skin: "foundry" });
    expect(messagePosts).toEqual([]);

    // The fake ACP engine verifies the existing message transport. It does not
    // prove real model quality, Calendar changes or new remote-device routing.
    await composer.press("Enter");
    const conversation = page.getByLabel(`Conversation with ${bot.name}`, { exact: true });
    await expect(conversation.getByText("hello from fake acp", { exact: true })).toHaveCount(1);
    const sends = messagePosts.filter((entry) => !entry.reconcile);
    expect(sends).toHaveLength(1);
    expect(new URL(sends[0].url).pathname).toBe(`/api/bots/${bot.id}/messages`);
    expect(sends[0].intentId).toMatch(/^[\w.-]{8,128}$/);
    expect(new Set(messagePosts.map((entry) => entry.intentId)).size).toBe(1);
  });
}

test("Today opens the existing Calendar and device settings surfaces at 320px without granting access", async ({ harness, newPage, pairCodeFromCloud }, testInfo) => {
  const page = await newPage();
  // Keep the existing marketplace's optional remote icons out of this
  // isolated navigation fixture; no external connector is exercised.
  await page.route("**/api/connectors/catalog", (route) => route.fulfill({ json: { configured: false, cards: [] } }));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await pairDesktop(page, harness, pairCodeFromCloud);
  await page.getByRole("button", { name: "Quick start — skip setup, just get me in", exact: true }).click();
  await expect(page.getByRole("region", { name: "Set up Muster", exact: true })).toBeHidden();
  await expect(page.getByRole("textbox", { name: /^Message / })).toBeVisible();
  await page.setViewportSize({ width: 320, height: 740 });
  const authorityWrites: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() !== "GET" && /\/api\/(calendar\/(connect|connection)|installations|pair|bots\/[^/]+\/messages)(\/|$)/.test(path)) {
      authorityWrites.push(`${request.method()} ${path}`);
    }
  });
  const today = await openToday(page, 320);
  await today.getByRole("button", { name: "Plan my day", exact: true }).click();
  const calendar = page.getByRole("region", { name: "Personal Google Calendar", exact: true });
  await expect(calendar).toBeVisible();
  await expect(calendar.getByText(/requests read-only access and does not change events/)).toBeVisible();
  await insideViewport(calendar);
  await page.getByRole("button", { name: "Close connected apps", exact: true }).click();
  await expect(today).toBeVisible();
  await today.getByRole("button", { name: "Devices", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(settings).toBeVisible();
  await expect(settings.getByRole("combobox", { name: "Settings section", exact: true })).toHaveValue("remoteAccess");
  await insideViewport(settings);
  await settings.screenshot({ path: testInfo.outputPath("today-devices-320.png") });
  await settings.getByRole("button", { name: "Close settings", exact: true }).click();
  await expect(today).toBeVisible();
  expect(authorityWrites).toEqual([]);
});
