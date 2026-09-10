// Google-login token source for the legacy local workspace transport.
// OAuth grants storage access; these helpers do not run automatic backups.
// Hosted v1 workspace routes remain disabled until account-scoped portable
// recovery is implemented and verified. Payload encryption lives elsewhere.
import type { DatabaseSync } from "node:sqlite";

import { z } from "zod";
import { uploadBundle, downloadBundle } from "./drive-sync.ts";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID?.trim() ?? "";
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET?.trim() ?? "";

interface GoogleAccountTokens {
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: number | null;
}

const googleAccountSchema = z.object({
  accessToken: z.string().nullable(),
  refreshToken: z.string().nullable(),
  accessTokenExpiresAt: z.union([z.string(), z.number()]).nullable(),
});

/** Read validated Google OAuth tokens belonging to this account. */
export function googleTokensFor(db: DatabaseSync, userId: string): GoogleAccountTokens | null {
  const row = db.prepare(
    `SELECT "accessToken", "refreshToken", "accessTokenExpiresAt" FROM "account"
     WHERE "userId" = ? AND "providerId" = 'google' ORDER BY "createdAt" DESC LIMIT 1`,
  ).get(userId);
  const parsed = googleAccountSchema.safeParse(row);
  if (!parsed.success) return null;
  const tokens = parsed.data;
  const expiry = tokens.accessTokenExpiresAt === null ? null : new Date(tokens.accessTokenExpiresAt).getTime();
  return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: expiry !== null && Number.isFinite(expiry) ? expiry : null };
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
  if (!tokens) return null;
  const fresh = tokens.accessToken && tokens.expiresAt && tokens.expiresAt - Date.now() > 60_000;
  if (fresh && tokens.accessToken) return tokens.accessToken;
  if (!tokens.refreshToken) return null;
  return await refreshGoogleToken(tokens.refreshToken);
}

/** Both token sources share one checked create/update/restore transport. */
export async function drivePushFor(accessToken: string, payload: string): Promise<string> {
  return (await uploadBundle(accessToken, payload)).id;
}

export async function drivePullFor(accessToken: string): Promise<string | null> {
  return downloadBundle(accessToken);
}
