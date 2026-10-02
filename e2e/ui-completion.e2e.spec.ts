/** Owned-account acceptance for the approved presentation migration.
 * These are real routes/controls; no provider or personal session is used. */
import type { Locator } from "@playwright/test";
import { test, expect, pairDesktop } from "./browser-fixtures.ts";

async function fits(surface: Locator, width: number) {
  await expect(surface).toBeVisible();
  const box = await surface.evaluate(node => {
    const r = node.getBoundingClientRect();
    return { left: r.left, right: r.right, scroll: node.scrollWidth, client: node.clientWidth };
  });
  expect(box.left).toBeGreaterThanOrEqual(-1);
  expect(box.right).toBeLessThanOrEqual(width + 1);
  expect(box.scroll).toBeLessThanOrEqual(box.client + 1);
}

for (const width of [320, 1280]) {
  test(`theme radios support keyboard selection, persistent Light and bounded settings at ${width}px`, async ({ harness, newPage, pairCodeFromCloud }, info) => {
    const page = await newPage();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await pairDesktop(page, harness, pairCodeFromCloud);
    await expect(page.getByRole("region", { name: "Set up Muster", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    const composer = page.getByRole("textbox", { name: /^Message / }).last();
    await composer.fill("Keep this unsent while changing appearance.");
    await page.getByRole("button", { name: "App settings", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "Settings", exact: true });
    await settings.getByRole("button", { name: "Appearance", exact: true }).click();
    await page.setViewportSize({ width, height: 900 });
    const group = settings.getByRole("radiogroup", { name: "Theme", exact: true });
    const midnight = group.getByRole("radio", { name: /^Midnight/ });
    await midnight.check();
    await midnight.focus();
    await page.keyboard.press("ArrowUp");
    const light = group.getByRole("radio", { name: /^Light/ });
    await expect(light).toBeChecked();
    await expect(light).toBeFocused();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await fits(settings, width);
    await fits(group, width);
    await page.screenshot({ path: info.outputPath(`light-settings-${width}.png`), fullPage: true });
    await page.getByRole("button", { name: "Close settings", exact: true }).click();
    await expect(composer).toHaveValue("Keep this unsent while changing appearance.");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(composer).toHaveValue("Keep this unsent while changing appearance.");
    await page.getByTitle("Bot settings").first().click();
    const botSettings = page.locator('aside[aria-label="Bot settings"]');
    await botSettings.getByRole("button", { name: "Choose model", exact: true }).click();
    const picker = botSettings.getByRole("dialog", { name: "Choose model", exact: true });
    await fits(picker, width);
    await page.keyboard.press("Escape");
    await expect(picker).toHaveCount(0);
    await expect(botSettings).toBeVisible();
  });
}

test("light sign-in keeps the Flower greeting and readable primary action at 320px", async ({ harness, newPage }, info) => {
  const page = await newPage();
  await page.setViewportSize({ width: 320, height: 800 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => { localStorage.setItem("omb-skin", "light"); });
  await page.goto(`${harness.cloudUrl}/sign-in`);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: "Wave to Muster", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Hello from Muster.");
  await fits(page.locator(".auth-layout"), 320);
  const action = page.locator(".auth-submit").first();
  await expect(action).toBeVisible();
  const contrast = await action.evaluate(node => {
    const style = getComputedStyle(node);
    const luminance = (color: string) => {
      const rgb = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(v => {
        const s = v / 255; return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4;
      });
      return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
    };
    const fg = luminance(style.color), bg = luminance(style.backgroundColor);
    return (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05);
  });
  expect(contrast).toBeGreaterThanOrEqual(4.5);
  await page.screenshot({ path: info.outputPath("light-auth-320.png"), fullPage: true });
});

test("OS presentation keeps overview, command console and return-to-chat usable at 320px", async ({ harness, newPage, pairCodeFromCloud }, info) => {
  const page = await newPage();
  await pairDesktop(page, harness, pairCodeFromCloud);
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 320, height: 800 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`${harness.desktopUrl}/os`);
  const overview = page.getByRole("region", { name: "Workspace overview", exact: true });
  await expect(overview).toBeVisible();
  await fits(page.locator(".os-desktop"), 320);
  await page.getByRole("button", { name: "Open command console", exact: true }).click();
  const console = page.getByRole("dialog", { name: "Command console", exact: true });
  await expect(console).toBeVisible();
  await expect(console.getByRole("textbox", { name: "Command", exact: true })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(console.getByRole("button").last()).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(console.getByRole("textbox", { name: "Command", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(console.getByRole("button").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(console).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open command console", exact: true })).toBeFocused();
  await expect(overview).toBeVisible();
  await page.screenshot({ path: info.outputPath("os-320.png"), fullPage: true });
  await page.getByRole("button", { name: "Open app", exact: true }).click();
  await expect(page).toHaveURL(`${harness.desktopUrl}/app`);
  await expect(page.getByRole("textbox", { name: /^Message / }).last()).toBeVisible();
});

test("Light onboarding keeps need choices readable and does not send a task", async ({ harness, newPage, pairCodeFromCloud }, info) => {
  const page = await newPage();
  await page.setViewportSize({ width: 320, height: 800 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => { localStorage.setItem("omb-skin", "light"); });
  await pairDesktop(page, harness, pairCodeFromCloud);
  const setup = page.getByRole("region", { name: "Set up Muster", exact: true });
  const messages: string[] = [];
  page.on("request", request => {
    if (request.method() === "POST" && /\/api\/bots\/[^/]+\/messages$/.test(new URL(request.url()).pathname)) messages.push(request.url());
  });
  await setup.getByRole("button", { name: "Continue", exact: true }).click();
  await setup.getByRole("button", { name: "Skip tour", exact: true }).click();
  await setup.getByRole("button", { name: "Set up later", exact: true }).click();
  await setup.getByRole("button", { name: "Not now", exact: true }).click();
  const needs = setup.getByRole("group", { name: "What do you want off your plate first?", exact: true });
  await expect(needs).toBeVisible();
  for (const chip of await needs.getByRole("button").all()) {
    const colors = await chip.evaluate(node => ({ color: getComputedStyle(node).color, ink: getComputedStyle(node).getPropertyValue("--color-ink").trim() }));
    expect(colors.color).toBe("rgb(22, 22, 22)");
    expect(colors.ink).toBe("#161616");
  }
  const first = needs.getByRole("button").first();
  await first.click();
  await expect(first).toHaveAttribute("aria-pressed", "true");
  await first.click();
  await expect(first).toHaveAttribute("aria-pressed", "false");
  await fits(needs, 320);
  expect(messages).toEqual([]);
  await page.screenshot({ path: info.outputPath("light-onboarding-320.png"), fullPage: true });
});
