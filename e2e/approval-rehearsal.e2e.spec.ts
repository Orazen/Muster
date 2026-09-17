/** Persisted evidence produced by real runtime events, with an offline engine. */
import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { test, expect, pairDesktop } from "./browser-fixtures.ts";

test.use({ engineMode: "rehearsal-gated" });

async function requestApproval(page: Page, message: string) {
  const composer = page.getByRole("textbox", { name: /^Message / });
  await composer.fill(message);
  await composer.press("Enter");
  const pending = page.locator("[data-mid]").filter({ hasText: "Waiting for your answer below" });
  await expect(pending).toHaveCount(1);
  const id = await pending.getAttribute("data-mid");
  expect(id).toBeTruthy();
  const card = page.locator(`[data-mid="${id}"]`);
  await expect(card.getByRole("region", { name: "Approval evidence", exact: true })).toBeVisible();
  return card;
}

test("approval transcript retains the original rehearsal and previous-run evidence after decisions and reload", async ({ harness, newPage, pairCodeFromCloud }) => {
  const page = await newPage();
  await pairDesktop(page, harness, pairCodeFromCloud);
  await page.getByRole("button", { name: "Quick start — skip setup, just get me in", exact: true }).click();
  const first = await requestApproval(page, `First rehearsal ${randomUUID()}`);
  const firstSummary = first.getByText(/^Plan rehearsal:/);
  await expect(firstSummary).toContainText("0/2 tool steps matched in order; 0 completed runs matched the full sequence (0 reviewed)");
  await page.getByRole("button", { name: "Allow once", exact: true }).click();
  await expect(first.getByText("Allowed", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: /^Message / })).toBeEnabled();
  await page.reload();
  await expect(firstSummary).toContainText("(0 reviewed)");

  const second = await requestApproval(page, `Second rehearsal ${randomUUID()}`);
  const evidence = second.getByRole("region", { name: "Approval evidence", exact: true });
  const summary = evidence.getByText(/^Plan rehearsal:/);
  await expect(summary).toContainText("2/2 tool steps matched in order; 1 completed runs matched the full sequence (1 reviewed)");
  await expect(summary).toContainText("Tool names and order only; arguments and screen states were not checked.");
  await expect(evidence.getByText(/was allowed 1× before/)).toContainText("never denied");
  await expect(evidence.locator("summary")).toContainText("Previous run");
  const snapshot = await evidence.textContent();

  await page.reload();
  await expect(evidence).toHaveText(snapshot!);
  await page.getByRole("button", { name: "Deny", exact: true }).click();
  await expect(second.getByText("Denied", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: /^Message / })).toBeEnabled();
  await expect(evidence).toHaveText(snapshot!);
  await page.reload();
  await expect(second.getByText("Denied", { exact: true })).toBeVisible();
  await expect(evidence).toHaveText(snapshot!);
  await evidence.locator("summary").click();
  await expect(evidence.locator("details")).toHaveAttribute("open", "");
  for (const detail of [
    "Exercise an owned approval rehearsal fixture.",
    "Wait for Allow once before emitting simulated tool successes.",
    "Record browser_open then screenshot in the fixture journal.",
    "Hypothesis: Two ordered successful fixture tools will match the next stated plan.",
    "Findings: The fixture emitted browser_open and screenshot in order; no real browser action was performed.",
  ]) await expect(evidence.getByText(detail, { exact: true })).toBeVisible();
  await expect(firstSummary).toContainText("(0 reviewed)");
  await expect(page.getByRole("button", { name: "Allow once", exact: true })).toHaveCount(0);
});
