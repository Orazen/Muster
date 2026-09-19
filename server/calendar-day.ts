import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
function plainDate(value: string) {
  return Temporal.PlainDate.from(dateSchema.parse(value));
}

/** Both boundaries are resolved in the requested zone: a civil day need not be 24 hours. */
export function calendarDayWindow(date: string, timeZone: string) {
  if (!timeZone || /^[+-]/.test(timeZone)) throw new Error('An IANA time zone is required');
  const day = plainDate(date);
  const start = day.toZonedDateTime(timeZone);
  if (!start.toPlainDate().equals(day)) throw new Error('The requested calendar date does not exist in this time zone');
  const end = day.add({ days: 1 }).toZonedDateTime(timeZone);
  return { date, timeZone, timeMin: start.toInstant().toString(), timeMax: end.toInstant().toString() };
}

const calendarSchema = z.object({
  id: z.string().min(1), summary: z.string().optional(),
  timeZone: z.string().min(1), primary: z.boolean().optional(),
});
const endpointSchema = z.object({ date: dateSchema.optional(), dateTime: z.string().optional() });
const eventSchema = z.object({
  id: z.string().min(1), status: z.enum(['confirmed', 'tentative', 'cancelled']).optional(),
  summary: z.string().optional(), start: endpointSchema.optional(), end: endpointSchema.optional(),
  transparency: z.enum(['opaque', 'transparent']).optional(),
  attendees: z.array(z.object({ self: z.boolean().optional(), responseStatus: z.enum(['needsAction', 'declined', 'tentative', 'accepted']) })).optional(),
});
export interface CalendarDayEvent {
  id: string; summary: string; start: string; end: string; allDay: boolean; busy: boolean;
}
type Guard = () => Promise<void>;

export class GoogleCalendarReader {
  private readonly fetcher: typeof fetch;
  constructor(options: { fetch?: typeof fetch } = {}) { this.fetcher = options.fetch ?? fetch; }

  private async pages<T>(path: string, params: Record<string, string>, token: string, schema: z.ZodType<T>, kind: 'calendar#events' | 'calendar#calendarList', guard?: Guard): Promise<T[]> {
    const result: T[] = [];
    const seen = new Set<string>();
    let pageToken: string | undefined;
    for (let page = 0; page < 20; page++) {
      const url = new URL(`https://www.googleapis.com/calendar/v3/${path}`);
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      await guard?.();
      const response = await this.fetcher(url, {
        headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(15_000),
      });
      await guard?.();
      if (!response.ok) throw new Error(`Google Calendar request failed (${response.status})`);
      await guard?.();
      const body: unknown = await response.json();
      await guard?.();
      const parsed = z.object({ kind: z.literal(kind), items: z.array(schema).optional(), nextPageToken: z.string().min(1).optional() }).safeParse(body);
      if (!parsed.success) throw new Error('Google Calendar returned an invalid response');
      result.push(...(parsed.data.items ?? []));
      if (result.length > 10_000) throw new Error('Google Calendar result limit exceeded');
      pageToken = parsed.data.nextPageToken;
      if (!pageToken) return result;
      if (seen.has(pageToken)) throw new Error('Google Calendar repeated a page token');
      seen.add(pageToken);
    }
    throw new Error('Google Calendar page limit exceeded');
  }

  async listCalendars(accessToken: string, guard?: Guard) {
    const calendars = await this.pages('users/me/calendarList', { maxResults: '250', showDeleted: 'false' }, accessToken, calendarSchema, 'calendar#calendarList', guard);
    await guard?.();
    return calendars.map(calendar => ({ id: calendar.id, summary: calendar.summary ?? 'Calendar', timeZone: calendar.timeZone, primary: calendar.primary ?? false }));
  }

  async readDay(accessToken: string, input: { calendarId: string; date: string; timeZone: string }, guard?: Guard) {
    if (!input.calendarId.trim()) throw new Error('A calendar is required');
    const window = calendarDayWindow(input.date, input.timeZone);
    const rows = await this.pages(`calendars/${encodeURIComponent(input.calendarId)}/events`, {
      timeMin: window.timeMin, timeMax: window.timeMax, timeZone: input.timeZone,
      singleEvents: 'true', orderBy: 'startTime', showDeleted: 'false', maxResults: '2500',
    }, accessToken, eventSchema, 'calendar#events', guard);
    await guard?.();
    const events: CalendarDayEvent[] = [];
    for (const row of rows) {
      if (row.status === 'cancelled') continue;
      const { start, end } = row;
      if (!start || !end) throw new Error('Google Calendar returned an event without an interval');
      let eventStart: string, eventEnd: string, overlaps: boolean, allDay: boolean;
      if (start.date && end.date && !start.dateTime && !end.dateTime) {
        const from = plainDate(start.date), to = plainDate(end.date);
        if (Temporal.PlainDate.compare(from, to) >= 0) throw new Error('Google Calendar returned an invalid event interval');
        eventStart = start.date; eventEnd = end.date; allDay = true;
        overlaps = start.date <= input.date && end.date > input.date;
      } else if (start.dateTime && end.dateTime && !start.date && !end.date) {
        // Offset-free timestamps fail closed; never infer an instant from the server zone.
        const from = Temporal.Instant.from(start.dateTime), to = Temporal.Instant.from(end.dateTime);
        if (Temporal.Instant.compare(from, to) >= 0) throw new Error('Google Calendar returned an invalid event interval');
        eventStart = start.dateTime; eventEnd = end.dateTime; allDay = false;
        overlaps = Temporal.Instant.compare(from, Temporal.Instant.from(window.timeMax)) < 0 && Temporal.Instant.compare(to, Temporal.Instant.from(window.timeMin)) > 0;
      } else throw new Error('Google Calendar returned an invalid event interval');
      if (overlaps) events.push({ id: row.id, summary: row.summary || 'Busy', start: eventStart, end: eventEnd, allDay,
        busy: row.transparency !== 'transparent' && !row.attendees?.some(attendee => attendee.self && attendee.responseStatus === 'declined') });
    }
    return { ...window, calendarId: input.calendarId, events, complete: true as const };
  }
}
