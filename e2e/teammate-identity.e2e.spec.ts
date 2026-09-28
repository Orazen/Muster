/** Real owned account/server persistence. No live providers, permissions or
 * third-party artwork: the existing avatar renderer serves both identity UIs. */
import { z } from "zod";
import type { Locator, Page } from "@playwright/test";
import { test, expect, pairDesktop } from "./browser-fixtures.ts";

const rosterSchema = z.object({ bots: z.array(z.object({
  id: z.string(), name: z.string(), color: z.string(), character: z.string(),
})) });
const setup = (page: Page) => page.getByRole("region", { name: "Set up Muster", exact: true });
const appearance = (page: Page) => page.getByRole("region", { name: "Teammate appearance", exact: true });

async function insideWidth(surface: Locator) {
  const bounds = await surface.evaluate(node => {
    const rect = node.getBoundingClientRect();
    return { left: rect.left, right: rect.right, width: innerWidth, scroll: node.scrollWidth, client: node.clientWidth };
  });
  expect(bounds.left).toBeGreaterThanOrEqual(-1);
  expect(bounds.right).toBeLessThanOrEqual(bounds.width + 1);
  expect(bounds.scroll).toBeLessThanOrEqual(bounds.client + 1);
}

for (const width of [320, 1280]) {
  test(`mascot editor previews without saving, persists choices and restores Flower at ${width}px`, async ({ harness, newPage, pairCodeFromCloud }, info) => {
    const page = await newPage();
    await page.setViewportSize({ width, height: width === 320 ? 568 : 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await pairDesktop(page, harness, pairCodeFromCloud);
    await expect(setup(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(setup(page)).toHaveCount(0);
    await page.getByTitle("Bot settings").first().click();
    const editor = appearance(page);
    await expect(editor).toBeVisible();
    if (width < 768) {
      const dialog = page.getByRole("dialog", { name: "Bot settings", exact: true });
      await expect(dialog).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      expect(await dialog.evaluate(node => node.contains(document.activeElement))).toBe(true);
      await page.keyboard.press("Tab");
      await expect(dialog.getByRole("button", { name: "Back to conversation", exact: true })).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(page.getByTitle("Bot settings").first()).toBeFocused();
      await page.getByTitle("Bot settings").first().click();
      // A higher dialog owns its keyboard scope while Bot settings stays open.
      await page.keyboard.press("ControlOrMeta+k");
      const palette = page.getByRole("dialog", { name: "Command palette", exact: true });
      await expect(palette.getByRole("textbox")).toBeFocused();
      await page.keyboard.press("Tab");
      await expect.poll(() => palette.evaluate(node => node.contains(document.activeElement))).toBe(true);
      await page.keyboard.press("Escape");
      await expect(palette).toHaveCount(0);
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "Choose model", exact: true }).click();
      const modelPicker = dialog.getByRole("dialog", { name: "Choose model", exact: true });
      await expect(modelPicker).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(modelPicker).toHaveCount(0);
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "Choose model", exact: true }).click();
      await expect(modelPicker).toBeVisible();
      // The nested picker is non-modal: it must not disable the outer scope.
      await dialog.getByRole("button", { name: "Back to conversation", exact: true }).focus();
      await page.keyboard.press("Shift+Tab");
      await expect.poll(() => dialog.evaluate(node => node.contains(document.activeElement))).toBe(true);
      await page.keyboard.press("Escape");
      await expect(modelPicker).toHaveCount(0);
      await expect(dialog).toBeVisible();
    }
    await insideWidth(editor);
    const writes: string[] = [];
    page.on("request", request => {
      if (request.method() === "PATCH" && /\/api\/bots\/[^/]+$/.test(new URL(request.url()).pathname)) writes.push(request.postData() ?? "");
    });
    await editor.getByRole("button", { name: "Working", exact: true }).click();
    await expect(editor.getByTestId("bot-avatar-preview").locator('canvas')).toHaveAttribute("data-state", "working");
    await expect(editor.getByTestId("bot-avatar-preview").locator('[data-bot-paused="true"]')).toHaveCount(1);
    await editor.getByRole("button", { name: "Resting", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(editor.getByTestId("bot-avatar-preview").locator('canvas')).toHaveAttribute("data-state", "sleeping");
    expect(writes).toEqual([]);
    for (const label of ["Use the cloud character", "Use teal mascot color"]) {
      const saved = page.waitForResponse(response => response.request().method() === "PATCH" && /\/api\/bots\/[^/]+$/.test(new URL(response.url()).pathname));
      await editor.getByRole("button", { name: label, exact: true }).click();
      expect((await saved).status()).toBe(200);
    }
    await page.getByRole("button", { name: "Close bot settings", exact: true }).click();
    await page.reload();
    await page.getByTitle("Bot settings").first().click();
    await expect(editor.getByRole("button", { name: "Use the cloud character", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(editor.getByRole("button", { name: "Use teal mascot color", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(editor.getByRole("button", { name: "Resting", exact: true })).toHaveAttribute("aria-pressed", "false");
    await insideWidth(editor);
    await page.screenshot({ path: info.outputPath(`mascot-editor-${width}.png`) });
    const reset = page.waitForResponse(response => response.request().method() === "PATCH" && /\/api\/bots\/[^/]+$/.test(new URL(response.url()).pathname));
    await editor.getByRole("button", { name: "Reset mascot appearance", exact: true }).click();
    expect((await reset).status()).toBe(200);
    await expect(editor.getByRole("button", { name: "Use the flower character", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(editor.getByRole("button", { name: "Use orange mascot color", exact: true })).toHaveAttribute("aria-pressed", "true");
  });

  test(`onboarding shares the identity editor and retains an unsent draft at ${width}px`, async ({ harness, newPage, pairCodeFromCloud }, info) => {
    const page = await newPage();
    await page.setViewportSize({ width, height: width === 320 ? 568 : 900 });
    await pairDesktop(page, harness, pairCodeFromCloud);
    await setup(page).getByRole("button", { name: "Continue", exact: true }).click();
    await setup(page).getByRole("button", { name: "Skip tour", exact: true }).click();
    await setup(page).getByRole("button", { name: "Set up later", exact: true }).click();
    await setup(page).getByRole("button", { name: "Not now", exact: true }).click();
    const editor = appearance(page);
    await expect(editor).toBeVisible();
    await expect(editor.getByRole("button", { name: "Use the blob character", exact: true })).toHaveCount(1);
    await editor.getByRole("button", { name: "Use the blob character", exact: true }).click();
    await editor.getByRole("button", { name: "Use blue mascot color", exact: true }).click();
    await page.getByLabel("Teammate name", { exact: true }).fill("Muster Scout");
    await page.getByLabel("Teammate role (optional)", { exact: true }).fill("Daily planning and research");
    await expect(editor.getByText("Muster Scout", { exact: true })).toBeVisible();
    await page.reload();
    await expect(editor.getByRole("button", { name: "Use the blob character", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(editor.getByRole("button", { name: "Use blue mascot color", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByLabel("Teammate name", { exact: true })).toHaveValue("Muster Scout");
    await insideWidth(editor);
    await editor.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`teammate-onboarding-${width}.png`) });
    // Continue to the real next stage: editing appearance creates no extra bot.
    const before = rosterSchema.parse(await (await page.request.get(`${harness.desktopUrl}/api/bots`)).json());
    await setup(page).getByRole("button", { name: "Continue", exact: true }).click();
    await expect(setup(page).getByTestId("onboarding-stage-title")).toHaveText("Permissions");
    const after = rosterSchema.parse(await (await page.request.get(`${harness.desktopUrl}/api/bots`)).json());
    expect(after).toEqual(before);
  });

  test(`room identities keep routing and unsent messages unchanged at ${width}px`, async ({ harness, newPage, pairCodeFromCloud }, info) => {
    const page = await newPage();
    await page.setViewportSize({ width, height: width === 320 ? 568 : 900 });
    await pairDesktop(page, harness, pairCodeFromCloud);
    await expect(setup(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(setup(page)).toHaveCount(0);
    let roster = rosterSchema.parse(await (await page.request.get(`${harness.desktopUrl}/api/bots`)).json());
    // The owned account starts with one greeter. Create real additional bots
    // so this checks a multi-agent room, not merely a one-member layout.
    for (let count = roster.bots.length; count < 12; count += 1) {
      const created = await page.request.post(`${harness.desktopUrl}/api/bots`, { data: {} });
      expect(created.status()).toBe(201);
    }
    roster = rosterSchema.parse(await (await page.request.get(`${harness.desktopUrl}/api/bots`)).json());
    const memberIds = roster.bots.slice(0, 12).map(bot => bot.id);
    expect(memberIds).toHaveLength(12);
    const response = await page.request.post(`${harness.desktopUrl}/api/groups`, { data: { name: "Identity review room", memberIds } });
    expect(response.status()).toBe(201);
    await page.reload();
    if (width < 768) await page.getByRole("button", { name: "Open bot list", exact: true }).click();
    await page.getByRole("button", { name: /Identity review room No messages yet$/ }).click();
    const participants = page.getByRole("list", { name: "Room participants", exact: true });
    await expect(participants.getByRole("listitem")).toHaveCount(memberIds.length);
    await expect(page.getByRole("list", { name: "Agents in this room", exact: true }).getByRole("listitem")).toHaveCount(memberIds.length);
    await expect(participants.getByText("Working here", { exact: true })).toHaveCount(0);
    await insideWidth(page.locator("main"));
    await insideWidth(page.getByRole("log", { name: "Room Identity review room", exact: true }));
    expect((await page.getByRole("region", { name: "Room participant strip", exact: true }).boundingBox())?.height).toBeLessThan(70);
    if (width === 320) {
      const strip = page.getByRole("region", { name: "Room participant strip", exact: true });
      await strip.focus();
      await page.keyboard.press("ArrowRight");
      await expect.poll(() => strip.evaluate(node => node.scrollLeft)).toBeGreaterThan(0);
    }
    const composer = page.getByRole("textbox", { name: "Message Identity review room", exact: true });
    await composer.fill("Do not send this draft — 42");
    const renamed = "ScoutWithAnUnbrokenNameThatMustNeverStretchTheRoomBeyondAMobileScreen";
    const patched = await page.request.patch(`${harness.desktopUrl}/api/bots/${memberIds[0]}`, { data: { name: renamed, color: "teal", character: "cloud" } });
    expect(patched.status()).toBe(200);
    await expect(participants.getByText(renamed, { exact: true })).toBeVisible();
    await expect(composer).toHaveValue("Do not send this draft — 42");
    await expect(page.getByText(`${renamed} responds by default — @mention someone else to choose them instead.`, { exact: true })).toBeVisible();
    await insideWidth(page.locator("main"));
    const composerBounds = await composer.boundingBox();
    expect(composerBounds).not.toBeNull();
    expect(composerBounds!.y + composerBounds!.height).toBeLessThanOrEqual(width === 320 ? 568 : 900);
    await page.screenshot({ path: info.outputPath(`room-identities-${width}.png`) });
  });
}
