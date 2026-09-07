// Login-scoped Drive sync — the "Continue with Google IS the backup" path.
//
// When a user signs in with Google, better-auth stores the OAuth tokens in
// the account table. With drive.appdata now in the granted scope, those
// tokens can push/pull the encrypted workspace bundle directly — no second
// consent, no paste-a-code flow. This module reads those tokens, refreshes
// them via Google when expired, and runs the same encrypt/restore pipeline
// as the manual bundle (server/workspace-bundle.ts).
//
// Trust shape (unchanged): the bundle is client-side encrypted under the
// user's passphrase, so Drive and this server hold only ciphertext. The
// passphrase prompt still gates push/pull — the login grant authorizes
// STORAGE, not unencrypted reads.
import { randomBytes } from "node:crypto";

import type { DatabaseSync } from "node:sqlite";

import { z } from "zod";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files";
const LIST_URL = "https://www.googleapis.com/drive/v3/files";
const FILE_URL = "https://www.googleapis.com/drive/v3/files";
const BUNDLE_NAME = "muster-workspace.enc";

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID?.trim() ?? "";
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET?.trim() ?? "";

interface GoogleAccountTokens {
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: number | null;
}

/** Read the Google OAuth tokens better-auth persisted for this user. */
export function googleTokensFor(db: DatabaseSync, userId: string): GoogleAccountTokens | null {
  // SAFETY: better-auth's own account schema defines these columns; the
  // query is parameterized and every field is re-checked for type below.
  const row = db
    .prepare(
      `SELECT "accessToken", "refreshToken", "accessTokenExpiresAt" FROM "account"
       WHERE "userId" = ? AND "providerId" = 'google' ORDER BY "createdAt" DESC LIMIT 1`,
    )
    .get(userId) as { accessToken: string | null; refreshToken: string | null; accessTokenExpiresAt: string | number | null } | undefined;
  if (!row) return null;
  const expiresRaw = row.accessTokenExpiresAt;
  const expiresMs = expiresRaw ? new Date(expiresRaw).getTime() : null;
  return { accessToken: row.accessToken, refreshToken: row.refreshToken, expiresAt: expiresMs };
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().optional(),
});

/** Refresh the Google access token with the stored refresh token. */
export async function refreshGoogleToken(refreshToken: string): Promise<string> {
  if (!CLIENT_ID || !CLIENT_SECRET) throw new Error("Google OAuth is not configured on this deployment");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const parsed = tokenResponseSchema.safeParse(await res.json().catch(() => null));
  if (!res.ok || !parsed.success) throw new Error("could not refresh the Google session — sign in with Google again");
  return parsed.data.access_token;
}

/** A working access token for this user's Google account: reuse when fresh,
 * refresh when expired, or null when the user has no Google login. */
export async function accessTokenFor(db: DatabaseSync, userId: string): Promise<string | null> {
  const tokens = googleTokensFor(db, userId);
  if (!tokens?.refreshToken) return null;
  const fresh = tokens.accessToken && tokens.expiresAt && tokens.expiresAt - Date.now() > 60_000;
  if (fresh && tokens.accessToken) return tokens.accessToken;
  return await refreshGoogleToken(tokens.refreshToken);
}

async function driveFetch(accessToken: string, url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${accessToken}`, ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(60_000),
  });
  if (res.status === 401) throw new Error("Google session expired — sign in with Google again");
  return res;
}

const listSchema = z.object({ files: z.array(z.object({ id: z.string() })).default([]) });
const uploadSchema = z.object({ id: z.string() });

/** Push an encrypted payload into the user's Drive app folder. */
export async function drivePushFor(accessToken: string, payload: string): Promise<string> {
  const existingRes = await driveFetch(
    accessToken,
    `${LIST_URL}?spaces=appDataFolder&q=${encodeURIComponent(`name = '${BUNDLE_NAME}'`)}&fields=files(id)`,
  );
  const existing = listSchema.safeParse(await existingRes.json().catch(() => null));
  const fileId = existing.success && existing.data.files[0] ? existing.data.files[0].id : null;

  const metadata = JSON.stringify({ name: BUNDLE_NAME, parents: ["appDataFolder"] });
  const boundary = `muster-${randomBytes(8).toString("hex")}`;
  const body = [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    metadata,
    `--${boundary}`,
    "Content-Type: application/octet-stream",
    "",
    payload,
    `--${boundary}--`,
  ].join("\r\n");
  const url = fileId
    ? `${UPLOAD_URL}/${fileId}?uploadType=multipart&fields=id`
    : `${UPLOAD_URL}?uploadType=multipart&fields=id`;
  const res = await driveFetch(accessToken, url, {
    method: fileId ? "PATCH" : "POST",
    headers: { "content-type": `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!res.ok) throw new Error(`Drive upload failed: HTTP ${res.status}`);
  const out = uploadSchema.safeParse(await res.json().catch(() => null));
  return out.success ? out.data.id : "uploaded";
}

/** Pull the encrypted payload from the user's Drive app folder. Null when
 * the user has never pushed a bundle. */
export async function drivePullFor(accessToken: string): Promise<string | null> {
  const listRes = await driveFetch(
    accessToken,
    `${LIST_URL}?spaces=appDataFolder&q=${encodeURIComponent(`name = '${BUNDLE_NAME}'`)}&fields=files(id)`,
  );
  const list = listSchema.safeParse(await listRes.json().catch(() => null));
  const fileId = list.success && list.data.files[0] ? list.data.files[0].id : null;
  if (!fileId) return null;
  const res = await driveFetch(accessToken, `${FILE_URL}/${fileId}?alt=media`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Drive download failed: HTTP ${res.status}`);
  return await res.text();
}
