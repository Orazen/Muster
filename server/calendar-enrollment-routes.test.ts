import { DatabaseSync } from "node:sqlite";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { z } from "zod";
import { ForegroundCallRegistry } from "./foreground-call.ts";
import { CalendarEnrollmentRegistry } from "./calendar-enrollment.ts";
import { handleForegroundCallRoute, type ForegroundCallRouteContext } from "./foreground-call-routes.ts";
import { handleCalendarRoute, type CalendarRouteContext } from "./calendar-routes.ts";
import { createCalendarState, saveCalendarGrant } from "./calendar-grants.ts";
import { resolveCalendarDeviceGrant, revokeCalendarDeviceGrant, listCalendarDeviceGrants } from "./calendar-device-grants.ts";
import { prepareCallCalendarPlan } from "./call-calendar-plan.ts";
import type { JsonValue } from "./schema.ts";
let db: DatabaseSync, server: Server, origin: string;
let calls: ForegroundCallRegistry, enrollment: CalendarEnrollmentRegistry, callCtx: ForegroundCallRouteContext, calendarCtx: CalendarRouteContext;
let account: { userId: string; sessionId: string } | null;
let owner: string;
let dispatch = vi.fn();
const callToken = "a".repeat(64), botId = "bot", threadId = "thread";
let callId: string;
const base = () => `/api/bots/${botId}/calls/${callId}`;
beforeEach(async () => {
  db = new DatabaseSync(":memory:"); db.exec("PRAGMA foreign_keys=ON; CREATE TABLE user(id TEXT PRIMARY KEY); INSERT INTO user VALUES ('alice'),('bob')");
  account = { userId: "alice", sessionId: "session-a" }; owner = "local"; callId = randomUUID(); dispatch = vi.fn();
  const flow = createCalendarState(db, account);
  saveCalendarGrant(db, { userId: "alice", googleSub: "google-alice", accessToken: "fixture-access", refreshToken: "fixture-refresh", expiresAt: Date.now() + 3600000, scopes: ["https://www.googleapis.com/auth/calendar.readonly"], expectedGeneration: flow.generation });
  calls = new ForegroundCallRegistry({ dispatch });
  enrollment = new CalendarEnrollmentRegistry({
    assertCallCurrent: binding => calls.assertEnrollmentBinding(binding),
    revoke: (user, id) => { revokeCalendarDeviceGrant(db, user, id); },
    isPermissionCurrent: (user, issued) => { const grant = resolveCalendarDeviceGrant(db, issued.token); return grant?.userId === user && grant.id === issued.grant.id; },
  });
  calendarCtx = { db: () => db, session: async () => account, origin: "", clientId: "fixture", clientSecret: "fixture", enrollment, enrollmentBotName: () => "Mimi",
    provider: { authorizationUrl: vi.fn(), exchange: vi.fn(), refresh: vi.fn() },
    reader: { listCalendars: vi.fn(async () => [{ id: "selected", summary: "Personal", timeZone: "UTC", primary: false }]),
      readDay: vi.fn(async (_token, input) => ({ ...input, timeMin: "2040-01-02T00:00:00Z", timeMax: "2040-01-03T00:00:00Z", complete: true as const, events: [{ id: "event", summary: "Owned planning meeting", start: "2040-01-02T10:00:00Z", end: "2040-01-02T11:00:00Z", allDay: false, busy: true }] })) },
  };
  callCtx = { registry: calls, calendarEnrollment: enrollment, origin: "", allowOriginless: true,
    authorizeBot: async id => id === botId ? { ownerId: owner, threadId } : null,
    prepareCalendar: (input, assertCallCurrent) => prepareCallCalendarPlan({ db, provider: { refresh: vi.fn() }, reader: calendarCtx.reader!, assertCallCurrent }, input),
  };
  server = createServer((req, res) => {
    const path = new URL(req.url!, origin).pathname;
    void (async () => {
      if (await handleForegroundCallRoute(req, res, req.method!, path, callCtx)) return;
      if (await handleCalendarRoute(req, res, req.method!, path, calendarCtx)) return;
      res.writeHead(404).end();
    })().catch(() => { res.writeHead(500).end(); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${z.object({ port: z.number() }).parse(server.address()).port}`;
  callCtx.origin = origin; calendarCtx.origin = origin;
});
afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); db.close(); });
function post(path: string, body: JsonValue, headers: Record<string, string> = {}) {
  return fetch(origin + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}
const device = (action: string, body: JsonValue) => post(`${base()}/${action}`, body, { "x-muster-call-token": callToken });
const browser = (action: string, body: JsonValue) => post(`/api/calendar/enrollment/${action}`, body, { origin });
async function begin() {
  expect((await post(`/api/bots/${botId}/calls`, { requestId: callId, threadId }, { "x-muster-call-token": callToken })).status).toBe(201);
  expect((await device("accept", {})).status).toBe(200);
  const response = await device("calendar-enrollment", { requestId: randomUUID() }); expect(response.status).toBe(201);
  return z.object({ enrollment: z.object({ id: z.string(), code: z.string() }) }).parse(await response.json()).enrollment;
}
const approve = (code: string) => browser("approve", { code, calendarId: "selected", label: "My Watch" });
it("approves on the same host, delivers only to the original call, then prepares without dispatch", async () => {
  const pending = await begin();
  expect((await device("calendar-enrollment-status", { enrollmentId: pending.id })).status).toBe(200);
  const inspect = await browser("inspect", { code: pending.code }); expect(inspect.status).toBe(200);
  expect(await inspect.json()).toMatchObject({ enrollment: { botName: "Mimi", state: "waiting" } });
  const approval = await approve(pending.code); expect(approval.status).toBe(200); expect(await approval.json()).toEqual({ ok: true });
  const delivered = await device("calendar-enrollment-status", { enrollmentId: pending.id }); expect(delivered.status).toBe(200);
  const received = z.object({ enrollment: z.object({ state: z.literal("consumed") }), issued: z.object({ token: z.string(), grant: z.object({ calendarId: z.string() }) }) }).parse(await delivered.json());
  expect(received.issued.grant.calendarId).toBe("selected");
  expect((await device("calendar-enrollment-status", { enrollmentId: pending.id })).status).toBe(409);
  const prepared = await post(`${base()}/prepare-calendar`, { date: "2040-01-02", timeZone: "UTC", workStart: "09:00", workEnd: "17:00", commitments: [{ title: "Report", minutes: 30 }] }, { "x-muster-call-token": callToken, "x-muster-calendar-token": received.issued.token });
  expect(prepared.status).toBe(200); expect(await prepared.text()).toContain("Owned planning meeting");
  expect(dispatch).not.toHaveBeenCalled();
});
it("requires signed-in same-origin approval and keeps hosted ownership isolated", async () => {
  owner = "alice"; const pending = await begin();
  expect((await post("/api/calendar/enrollment/approve", { code: pending.code, calendarId: "selected", label: "Watch" })).status).toBe(403);
  account = { userId: "bob", sessionId: "session-b" }; expect((await browser("inspect", { code: pending.code })).status).toBe(404);
  account = null; expect((await approve(pending.code)).status).toBe(401);
  expect(listCalendarDeviceGrants(db, "alice")).toEqual([]);
});
it("revokes late issuance if the call ends during the calendar check", async () => {
  const pending = await begin();
  vi.mocked(calendarCtx.reader!.listCalendars).mockImplementationOnce(async () => {
    await calls.end({ ownerId: owner, botId, token: callToken }, callId);
    return [{ id: "selected", summary: "Personal", timeZone: "UTC", primary: false }];
  });
  expect((await approve(pending.code)).status).toBe(409);
  expect(listCalendarDeviceGrants(db, "alice")).toEqual([]);
  expect(dispatch).not.toHaveBeenCalled();
});
it("does not deliver revoked Calendar permission", async () => {
  const pending = await begin(); await approve(pending.code);
  const grant = listCalendarDeviceGrants(db, "alice")[0]; revokeCalendarDeviceGrant(db, "alice", grant.id);
  const result = await device("calendar-enrollment-status", { enrollmentId: pending.id });
  expect(result.status).toBe(409); expect(await result.text()).not.toContain('"issued"');
});
it("lets the original call cancel enrollment even after ending", async () => {
  const pending = await begin(); await approve(pending.code); await device("end", {});
  expect((await device("calendar-enrollment-cancel", { enrollmentId: pending.id })).status).toBe(200);
  expect(listCalendarDeviceGrants(db, "alice")).toEqual([]);
});
it("invalidates the internal binding when a call identifier is reused", async () => {
  const registry = new ForegroundCallRegistry({ dispatch, retentionMs: 0 });
  const scope = { ownerId: "local", botId, token: callToken };
  registry.ring(scope, { requestId: callId, threadId }); registry.accept(scope, callId);
  const binding = registry.enrollmentBinding(scope, callId); await registry.end(scope, callId);
  registry.ring(scope, { requestId: callId, threadId }); registry.accept(scope, callId);
  expect(() => registry.assertEnrollmentBinding(binding)).toThrow("Call not found");
  expect(registry.enrollmentBinding(scope, callId).callInstanceId).not.toBe(binding.callInstanceId);
});
