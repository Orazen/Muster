/** Pairing and transcript behavior against owned servers and a fake ACP engine. */
import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { test, expect, pairDesktop } from "./browser-fixtures.ts";

async function expectTranscript(page: Page, message: string): Promise<void> {
  const userRow = page.locator("[data-mid]").filter({ hasText: message });
  const replyRow = page.locator("[data-mid]").filter({ hasText: "hello from fake acp" });
  await expect(userRow).toHaveCount(1);
  await expect(replyRow).toHaveCount(1);
  // The row wrappers use display:contents. Require the actual text inside
  // each row to be visible, not a bounding box on the wrapper itself.
  await expect(userRow.getByText(message, { exact: true })).toBeVisible();
  await expect(replyRow.getByText("hello from fake acp", { exact: true })).toBeVisible();
}

test.describe("desktop and cloud pairing", () => {
  test("the desktop exposes the pairing bridge", async ({ harness, newPage }) => {
    const page = await newPage();
    await page.goto(`${harness.desktopUrl}/sign-in`);
    await expect(page.getByLabel("Pairing code", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect", exact: true })).toBeVisible();
  });

  test("a displayed cloud code pairs the exact account", async ({ harness, newPage, pairCodeFromCloud }) => {
    await pairDesktop(await newPage(), harness, pairCodeFromCloud);
  });

  test("paired messages and the engine reply render and survive reload", async ({ harness, newPage, pairCodeFromCloud }) => {
    const page = await newPage();
    await pairDesktop(page, harness, pairCodeFromCloud);
    await page.getByRole("button", { name: "Quick start — skip setup, just get me in", exact: true }).click();
    const composer = page.getByRole("textbox", { name: /^Message / });
    await expect(composer).toBeVisible();
    const message = `Pairing transcript ${randomUUID()}`;
    await composer.fill(message);
    await composer.press("Enter");
    await expectTranscript(page, message);
    await page.reload();
    await expectTranscript(page, message);
  });

  test("OAuth start constructs a Google redirect without following it", async ({ harness, request }) => {
    const query = new URLSearchParams({ redirect: harness.desktopUrl });
    const response = await request.get(`${harness.cloudUrl}/desktop-auth/start?${query}`, { maxRedirects: 0 });
    expect(response.status()).toBe(302);
    const destination = new URL(response.headers().location ?? "");
    expect(destination.origin).toBe("https://accounts.google.com");
    expect(destination.searchParams.get("client_id")).toBeTruthy();
    expect(response.headers()["set-cookie"]).toContain("better-auth.state=");
  });

  test("a consumed code is rejected without a desktop session", async ({ harness, newPage, pairCodeFromCloud, request }) => {
    const consumed = await request.post(`${harness.cloudUrl}/api/pair/verify`, { data: { code: pairCodeFromCloud }, maxRedirects: 0 });
    expect(consumed.status()).toBe(200);
    expect((await consumed.json()).email).toBe(harness.email);
    const page = await newPage(true);
    await page.goto(`${harness.desktopUrl}/sign-in`);
    await page.getByLabel("Pairing code", { exact: true }).fill(pairCodeFromCloud);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(page.getByText(/isn't valid/)).toBeVisible();
    await expect(page).toHaveURL(`${harness.desktopUrl}/sign-in`);
    const session = await page.context().request.get(`${harness.desktopUrl}/api/auth/get-session`, { maxRedirects: 0 });
    expect(session.status()).toBe(200);
    expect(await session.json()).toBeNull();
  });
});
