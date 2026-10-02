import { useEffect, useRef, useState } from "react";
import { api } from "@/state/store";
import { useAuth } from "@/lib/auth";
import { calendarDateSchema, calendarDayResponseSchema, calendarEventTime, calendarStatusSchema, calendarZoneSchema, calendarsSchema, type CalendarDay, type CalendarList, type CalendarStatus } from "@/lib/calendar-agenda";
import { CalendarPlanning } from "./CalendarPlanning";

function today() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

interface CalendarAgendaProps {
  variant?: "settings" | "today";
  onOpenConnection?: () => void;
}

/** Explicit, read-only day retrieval shared by Calendar settings and Today.
 * Today checks connection status only; listing calendars and reading events
 * always require the user's buttons. Account changes replace the whole view. */
export function CalendarAgenda(props: CalendarAgendaProps) {
  const { user, session } = useAuth();
  const owner = user && session ? `${user.id}:${session.id}` : "";
  const liveOwner = useRef(owner);
  liveOwner.current = owner;
  return <CalendarAgendaContent key={owner} {...props} owner={owner} isCurrentOwner={() => liveOwner.current === owner} />;
}

function CalendarAgendaContent({ variant = "settings", onOpenConnection, owner, isCurrentOwner }: CalendarAgendaProps & { owner: string; isCurrentOwner: () => boolean }) {
  const compact = variant === "today";
  const [status, setStatus] = useState<CalendarStatus | null>(null);
  const [checking, setChecking] = useState(compact);
  const [attempt, setAttempt] = useState(0);
  const [calendars, setCalendars] = useState<CalendarList | null>(null);
  const [calendarId, setCalendarId] = useState("");
  const [date, setDate] = useState(today);
  const [timeZone, setTimeZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [day, setDay] = useState<CalendarDay | null>(null);
  const [readAt, setReadAt] = useState<Date | null>(null);
  const [busy, setBusy] = useState(false);
  const [partial, setPartial] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const pending = useRef(false);
  const currentOwner = useRef(isCurrentOwner);
  currentOwner.current = isCurrentOwner;
  useEffect(() => () => { generation.current++; }, []);

  useEffect(() => {
    if (!compact) return;
    const request = ++generation.current;
    setChecking(true); setStatus(null); setCalendars(null); setCalendarId(""); setDay(null); setReadAt(null); setPartial(false); setError(null);
    pending.current = false; setBusy(false);
    if (!owner) { setStatus({ configured: false, connected: false, requiresSignIn: true }); setChecking(false); return; }
    const current = () => request === generation.current && currentOwner.current();
    api("/api/calendar/status").then((result) => {
      if (!current()) return;
      const parsed = calendarStatusSchema.safeParse(result);
      if (!parsed.success) throw new Error("Calendar status is unavailable. Please retry.");
      setStatus(parsed.data);
    }).catch((cause) => {
      if (current()) setError(cause instanceof Error ? cause.message : "Could not check Calendar. Please retry.");
    }).finally(() => { if (current()) setChecking(false); });
    return () => { generation.current++; };
  }, [compact, attempt, owner]);

  function invalidate() {
    generation.current++; pending.current = false; setBusy(false); setDay(null); setReadAt(null); setPartial(false); setError(null);
  }

  const connected = !compact || Boolean(status?.configured && status.connected && !status.requiresSignIn);
  async function load(list: boolean) {
    if (pending.current || checking || !owner || !currentOwner.current() || !connected) return;
    if (!list && (!calendars?.some((calendar) => calendar.id === calendarId) || !calendarDateSchema.safeParse(date).success || !calendarZoneSchema.safeParse(timeZone).success)) {
      setError("Choose a calendar, a valid date and a time zone such as Europe/Rome."); return;
    }
    const request = ++generation.current;
    const current = () => request === generation.current && currentOwner.current();
    pending.current = true; setBusy(true); setDay(null); setReadAt(null); setPartial(false); setError(null);
    if (list) { setCalendars(null); setCalendarId(""); }
    try {
      const query = new URLSearchParams({ calendarId, date, timeZone });
      const result = await api(list ? "/api/calendar/calendars" : `/api/calendar/day?${query}`);
      if (!current()) return;
      if (list) {
        const parsed = calendarsSchema.safeParse(result);
        if (!parsed.success) throw new Error("Calendar list is unavailable. Please retry.");
        setCalendars(parsed.data.calendars);
      } else {
        const parsed = calendarDayResponseSchema({ calendarId, date, timeZone }).safeParse(result);
        if (!parsed.success || parsed.data.kind !== "complete") {
          setPartial(parsed.success && parsed.data.kind === "partial");
          throw new Error("Could not load a complete day. Please retry.");
        }
        setDay(parsed.data.day); setReadAt(new Date());
      }
    } catch (cause) {
      if (current()) setError(cause instanceof Error ? cause.message : "Could not load Calendar. Please retry.");
    } finally {
      if (current()) { pending.current = false; setBusy(false); }
    }
  }

  const inputClass = "mt-1 block w-full min-w-0 max-w-full rounded-lg border border-hairline bg-raised px-2 py-2 text-ink";
  const selectedCalendar = calendars?.find((calendar) => calendar.id === day?.calendarId);
  return <div className={compact ? "wt-agenda" : "mt-4 min-w-0 border-t border-hairline/50 pt-3"} role={compact ? "region" : undefined} aria-label={compact ? "Today Calendar" : undefined}>
    {!compact && <h4 className="font-medium text-ink">Read your day</h4>}
    {compact && <>
      <p className="wt-agenda-status" role="status">{checking ? "Checking Calendar connection…" : status?.requiresSignIn ? "Sign in to connect your personal Calendar." : status && !status.configured ? "Calendar is unavailable on this server." : status?.connected ? "Calendar connected · read-only" : status ? "Calendar not connected" : "Calendar status unknown"}</p>
      {!checking && !connected && <p className="wt-agenda-copy">Google sign-in and Drive backup do not grant Calendar access. Connect it separately to read your day here.</p>}
      {!checking && onOpenConnection && <button type="button" className="wt-text-button" onClick={onOpenConnection}>Open Calendar</button>}
      {!checking && <button type="button" className="wt-text-button wt-agenda-recheck" onClick={() => { invalidate(); setAttempt((value) => value + 1); }}>Refresh Calendar connection</button>}
    </>}
    {connected && <>
      <p className="mt-1 text-ink-secondary wt-agenda-copy">Choose a calendar and load its events. Nothing is changed or sent to a bot.</p>
      <button type="button" disabled={busy || !owner} onClick={() => void load(true)} className="mt-2 rounded-lg bg-raised px-3 py-2 text-ink disabled:opacity-40 wt-agenda-button">Choose a calendar</button>
      {calendars && calendars.length === 0 && <p className="mt-2 text-ink-secondary" role="status">No calendars available.</p>}
      {calendars && calendars.length > 0 && <div className="mt-3 min-w-0 space-y-3 wt-agenda-fields">
        <label className="block min-w-0 text-ink-secondary">Calendar<select className={inputClass} value={calendarId} onChange={(event) => { invalidate(); setCalendarId(event.target.value); const selected = calendars.find((calendar) => calendar.id === event.target.value); if (selected) setTimeZone(selected.timeZone); }}><option value="">Select a calendar</option>{calendars.map((calendar) => <option key={calendar.id} value={calendar.id}>{calendar.summary || "Untitled calendar"}{calendar.primary ? " (primary)" : ""}</option>)}</select></label>
        <label className="block min-w-0 text-ink-secondary">Date<input type="date" className={inputClass} value={date} onChange={(event) => { invalidate(); setDate(event.target.value); }} /></label>
        <label className="block min-w-0 text-ink-secondary">Time zone<input className={inputClass} value={timeZone} onChange={(event) => { invalidate(); setTimeZone(event.target.value); }} placeholder="Europe/Rome" /></label>
        <button type="button" disabled={busy || !calendarId} onClick={() => void load(false)} className="rounded-lg bg-raised px-3 py-2 text-ink disabled:opacity-40 wt-agenda-button">Load day</button>
      </div>}
    </>}
    {busy && <p role="status" className="mt-2 text-ink-secondary">Loading Calendar…</p>}
    {error && <p role="alert" className="mt-2 break-words text-danger">{error}</p>}
    {partial && <p className="mt-2 text-ink-secondary">This response was incomplete. Events and available time are not shown; reload before planning.</p>}
    {day && <div className="mt-3 min-w-0 wt-agenda-day" aria-label="Calendar day">
      {compact && <h3>{selectedCalendar?.summary || "Your calendar"}</h3>}
      <p className="break-words text-ink-secondary">{day.date} · {day.timeZone}</p>
      {compact && readAt && <p className="wt-agenda-read-at">Last read {readAt.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}. Reload to check for changes.</p>}
      {day.events.length === 0 ? <p role="status" className="mt-2 text-ink-secondary">No events for this day.</p> : <ul className="mt-2 space-y-3 wt-agenda-events">{day.events.map((event, index) => <li key={`${event.id}-${index}`} className="min-w-0 break-words"><p className="text-ink">{event.summary || "Untitled event"}</p><p className="text-ink-secondary">{calendarEventTime(event, day.timeZone)}</p></li>)}</ul>}
      {compact ? <details className="wt-agenda-planning"><summary>Prepare a plan</summary><CalendarPlanning key={`${day.calendarId}:${day.date}:${day.timeZone}`} calendarId={day.calendarId} date={day.date} timeZone={day.timeZone} compact /></details>
        : <CalendarPlanning key={`${day.calendarId}:${day.date}:${day.timeZone}`} calendarId={day.calendarId} date={day.date} timeZone={day.timeZone} />}
    </div>}
  </div>;
}
