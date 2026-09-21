import { test, expect, pairDesktop } from "./browser-fixtures.ts";

test("Watch Calendar enrollment requires inspected consent and discards changed-code responses", async ({ harness, newPage, pairCodeFromCloud }) => {
  const page = await newPage();
  await pairDesktop(page, harness, pairCodeFromCloud);
  // Quick start persists its gate asynchronously (PUT /api/me/onboarding);
  // reloading before it lands legitimately re-shows the wizard, whose
  // overlay then intercepts everything below. Wait for the save.
  const gateSaved = page.waitForResponse(response => response.url().includes("/api/me/onboarding") && response.request().method() === "PUT");
  await page.getByRole("button", { name: "Quick start — skip setup, just get me in", exact: true }).click();
  await gateSaved;
  await page.reload();
  await page.route("**/api/calendar/status", route => route.fulfill({ json: { configured: true, connected: true } }));
  await page.route("**/api/connectors/catalog", route => route.fulfill({ json: { configured: false, cards: [] } }));
  await page.route("**/api/calendar/calendars", route => route.fulfill({ json: { calendars: [{ id: "personal", summary: "Personal", timeZone: "UTC", primary: true }] } }));
  const grant = { id: "00000000-0000-4000-8000-000000000001", label: "My Watch", calendarId: "personal", expiresAt: Date.now() + 86400000 };
  let approved = 0;
  let revoked = 0;
  let release: (() => void) | undefined;
  await page.route("**/api/calendar/enrollment/inspect", async route => {
    const { code } = route.request().postDataJSON();
    if (code === "ABCDEFGH") await new Promise<void>(resolve => { release = resolve; });
    await route.fulfill({ json: { enrollment: { id: "request", botId: "bot", botName: code === "ABCDEFGH" ? "Stale Bot" : "Current Bot", threadId: "thread", callId: grant.id, expiresAt: Date.now() + 300000, state: "waiting" } } });
  });
  await page.route("**/api/calendar/enrollment/approve", async route => {
    approved++;
    expect(route.request().postDataJSON()).toEqual({ code: "JKMNPQRS", calendarId: "personal", label: "My Watch" });
    await route.fulfill({ json: { ok: true } });
  });
  await page.route("**/api/calendar/devices", route => route.fulfill({ json: { devices: approved && !revoked ? [grant] : [] } }));
  await page.route(`**/api/calendar/devices/${grant.id}`, route => {
    expect(route.request().method()).toBe("DELETE"); revoked++;
    return route.fulfill({ json: { ok: true } });
  });
  await page.getByRole("button", { name: "Connected apps", exact: true }).click();
  const card = page.getByRole("region", { name: "Watch Calendar authorization", exact: true });
  await expect(card).toBeVisible();
  await card.getByLabel("Watch authorization code").fill("abcd-efgh");
  await card.getByRole("button", { name: "Inspect Watch request" }).click();
  await expect.poll(() => Boolean(release)).toBe(true);
  await card.getByLabel("Watch authorization code").fill("jkmn pqrs");
  const response = page.waitForResponse("**/api/calendar/enrollment/inspect"); release!(); await response;
  await expect(card.getByText(/Stale Bot/)).toHaveCount(0);
  await card.getByRole("button", { name: "Inspect Watch request" }).click();
  await expect(card.getByText(/Request for Current Bot/)).toBeVisible();
  await expect(card.getByRole("button", { name: "Approve 24-hour access" })).toBeDisabled();
  await card.getByRole("combobox", { name: "Watch calendar", exact: true }).selectOption("personal");
  expect(approved).toBe(0);
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await card.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await card.getByRole("button", { name: "Approve 24-hour access" }).click();
  await expect(card.getByText("Approved. Return to your Watch to finish connecting.")).toBeVisible();
  await card.getByRole("button", { name: "Revoke My Watch" }).click();
  await expect(card.getByText("No active device authorizations.")).toBeVisible();
  expect(approved).toBe(1); expect(revoked).toBe(1);
});
