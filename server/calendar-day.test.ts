import { describe, expect, it, vi } from 'vitest';
import type { JsonValue } from './schema.ts';
import { calendarDayWindow, GoogleCalendarReader } from './calendar-day.ts';

const input = { calendarId: 'owner@example.com', date: '2026-09-19', timeZone: 'Europe/Rome' };
const event = (id = 'one') => ({ id, start: { dateTime: '2026-09-19T10:00:00+02:00' }, end: { dateTime: '2026-09-19T11:00:00+02:00' } });
function mockPages(...pages: Record<string, JsonValue>[]) {
  const fetcher = vi.fn<typeof fetch>();
  for (const page of pages) fetcher.mockResolvedValueOnce(Response.json({ kind: 'calendar#events', ...page }));
  return { fetcher, reader: new GoogleCalendarReader({ fetch: fetcher }) };
}

describe('calendar day civil boundaries', () => {
  it.each([['2026-03-29', 'Europe/Rome', 23], ['2026-10-25', 'Europe/Rome', 25], ['2026-10-04', 'Australia/Lord_Howe', 23.5], ['2026-04-05', 'Australia/Lord_Howe', 24.5]])('%s %s spans %s hours', (date, zone, hours) => {
    const window = calendarDayWindow(date, zone);
    expect((Date.parse(window.timeMax) - Date.parse(window.timeMin)) / 3_600_000).toBe(hours);
  });
  it('rejects a skipped date and malformed date or zone', () => {
    expect(() => calendarDayWindow('2011-12-30', 'Pacific/Apia')).toThrow();
    expect(() => calendarDayWindow('2026-02-30', 'Europe/Rome')).toThrow();
    expect(() => calendarDayWindow('2026-09-19', '+02:00')).toThrow();
    expect(() => calendarDayWindow('2026-09-19', 'Invalid/Zone')).toThrow();
  });
});

describe('Google Calendar complete reads', () => {
  it('lists all calendars including after an empty page', async () => {
    const { reader, fetcher } = mockPages({ kind: 'calendar#calendarList', nextPageToken: 'two' }, { kind: 'calendar#calendarList', items: [{ id: 'primary', summary: 'Work', timeZone: 'Europe/Rome', primary: true }] });
    expect(await reader.listCalendars('secret')).toEqual([{ id: 'primary', summary: 'Work', timeZone: 'Europe/Rome', primary: true }]);
    expect(String(fetcher.mock.calls[1][0])).toContain('pageToken=two');
  });
  it('expands recurrence with bounded GETs, continues empty pages and preserves intervals', async () => {
    const { reader, fetcher } = mockPages({ items: [], nextPageToken: 'two' }, { items: [event()] });
    const result = await reader.readDay('secret', input);
    expect(result.complete).toBe(true);
    expect(result.events).toEqual([{ id: 'one', summary: 'Busy', start: event().start.dateTime, end: event().end.dateTime, allDay: false, busy: true }]);
    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect(url.origin).toBe('https://www.googleapis.com');
    expect(url.searchParams.get('singleEvents')).toBe('true');
    expect(url.searchParams.get('orderBy')).toBe('startTime');
    expect(url.searchParams.get('showDeleted')).toBe('false');
    expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: 'error', headers: { Authorization: 'Bearer secret' } });
    expect(fetcher.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });
  it('handles cancelled, private, all-day, transparent, declined and day overlap', async () => {
    const { reader } = mockPages({ items: [
      { id: 'cancel', status: 'cancelled' }, event('private'),
      { id: 'all', start: { date: '2026-09-18' }, end: { date: '2026-09-20' } },
      { id: 'ended', start: { date: '2026-09-18' }, end: { date: '2026-09-19' } },
      { ...event('transparent'), transparency: 'transparent' },
      { ...event('declined'), attendees: [{ self: true, responseStatus: 'declined' }] },
      { id: 'outside', start: { dateTime: '2026-09-18T21:00:00Z' }, end: { dateTime: '2026-09-18T22:00:00Z' } },
    ] });
    const { events } = await reader.readDay('secret', input);
    expect(events.map(row => [row.id, row.busy])).toEqual([['private', true], ['all', true], ['transparent', false], ['declined', false]]);
    expect(events[1]).toMatchObject({ start: '2026-09-18', end: '2026-09-20', allDay: true });
  });
  it('accepts omitted items only in an identified empty collection', async () => {
    const { reader } = mockPages({ kind: 'calendar#events' });
    expect(await reader.readDay('secret', input)).toMatchObject({ events: [], complete: true });
  });
  it.each([{}, { kind: 'calendar#calendarList', items: [] }])('rejects missing or wrong collection kind %j', async body => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body));
    await expect(new GoogleCalendarReader({ fetch: fetcher }).readDay('secret', input)).rejects.toThrow('invalid response');
  });
  it('rejects an unidentified calendar list', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}));
    await expect(new GoogleCalendarReader({ fetch: fetcher }).listCalendars('secret')).rejects.toThrow('invalid response');
  });
  it('fails closed for offset-free timed events', async () => {
    const { reader } = mockPages({ items: [{ id: 'local', start: { dateTime: '2026-09-19T10:00:00' }, end: { dateTime: '2026-09-19T11:00:00' } }] });
    await expect(reader.readDay('secret', input)).rejects.toThrow();
  });
  it('rejects repeated page tokens without returning partial data', async () => {
    const { reader } = mockPages({ items: [event()], nextPageToken: 'same' }, { nextPageToken: 'same' });
    await expect(reader.readDay('secret', input)).rejects.toThrow('repeated');
  });
  it('fails at the page bound', async () => {
    const { reader, fetcher } = mockPages(...Array.from({ length: 20 }, (_, n) => ({ nextPageToken: String(n) })));
    await expect(reader.readDay('secret', input)).rejects.toThrow('page limit');
    expect(fetcher).toHaveBeenCalledTimes(20);
  });
  it('fails at the item bound', async () => {
    const { reader } = mockPages({ items: Array.from({ length: 10_001 }, (_, n) => event(String(n))) });
    await expect(reader.readDay('secret', input)).rejects.toThrow('result limit');
  });
  it.each([{ items: [event(), { id: 2 }] }, { items: [event(), { id: 'bad' }] }, { items: [{ ...event(), end: event().start }] }, { items: 'bad' }])('rejects malformed partial responses %j', async body => {
    const { reader } = mockPages(body);
    await expect(reader.readDay('secret', input)).rejects.toThrow();
  });
  it('does not expose upstream error content', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('sensitive provider details', { status: 403 }));
    await expect(new GoogleCalendarReader({ fetch: fetcher }).readDay('secret', input)).rejects.toThrow('Google Calendar request failed (403)');
  });
  it('rejects credentials revoked while fetch is pending', async () => {
    let revoked = false;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => { revoked = true; return Response.json({ items: [event()] }); });
    const guard = async () => { if (revoked) throw new Error('revoked'); };
    await expect(new GoogleCalendarReader({ fetch: fetcher }).readDay('secret', input, guard)).rejects.toThrow('revoked');
  });
  it('rejects credentials revoked while parsing the body', async () => {
    let revoked = false;
    const response = Response.json({});
    vi.spyOn(response, 'json').mockImplementation(async () => { revoked = true; return { items: [event()] }; });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
    await expect(new GoogleCalendarReader({ fetch: fetcher }).readDay('secret', input, async () => { if (revoked) throw new Error('revoked'); })).rejects.toThrow('revoked');
  });
});
