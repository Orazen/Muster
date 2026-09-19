import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { CalendarEnrollmentError, type CalendarEnrollmentRegistry } from "./calendar-enrollment.ts";
import { json, readBody } from "./http-helpers.ts";
import { CallCalendarPlanError, callCalendarPlanInputSchema, type CallCalendarPlanInput, type CallCalendarPlanResult } from "./call-calendar-plan.ts";
import { ForegroundCallError, type ForegroundCallRegistry } from "./foreground-call.ts";

export interface ForegroundCallRouteContext {
  registry: ForegroundCallRegistry;
  calendarEnrollment?: CalendarEnrollmentRegistry;
  prepareCalendar?(input: CallCalendarPlanInput, assertCallCurrent: () => Promise<void>): Promise<CallCalendarPlanResult>;
  origin: string;
  /** Only the existing installation-loopback trust may admit originless calls. */
  allowOriginless: boolean;
  /** Revalidates the current request account and its ownership of this bot. */
  authorizeBot(botId: string): Promise<{ ownerId: string | null; threadId: string } | null>;
}
const uuid = z.string().uuid();
const ringBody = z.object({ requestId: uuid, threadId: z.string().min(1).max(256).regex(/^[\w-]+$/) }).strict();
const messageBody = z.object({ requestId: uuid, text: z.string().trim().min(1).max(8000) }).strict();
const emptyBody = z.object({}).strict();
const capability = z.string().regex(/^[0-9a-f]{64}$/);

export async function handleForegroundCallRoute(req: IncomingMessage, res: ServerResponse, method: string, path: string, ctx: ForegroundCallRouteContext): Promise<boolean> {
  const family = /^\/api\/bots\/([\w-]+)\/calls(?:\/|$)/.exec(path);
  if (!family) return false;
  res.setHeader("Cache-Control", "no-store");
  const route = /^\/api\/bots\/([\w-]+)\/calls(?:\/([^/]+)(?:\/(accept|messages|end|prepare-calendar|calendar-enrollment|calendar-enrollment-status|calendar-enrollment-cancel))?)?$/.exec(path);
  if (!route || (route[2] && !uuid.safeParse(route[2]).success)) {
    json(res, 404, { error: "Call endpoint not found." }); return true;
  }
  const [, botId, callId, action] = route;
  if (!((method === "POST" && (!callId || action)) || (method === "GET" && callId && !action))) {
    json(res, 405, { error: "Method not allowed." }); return true;
  }
  try {
    const authorized = await ctx.authorizeBot(botId);
    if (!authorized) { json(res, 404, { error: "Call not found." }); return true; }
    const parsedToken = capability.safeParse(req.headers["x-muster-call-token"]);
    if (!parsedToken.success) { json(res, 400, { error: "A valid foreground call capability is required." }); return true; }
    if (method === "POST" && req.headers.origin !== ctx.origin && !(ctx.allowOriginless && req.headers.origin === undefined)) {
      json(res, 403, { error: "Open this call in Muster to try again." }); return true;
    }
    const scope = { ownerId: authorized.ownerId, botId, token: parsedToken.data };
    if (method === "GET" && callId) { json(res, 200, { call: ctx.registry.get(scope, callId) }); return true; }
    let body;
    try { body = await readBody(req); }
    catch { json(res, 400, { error: "Invalid call request." }); return true; }
    if (action?.startsWith("calendar-enrollment") && callId) {
      if (!ctx.calendarEnrollment) { json(res, 503, { error: "Calendar enrollment is not available on this host." }); return true; }
      const current = await ctx.authorizeBot(botId);
      if (!current || current.ownerId !== authorized.ownerId || current.threadId !== authorized.threadId) {
        json(res, 409, { error: "The conversation changed. Start enrollment again." }); return true;
      }
      ctx.registry.peek(scope, callId);
      if (action === "calendar-enrollment") {
        const binding = ctx.registry.enrollmentBinding(scope, callId);
        const parsed = z.object({ requestId: uuid }).strict().safeParse(body);
        if (!parsed.success) { json(res, 400, { error: "Invalid enrollment request." }); return true; }
        json(res, 201, { enrollment: ctx.calendarEnrollment.start(scope, binding, parsed.data.requestId) }); return true;
      }
      const parsed = z.object({ enrollmentId: uuid }).strict().safeParse(body);
      if (!parsed.success) { json(res, 400, { error: "Invalid enrollment request." }); return true; }
      if (action === "calendar-enrollment-cancel") {
        ctx.calendarEnrollment.cancel(scope, parsed.data.enrollmentId, callId);
        json(res, 200, { ok: true }); return true;
      }
      json(res, 200, ctx.calendarEnrollment.take(scope, parsed.data.enrollmentId, callId)); return true;
    }
    if (action === "prepare-calendar" && callId) {
      const calendarToken = capability.safeParse(req.headers["x-muster-calendar-token"]);
      const wireBody = z.record(z.string(), z.unknown()).safeParse(body);
      const input = callCalendarPlanInputSchema.safeParse(wireBody.success
        ? { ...wireBody.data, capability: calendarToken.success ? calendarToken.data : undefined } : null);
      // The capability belongs in its dedicated header, never the body.
      if (!calendarToken.success || !wireBody.success || !input.success || "capability" in wireBody.data) {
        json(res, 400, { error: "Choose a valid Calendar permission and planning details." }); return true;
      }
      const initial = ctx.registry.peek(scope, callId);
      const assertCallCurrent = async () => {
        const latest = await ctx.authorizeBot(botId);
        const call = ctx.registry.peek(scope, callId);
        if (!latest || latest.ownerId !== authorized.ownerId || latest.threadId !== authorized.threadId || call.threadId !== latest.threadId
          || call.state !== "connected" || call.turn?.requestId !== initial.turn?.requestId
          || (call.turn && !["completed", "failed", "cancelled"].includes(call.turn.state))) {
          throw new ForegroundCallError(409, "The call changed. Check its status before preparing a plan.");
        }
      };
      await assertCallCurrent();
      if (!ctx.prepareCalendar) { json(res, 503, { error: "Calendar planning is not available on this host." }); return true; }
      const plan = await ctx.prepareCalendar(input.data, assertCallCurrent);
      await assertCallCurrent();
      json(res, 200, plan); return true;
    }
    const parsed = (!callId ? ringBody : action === "messages" ? messageBody : emptyBody).safeParse(body);
    if (!parsed.success) { json(res, 400, { error: "Invalid call request." }); return true; }
    const current = await ctx.authorizeBot(botId);
    if (!current || current.ownerId !== authorized.ownerId) { json(res, 404, { error: "Call not found." }); return true; }
    if (!callId) {
      const input = ringBody.parse(parsed.data);
      if (input.threadId !== current.threadId || current.threadId !== authorized.threadId) {
        json(res, 409, { error: "The conversation changed. Start a new call." }); return true;
      }
      json(res, 201, { call: ctx.registry.ring(scope, input) }); return true;
    }
    if (action === "end") { json(res, 200, { call: await ctx.registry.end(scope, callId) }); return true; }
    const call = ctx.registry.peek(scope, callId);
    if (call.threadId !== current.threadId || current.threadId !== authorized.threadId) {
      json(res, 409, { error: "The conversation changed. End this call and start a new one." }); return true;
    }
    if (action === "accept") json(res, 200, { call: ctx.registry.accept(scope, callId) });
    else json(res, 202, { call: ctx.registry.message(scope, callId, messageBody.parse(parsed.data)) });
  } catch (error) {
    if (error instanceof CalendarEnrollmentError || error instanceof ForegroundCallError || error instanceof CallCalendarPlanError) json(res, error.status, { error: error.message });
    else json(res, 500, { error: "The call could not be updated. Check its status before trying again." });
  }
  return true;
}
