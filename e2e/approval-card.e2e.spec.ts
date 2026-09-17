/** Human decision -> exact approval card -> completed fake-engine turn.
 * The gated fixture emits no final reply until it receives the decision. */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test, expect, pairDesktop } from "./browser-fixtures.ts";

test.use({ engineMode: "permission-gated" });

for (const decision of ["allow", "deny"] as const) {
  test(`${decision === "allow" ? "Allow once releases" : "Deny blocks"} the exact pending action and survives reload`, async ({ harness, newPage, pairCodeFromCloud }) => {
    const page = await newPage();
    await pairDesktop(page, harness, pairCodeFromCloud);
    await page.getByRole("button", { name: "Quick start — skip setup, just get me in", exact: true }).click();
    const composer = page.getByRole("textbox", { name: /^Message / });
    const message = `Approval ${decision} ${randomUUID()}`;
    await composer.fill(message);
    await composer.press("Enter");

    const pending = page.locator("[data-mid]").filter({ hasText: "Waiting for your answer below" });
    await expect(pending).toHaveCount(1);
    await expect(pending.locator("pre")).toContainText("echo hi");
    const messageId = await pending.getAttribute("data-mid");
    expect(messageId).toBeTruthy();
    const card = page.locator(`[data-mid="${messageId}"]`);
    await expect(page.getByText("hello from fake acp", { exact: true })).toHaveCount(0);
    await expect(page.getByText("permission denied by fake acp", { exact: true })).toHaveCount(0);

    // Reload while the engine is paused: recovery must keep the same action,
    // not a newly generated card or a different task's pending decision.
    await page.reload();
    await expect(card.getByText("Waiting for your answer below", { exact: true })).toBeVisible();
    await expect(card.locator("pre")).toContainText("echo hi");
    await expect(page.getByText("hello from fake acp", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: decision === "allow" ? "Allow once" : "Deny", exact: true }).click();

    const outcome = decision === "allow" ? "Allowed" : "Denied";
    const reply = decision === "allow" ? "hello from fake acp" : "permission denied by fake acp";
    const replyRow = page.locator("[data-mid]").filter({ hasText: reply });
    await expect(card.getByText(outcome, { exact: true })).toBeVisible();
    await expect(replyRow).toHaveCount(1);
    await expect(replyRow.getByText(reply, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Allow once", exact: true })).toHaveCount(0);
    await expect(page.getByText("Waiting for your answer below", { exact: true })).toHaveCount(0);
    // Turn fully ended: the composer is free again. (The fleet orb was
    // unmounted by owner direction 2026-09-15, so there is no idle pill.)
    await expect(composer).toBeEnabled();
    if (decision === "deny") await expect(page.getByText("hello from fake acp", { exact: true })).toHaveCount(0);

    // Pin the actual ACP choice as well as its visible result. A fixture
    // that responds happily to every decision must not make denial pass.
    expect(harness.permissionOutcomePath).toBeTruthy();
    await expect.poll(async () => {
      const raw = await readFile(harness.permissionOutcomePath!, "utf8").catch(() => "null");
      return JSON.parse(raw);
    }).toEqual({ outcome: "selected", optionId: decision === "allow" ? "allow-once" : "reject" });

    await page.reload();
    await expect(card.getByText(outcome, { exact: true })).toBeVisible();
    await expect(replyRow).toHaveCount(1);
    await expect(replyRow.getByText(reply, { exact: true })).toBeVisible();
    await expect(page.locator("[data-mid]").filter({ hasText: message })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Allow once", exact: true })).toHaveCount(0);
  });
}
