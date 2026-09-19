import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { JsonObject } from "./schema.ts";
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

describe("planning draft preparation", () => {
  const request = { calendarId: "primary", date: "2040-01-02", timeZone: "UTC", workStart: "09:00", workEnd: "17:00", commitments: [{ title: "Finish report", minutes: 90 }] };
  const day = { calendarId: "primary", date: request.date, timeZone: "UTC", timeMin: "2040-01-02T00:00:00Z", timeMax: "2040-01-03T00:00:00Z", events: [{ id: "meeting", summary: "Team meeting", start: "2040-01-02T10:00:00Z", end: "2040-01-02T11:00:00Z", allDay: false, busy: true }], complete: true as const };
  async function connect() { await start(); expect((await callback()).headers.get("location")).toBe("/app?calendar=connected"); }
  function prepare(body: JsonObject = request, source = origin) {
    return fetch(`${origin}/api/calendar/plan`, { method: "POST", headers: { origin: source, "content-type": "application/json" }, body: JSON.stringify(body) });
  }
  it("re-reads the owned calendar and prepares an unsent proposal", async () => {
    await connect();
    ctx.reader = { listCalendars: vi.fn(), readDay: vi.fn(async (_token, args, guard) => { await guard?.(); expect(args).toEqual({ calendarId: "primary", date: request.date, timeZone: "UTC" }); return day; }) };
    const response = await prepare();
    expect(response.status).toBe(200);
    const plan = z.object({ priorities: z.array(z.object({ title: z.string(), minutes: z.number(), start: z.string().optional(), end: z.string().optional() })), draft: z.string() }).parse(await response.json());
    expect(plan.priorities).toEqual([{ title: "Finish report", minutes: 90, start: "2040-01-02T11:00:00Z", end: "2040-01-02T12:30:00Z" }]);
    expect(plan.draft).toContain("Finish report");
    expect(plan.draft).toContain("Team meeting");
    expect(plan.draft).not.toContain("private-access");
    expect(ctx.reader.readDay).toHaveBeenCalledTimes(1);
  });
  it("ignores a forged empty snapshot and reports a fully busy day", async () => {
    await connect();
    ctx.reader = { listCalendars: vi.fn(), readDay: vi.fn(async () => ({ ...day, events: [{ id: "busy", summary: "Away", start: "2040-01-02", end: "2040-01-03", allDay: true, busy: true }] })) };
    const response = await prepare({ ...request, events: [], complete: true });
    expect(response.status).toBe(200);
    const plan = z.object({ unplaced: z.array(z.object({ title: z.string(), minutes: z.number() })), available: z.array(z.object({ start: z.string(), end: z.string() })), draft: z.string() }).parse(await response.json());
    expect(plan.unplaced).toEqual(request.commitments);
    expect(plan.available).toEqual([]);
    expect(plan.draft).toContain("Away");
  });
  it("rejects invalid commitments and cross-origin preparation before reading", async () => {
    await connect(); ctx.reader = { listCalendars: vi.fn(), readDay: vi.fn() };
    expect((await prepare(request, "https://foreign.example")).status).toBe(403);
    expect((await prepare({ ...request, commitments: [] })).status).toBe(400);
    expect((await prepare({ ...request, commitments: [{ title: "report", minutes: -1 }] })).status).toBe(400);
    expect(ctx.reader.readDay).not.toHaveBeenCalled();
  });
  it("requires the requesting account's grant", async () => {
    await connect(); user = { userId: "bob", sessionId: "bob-session" };
    ctx.reader = { listCalendars: vi.fn(), readDay: vi.fn() };
    expect((await prepare()).status).toBe(409);
    expect(ctx.reader.readDay).not.toHaveBeenCalled();
  });
  it("discards a plan if permission changes while refreshing evidence", async () => {
    await connect(); ctx.reader = { listCalendars: vi.fn(), readDay: vi.fn(async () => { disconnectCalendar(db, "alice"); return day; }) };
    const response = await prepare();
    expect(response.status).toBe(409);
    const result = await response.json();
    expect(result).not.toHaveProperty("draft");
    expect(JSON.stringify(result)).not.toContain("Team meeting");
  });
});

describe("explicit Calendar device authorizations", () => {
  async function connected() {
    await start(); await callback();
    ctx.reader = { listCalendars: vi.fn(async () => [{ id: "chosen", summary: "Personal", primary: false, timeZone: "UTC" }]), readDay: vi.fn() };
  }
  function issue(body: JsonObject = { calendarId: "chosen", label: "My Watch" }, source = origin) {
    return fetch(`${origin}/api/calendar/devices`, { method: "POST", headers: { origin: source, "content-type": "application/json" }, body: JSON.stringify(body) });
  }
  async function list() { return z.object({ devices: z.array(z.object({ id: z.string(), label: z.string(), calendarId: z.string(), expiresAt: z.number() }).strict()) }).parse(await (await fetch(`${origin}/api/calendar/devices`)).json()); }
  it("issues once after a fresh owned calendar read and lists no capability", async () => {
    await connected();
    const response = await issue(); expect(response.status).toBe(201);
    const result = z.object({ token: z.string().regex(/^[0-9a-f]{64}$/), grant: z.object({ id: z.string().uuid(), label: z.string(), calendarId: z.string(), expiresAt: z.number() }) }).parse(await response.json());
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(result.grant).toMatchObject({ label: "My Watch", calendarId: "chosen" });
    expect(await list()).toEqual({ devices: [result.grant] });
    expect(JSON.stringify(await list())).not.toContain(result.token);
    expect(JSON.stringify(result)).not.toContain("private-access");
    expect(ctx.reader!.listCalendars).toHaveBeenCalledTimes(1);
    expect(ctx.reader!.readDay).not.toHaveBeenCalled();
  });
  it("requires account session, same origin and an explicit bounded selection", async () => {
    await connected();
    expect((await issue(undefined, "https://foreign.example")).status).toBe(403);
    expect((await issue({ calendarId: "chosen", label: "" })).status).toBe(400);
    expect((await issue({ calendarId: "chosen", label: "Watch", userId: "bob" })).status).toBe(400);
    expect(ctx.reader!.listCalendars).not.toHaveBeenCalled();
    ctx.session = async () => null;
    expect((await issue()).status).toBe(401);
    expect((await fetch(`${origin}/api/calendar/devices`)).status).toBe(401);
  });
  it("does not infer the connected account from local installation access", async () => {
    await connected(); user = { userId: "bob", sessionId: "bob-session" };
    expect((await issue()).status).toBe(409);
    expect(ctx.reader!.listCalendars).not.toHaveBeenCalled();
    expect(await list()).toEqual({ devices: [] });
  });
  it("refuses a calendar absent from the complete fresh account list", async () => {
    await connected(); expect((await issue({ calendarId: "foreign", label: "Watch" })).status).toBe(409);
    expect(await list()).toEqual({ devices: [] });
  });
  it.each(["logout", "switch", "disconnect", "partial"])("does not authorize after %s during selection read", async failure => {
    await connected();
    vi.mocked(ctx.reader!.listCalendars).mockImplementationOnce(async () => {
      if (failure === "logout") ctx.session = async () => null;
      if (failure === "switch") user = { userId: "bob", sessionId: "bob-session" };
      if (failure === "disconnect") disconnectCalendar(db, "alice");
      if (failure === "partial") throw new Error("private-provider-details");
      return [{ id: "chosen", summary: "Personal", primary: false, timeZone: "UTC" }];
    });
    const response = await issue(); expect(response.status).toBe(409);
    expect(await response.text()).not.toContain("private-provider-details");
    ctx.session = async () => ({ userId: "alice", sessionId: "alice-session" });
    expect(await list()).toEqual({ devices: [] });
  });
  it("revokes only the signed-in account's selection without revealing other records", async () => {
    await connected();
    const { grant: created } = z.object({ grant: z.object({ id: z.string() }) }).parse(await (await issue()).json());
    const revoke = () => fetch(`${origin}/api/calendar/devices/${created.id}`, { method: "DELETE", headers: { origin } });
    user = { userId: "bob", sessionId: "bob-session" };
    expect((await revoke()).status).toBe(200); expect(await list()).toEqual({ devices: [] });
    user = { userId: "alice", sessionId: "alice-session" };
    expect((await list()).devices).toHaveLength(1);
    expect((await revoke()).status).toBe(200); expect(await list()).toEqual({ devices: [] });
  });
});
