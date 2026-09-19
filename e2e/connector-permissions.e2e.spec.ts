import { test, expect, pairDesktop } from "./browser-fixtures.ts";

test("an unavailable account connection explains the limit without offering operator settings", async ({ harness, newPage, pairCodeFromCloud }) => {
  const page = await newPage();
  await pairDesktop(page, harness, pairCodeFromCloud);
  await page.getByRole("button", { name: "Quick start — skip setup, just get me in", exact: true }).click();
  const reason = "Personal app connections are not available for this account yet. You can keep working without connecting an app.";
  // UI contract fixture. Real hosted two-account isolation is exercised by
  // connector-ownership-harness.test.ts; this does not stand in for consent.
  await page.route("**/api/connectors/catalog", (route) => route.fulfill({ json: { configured: false, cards: [], source: "curated", mode: "unavailable", reason } }));
  await page.getByRole("button", { name: "Connected apps", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "Connected apps", exact: true });
  await expect(panel.getByText(reason, { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Open settings", exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 320, height: 740 });
  await expect(panel.getByText(reason, { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await panel.getByRole("button", { name: "Close connected apps", exact: true }).click();
  await expect(panel).toHaveCount(0);
});
