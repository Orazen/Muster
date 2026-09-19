import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DatabaseSync } from "node:sqlite";
import { createServer, type Server } from "node:http";
import { handleCalendarRoute, type CalendarRouteContext } from "./calendar-routes.ts";
import { getCalendarGrant, disconnectCalendar, createCalendarState } from "./calendar-grants.ts";

let db: DatabaseSync;
let server: Server;
let origin: string;
let user = { userId: "alice", sessionId: "alice-session" };
let ctx: CalendarRouteContext;
let authState = "";
const grant = { googleSub: "google-alice", accessToken: "private-access", refreshToken: "private-refresh", expiresAt: Date.now() + 3600000, scopes: ["https://www.googleapis.com/auth/calendar.readonly"] };

beforeEach(async () => {
  db = new DatabaseSync(":memory:");
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE "user" (id TEXT PRIMARY KEY); INSERT INTO "user" VALUES (\'alice\'), (\'bob\');');
  user = { userId: "alice", sessionId: "alice-session" };
  ctx = {
    db: () => db, session: async () => user, origin: "", clientId: "test-client", clientSecret: "test-secret",
    provider: {
      authorizationUrl: vi.fn((flow) => { authState = flow.state; return `https://accounts.google.com/o/oauth2/v2/auth?state=${flow.state}`; }),
      exchange: vi.fn(async () => ({ ...grant })),
    },
  };
  server = createServer((req, res) => {
    void handleCalendarRoute(req, res, req.method ?? "GET", new URL(req.url!, origin).pathname, ctx)
      .catch(() => { res.writeHead(500); res.end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = z.object({ port: z.number() }).parse(server.address());
  origin = `http://127.0.0.1:${address.port}`; ctx.origin = origin;
});
afterEach(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); db.close(); });
async function start() { return fetch(`${origin}/api/calendar/connect`, { method: "POST", headers: { origin } }); }
async function callback(state = authState) { return fetch(`${origin}/api/calendar/google/callback?state=${state}&code=code`, { redirect: "manual" }); }

describe("personal Calendar HTTP family", () => {
  it("requires a real session even on a local server", async () => {
    ctx.session = async () => null;
    expect((await start()).status).toBe(401);
    expect(await (await fetch(`${origin}/api/calendar/status`)).json()).toEqual({ configured: true, connected: false, requiresSignIn: true });
    expect(ctx.provider!.authorizationUrl).not.toHaveBeenCalled();
  });
  it("blocks cross-origin and missing-origin mutations", async () => {
    for (const headers of [{}, { origin: "https://foreign.example" }]) {
      expect((await fetch(`${origin}/api/calendar/connect`, { method: "POST", headers })).status).toBe(403);
      expect((await fetch(`${origin}/api/calendar/connection`, { method: "DELETE", headers })).status).toBe(403);
    }
    expect(ctx.provider!.authorizationUrl).not.toHaveBeenCalled();
  });
  it("reports unavailable configuration without opening consent", async () => {
    ctx.clientSecret = "";
    expect(await (await fetch(`${origin}/api/calendar/status`)).json()).toEqual({ configured: false, connected: false });
    expect((await start()).status).toBe(503);
    expect(ctx.provider!.authorizationUrl).not.toHaveBeenCalled();
  });
  it("connects only the owning session and never returns credentials", async () => {
    expect((await start()).status).toBe(200);
    const original = { ...user };
    user = { userId: "bob", sessionId: "bob-session" };
    expect((await callback()).headers.get("location")).toBe("/app?calendar=failed");
    expect(ctx.provider!.exchange).not.toHaveBeenCalled();
    user = { ...original, sessionId: "another-alice-session" };
    expect((await callback()).headers.get("location")).toBe("/app?calendar=failed");
    user = original;
    const response = await callback();
    expect(response.headers.get("location")).toBe("/app?calendar=connected");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("");
    expect(await (await fetch(`${origin}/api/calendar/status`)).json()).toEqual({ configured: true, connected: true });
    expect(getCalendarGrant(db, "bob")).toBeNull();
    expect((await callback()).headers.get("location")).toBe("/app?calendar=failed");
    expect(ctx.provider!.exchange).toHaveBeenCalledTimes(1);
  });
  it("consumes denied and failed consent without leaking provider errors", async () => {
    await start();
    const denied = await fetch(`${origin}/api/calendar/google/callback?state=${authState}&error=access_denied`, { redirect: "manual" });
    expect(denied.headers.get("location")).toBe("/app?calendar=failed");
    await callback(); expect(ctx.provider!.exchange).not.toHaveBeenCalled();
    await start();
    vi.mocked(ctx.provider!.exchange).mockRejectedValueOnce(new Error("private-token-provider-error"));
    const failed = await callback();
    expect(failed.headers.get("location")).toBe("/app?calendar=failed");
    expect(await failed.text()).toBe("");
    expect(getCalendarGrant(db, "alice")).toBeNull();
  });
  it("does not save after session logout during the provider exchange", async () => {
    await start();
    vi.mocked(ctx.provider!.exchange).mockImplementationOnce(async () => { ctx.session = async () => null; return grant; });
    expect((await callback()).headers.get("location")).toBe("/app?calendar=failed");
    expect(getCalendarGrant(db, "alice")).toBeNull();
  });
  it("disconnect during exchange wins and cannot delete another account's grant", async () => {
    await start();
    vi.mocked(ctx.provider!.exchange).mockImplementationOnce(async () => {
      const response = await fetch(`${origin}/api/calendar/connection`, { method: "DELETE", headers: { origin } });
      expect(response.status).toBe(200); return grant;
    });
    expect((await callback()).headers.get("location")).toBe("/app?calendar=failed");
    expect(getCalendarGrant(db, "alice")).toBeNull();
    await start(); await callback();
    user = { userId: "bob", sessionId: "bob-session" };
    await fetch(`${origin}/api/calendar/connection`, { method: "DELETE", headers: { origin } });
    expect(getCalendarGrant(db, "alice")).not.toBeNull();
  });
});


describe("account-owned Calendar day reads", () => {
  const selection = "calendarId=primary&date=2026-10-25&timeZone=Europe%2FRome";
  const day = { calendarId: "primary", date: "2026-10-25", timeZone: "Europe/Rome", timeMin: "2026-10-24T22:00:00Z", timeMax: "2026-10-25T23:00:00Z", events: [], complete: true as const };
  async function connect() { await start(); expect((await callback()).headers.get("location")).toBe("/app?calendar=connected"); }
  it("returns only the signed-in account's calendars/day without credentials", async () => {
    await connect();
    ctx.reader = {
      listCalendars: vi.fn(async (token, guard) => { expect(token).toBe("private-access"); await guard?.(); return [{ id: "primary", summary: "My calendar", timeZone: "Europe/Rome", primary: true }]; }),
      readDay: vi.fn(async (token, args, guard) => { expect(token).toBe("private-access"); expect(args).toEqual({ calendarId: "primary", date: "2026-10-25", timeZone: "Europe/Rome" }); await guard?.(); return day; }),
    };
    expect(await (await fetch(`${origin}/api/calendar/calendars`)).json()).toEqual({ calendars: [{ id: "primary", summary: "My calendar", timeZone: "Europe/Rome", primary: true }] });
    expect(await (await fetch(`${origin}/api/calendar/day?${selection}`)).json()).toEqual(day);
    user = { userId: "bob", sessionId: "bob-session" };
    const other = await fetch(`${origin}/api/calendar/day?${selection}`);
    expect(other.status).toBe(409);
    expect(await other.text()).not.toContain("private-access");
    expect(ctx.reader.readDay).toHaveBeenCalledTimes(1);
  });
  it("rejects bad dates and timezones before provider access", async () => {
    await connect();
    ctx.reader = { listCalendars: vi.fn(), readDay: vi.fn() };
    for (const query of ["", "calendarId=primary&date=2026-02-30&timeZone=Europe/Rome", "calendarId=primary&date=2026-01-01&timeZone=bad", "calendarId=primary&date=2011-12-30&timeZone=Pacific/Apia"]) {
      expect((await fetch(`${origin}/api/calendar/day?${query}`)).status).toBe(400);
    }
    expect(ctx.reader.readDay).not.toHaveBeenCalled();
  });
  it.each(["disconnect", "new-consent", "session-change"])("discards results after %s while reading", async (change) => {
    await connect();
    ctx.reader = { listCalendars: vi.fn(), readDay: vi.fn(async () => {
      if (change === "disconnect") disconnectCalendar(db, "alice");
      else if (change === "new-consent") createCalendarState(db, user);
      else user = { userId: "bob", sessionId: "bob-session" };
      return { ...day, events: [{ id: "private", summary: "private event", start: "2026-10-25T10:00:00Z", end: "2026-10-25T11:00:00Z", allDay: false, busy: true }] };
    }) };
    const response = await fetch(`${origin}/api/calendar/day?${selection}`);
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain("private event");
  });
  it("never converts provider failure into an empty complete day", async () => {
    await connect();
    ctx.reader = { listCalendars: vi.fn(), readDay: vi.fn(async () => { throw new Error("private upstream partial data"); }) };
    const response = await fetch(`${origin}/api/calendar/day?${selection}`);
    expect(response.status).toBe(409);
    const result = await response.json();
    expect(result).not.toHaveProperty("events");
    expect(result).not.toHaveProperty("complete");
    expect(JSON.stringify(result)).not.toContain("private upstream");
  });
});
