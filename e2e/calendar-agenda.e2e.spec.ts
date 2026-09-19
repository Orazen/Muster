import { test, expect, pairDesktop } from "./browser-fixtures.ts";

// Mocked responses exercise UI contracts only, not real Google acceptance.
test("Calendar agenda UI: explicit reads, complete results and stale-response invalidation at 320px", async ({ harness, newPage, pairCodeFromCloud }) => {
  const page = await newPage();
  await pairDesktop(page, harness, pairCodeFromCloud);
  await page.getByRole("button", { name: "Quick start — skip setup, just get me in", exact: true }).click();
  let listCalls = 0;
  let dayCalls = 0;
  let mode = "events";
  let release: (() => void) | undefined;
  await page.route("**/api/calendar/status", (route) => route.fulfill({ json: { configured: true, connected: true } }));
  await page.route("**/api/connectors/catalog", (route) => route.fulfill({ json: { configured: false, cards: [] } }));
  await page.route("**/api/calendar/calendars", (route) => {
    listCalls++;
    expect(route.request().method()).toBe("GET");
    return route.fulfill({ json: { calendars: [{ id: "personal", summary: "Personal", timeZone: "Europe/Rome", primary: true }] } });
  });
  await page.route("**/api/calendar/day?**", async (route) => {
    dayCalls++;
    expect(route.request().method()).toBe("GET");
    const query = new URL(route.request().url()).searchParams;
    const requestedMode = mode;
    if (requestedMode === "pending") await new Promise<void>((resolve) => { release = resolve; });
    await route.fulfill({ json: {
      calendarId: query.get("calendarId"), date: query.get("date"), timeZone: query.get("timeZone"),
      timeMin: "2026-09-18T22:00:00Z", timeMax: "2026-09-19T22:00:00Z", complete: requestedMode !== "partial",
      events: requestedMode === "empty" ? [] : [
        { id: "one", summary: requestedMode === "pending" ? "Late stale event" : "Morning meeting", start: "2026-09-19T08:00:00Z", end: "2026-09-19T09:00:00Z", allDay: false, busy: true },
        { id: "two", summary: "Busy", start: "2026-09-19T10:00:00Z", end: "2026-09-19T11:00:00Z", allDay: false, busy: true },
        { id: "three", summary: "Holiday", start: "2026-09-19", end: "2026-09-20", allDay: true, busy: false },
      ],
    } });
  });
  await page.getByRole("button", { name: "Connected apps", exact: true }).click();
  const card = page.getByRole("region", { name: "Personal Google Calendar", exact: true });
  await expect(card.getByRole("button", { name: "Choose a calendar", exact: true })).toBeVisible();
  expect(listCalls).toBe(0);
  expect(dayCalls).toBe(0);
  await card.getByRole("button", { name: "Choose a calendar", exact: true }).click();
  await expect(card.getByRole("combobox", { name: "Calendar", exact: true })).toBeVisible();
  expect(listCalls).toBe(1);
  await expect(card.getByRole("button", { name: "Load day", exact: true })).toBeDisabled();
  await card.getByRole("combobox", { name: "Calendar", exact: true }).selectOption("personal");
  await card.getByLabel("Date", { exact: true }).fill("2026-09-19");
  expect(dayCalls).toBe(0);
  await page.setViewportSize({ width: 320, height: 740 });
  await card.getByRole("button", { name: "Load day", exact: true }).click();
  await expect(card.getByText("Morning meeting", { exact: true })).toBeVisible();
  await expect(card.getByText("Busy", { exact: true })).toBeVisible();
  await expect(card.getByText("All day · 2026-09-19", { exact: true })).toBeVisible();
  expect(dayCalls).toBe(1);
  expect(await card.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  mode = "pending";
  await card.getByRole("button", { name: "Load day", exact: true }).click();
  await expect.poll(() => dayCalls).toBe(2);
  await card.getByLabel("Time zone", { exact: true }).fill("UTC");
  release!();
  await expect(card.getByRole("button", { name: "Load day", exact: true })).toBeEnabled();
  mode = "empty";
  await card.getByRole("button", { name: "Load day", exact: true }).click();
  await expect(card.getByText("No events for this day.", { exact: true })).toBeVisible();
  await expect(card.getByText("Late stale event", { exact: true })).toHaveCount(0);
  await card.getByLabel("Date", { exact: true }).fill("2026-09-20");
  await expect(card.getByText("No events for this day.", { exact: true })).toHaveCount(0);
  mode = "partial";
  await card.getByRole("button", { name: "Load day", exact: true }).click();
  await expect(card.getByRole("alert")).toHaveText("Could not load a complete day. Please retry.");
  await expect(card.getByText("No events for this day.", { exact: true })).toHaveCount(0);
  await expect(card.getByText("Morning meeting", { exact: true })).toHaveCount(0);
});
