// Personal Calendar consent is account/session scoped, even on loopback.
// It never updates login/Drive credentials or revokes a combined Google grant.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { GoogleCalendarReader, calendarDayWindow } from "./calendar-day.ts";
import { getCalendarAccess } from "./calendar-access.ts";
import { buildCalendarPlan, calendarPlanInputSchema } from "./calendar-plan.ts";
import { json, readBody } from "./http-helpers.ts";
import { createCalendarState, consumeCalendarState, getCalendarGrant, saveCalendarGrant, disconnectCalendar } from "./calendar-grants.ts";
import { GoogleCalendarOAuthProvider } from "./calendar-oauth.ts";

import { CalendarEnrollmentError, type CalendarEnrollmentRegistry } from "./calendar-enrollment.ts";
import { issueCalendarDeviceGrant, listCalendarDeviceGrants, revokeCalendarDeviceGrant } from "./calendar-device-grants.ts";

export const CALENDAR_CALLBACK_PATH = "/api/calendar/google/callback";
interface CalendarSession { userId: string; sessionId: string }
export interface CalendarRouteContext {
  db(): DatabaseSync;
  enrollment?: CalendarEnrollmentRegistry;
  enrollmentBotName?(botId: string): string;
  session(): Promise<CalendarSession | null>;
  origin: string;
  clientId: string;
  clientSecret: string;
  provider?: Pick<GoogleCalendarOAuthProvider, "authorizationUrl" | "exchange"> & Partial<Pick<GoogleCalendarOAuthProvider, "refresh">>;
  reader?: Pick<GoogleCalendarReader, "listCalendars" | "readDay">;
}

export async function handleCalendarRoute(req: IncomingMessage, res: ServerResponse, method: string, path: string, ctx: CalendarRouteContext): Promise<boolean> {
  if (!path.startsWith("/api/calendar/")) return false;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  const session = await ctx.session();
  const configured = Boolean(ctx.clientId && ctx.clientSecret);
  // A local paired desktop can legitimately have no web login. Advertising
  // this capability must not trigger the shared API client's 401 sign-out.
  if (!session && method === "GET" && path === "/api/calendar/status") {
    json(res, 200, { configured, connected: false, requiresSignIn: true }); return true;
  }
  if (!session) { json(res, 401, { error: "Sign in to connect your calendar." }); return true; }
  if (method === "GET" && path === "/api/calendar/status") {
    json(res, 200, { configured, connected: Boolean(getCalendarGrant(ctx.db(), session.userId)) });
    return true;
  }
  if (method === "GET" && (path === "/api/calendar/calendars" || path === "/api/calendar/day")) {
    if (!configured) { json(res, 503, { error: "Google Calendar connection is not configured yet." }); return true; }
    const query = new URL(req.url ?? path, ctx.origin).searchParams;
    const selection = z.object({
      calendarId: z.string().min(1).max(1024).refine(value => [...value].every(character => character.charCodeAt(0) >= 32)),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      timeZone: z.string().min(1).max(100),
    }).safeParse({ calendarId: query.get("calendarId"), date: query.get("date"), timeZone: query.get("timeZone") });
    if (path === "/api/calendar/day") {
      try {
        if (!selection.success) throw new Error();
        calendarDayWindow(selection.data.date, selection.data.timeZone);
      } catch { json(res, 400, { error: "Choose a valid calendar, date and timezone." }); return true; }
    }
    try {
      const guard = async () => {
        const current = await ctx.session();
        if (current?.userId !== session.userId || current.sessionId !== session.sessionId) throw new Error("Calendar session changed");
      };
      const provider = ctx.provider?.refresh ? { refresh: ctx.provider.refresh.bind(ctx.provider) }
        : new GoogleCalendarOAuthProvider({ clientId: ctx.clientId, clientSecret: ctx.clientSecret, redirectUri: `${ctx.origin}${CALENDAR_CALLBACK_PATH}` });
      const access = await getCalendarAccess(ctx.db(), session.userId, provider, guard);
      const reader = ctx.reader ?? new GoogleCalendarReader({});
      const payload = path === "/api/calendar/calendars"
        ? { calendars: await reader.listCalendars(access.grant.accessToken, access.assertCurrent) }
        : await reader.readDay(access.grant.accessToken, selection.data!, access.assertCurrent);
      await access.assertCurrent();
      json(res, 200, payload);
    } catch {
      // A partial page/expired grant is never an empty agenda. Do not leak
      // upstream responses, tokens or details from another session.
      json(res, 409, { error: "Could not read the complete calendar. Retry, or reconnect Calendar if access has expired." });
    }
    return true;
  }
  // Browser mutations require an explicit same-origin request. The OAuth
  // callback uses the one-time, session-bound state instead of Origin.
  if (method === "POST" || method === "DELETE") {
    if (req.headers.origin !== ctx.origin) {
      json(res, 403, { error: "Open Calendar settings in Muster to try again." }); return true;
    }
  }
  if (method === "POST" && path === "/api/calendar/enrollment/inspect") {
    if (!ctx.enrollment) { json(res, 503, { error: "Calendar enrollment is unavailable on this host." }); return true; }
    let code: string;
    try { code = z.object({ code: z.string().max(32) }).strict().parse(await readBody(req)).code; }
    catch { json(res, 400, { error: "Enter the code shown on your Watch." }); return true; }
    try {
      const enrollment = ctx.enrollment.inspect(code, session.userId);
      json(res, 200, { enrollment: { ...enrollment, botName: ctx.enrollmentBotName?.(enrollment.botId) ?? "Bot" } });
    } catch (error) {
      if (error instanceof CalendarEnrollmentError) json(res, error.status, { error: error.message });
      else json(res, 409, { error: "Could not inspect this enrollment. Open Calendar on the computer connected to your Watch." });
    }
    return true;
  }
  if (method === "GET" && path === "/api/calendar/devices") {
    json(res, 200, { devices: listCalendarDeviceGrants(ctx.db(), session.userId) }); return true;
  }
  if (method === "DELETE" && /^\/api\/calendar\/devices\/[^/]+$/.test(path)) {
    const id = path.split("/").at(-1)!;
    if (!z.string().uuid().safeParse(id).success) { json(res, 400, { error: "Choose a valid Calendar authorization." }); return true; }
    // Same response for absent and other-account records; revocation stays scoped.
    revokeCalendarDeviceGrant(ctx.db(), session.userId, id);
    json(res, 200, { ok: true }); return true;
  }
  if (method === "POST" && (path === "/api/calendar/devices" || path === "/api/calendar/enrollment/approve")) {
    if (!configured) { json(res, 503, { error: "Google Calendar connection is not configured yet." }); return true; }
    const enrolling = path === "/api/calendar/enrollment/approve";
    if (enrolling && !ctx.enrollment) { json(res, 503, { error: "Calendar enrollment is unavailable on this host." }); return true; }
    const schema = z.object({
      code: z.string().max(32).optional(),
      calendarId: z.string().min(1).max(1024).refine(value => [...value].every(character => character.charCodeAt(0) >= 32)),
      label: z.string().trim().min(1).max(80),
    }).strict();
    let body: z.infer<typeof schema>;
    try { body = schema.parse(await readBody(req)); if (enrolling !== (body.code !== undefined)) throw new Error("Invalid enrollment selection"); }
    catch { json(res, 400, { error: "Choose a calendar and name this authorization." }); return true; }
    try {
      const issue = async () => {
        const guard = async () => {
          const current = await ctx.session();
          if (current?.userId !== session.userId || current.sessionId !== session.sessionId) throw new Error("Calendar session changed");
        };
        const provider = ctx.provider?.refresh ? { refresh: ctx.provider.refresh.bind(ctx.provider) }
          : new GoogleCalendarOAuthProvider({ clientId: ctx.clientId, clientSecret: ctx.clientSecret, redirectUri: `${ctx.origin}${CALENDAR_CALLBACK_PATH}` });
        const access = await getCalendarAccess(ctx.db(), session.userId, provider, guard);
        const reader = ctx.reader ?? new GoogleCalendarReader({});
        const calendars = await reader.listCalendars(access.grant.accessToken, access.assertCurrent);
        await access.assertCurrent();
        if (!calendars.some(calendar => calendar.id === body.calendarId)) throw new Error("Calendar is not available");
        return issueCalendarDeviceGrant(ctx.db(), { userId: session.userId, calendarId: body.calendarId, label: body.label });
      };
      if (enrolling) {
        await ctx.enrollment!.approve(body.code!, session.userId, issue);
        json(res, 200, { ok: true });
      } else json(res, 201, await issue());
    } catch (error) {
      if (error instanceof CalendarEnrollmentError) json(res, error.status, { error: error.message });
      else json(res, 409, { error: "Could not authorize Calendar. Reconnect, check the selected calendar, or remove an existing authorization and try again." });
    }
    return true;
  }
  if (method === "POST" && path === "/api/calendar/plan") {
    if (!configured) { json(res, 503, { error: "Google Calendar connection is not configured yet." }); return true; }
    const bodySchema = z.object({
      calendarId: z.string().min(1).max(1024).refine(value => [...value].every(character => character.charCodeAt(0) >= 32)),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), timeZone: z.string().min(1).max(100),
      workStart: z.string(), workEnd: z.string(), commitments: z.array(z.object({ title: z.string(), minutes: z.number() })),
    });
    let body: z.infer<typeof bodySchema>;
    try {
      body = bodySchema.parse(await readBody(req));
      calendarDayWindow(body.date, body.timeZone);
      calendarPlanInputSchema.parse({ workStart: body.workStart, workEnd: body.workEnd, commitments: body.commitments });
    } catch { json(res, 400, { error: "Choose a valid day, work hours and one to three commitments with durations." }); return true; }
    try {
      const guard = async () => {
        const current = await ctx.session();
        if (current?.userId !== session.userId || current.sessionId !== session.sessionId) throw new Error("Calendar session changed");
      };
      const provider = ctx.provider?.refresh ? { refresh: ctx.provider.refresh.bind(ctx.provider) }
        : new GoogleCalendarOAuthProvider({ clientId: ctx.clientId, clientSecret: ctx.clientSecret, redirectUri: `${ctx.origin}${CALENDAR_CALLBACK_PATH}` });
      const access = await getCalendarAccess(ctx.db(), session.userId, provider, guard);
      const reader = ctx.reader ?? new GoogleCalendarReader({});
      // Never accept a browser-supplied event snapshot as calendar authority.
      const day = await reader.readDay(access.grant.accessToken, { calendarId: body.calendarId, date: body.date, timeZone: body.timeZone }, access.assertCurrent);
      const plan = buildCalendarPlan(day, { workStart: body.workStart, workEnd: body.workEnd, commitments: body.commitments });
      await access.assertCurrent();
      json(res, 200, plan);
    } catch {
      json(res, 409, { error: "Could not prepare a complete plan. Check work hours, reload Calendar and try again." });
    }
    return true;
  }
  if (method === "DELETE" && path === "/api/calendar/connection") {
    disconnectCalendar(ctx.db(), session.userId);
    json(res, 200, { ok: true }); return true;
  }
  if ((method === "POST" && path === "/api/calendar/connect") || (method === "GET" && path === CALENDAR_CALLBACK_PATH)) {
    if (!configured) { json(res, 503, { error: "Google Calendar connection is not configured yet." }); return true; }
    const provider = ctx.provider ?? new GoogleCalendarOAuthProvider({ clientId: ctx.clientId, clientSecret: ctx.clientSecret, redirectUri: `${ctx.origin}${CALENDAR_CALLBACK_PATH}` });
    if (path === "/api/calendar/connect") {
      const flow = createCalendarState(ctx.db(), session);
      json(res, 200, { url: provider.authorizationUrl(flow) }); return true;
    }
    const query = new URL(req.url ?? path, ctx.origin).searchParams;
    const flow = consumeCalendarState(ctx.db(), { ...session, state: query.get("state") ?? "" });
    let success = false;
    if (flow && !query.has("error")) {
      const code = query.get("code");
      if (code && code.length <= 8192) {
        try {
          const grant = await provider.exchange(code, flow);
          // Logout/account change while the provider was answering must not
          // create a grant. The store also rejects disconnect/new-consent races.
          const current = await ctx.session();
          if (current?.userId === session.userId && current.sessionId === session.sessionId) {
            saveCalendarGrant(ctx.db(), { ...grant, userId: session.userId, expectedGeneration: flow.generation });
            success = true;
          }
        } catch { /* Fixed recovery result; never reflect provider credentials. */ }
      }
    }
    res.writeHead(303, { Location: `/app?calendar=${success ? "connected" : "failed"}` });
    res.end(); return true;
  }
  json(res, 404, { error: "Calendar endpoint not found." }); return true;
}
