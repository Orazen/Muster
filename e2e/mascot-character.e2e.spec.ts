/** Mascot character acceptance against an owned server and fake ACP engine:
 * the calm switch, the expression editor and the old antics (poke / annoy /
 * slap) are gone with the Character system, and every avatar surface renders
 * the shared bot-avatars adapter. No real providers, no external requests. */
import { expect, test, pairDesktop } from "./browser-fixtures.ts";
import type { Page } from "@playwright/test";

async function dismissOnboarding(page: Page): Promise<void> {
  const shell = page.getByRole("region", { name: "Set up Muster", exact: true });
  await expect(shell).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Escape");
  await expect(shell).toHaveCount(0);
}

test.describe("mascot character", () => {
  test("the calm switch and antics are gone; every avatar is a bot-avatars canvas", async ({ harness, newPage, pairCodeFromCloud }) => {
    const page = await newPage();
    await pairDesktop(page, harness, pairCodeFromCloud);
    await dismissOnboarding(page);

    // The calm switch and the expression editor are gone with the old system…
    await page.getByTitle("Bot settings").first().click();
    await expect(page.getByRole("switch", { name: "Calm mascot" })).toHaveCount(0);
    await expect(page.getByText("Expression", { exact: true })).toHaveCount(0);

    // …and the panel preview is a bot-avatars canvas from the shared adapter.
    const preview = page.getByTestId("bot-avatar-preview");
    await expect(preview).toBeVisible({ timeout: 15_000 });
    await expect(preview.locator("canvas[data-bot-avatar]").first()).toBeVisible();

    // Clicks are inert: no pokes, no annoyed/stunned/dizzy beats, no faked status.
    await preview.click();
    await expect(preview.getByText(/annoyed|stunned|dizzy/i)).toHaveCount(0);
    await expect(page.getByText(/The mascot is/i)).toHaveCount(0);

    // Roster rows render through the same funnel — bot-avatars all the way down.
    await page.keyboard.press("Escape");
    await expect(page.locator('canvas[data-bot-avatar]').first()).toBeVisible({ timeout: 15_000 });
  });
});
