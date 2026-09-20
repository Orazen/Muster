// Account Drive consent is separate from sign-in and Calendar credentials.
// Legacy login tokens are deliberately not migrated: their identity/scope was
// not verified by the old Drive callback. Users explicitly reconnect Drive.
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { uploadSnapshot, downloadLatestSnapshot, listSnapshots, downloadSnapshot, type SnapshotInfo } from "./drive-sync.ts";
import { getDriveGrant, isDriveGrantCurrent, createDriveState, saveDriveGrant, type DriveStateBinding, type DrivePendingState } from "./drive-grants.ts";
import { getDriveAccess } from "./drive-access.ts";
import { GoogleDriveOAuthProvider } from "./drive-oauth.ts";

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID?.trim() ?? "";
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET?.trim() ?? "";
export const DRIVE_CALLBACK_PATH = "/api/workspace/google/callback";
const subjectSchema = z.object({ id: z.string().min(1), accountId: z.string().min(1) });

function provider(origin: string) {
  return new GoogleDriveOAuthProvider({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: `${origin}${DRIVE_CALLBACK_PATH}` });
}

/** Only explicit, verified Drive consent counts as connected. */
export function googleTokensFor(db: DatabaseSync, userId: string) {
  const grant = getDriveGrant(db, userId);
  return grant && isDriveGrantCurrent(db, grant) ? { accessToken: grant.accessToken, refreshToken: grant.refreshToken, expiresAt: grant.expiresAt } : null;
}

export async function accountDriveAccess(db: DatabaseSync, userId: string, origin: string, guard: () => Promise<void>) {
  return getDriveAccess(db, userId, provider(origin), guard);
}

export function startDriveConsent(db: DatabaseSync, binding: DriveStateBinding, origin: string): string {
  const oauth = provider(origin);
  const pending = createDriveState(db, binding);
  return oauth.authorizationUrl(pending);
}

function googleIdentity(db: DatabaseSync, userId: string): { id: string; accountId: string } | null {
  const row = db.prepare(`SELECT id, accountId FROM account WHERE userId = ? AND providerId = 'google' ORDER BY createdAt DESC LIMIT 1`).get(userId);
  if (!row) return null;
  return subjectSchema.parse(row);
}

/** A different Google subject must never replace an existing sign-in identity.
 * Email-only users can grant Drive independently; the grant then pins its subject.
 * Recheck the exact login row and session after external work before persistence.
 */
export async function completeDriveConsent(db: DatabaseSync, binding: DriveStateBinding, pending: DrivePendingState,
  code: string, origin: string, guard: () => Promise<void>, oauth: Pick<GoogleDriveOAuthProvider, "exchange"> = provider(origin)): Promise<void> {
  await guard();
  if (pending.userId !== binding.userId || pending.sessionId !== binding.sessionId) throw new Error("Drive session changed");
  const expected = googleIdentity(db, binding.userId);
  const grant = await oauth.exchange(code, pending);
  await guard();
  const current = googleIdentity(db, binding.userId);
  if (JSON.stringify(current) !== JSON.stringify(expected) || (expected && grant.googleSub !== expected.accountId)) {
    throw new Error("Google Drive account does not match this sign-in");
  }
  saveDriveGrant(db, { ...grant, userId: binding.userId, expectedGeneration: pending.generation });
}

export async function drivePushFor(accessToken: string, payload: string, guard?: () => Promise<void>): Promise<string> {
  // Immutable v2 upload: always POST a fresh snapshot so a stale device can
  // never clobber the newest backup. The returned id is the snapshot's name.
  return (await uploadSnapshot(accessToken, payload, guard)).id;
}
export async function drivePullFor(accessToken: string, guard?: () => Promise<void>): Promise<string | null> {
  // Restore picks the newest snapshot by its Drive id (list + download-by-id),
  // so a stale later upload can never win simply by being newer.
  return downloadLatestSnapshot(accessToken, guard);
}
/** List the user's immutable v2 snapshots for explicit restore selection. */
export async function driveListSnapshotsFor(accessToken: string, guard?: () => Promise<void>): Promise<SnapshotInfo[]> {
  return listSnapshots(accessToken, guard);
}
/** Download a specific snapshot chosen by the user for restore. */
export async function driveDownloadSnapshotFor(accessToken: string, snapshotId: string, guard?: () => Promise<void>): Promise<string> {
  return downloadSnapshot(accessToken, snapshotId, guard);
}
