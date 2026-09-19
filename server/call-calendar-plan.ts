import { Temporal } from "@js-temporal/polyfill";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { resolveCalendarDeviceGrant } from "./calendar-device-grants.ts";
import { getCalendarAccess } from "./calendar-access.ts";
import { calendarDayWindow, type GoogleCalendarReader } from "./calendar-day.ts";
import type { GoogleCalendarOAuthProvider } from "./calendar-oauth.ts";
import { buildCalendarPlan, calendarPlanInputSchema } from "./calendar-plan.ts";

export const callCalendarPlanInputSchema = calendarPlanInputSchema.safeExtend({
  capability: z.string().regex(/^[a-f0-9]{64}$/),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timeZone: z.string().min(1).max(128),
}).strict();
export type CallCalendarPlanInput = z.infer<typeof callCalendarPlanInputSchema>;
export interface CallCalendarPlanContext {
  db: DatabaseSync;
  provider: Pick<GoogleCalendarOAuthProvider, "refresh">;
  reader: Pick<GoogleCalendarReader, "readDay">;
  assertCallCurrent: () => Promise<void>;
  now?: () => number;
  accountId?: string;
}
export interface CallCalendarPlanResult { draft: string; date: string; timeZone: string; calendarId: string }
export class CallCalendarPlanError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

/** Reads one explicitly authorized calendar and returns unsent text only.
 * Every async boundary revalidates the call and device authorization; no model
 * dispatch, Calendar write or account session transfer exists in this service.
 */
export async function prepareCallCalendarPlan(ctx: CallCalendarPlanContext, rawInput: CallCalendarPlanInput): Promise<CallCalendarPlanResult> {
  const parsed = callCalendarPlanInputSchema.safeParse(rawInput);
  if (!parsed.success) throw new CallCalendarPlanError(400, "Invalid Calendar planning request.");
  const input = parsed.data;
  try {
    calendarDayWindow(input.date, input.timeZone);
    for (const time of [input.workStart, input.workEnd]) {
      Temporal.PlainDateTime.from(`${input.date}T${time}`).toZonedDateTime(input.timeZone, { disambiguation: "reject" });
    }
  } catch { throw new CallCalendarPlanError(400, "Invalid Calendar planning date, time zone or work hours."); }
  const now = ctx.now ?? Date.now;
  const identity = resolveCalendarDeviceGrant(ctx.db, input.capability, now());
  if (!identity || (ctx.accountId !== undefined && identity.userId !== ctx.accountId)) throw new CallCalendarPlanError(403, "Calendar device permission is unavailable. Authorize it again in Muster.");
  const assertPermission = () => {
    const current = resolveCalendarDeviceGrant(ctx.db, input.capability, now());
    if (!current || (ctx.accountId !== undefined && current.userId !== ctx.accountId) || current.id !== identity.id || current.userId !== identity.userId || current.calendarId !== identity.calendarId ||
      current.generation !== identity.generation || current.googleSub !== identity.googleSub || current.expiresAt !== identity.expiresAt) {
      throw new CallCalendarPlanError(403, "Calendar device permission changed. Authorize it again in Muster.");
    }
  };
  const guard = async () => {
    assertPermission();
    try { await ctx.assertCallCurrent(); }
    catch { throw new CallCalendarPlanError(409, "This call is no longer current. Start a new call before preparing a plan."); }
    assertPermission();
  };
  try {
    const access = await getCalendarAccess(ctx.db, identity.userId, ctx.provider, guard);
    await guard();
    const readerGuard = async () => { await access.assertCurrent(); await guard(); };
    const day = await ctx.reader.readDay(access.grant.accessToken, { calendarId: identity.calendarId, date: input.date, timeZone: input.timeZone }, readerGuard);
    await readerGuard();
    if (day.calendarId !== identity.calendarId || day.date !== input.date || day.timeZone !== input.timeZone || day.complete !== true) {
      throw new CallCalendarPlanError(502, "A complete selected-calendar read could not be confirmed.");
    }
    let plan: ReturnType<typeof buildCalendarPlan>;
    try { plan = buildCalendarPlan(day, { workStart: input.workStart, workEnd: input.workEnd, commitments: input.commitments }, now()); }
    catch (error) {
      if (error instanceof Error && error.message === "Calendar planning draft exceeds the 32000 character limit") {
        throw new CallCalendarPlanError(413, "The complete Calendar proposal is too long for a call message. Review it in Muster instead.");
      }
      throw error;
    }
    if (plan.draft.length > 8000) throw new CallCalendarPlanError(413, "The complete Calendar proposal is too long for a call message. Review it in Muster instead.");
    await guard();
    return { draft: plan.draft, date: plan.date, timeZone: plan.timeZone, calendarId: plan.calendarId };
  } catch (error) {
    if (error instanceof CallCalendarPlanError) throw error;
    // Recheck on failure too: provider error details never cross this boundary.
    await guard();
    throw new CallCalendarPlanError(502, "Calendar planning is unavailable. Check the permission and try preparing again.");
  }
}
