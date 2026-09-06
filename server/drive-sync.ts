// Google Drive transport for the workspace bundle — drive.appdata scope
// (app-private folder, invisible in the user's Drive UI). One file:
// muster-workspace.enc. OAuth tokens come from the user completing
// Google's device-code or web flow out-of-band; Muster only stores the
// refresh token (write-only config) and talks to Drive's REST API.
//
// Server-side URL requests here go to exactly two validated https hosts:
// oauth2.googleapis.com and www.googleapis.com. Loopback/private/reserved
// targets are structurally impossible — the paths are fixed constants.
import { z } from "zod";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files";
const LIST_URL = "https://www.googleapis.com/drive/v3/files";
const FILE_URL = "https://www.googleapis.com/drive/v3/files";
const APPDATA_FOLDER = "appDataFolder";
const BUNDLE_NAME = "muster-workspace.enc";

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID?.trim() ?? "";
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET?.trim() ?? "";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.appdata";

/** The URL a user opens in a browser to grant Drive access. Muster shows
 * this in Settings; the resulting code is pasted back (OAuth device-lite
 * flow — no loopback listener needed). */
export function driveAuthUrl(redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: DRIVE_SCOPE,
    access_type: "offline",
    prompt: "consent",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

interface DriveTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
});

/** Trade an authorization code for tokens. */
export async function exchangeDriveCode(code: string, redirectUri: string): Promise<DriveTokens> {
  if (!CLIENT_ID || !CLIENT_SECRET) throw new Error("Google OAuth is not configured on this deployment");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = tokenResponseSchema.safeParse(await res.json().catch(() => null));
  if (!res.ok || !data.success) throw new Error("Google rejected the authorization code");
  return {
    accessToken: data.data.access_token,
    refreshToken: data.data.refresh_token,
    expiresAt: data.data.expires_in ? Date.now() + data.data.expires_in * 1000 : undefined,
  };
}

/** Refresh an expired access token. */
export async function refreshDriveToken(refreshToken: string): Promise<DriveTokens> {
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
  const data = tokenResponseSchema.safeParse(await res.json().catch(() => null));
  if (!res.ok || !data.success) throw new Error("could not refresh the Drive token — reconnect Google Drive in Settings");
  return { accessToken: data.data.access_token, refreshToken, expiresAt: data.data.expires_in ? Date.now() + data.data.expires_in * 1000 : undefined };
}

async function driveFetch(accessToken: string, url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${accessToken}`, ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(60_000),
  });
  if (res.status === 401) throw new Error("Drive token expired — reconnect Google Drive in Settings");
  return res;
}

/** Upload (create or overwrite) the workspace bundle in the app folder. */
export async function uploadBundle(accessToken: string, payload: string): Promise<{ id: string }> {
  const metadata = JSON.stringify({ name: BUNDLE_NAME, parents: [APPDATA_FOLDER] });
  const boundary = "muster-bundle-boundary";
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
  const res = await driveFetch(
    accessToken,
    `${UPLOAD_URL}?uploadType=multipart&fields=id`,
    {
      method: "POST",
      headers: { "content-type": `multipart/related; boundary=${boundary}` },
      body,
    },
  );
  if (!res.ok) throw new Error(`Drive upload failed: HTTP ${res.status}`);
  // SAFETY: Drive's upload response is JSON with the created file id; only
  // the id field is read.
  return (await res.json()) as { id: string };
}

const driveListSchema = z.object({
  files: z.array(z.object({ id: z.string(), name: z.string() })).default([]),
});

/** Find the existing bundle file id, if any. */
export async function findBundleFile(accessToken: string): Promise<string | null> {
  const res = await driveFetch(
    accessToken,
    `${LIST_URL}?spaces=appDataFolder&q=name%20%3D%20'${BUNDLE_NAME}'&fields=files(id,name)`,
  );
  if (!res.ok) throw new Error(`Drive list failed: HTTP ${res.status}`);
  const parsed = driveListSchema.safeParse(await res.json().catch(() => null));
  return parsed.success ? (parsed.data.files[0]?.id ?? null) : null;
}

/** Download the bundle payload. Returns null when no bundle exists yet. */
export async function downloadBundle(accessToken: string): Promise<string | null> {
  const fileId = await findBundleFile(accessToken);
  if (!fileId) return null;
  const res = await driveFetch(accessToken, `${FILE_URL}/${fileId}?alt=media`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Drive download failed: HTTP ${res.status}`);
  return await res.text();
}
