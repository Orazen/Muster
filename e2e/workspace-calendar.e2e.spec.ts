import type { Locator, Page } from "@playwright/test";
import { z } from "zod";
import { test, expect, pairDesktop } from "./browser-fixtures.ts";
import type { CalendarStatus } from "../src/lib/calendar-agenda.ts";

// Owned accounts and servers, with explicit Calendar provider-response seams.
// These prove UI reads and draft boundaries, not real Google consent/availability.
const list = { calendars: [{ id: "personal", summary: "Personal", timeZone: "UTC", primary: true }] };
const calendarEvent = { id: "one", summary: "<img src=x onerror=alert(1)> Planning review", start: "2026-10-02T09:00:00Z", end: "2026-10-02T09:30:00Z", allDay: false, busy: true };
const day = { calendarId: "personal", date: "2026-10-02", timeZone: "UTC", timeMin: "2026-10-02T00:00:00Z", timeMax: "2026-10-03T00:00:00Z", complete: true, events: [calendarEvent] };

async function openToday(page: Page, width = 1280) {
  if (width < 768) await page.getByRole("button", { name: "Open bot list", exact: true }).click();
  await page.getByRole("button", { name: "Today", exact: true }).click();
  const calendar = page.getByRole("region", { name: "Today Calendar", exact: true });
  await expect(calendar).toBeVisible();
  return calendar;
}
async function selectDay(calendar: Locator) {
  await calendar.getByRole("button", { name: "Choose a calendar", exact: true }).click();
  await calendar.getByRole("combobox", { name: "Calendar", exact: true }).selectOption("personal");
  await calendar.getByLabel("Date", { exact: true }).fill(day.date);
}
async function fits(surface: Locator) {
  await expect.poll(() => surface.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
}

for (const width of [1280, 320]) {
  test(`Today reads Calendar only on request and prepares one unsent plan at ${width}px`, async ({ harness, newPage, pairCodeFromCloud }, testInfo) => {
    const page = await newPage();
    await pairDesktop(page, harness, pairCodeFromCloud);
    await page.getByRole("button", { name: "Quick start — skip setup, just get me in", exact: true }).click();
    await expect(page.getByRole("region", { name: "Set up Muster", exact: true })).toBeHidden();
    const roster = z.object({ bots: z.array(z.object({ id: z.string(), name: z.string() })) }).parse(await (await page.context().request.get(`${harness.desktopUrl}/api/bots`)).json());
    const bot = roster.bots[0];
    expect(bot).toBeDefined();
    const attachment = { kind: "paste", id: "today-calendar-preserved", text: "Keep this private context", size: 25, lines: 1 };
    await page.evaluate(({ id, attachment }) => {
      localStorage.setItem("omb-drafts", JSON.stringify({ [`bot:${id}`]: "Keep my existing draft." }));
      localStorage.setItem("omb-draft-attachments", JSON.stringify({ [`bot:${id}`]: [attachment] }));
    }, { id: bot.id, attachment });
    await page.goto(`${harness.desktopUrl}/app?bot=${encodeURIComponent(bot.id)}`);
    const composer = page.getByRole("textbox", { name: `Message ${bot.name}`, exact: true });
    await expect(composer).toHaveValue("Keep my existing draft.");
    let lists = 0, reads = 0, plans = 0;
    const writes: string[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (request.method() !== "GET" && /\/api\/(calendar\/|bots\/[^/]+\/messages)/.test(path)) writes.push(`${request.method()} ${path}`);
    });
    await page.route("**/api/calendar/status", (route) => route.fulfill({ json: { configured: true, connected: true } }));
    await page.route("**/api/calendar/calendars", (route) => { lists++; return route.fulfill({ json: list }); });
    await page.route("**/api/calendar/day?**", (route) => {
      reads++;
      expect(route.request().method()).toBe("GET");
      expect(Object.fromEntries(new URL(route.request().url()).searchParams)).toEqual({ calendarId: day.calendarId, date: day.date, timeZone: day.timeZone });
      return route.fulfill({ json: day });
    });
    const draft = "Planning proposal — 2026-10-02 (UTC)\nPriority: Finish report (30 minutes).\nNothing has been added to Calendar.";
    await page.route("**/api/calendar/plan", (route) => {
      plans++;
      expect(route.request().postDataJSON()).toEqual({ calendarId: day.calendarId, date: day.date, timeZone: day.timeZone, workStart: "09:00", workEnd: "17:00", commitments: [{ title: "Finish report", minutes: 30 }] });
      return route.fulfill({ json: { calendarId: day.calendarId, date: day.date, timeZone: day.timeZone, draft } });
    });
    await page.setViewportSize({ width, height: 900 });
    const calendar = await openToday(page, width);
    await expect(calendar.getByText("Calendar connected · read-only", { exact: true })).toBeVisible();
    expect({ lists, reads, plans }).toEqual({ lists: 0, reads: 0, plans: 0 });
    await selectDay(calendar);
    expect({ lists, reads }).toEqual({ lists: 1, reads: 0 });
    await calendar.getByRole("button", { name: "Load day", exact: true }).click();
    await expect(calendar.getByText(calendarEvent.summary, { exact: true })).toBeVisible();
    await expect(calendar.getByText(/Last read .*Reload to check for changes/)).toBeVisible();
    await expect(calendar.locator("img")).toHaveCount(0);
    await fits(calendar);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await calendar.locator("summary").filter({ hasText: "Prepare a plan" }).click();
    await calendar.getByLabel("Commitment 1", { exact: true }).fill("Finish report");
    await expect(calendar.getByRole("combobox", { name: "Draft for bot", exact: true })).toHaveValue(bot.id);
    await fits(calendar);
    await calendar.screenshot({ path: testInfo.outputPath(`today-calendar-${width}.png`) });
    await calendar.getByRole("button", { name: "Prepare planning draft", exact: true }).click();
    await expect(composer).toHaveValue(`Keep my existing draft.\n\n${draft}`);
    await expect(composer).toBeVisible();
    await expect(page.getByText(attachment.text, { exact: true })).toBeVisible();
    expect({ lists, reads, plans }).toEqual({ lists: 1, reads: 1, plans: 1 });
    expect(writes).toEqual(["POST /api/calendar/plan"]);
    await page.reload();
    await expect(composer).toHaveValue(`Keep my existing draft.\n\n${draft}`);
    expect(await page.evaluate((id) => JSON.parse(localStorage.getItem("omb-draft-attachments") ?? "{}")[`bot:${id}`], bot.id)).toEqual([attachment]);
    expect(writes).toEqual(["POST /api/calendar/plan"]);
  });
}

test("Today distinguishes unavailable, disconnected, unknown and empty Calendar without automatic consent", async ({ harness, newPage, pairCodeFromCloud }) => {
  const page = await newPage();
  await pairDesktop(page, harness, pairCodeFromCloud);
  await page.getByRole("button", { name: "Quick start — skip setup, just get me in", exact: true }).click();
  await expect(page.getByRole("region", { name: "Set up Muster", exact: true })).toBeHidden();
  await expect(page.getByRole("textbox", { name: /^Message / })).toBeVisible();
  let status: CalendarStatus | { connected: string } = { configured: true, connected: false };
  let lists = 0, reads = 0;
  const writes: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/calendar/") && request.method() !== "GET") writes.push(request.url());
  });
  await page.route("**/api/calendar/status", (route) => route.fulfill({ json: status }));
  await page.route("**/api/calendar/calendars", (route) => { lists++; return route.fulfill({ json: { calendars: [] } }); });
  await page.route("**/api/calendar/day?**", (route) => { reads++; return route.fulfill({ json: day }); });
  const calendar = await openToday(page);
  await expect(calendar.getByText("Calendar not connected", { exact: true })).toBeVisible();
  await expect(calendar.getByRole("button", { name: "Choose a calendar", exact: true })).toHaveCount(0);
  await expect(calendar.getByText(/Google sign-in and Drive backup do not grant Calendar access/)).toBeVisible();
  const recheck = calendar.getByRole("button", { name: "Refresh Calendar connection", exact: true });
  status = { configured: false, connected: false };
  await recheck.click();
  await expect(calendar.getByText("Calendar is unavailable on this server.", { exact: true })).toBeVisible();
  status = { configured: true, connected: false, requiresSignIn: true };
  await recheck.click();
  await expect(calendar.getByText("Sign in to connect your personal Calendar.", { exact: true })).toBeVisible();
  status = { connected: "yes" };
  await recheck.click();
  await expect(calendar.getByRole("alert")).toHaveText("Calendar status is unavailable. Please retry.");
  await expect(calendar.getByText("Calendar status unknown", { exact: true })).toBeVisible();
  status = { configured: true, connected: true };
  await recheck.click();
  await expect(calendar.getByRole("alert")).toHaveCount(0);
  await calendar.getByRole("button", { name: "Choose a calendar", exact: true }).click();
  await expect(calendar.getByText("No calendars available.", { exact: true })).toBeVisible();
  expect({ lists, reads, writes }).toEqual({ lists: 1, reads: 0, writes: [] });
});

test("Today discards late Calendar reads and incomplete data, and rechecks access after settings at 320px", async ({ harness, newPage, pairCodeFromCloud }) => {
  const page = await newPage();
  await pairDesktop(page, harness, pairCodeFromCloud);
  await page.getByRole("button", { name: "Quick start — skip setup, just get me in", exact: true }).click();
  await expect(page.getByRole("region", { name: "Set up Muster", exact: true })).toBeHidden();
  await expect(page.getByRole("textbox", { name: /^Message / })).toBeVisible();
  let connected = true;
  let mode: "pending" | "empty" | "partial" | "mismatch" = "pending";
  let release: (() => void) | undefined;
  let reads = 0;
  await page.route("**/api/calendar/status", (route) => route.fulfill({ json: { configured: true, connected } }));
  await page.route("**/api/connectors/catalog", (route) => route.fulfill({ json: { configured: false, cards: [] } }));
  await page.route("**/api/calendar/devices", (route) => route.fulfill({ json: { devices: [] } }));
  await page.route("**/api/calendar/calendars", (route) => route.fulfill({ json: list }));
  await page.route("**/api/calendar/day?**", async (route) => {
    reads++;
    const requestedMode = mode;
    const requested = Object.fromEntries(new URL(route.request().url()).searchParams);
    if (requestedMode === "pending") await new Promise<void>((resolve) => { release = resolve; });
    await route.fulfill({ json: { ...day, ...requested, calendarId: requestedMode === "mismatch" ? "different-owner-calendar" : requested.calendarId, complete: requestedMode !== "partial", events: requestedMode === "empty" ? [] : [{ ...calendarEvent, summary: requestedMode === "pending" ? "Late stale event" : calendarEvent.summary }] } });
  });
  await page.setViewportSize({ width: 320, height: 740 });
  const calendar = await openToday(page, 320);
  await selectDay(calendar);
  await calendar.getByRole("button", { name: "Load day", exact: true }).click();
  await expect.poll(() => reads).toBe(1);
  await expect(calendar.getByText("Loading Calendar…", { exact: true })).toBeVisible();
  const staleResponse = page.waitForResponse("**/api/calendar/day?**");
  await calendar.getByLabel("Date", { exact: true }).fill("2026-10-03");
  release!();
  await staleResponse;
  await expect(calendar.getByText("Late stale event", { exact: true })).toHaveCount(0);
  await expect(calendar.getByLabel("Calendar day", { exact: true })).toHaveCount(0);
  mode = "empty";
  await calendar.getByRole("button", { name: "Load day", exact: true }).click();
  await expect(calendar.getByText("No events for this day.", { exact: true })).toBeVisible();
  mode = "partial";
  await calendar.getByRole("button", { name: "Load day", exact: true }).click();
  await expect(calendar.getByRole("alert")).toHaveText("Could not load a complete day. Please retry.");
  await expect(calendar.getByText(/This response was incomplete/)).toBeVisible();
  await expect(calendar.getByText("No events for this day.", { exact: true })).toHaveCount(0);
  await expect(calendar.getByText(calendarEvent.summary, { exact: true })).toHaveCount(0);
  await expect(calendar.locator("summary").filter({ hasText: "Prepare a plan" })).toHaveCount(0);
  mode = "mismatch";
  await calendar.getByRole("button", { name: "Load day", exact: true }).click();
  await expect(calendar.getByRole("alert")).toHaveText("Could not load a complete day. Please retry.");
  await expect(calendar.getByText(/This response was incomplete/)).toHaveCount(0);
  await fits(calendar);
  mode = "empty";
  await calendar.getByRole("button", { name: "Load day", exact: true }).click();
  await expect(calendar.getByText("No events for this day.", { exact: true })).toBeVisible();
  await calendar.getByRole("button", { name: "Open Calendar", exact: true }).click();
  const settings = page.getByRole("region", { name: "Personal Google Calendar", exact: true });
  await expect(settings).toBeVisible();
  connected = false;
  await page.getByRole("button", { name: "Close connected apps", exact: true }).click();
  await expect(calendar.getByText("Calendar not connected", { exact: true })).toBeVisible();
  await expect(calendar.getByLabel("Calendar day", { exact: true })).toHaveCount(0);
  await expect(calendar.getByRole("button", { name: "Choose a calendar", exact: true })).toHaveCount(0);
  expect(reads).toBe(5);
});
