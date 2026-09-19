import { DatabaseSync } from "node:sqlite";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { CALENDAR_READONLY_SCOPE, createCalendarState, saveCalendarGrant } from "./calendar-grants.ts";
import { issueCalendarDeviceGrant, revokeCalendarDeviceGrant, CALENDAR_DEVICE_GRANT_TTL_MS } from "./calendar-device-grants.ts";
import { prepareCallCalendarPlan, type CallCalendarPlanContext, type CallCalendarPlanInput } from "./call-calendar-plan.ts";
import type { GoogleCalendarReader } from "./calendar-day.ts";
let db: DatabaseSync;
const initialNow = Date.parse("2026-09-19T07:00:00Z");
function connect() {
  const flow = createCalendarState(db, { userId: "alice", sessionId: "session" }, initialNow);
  saveCalendarGrant(db, { userId: "alice", googleSub: "google-alice", expectedGeneration: flow.generation, accessToken: "owned-access", refreshToken: "owned-refresh", expiresAt: Date.now() + 3600_000, scopes: [CALENDAR_READONLY_SCOPE] });
}
beforeEach(() => { db = new DatabaseSync(":memory:"); db.exec("CREATE TABLE user(id TEXT PRIMARY KEY); INSERT INTO user VALUES ('alice')"); connect(); });
afterEach(() => db.close());
function fixture() {
  const issued = issueCalendarDeviceGrant(db, { userId: "alice", calendarId: "selected", label: "Watch" }, initialNow);
  const input: CallCalendarPlanInput = { capability: issued.token, date: "2026-09-19", timeZone: "UTC", workStart: "09:00", workEnd: "17:00", commitments: [{ title: "Write proposal", minutes: 45 }] };
  let now = initialNow;
  let reads = 0;
  let guards = 0;
  let active = true;
  let duringRead: (() => void | Promise<void>) | undefined;
  let duringGuard: (() => void) | undefined;
  const day: Awaited<ReturnType<GoogleCalendarReader["readDay"]>> = { calendarId: "selected", date: input.date, timeZone: input.timeZone,
    timeMin: "2026-09-19T00:00:00Z", timeMax: "2026-09-20T00:00:00Z", complete: true,
    events: [{ id: "meeting", summary: "Actual meeting", start: "2026-09-19T10:00:00Z", end: "2026-09-19T11:00:00Z", busy: true, allDay: false }] };
  const ctx: CallCalendarPlanContext = {
    db, now: () => now,
    provider: { refresh: async () => { throw new Error("Refresh should not be needed"); } },
    assertCallCurrent: async () => { guards++; duringGuard?.(); if (!active) throw new Error("private call detail"); },
    reader: { readDay: async (token, selection, guard) => {
      reads++; expect(token).toBe("owned-access"); expect(selection.calendarId).toBe("selected");
      await guard?.(); await duringRead?.(); await guard?.(); return day;
    } },
  };
  return { input, ctx, day, issued, reads: () => reads, guards: () => guards,
    onRead: (callback: () => void | Promise<void>) => { duringRead = callback; },
    onGuard: (callback: () => void) => { duringGuard = callback; },
    end: () => { active = false; }, advance: (ms: number) => { now += ms; } };
}
describe("call Calendar proposal", () => {
  it("freshly reads only the authorized calendar and returns unsent bounded evidence", async () => {
    const f = fixture(); const result = await prepareCallCalendarPlan(f.ctx, f.input);
    expect(f.reads()).toBe(1); expect(f.guards()).toBeGreaterThan(3);
    expect(Object.keys(result).sort()).toEqual(["calendarId", "date", "draft", "timeZone"]);
    expect(result.draft).toContain("Actual meeting"); expect(result.draft).toContain("Write proposal");
    expect(result.draft).toContain("unsent proposal"); expect(result.draft.length).toBeLessThanOrEqual(8000);
    expect(JSON.stringify(result)).not.toContain(f.issued.token); expect(JSON.stringify(result)).not.toContain("owned-access");
  });
  it("rejects an unknown capability without Calendar reads", async () => {
    const f = fixture(); await expect(prepareCallCalendarPlan(f.ctx, { ...f.input, capability: "b".repeat(64) })).rejects.toMatchObject({ status: 403 });
    expect(f.reads()).toBe(0);
  });
  it("refuses a different hosted account before reading", async () => {
    const f = fixture(); f.ctx.accountId = "bob";
    await expect(prepareCallCalendarPlan(f.ctx, f.input)).rejects.toMatchObject({ status: 403 }); expect(f.reads()).toBe(0);
  });
  it.each(["revoke", "reconsent", "expire", "call-end", "account-change"])("discards evidence when %s happens during a read", async (action) => {
    const f = fixture(); f.ctx.accountId = "alice";
    f.onRead(() => {
      if (action === "revoke") revokeCalendarDeviceGrant(db, "alice", f.issued.grant.id);
      else if (action === "reconsent") connect();
      else if (action === "expire") f.advance(CALENDAR_DEVICE_GRANT_TTL_MS);
      else if (action === "account-change") f.ctx.accountId = "bob";
      else f.end();
    });
    await expect(prepareCallCalendarPlan(f.ctx, f.input)).rejects.toMatchObject({ status: action === "call-end" ? 409 : 403 });
    expect(f.reads()).toBe(1);
  });
  it("revalidates capability after the asynchronous call guard", async () => {
    const f = fixture(); f.onGuard(() => revokeCalendarDeviceGrant(db, "alice", f.issued.grant.id));
    await expect(prepareCallCalendarPlan(f.ctx, f.input)).rejects.toMatchObject({ status: 403 }); expect(f.reads()).toBe(0);
  });
  it.each([
    { date: "2026-02-30" }, { timeZone: "unknown/zone" }, { timeZone: "+01:00" },
    { workStart: "20:00", workEnd: "09:00" }, { commitments: [] }, { date: "2026-03-08", timeZone: "America/New_York", workStart: "02:30" },
  ])("rejects malformed selection before contacting Calendar %j", async (patch) => {
    const f = fixture(); await expect(prepareCallCalendarPlan(f.ctx, { ...f.input, ...patch })).rejects.toMatchObject({ status: 400 }); expect(f.reads()).toBe(0);
  });
  it.each([30, 100])("rejects an oversized complete draft with %i events rather than truncating evidence", async count => {
    const f = fixture(); f.day.events = Array.from({ length: count }, (_, i) => ({ ...f.day.events[0], id: String(i), summary: "x".repeat(500) }));
    await expect(prepareCallCalendarPlan(f.ctx, f.input)).rejects.toMatchObject({ status: 413, message: "The complete Calendar proposal is too long for a call message. Review it in Muster instead." });
  });
  it("refuses wrong-calendar evidence even if the reader returns a complete day", async () => {
    const f = fixture(); f.day.calendarId = "other";
    await expect(prepareCallCalendarPlan(f.ctx, f.input)).rejects.toMatchObject({ status: 502 });
  });
  it("sanitizes provider failures and never invents an empty day", async () => {
    const f = fixture(); f.onRead(() => { throw new Error("private provider credentials"); });
    await expect(prepareCallCalendarPlan(f.ctx, f.input)).rejects.toMatchObject({ status: 502, message: "Calendar planning is unavailable. Check the permission and try preparing again." });
  });
});
