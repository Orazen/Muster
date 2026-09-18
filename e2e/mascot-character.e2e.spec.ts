/** Mascot character acceptance against an owned server and fake ACP engine:
 * interactions on the empty-chat hero character, the coexistence rule
 * (interactions never fake a status), the annoyed chain, the slap-dizzy
 * chain, and the calm off switch. No real providers, no external requests. */
import { expect, test, pairDesktop } from "./browser-fixtures.ts";
import type { Page } from "@playwright/test";

async function dismissOnboarding(page: Page): Promise<void> {
  const shell = page.getByRole("region", { name: "Set up Muster", exact: true });
  await expect(shell).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Escape");
  await expect(shell).toHaveCount(0);
}

function character(page: Page) {
  return page.getByTestId("flower-character").first();
}

test.describe("mascot character", () => {
  test("the character pokes, annoys, and recovers without a status change", async ({ harness, newPage, pairCodeFromCloud }) => {
    const page = await newPage();
    await pairDesktop(page, harness, pairCodeFromCloud);
    await dismissOnboarding(page);

    // The settings panel preview is the character surface: the bot's face,
    // pokeable, with the interaction state readable for tests.
    await page.getByTitle("Bot settings").first().click();
    const bot = character(page);
    await expect(bot).toBeVisible({ timeout: 15_000 });
    await expect(bot).toHaveAttribute("data-status", "idle");

    // Two pokes: reactions, but no grudge yet.
    await bot.click();
    await bot.click();
    await expect(bot).not.toHaveAttribute("data-override");
    // A third poke within the window annoys it.
    await bot.click();
    await expect(bot).toHaveAttribute("data-override", "annoyed");
    await expect(page.getByText("The mascot is annoyed")).toBeVisible();
    // And the annoyed beat decays on its own.
    await expect(bot).not.toHaveAttribute("data-override", { timeout: 6_000 });
  });

  test("a slap stuns, hands off to dizzy, and fully recovers", async ({ harness, newPage, pairCodeFromCloud }) => {
    const page = await newPage();
    await pairDesktop(page, harness, pairCodeFromCloud);
    await dismissOnboarding(page);

    await page.getByTitle("Bot settings").first().click();
    const bot = character(page);
    await expect(bot).toBeVisible({ timeout: 15_000 });

    await bot.click({ modifiers: ["Shift"] });
    await expect(bot).toHaveAttribute("data-override", "slapped");
    await expect(page.getByText("The mascot is stunned")).toBeVisible();
    // The dizzy hand-off happens at the stun boundary (~1.5s).
    await expect(bot).toHaveAttribute("data-override", "dizzy", { timeout: 3_000 });
    await expect(page.getByText("The mascot is dizzy")).toBeVisible();
    // Then it fully recovers.
    await expect(bot).not.toHaveAttribute("data-override", { timeout: 4_000 });
  });

  test("calm mode silences interactions but keeps the character visible", async ({ harness, newPage, pairCodeFromCloud }) => {
    const page = await newPage();
    await pairDesktop(page, harness, pairCodeFromCloud);
    await dismissOnboarding(page);

    // Open the bot's settings — the surface that owns the calm switch.
    await page.getByTitle("Bot settings").first().click();
    const calmSwitch = page.getByRole("switch", { name: "Calm mascot" });
    await expect(calmSwitch).toBeVisible();
    await expect(calmSwitch).toHaveAttribute("aria-checked", "false");
    await calmSwitch.click();
    await expect(calmSwitch).toHaveAttribute("aria-checked", "true");

    // The character is still there — calm is not a removal — and it
    // ignores pokes entirely.
    const bot = character(page);
    await expect(bot).toBeVisible();
    await expect(bot).toHaveAttribute("data-calm", "true");
    await bot.click({ force: true });
    await expect(bot).not.toHaveAttribute("data-override");
    await expect(page.getByText("The mascot is annoyed")).toHaveCount(0);
  });
});
