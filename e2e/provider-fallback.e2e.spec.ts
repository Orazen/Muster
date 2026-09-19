import { test, expect, pairDesktop } from "./browser-fixtures.ts";
import type { Page } from "@playwright/test";

async function openProviders(page: Page) {
  await page.getByRole("button", { name: "App settings", exact: true }).click();
  await page.getByRole("dialog", { name: "Settings", exact: true }).getByRole("button", { name: "Providers", exact: true }).click();
  return page.getByRole("region", { name: "Automatic provider retry", exact: true });
}

// Owned UI contract fixtures: no request reaches a paid provider.
test("provider retry defaults off, requires explicit save, persists and revokes at 320px", async ({ harness, newPage, pairCodeFromCloud }) => {
  const page = await newPage();
  await pairDesktop(page, harness, pairCodeFromCloud);
  await page.getByRole("button", { name: "Quick start — skip setup, just get me in", exact: true }).click();
  let enabled = false;
  let generation = 0;
  let malformed = false;
  const writes: boolean[] = [];
  await page.route("**/api/provider-fallback", async (route) => {
    if (route.request().method() === "PATCH") {
      writes.push(route.request().postDataJSON().enabled);
      if (malformed) { await route.fulfill({ json: { error: "Owned ambiguous save fixture" } }); return; }
      enabled = route.request().postDataJSON().enabled;
      generation++;
    }
    await route.fulfill({ json: { enabled, generation } });
  });
  const card = await openProviders(page);
  await expect(card.getByRole("status")).toHaveText("Automatic retry is off");
  expect(writes).toEqual([]);
  await page.setViewportSize({ width: 320, height: 740 });
  await expect(card.getByText(/task may be sent to another connected provider and use paid credits/)).toBeVisible();
  expect(await card.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  malformed = true;
  await card.getByRole("button", { name: "Enable automatic retry", exact: true }).click();
  await expect(card.getByRole("status")).toHaveText("Automatic retry status unknown");
  await expect(card.getByRole("alert")).toContainText("Could not confirm the change");
  expect(enabled).toBe(false);
  await card.getByRole("button", { name: "Check saved preference", exact: true }).click();
  await expect(card.getByRole("status")).toHaveText("Automatic retry is off");
  malformed = false;
  await card.getByRole("button", { name: "Enable automatic retry", exact: true }).click();
  await expect(card.getByRole("status")).toHaveText("Automatic retry is on");
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.reload();
  await openProviders(page);
  await expect(card.getByRole("status")).toHaveText("Automatic retry is on");
  await card.getByRole("button", { name: "Turn off automatic retry", exact: true }).click();
  await expect(card.getByRole("status")).toHaveText("Automatic retry is off");
  expect(writes).toEqual([true, true, false]);
});

test("provider retry ignores a closed panel's late save and never enables on unknown status", async ({ harness, newPage, pairCodeFromCloud }) => {
  const page = await newPage();
  await pairDesktop(page, harness, pairCodeFromCloud);
  await page.getByRole("button", { name: "Quick start — skip setup, just get me in", exact: true }).click();
  let release: (() => void) | undefined;
  let arrived = false;
  let malformed = false;
  await page.route("**/api/provider-fallback", async (route) => {
    if (route.request().method() === "PATCH") {
      arrived = true;
      await new Promise<void>((resolve) => { release = resolve; });
      await route.fulfill({ json: { enabled: true, generation: 1 } });
    } else await route.fulfill({ json: malformed ? { enabled: "unknown" } : { enabled: false, generation: 2 } });
  });
  const card = await openProviders(page);
  await expect(card.getByRole("status")).toHaveText("Automatic retry is off");
  await card.getByRole("button", { name: "Enable automatic retry", exact: true }).click();
  await expect.poll(() => arrived).toBe(true);
  await expect(card.getByRole("status")).toHaveText("Checking or saving preference…");
  await expect(card.getByRole("button", { name: "Enable automatic retry", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  malformed = true;
  await openProviders(page);
  await expect(card.getByRole("status")).toHaveText("Automatic retry status unknown");
  const lateResponse = page.waitForResponse((response) => response.url().endsWith("/api/provider-fallback") && response.request().method() === "PATCH");
  release!();
  await lateResponse;
  await expect(card.getByRole("status")).toHaveText("Automatic retry status unknown");
  await expect(card.getByRole("button", { name: "Enable automatic retry", exact: true })).toHaveCount(0);
  malformed = false;
  await card.getByRole("button", { name: "Check saved preference", exact: true }).click();
  await expect(card.getByRole("status")).toHaveText("Automatic retry is off");
});

test("provider retry requires personal sign-in without offering installation consent", async ({ harness, newPage, pairCodeFromCloud }) => {
  const page = await newPage();
  await pairDesktop(page, harness, pairCodeFromCloud);
  await page.getByRole("button", { name: "Quick start — skip setup, just get me in", exact: true }).click();
  let writes = 0;
  await page.route("**/api/provider-fallback", async (route) => {
    if (route.request().method() !== "GET") writes++;
    await route.fulfill({ json: { enabled: false, generation: 0, requiresSignIn: true } });
  });
  const card = await openProviders(page);
  await expect(card.getByRole("status")).toHaveText("Sign in to choose automatic provider retry.");
  await expect(card.getByRole("link", { name: "Sign in for automatic retry", exact: true })).toHaveAttribute("href", "/sign-in?next=%2Fapp");
  await expect(card.getByRole("button")).toHaveCount(0);
  expect(writes).toBe(0);
});
