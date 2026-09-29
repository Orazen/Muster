import { z } from "zod";
import { test, expect, pairDesktop } from "./browser-fixtures.ts";
import { DAILY_PLANNING_TASK, PERSONAL_ASSISTANT_ROLE } from "../src/lib/daily-planning.ts";

test("personal assistant hiring prepares a persistent daily-plan draft without sending or granting access", async ({ harness, newPage, pairCodeFromCloud }, testInfo) => {
  const page = await newPage();
  await pairDesktop(page, harness, pairCodeFromCloud);
  await page.getByRole("button", { name: "Quick start — skip setup, just get me in", exact: true }).click();
  await page.getByRole("button", { name: "New or share", exact: true }).click();
  await page.getByRole("button", { name: "Agent Hub", exact: true }).click();
  const hub = page.getByRole("dialog", { name: "Agent Hub", exact: true });
  await expect(hub.getByText("Personal assistant", { exact: false })).toBeVisible();
  await page.setViewportSize({ width: 320, height: 740 });
  await expect(hub.getByText(/Needs a working model and calendar connection/)).toBeVisible();
  await expect.poll(async () => {
    const bounds = await hub.boundingBox();
    return bounds !== null && bounds.x >= 0 && bounds.x + bounds.width <= 320;
  }).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("personal-assistant-320.png"), fullPage: true });
  const messagePosts: { intentId: string; reconcile: boolean }[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST" || !/\/api\/bots\/[^/]+\/messages$/.test(request.url())) return;
    const body = z.object({
      clientIntentId: z.string().optional(),
      reconcile: z.boolean().optional(),
    }).parse(request.postDataJSON());
    messagePosts.push({
      intentId: body.clientIntentId ?? "",
      reconcile: body.reconcile ?? false,
    });
  });
  await hub.getByRole("button", { name: "Hire Daylight", exact: true }).click();
  const composer = page.getByRole("textbox", { name: "Message Daylight", exact: true });
  await expect(composer).toHaveValue(DAILY_PLANNING_TASK);
  await hub.getByRole("button", { name: "Close Agent Hub", exact: true }).click();
  await expect(composer).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const roster = await page.context().request.get(`${harness.desktopUrl}/api/bots`);
  const bots = z.object({ bots: z.array(z.object({ id: z.string(), name: z.string(), description: z.string(), autoApprove: z.boolean().optional() })) }).parse(await roster.json()).bots;
  const assistant = bots.filter((bot) => bot.name === "Daylight");
  expect(assistant).toHaveLength(1);
  expect(assistant[0].description).toBe(PERSONAL_ASSISTANT_ROLE);
  expect(assistant[0].autoApprove).not.toBe(true);
  expect(messagePosts).toEqual([]);
  await page.reload();
  await expect(composer).toHaveValue(DAILY_PLANNING_TASK);
  expect(messagePosts).toEqual([]);
  // User approval to send is explicit; the fake model only verifies routing,
  // not calendar reading or the quality of a real model's plan.
  await composer.press("Enter");
  const conversation = page.getByLabel("Conversation with Daylight", { exact: true });
  await expect(conversation.getByText("hello from fake acp", { exact: true })).toHaveCount(1);
  await expect(conversation.getByText(DAILY_PLANNING_TASK, { exact: true })).toHaveCount(1);
  const createRequests = messagePosts.filter((request) => !request.reconcile);
  expect(createRequests).toHaveLength(1);
  expect(createRequests[0]?.intentId).toMatch(/^[\w.-]{8,128}$/);
  // Reconnect may POST a reconcile:true lookup with this same ID; that is not
  // a second user message. Different IDs would represent distinct sends.
  expect(new Set(messagePosts.map((request) => request.intentId)).size).toBe(1);
});
