import type { DatabaseSync } from 'node:sqlite';
import { getCalendarGrant, isCalendarGrantCurrent, saveCalendarGrant, type CalendarGrant } from './calendar-grants.ts';
import { CalendarOAuthRefreshError, type GoogleCalendarOAuthGrant, type GoogleCalendarOAuthProvider } from './calendar-oauth.ts';

export class CalendarAccessError extends Error {
  readonly reconnectRequired: boolean;
  constructor(reconnectRequired = true) {
    super(reconnectRequired ? 'Reconnect Google Calendar' : 'Google Calendar is temporarily unavailable');
    this.reconnectRequired = reconnectRequired;
  }
}
const pending = new WeakMap<DatabaseSync, Map<string, Promise<GoogleCalendarOAuthGrant>>>();

/** Session guards belong to each caller, never to the shared provider request. */
export async function getCalendarAccess(db: DatabaseSync, userId: string,
  provider: Pick<GoogleCalendarOAuthProvider, 'refresh'>, guard: () => Promise<void>,
): Promise<{ grant: CalendarGrant; assertCurrent: () => Promise<void> }> {
  await guard();
  let grant = getCalendarGrant(db, userId);
  if (!grant || !isCalendarGrantCurrent(db, grant)) throw new CalendarAccessError();
  if (grant.expiresAt <= Date.now() + 60_000) {
    const original = grant;
    let flights = pending.get(db);
    if (!flights) { flights = new Map(); pending.set(db, flights); }
    const key = JSON.stringify([userId, original.generation, original.accessToken, original.refreshToken]);
    let flight = flights.get(key);
    if (!flight) {
      flight = provider.refresh(original);
      flights.set(key, flight);
      // Remove only this flight; no caller's session controls other callers.
      void flight.finally(() => { if (flights.get(key) === flight) flights.delete(key); }).catch(() => {});
    }
    let refreshed: GoogleCalendarOAuthGrant;
    try { refreshed = await flight; }
    catch (error) {
      await guard();
      if (!isCalendarGrantCurrent(db, original)) throw new CalendarAccessError();
      throw new CalendarAccessError(error instanceof CalendarOAuthRefreshError && error.reconnectRequired);
    }
    await guard();
    if (refreshed.googleSub !== original.googleSub || refreshed.expiresAt <= Date.now()) throw new CalendarAccessError();
    if (isCalendarGrantCurrent(db, original)) {
      grant = saveCalendarGrant(db, { ...refreshed, userId, expectedGeneration: original.generation });
    } else {
      // Another caller of this same flight may already have persisted its result.
      const saved = getCalendarGrant(db, userId);
      if (!saved || saved.generation !== original.generation || saved.googleSub !== refreshed.googleSub
        || saved.accessToken !== refreshed.accessToken || saved.refreshToken !== (refreshed.refreshToken ?? original.refreshToken)
        || saved.expiresAt !== refreshed.expiresAt || JSON.stringify(saved.scopes) !== JSON.stringify(refreshed.scopes)
        || !isCalendarGrantCurrent(db, saved)) throw new CalendarAccessError();
      grant = saved;
    }
  }
  const usable = grant;
  const assertCurrent = async () => {
    await guard();
    if (usable.expiresAt <= Date.now() || !isCalendarGrantCurrent(db, usable)) throw new CalendarAccessError();
  };
  await assertCurrent();
  return { grant: usable, assertCurrent };
}
