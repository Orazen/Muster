import type { DatabaseSync } from 'node:sqlite';
import { getDriveGrant, isDriveGrantCurrent, saveDriveGrant, type DriveGrant } from './drive-grants.ts';
import { DriveOAuthRefreshError, type GoogleDriveOAuthGrant, type GoogleDriveOAuthProvider } from './drive-oauth.ts';

export class DriveAccessError extends Error {
  readonly reconnectRequired: boolean;
  constructor(reconnectRequired = true) {
    super(reconnectRequired ? 'Reconnect Google Drive' : 'Google Drive is temporarily unavailable');
    this.reconnectRequired = reconnectRequired;
  }
}
const pending = new WeakMap<DatabaseSync, Map<string, Promise<GoogleDriveOAuthGrant>>>();

/** Session guards belong to each caller, never to the shared provider request. */
export async function getDriveAccess(db: DatabaseSync, userId: string,
  provider: Pick<GoogleDriveOAuthProvider, 'refresh'>, guard: () => Promise<void>,
): Promise<{ grant: DriveGrant; assertCurrent: () => Promise<void> }> {
  await guard();
  let grant = getDriveGrant(db, userId);
  if (!grant || !isDriveGrantCurrent(db, grant)) throw new DriveAccessError();
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
    let refreshed: GoogleDriveOAuthGrant;
    try { refreshed = await flight; }
    catch (error) {
      await guard();
      if (!isDriveGrantCurrent(db, original)) throw new DriveAccessError();
      throw new DriveAccessError(error instanceof DriveOAuthRefreshError && error.reconnectRequired);
    }
    await guard();
    if (refreshed.googleSub !== original.googleSub || refreshed.expiresAt <= Date.now()) throw new DriveAccessError();
    if (isDriveGrantCurrent(db, original)) {
      grant = saveDriveGrant(db, { ...refreshed, userId, expectedGeneration: original.generation });
    } else {
      // Another caller of this same flight may already have persisted its result.
      const saved = getDriveGrant(db, userId);
      if (!saved || saved.generation !== original.generation || saved.googleSub !== refreshed.googleSub
        || saved.accessToken !== refreshed.accessToken || saved.refreshToken !== (refreshed.refreshToken ?? original.refreshToken)
        || saved.expiresAt !== refreshed.expiresAt || JSON.stringify(saved.scopes) !== JSON.stringify(refreshed.scopes)
        || !isDriveGrantCurrent(db, saved)) throw new DriveAccessError();
      grant = saved;
    }
  }
  const usable = grant;
  const assertCurrent = async () => {
    await guard();
    if (usable.expiresAt <= Date.now() || !isDriveGrantCurrent(db, usable)) throw new DriveAccessError();
  };
  await assertCurrent();
  return { grant: usable, assertCurrent };
}
