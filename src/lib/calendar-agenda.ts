import { z } from "zod";

export const calendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
});
export const calendarZoneSchema = z.string().min(1).refine((value) => {
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
});
const instantSchema = z.string().datetime({ offset: true });
export const calendarStatusSchema = z.object({ configured: z.boolean(), connected: z.boolean(), requiresSignIn: z.boolean().optional() });
export const calendarsSchema = z.object({ calendars: z.array(z.object({ id: z.string().min(1), summary: z.string(), timeZone: calendarZoneSchema, primary: z.boolean() })) });
const daySchema = z.object({
  calendarId: z.string().min(1), date: calendarDateSchema, timeZone: calendarZoneSchema,
  timeMin: instantSchema, timeMax: instantSchema, complete: z.boolean(),
  events: z.array(z.object({ id: z.string().min(1), summary: z.string(), start: z.string(), end: z.string(), allDay: z.boolean(), busy: z.boolean() }).refine((event) => {
    const schema = event.allDay ? calendarDateSchema : instantSchema;
    return schema.safeParse(event.start).success && schema.safeParse(event.end).success && (event.allDay ? event.end > event.start : Date.parse(event.end) > Date.parse(event.start));
  })),
}).refine((day) => Date.parse(day.timeMax) > Date.parse(day.timeMin));

export type CalendarDay = z.infer<typeof daySchema>;
export type CalendarStatus = z.infer<typeof calendarStatusSchema>;
export type CalendarList = z.infer<typeof calendarsSchema>["calendars"];
type Selection = Pick<CalendarDay, "calendarId" | "date" | "timeZone">;
type DayResult = { kind: "complete"; day: CalendarDay } | { kind: "partial" };

/** Bind the provider response to the user's selection. Incomplete data never
 * becomes an empty day, a free-time claim, or input to the planning form. */
export function calendarDayResponseSchema(selection: Selection) {
  return daySchema.refine((day) => day.calendarId === selection.calendarId && day.date === selection.date && day.timeZone === selection.timeZone)
    .transform((day): DayResult => day.complete ? { kind: "complete", day } : { kind: "partial" });
}

export function calendarEventTime(event: CalendarDay["events"][number], timeZone: string) {
  if (event.allDay) {
    const last = new Date(`${event.end}T00:00:00Z`);
    last.setUTCDate(last.getUTCDate() - 1);
    const end = last.toISOString().slice(0, 10);
    return `All day · ${event.start}${end === event.start ? "" : ` – ${end}`}`;
  }
  const format = new Intl.DateTimeFormat(undefined, { timeZone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return `${format.format(new Date(event.start))} – ${format.format(new Date(event.end))}`;
}
