// Google-login token source for the legacy local workspace transport.
// OAuth grants storage access; these helpers do not run automatic backups.
// Hosted v1 workspace routes remain disabled until account-scoped portable
// recovery is implemented and verified. Payload encryption lives elsewhere.
import type { DatabaseSync } from "node:sqlite";
import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";
import { uploadBundle, downloadBundle, BUNDLE_V2_NAME } from "./drive-sync.ts";
import { deploymentSigningSecret } from "./auth.ts";

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
});/** Refresh the Google access token and persist it on the account row so the
 * next operation reuses it instead of paying Google a fresh grant. */
async function refreshGoogleToken(db: DatabaseSync, userId: string, refreshToken: string): Promise<string> {
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
  db.prepare(
    `UPDATE "account" SET "accessToken" = ?, "accessTokenExpiresAt" = ?, "updatedAt" = ?
     WHERE "userId" = ? AND "providerId" = 'google'`,
  ).run(
    parsed.data.access_token,
    parsed.data.expires_in ? new Date(Date.now() + parsed.data.expires_in * 1000).toISOString() : null,
    new Date().toISOString(),
    userId,
  );
  return parsed.data.access_token;
}

/** A working access token for this user's Google account: reuse when fresh,
 * refresh — and persist the refresh — when expired, or null when the user has
 * no Google login. */
export async function accessTokenFor(db: DatabaseSync, userId: string): Promise<string | null> {
  const tokens = googleTokensFor(db, userId);
  if (!tokens) return null;
  const fresh = tokens.accessToken && tokens.expiresAt && tokens.expiresAt - Date.now() > 60_000;
  if (fresh && tokens.accessToken) return tokens.accessToken;
  if (!tokens.refreshToken) return null;
  return await refreshGoogleToken(db, userId, tokens.refreshToken);
}

/** Both token sources share one checked create/update/restore transport.
 * The account transport moves the portable v2 bundle: a Google-login backup
 * must never clobber the manual connection's v1 file, which an older build
 * may still need for its own restore flow. */
export async function drivePushFor(accessToken: string, payload: string): Promise<string> {
  return (await uploadBundle(accessToken, payload, BUNDLE_V2_NAME)).id;
}

export async function drivePullFor(accessToken: string): Promise<string | null> {
  return downloadBundle(accessToken, BUNDLE_V2_NAME);
}

// ── opt-in Drive connect ─────────────────────────────────────────────────
// Sign-in is deliberately basic-scope (see auth.ts): drive.appdata is a
// restricted scope and requesting it at login shows every new user Google's
// unverified-app interstitial. Backup therefore asks for Drive as its own
// explicit grant — same client, same account row, one click in settings.

const DRIVE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const DRIVE_CALLBACK_PATH = "/api/workspace/google/callback";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.appdata";

/** The consent URL for the separate Drive grant. `origin` is this
 * deployment's own https origin — it decides the redirect_uri, so Google's
 * client must list `${origin}${DRIVE_CALLBACK_PATH}`. */
export function googleDriveAuthUrl(origin: string, state: string): string {
  if (!CLIENT_ID || !CLIENT_SECRET) throw new Error("Google OAuth is not configured on this deployment");
  const url = new URL(DRIVE_AUTH_URL);
  url.search = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: `${origin}${DRIVE_CALLBACK_PATH}`,
    response_type: "code",
    scope: DRIVE_SCOPE,
    access_type: "offline",
    prompt: "consent",
    state,
  }).toString();
  return url.toString();
}

/** State = userId.issued.mac — binds the callback to the requesting account
 * and expires in ten minutes. */
export function signDriveState(userId: string, now = Date.now()): string {
  const issued = now.toString();
  const mac = createHmac("sha256", deploymentSigningSecret()).update(`${userId}.${issued}`).digest("base64url");
  return `${userId}.${issued}.${mac}`;
}

export function verifyDriveState(state: string): string | null {
  const parts = state.split(".");
  if (parts.length !== 3) return null;
  const [userId, issued, mac] = parts;
  const age = Date.now() - Number(issued);
  if (!userId || !Number.isFinite(age) || age < 0 || age > 10 * 60_000) return null;
  const expected = createHmac("sha256", deploymentSigningSecret()).update(`${userId}.${issued}`).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b) ? userId : null;
}

const driveCodeResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().optional(),
});
const googleAccountIdSchema = z.object({ id: z.string() });

/** Trade the consent code for tokens and store them on the user's existing
 * google account row. False when no such row exists — Drive connects to an
 * account, it does not create one. */
export async function connectDriveFor(db: DatabaseSync, userId: string, code: string, origin: string): Promise<boolean> {
  if (!CLIENT_ID || !CLIENT_SECRET) throw new Error("Google OAuth is not configured on this deployment");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: `${origin}${DRIVE_CALLBACK_PATH}`,
      grant_type: "authorization_code",
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const parsed = driveCodeResponseSchema.safeParse(await res.json().catch(() => null));
  if (!res.ok || !parsed.success) throw new Error("Google refused the Drive connection — try connecting again");
  const row = db.prepare(
    `SELECT id FROM "account" WHERE "userId" = ? AND "providerId" = 'google' ORDER BY "createdAt" DESC LIMIT 1`,
  ).get(userId);
  const account = googleAccountIdSchema.safeParse(row);
  if (!account.success) return false;
  const expiresAt = parsed.data.expires_in
    ? new Date(Date.now() + parsed.data.expires_in * 1000).toISOString()
    : null;
  db.prepare(
    `UPDATE "account" SET "accessToken" = ?, "refreshToken" = COALESCE(?, "refreshToken"),
     "accessTokenExpiresAt" = ?, "updatedAt" = ? WHERE "id" = ?`,
  ).run(parsed.data.access_token, parsed.data.refresh_token ?? null, expiresAt, new Date().toISOString(), account.data.id);
  return true;
}
