import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { api } from "@/state/store";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
});
const zoneSchema = z.string().min(1).refine((value) => {
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
});
const instantSchema = z.string().datetime({ offset: true });
const calendarsSchema = z.object({ calendars: z.array(z.object({ id: z.string().min(1), summary: z.string(), timeZone: zoneSchema, primary: z.boolean() })) });
const daySchema = z.object({
  calendarId: z.string(), date: dateSchema, timeZone: zoneSchema,
  timeMin: instantSchema, timeMax: instantSchema, complete: z.literal(true),
  events: z.array(z.object({ id: z.string().min(1), summary: z.string(), start: z.string(), end: z.string(), allDay: z.boolean(), busy: z.boolean() }).refine((event) => {
    const schema = event.allDay ? dateSchema : instantSchema;
    return schema.safeParse(event.start).success && schema.safeParse(event.end).success && (event.allDay ? event.end > event.start : Date.parse(event.end) > Date.parse(event.start));
  })),
}).refine((day) => Date.parse(day.timeMax) > Date.parse(day.timeMin));
type Day = z.infer<typeof daySchema>;

function today() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
function eventTime(event: Day["events"][number], timeZone: string) {
  if (event.allDay) {
    const last = new Date(`${event.end}T00:00:00Z`);
    last.setUTCDate(last.getUTCDate() - 1);
    const end = last.toISOString().slice(0, 10);
    return `All day · ${event.start}${end === event.start ? "" : ` – ${end}`}`;
  }
  const format = new Intl.DateTimeFormat(undefined, { timeZone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return `${format.format(new Date(event.start))} – ${format.format(new Date(event.end))}`;
}

/** Explicit, read-only day retrieval. A changed input invalidates every pending result. */
export function CalendarAgenda() {
  const [calendars, setCalendars] = useState<z.infer<typeof calendarsSchema>["calendars"] | null>(null);
  const [calendarId, setCalendarId] = useState("");
  const [date, setDate] = useState(today);
  const [timeZone, setTimeZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [day, setDay] = useState<Day | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const pending = useRef(false);
  useEffect(() => () => { generation.current++; }, []);
  function invalidate() {
    generation.current++; pending.current = false; setBusy(false); setDay(null); setError(null);
  }
  async function load(list: boolean) {
    if (pending.current) return;
    if (!list && (!calendarId || !dateSchema.safeParse(date).success || !zoneSchema.safeParse(timeZone).success)) {
      setError("Choose a calendar, a valid date and a time zone such as Europe/Rome."); return;
    }
    const request = ++generation.current;
    pending.current = true; setBusy(true); setDay(null); setError(null);
    try {
      const query = new URLSearchParams({ calendarId, date, timeZone });
      const result = await api(list ? "/api/calendar/calendars" : `/api/calendar/day?${query}`);
      if (request !== generation.current) return;
      if (list) {
        const parsed = calendarsSchema.safeParse(result);
        if (!parsed.success) throw new Error("Calendar list is unavailable. Please retry.");
        setCalendars(parsed.data.calendars);
      } else {
        const parsed = daySchema.safeParse(result);
        if (!parsed.success || parsed.data.calendarId !== calendarId || parsed.data.date !== date || parsed.data.timeZone !== timeZone) throw new Error("Could not load a complete day. Please retry.");
        setDay(parsed.data);
      }
    } catch (cause) {
      if (request === generation.current) setError(cause instanceof Error ? cause.message : "Could not load Calendar. Please retry.");
    } finally {
      if (request === generation.current) { pending.current = false; setBusy(false); }
    }
  }
  const inputClass = "mt-1 block w-full min-w-0 max-w-full rounded-lg border border-hairline bg-raised px-2 py-2 text-ink";
  return <div className="mt-4 min-w-0 border-t border-hairline/50 pt-3">
    <h4 className="font-medium text-ink">Read your day</h4>
    <p className="mt-1 text-ink-secondary">Choose a calendar and load its events. Nothing is changed or sent to a bot.</p>
    <button disabled={busy} onClick={() => void load(true)} className="mt-2 rounded-lg bg-raised px-3 py-2 text-ink disabled:opacity-40">Choose a calendar</button>
    {calendars && calendars.length === 0 && <p className="mt-2 text-ink-secondary">No calendars available.</p>}
    {calendars && calendars.length > 0 && <div className="mt-3 min-w-0 space-y-3">
      <label className="block min-w-0 text-ink-secondary">Calendar<select className={inputClass} value={calendarId} onChange={(event) => { invalidate(); setCalendarId(event.target.value); const selected = calendars.find((calendar) => calendar.id === event.target.value); if (selected) setTimeZone(selected.timeZone); }}><option value="">Select a calendar</option>{calendars.map((calendar) => <option key={calendar.id} value={calendar.id}>{calendar.summary || "Untitled calendar"}{calendar.primary ? " (primary)" : ""}</option>)}</select></label>
      <label className="block min-w-0 text-ink-secondary">Date<input type="date" className={inputClass} value={date} onChange={(event) => { invalidate(); setDate(event.target.value); }} /></label>
      <label className="block min-w-0 text-ink-secondary">Time zone<input className={inputClass} value={timeZone} onChange={(event) => { invalidate(); setTimeZone(event.target.value); }} placeholder="Europe/Rome" /></label>
      <button disabled={busy || !calendarId} onClick={() => void load(false)} className="rounded-lg bg-raised px-3 py-2 text-ink disabled:opacity-40">Load day</button>
    </div>}
    {busy && <p role="status" className="mt-2 text-ink-secondary">Loading Calendar…</p>}
    {error && <p role="alert" className="mt-2 break-words text-danger">{error}</p>}
    {day && <div className="mt-3 min-w-0" aria-label="Calendar day">
      <p className="break-words text-ink-secondary">{day.date} · {day.timeZone}</p>
      {day.events.length === 0 ? <p role="status" className="mt-2 text-ink-secondary">No events for this day.</p> : <ul className="mt-2 space-y-3">{day.events.map((event, index) => <li key={`${event.id}-${index}`} className="min-w-0 break-words"><p className="text-ink">{event.summary || "Untitled event"}</p><p className="text-ink-secondary">{eventTime(event, day.timeZone)}</p></li>)}</ul>}
    </div>}
  </div>;
}
