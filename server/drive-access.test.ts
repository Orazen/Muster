import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createDriveState, saveDriveGrant, getDriveGrant, disconnectDrive, DRIVE_APPDATA_SCOPE } from './drive-grants.ts';
import { getDriveAccess } from './drive-access.ts';
let db: DatabaseSync;
const guard = async () => {};
const original = { userId: 'alice', googleSub: 'google-a', accessToken: 'old', refreshToken: 'refresh', expiresAt: 1, scopes: [DRIVE_APPDATA_SCOPE], expectedGeneration: 1 };
const fresh = () => ({ ...original, accessToken: 'new', expiresAt: Date.now() + 3600_000 });
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE user(id TEXT PRIMARY KEY); INSERT INTO user VALUES ('alice'); CREATE TABLE account(accessToken TEXT); INSERT INTO account VALUES ('login-token')");
  createDriveState(db, { userId: 'alice', sessionId: 'session' });
  saveDriveGrant(db, original);
});
afterEach(() => db.close());
function deferred() {
  let resolve!: (value: ReturnType<typeof fresh>) => void;
  const refresh = vi.fn(() => new Promise<ReturnType<typeof fresh>>(r => { resolve = r; }));
  return { refresh, resolve: () => resolve(fresh()) };
}
it('shares refresh while preserving login tokens and allowing independent session guards', async () => {
  const provider = deferred();
  let active = true;
  const first = getDriveAccess(db, 'alice', provider, async () => { if (!active) throw new Error('logged out'); });
  const second = getDriveAccess(db, 'alice', provider, guard);
  await vi.waitFor(() => expect(provider.refresh).toHaveBeenCalledTimes(1));
  active = false;
  provider.resolve();
  await expect(first).rejects.toThrow('logged out');
  const access = await second;
  expect(access.grant.accessToken).toBe('new');
  expect(db.prepare('SELECT accessToken FROM account').get()?.accessToken).toBe('login-token');
  disconnectDrive(db, 'alice');
  await expect(access.assertCurrent()).rejects.toThrow('Reconnect');
});
it('returns the same persisted result to concurrent live sessions', async () => {
  const provider = deferred();
  const requests = [getDriveAccess(db, 'alice', provider, guard), getDriveAccess(db, 'alice', provider, guard)];
  await vi.waitFor(() => expect(provider.refresh).toHaveBeenCalledTimes(1));
  provider.resolve();
  const results = await Promise.all(requests);
  expect(results[0].grant).toEqual(results[1].grant);
});
it.each(['disconnect', 'consent'])('rejects refresh after %s without overwriting a new grant', async action => {
  const provider = deferred();
  const request = getDriveAccess(db, 'alice', provider, guard);
  await vi.waitFor(() => expect(provider.refresh).toHaveBeenCalledTimes(1));
  if (action === 'disconnect') disconnectDrive(db, 'alice');
  else {
    const state = createDriveState(db, { userId: 'alice', sessionId: 'session' });
    saveDriveGrant(db, { ...fresh(), accessToken: 'new-consent', expectedGeneration: state.generation });
  }
  provider.resolve();
  await expect(request).rejects.toThrow('Reconnect');
  expect(getDriveGrant(db, 'alice')?.accessToken).toBe(action === 'disconnect' ? undefined : 'new-consent');
});
it('leaves grant unchanged on failed refresh and permits retry', async () => {
  const before = getDriveGrant(db, 'alice');
  await expect(getDriveAccess(db, 'alice', { refresh: vi.fn().mockRejectedValue(new Error('PRIVATE')) }, guard)).rejects.toThrow('temporarily unavailable');
  expect(getDriveGrant(db, 'alice')).toEqual(before);
  expect((await getDriveAccess(db, 'alice', { refresh: vi.fn().mockResolvedValue(fresh()) }, guard)).grant.accessToken).toBe('new');
});
it('rejects old saved epochs before contacting Google and revalidates unexpired access', async () => {
  saveDriveGrant(db, fresh());
  const provider = { refresh: vi.fn() };
  const access = await getDriveAccess(db, 'alice', provider, guard);
  createDriveState(db, { userId: 'alice', sessionId: 'session' });
  await expect(access.assertCurrent()).rejects.toThrow('Reconnect');
  await expect(getDriveAccess(db, 'alice', provider, guard)).rejects.toThrow('Reconnect');
  expect(provider.refresh).not.toHaveBeenCalled();
});
it('refuses a refreshed Google identity change without changing stored credentials', async () => {
  const before = getDriveGrant(db, 'alice');
  await expect(getDriveAccess(db, 'alice', { refresh: async () => ({ ...fresh(), googleSub: 'google-b' }) }, guard)).rejects.toThrow('Reconnect');
  expect(getDriveGrant(db, 'alice')).toEqual(before);
});
it('never treats a basic login token as a Drive grant', async () => {
  disconnectDrive(db, 'alice');
  const provider = { refresh: vi.fn() };
  await expect(getDriveAccess(db, 'alice', provider, guard)).rejects.toThrow('Reconnect');
  expect(provider.refresh).not.toHaveBeenCalled();
  expect(db.prepare('SELECT accessToken FROM account').get()?.accessToken).toBe('login-token');
});
