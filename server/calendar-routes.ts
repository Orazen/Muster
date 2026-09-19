// Personal Calendar consent is account/session scoped, even on loopback.
// It never updates login/Drive credentials or revokes a combined Google grant.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { json } from "./http-helpers.ts";
import { createCalendarState, consumeCalendarState, getCalendarGrant, saveCalendarGrant, disconnectCalendar } from "./calendar-grants.ts";
import { GoogleCalendarOAuthProvider } from "./calendar-oauth.ts";

export const CALENDAR_CALLBACK_PATH = "/api/calendar/google/callback";
interface CalendarSession { userId: string; sessionId: string }
export interface CalendarRouteContext {
  db(): DatabaseSync;
  session(): Promise<CalendarSession | null>;
  origin: string;
  clientId: string;
  clientSecret: string;
  provider?: Pick<GoogleCalendarOAuthProvider, "authorizationUrl" | "exchange">;
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
  // Browser mutations require an explicit same-origin request. The OAuth
  // callback uses the one-time, session-bound state instead of Origin.
  if (method === "POST" || method === "DELETE") {
    if (req.headers.origin !== ctx.origin) {
      json(res, 403, { error: "Open Calendar settings in Muster to try again." }); return true;
    }
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
