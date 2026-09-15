// Drive transport for the legacy local workspace bundle, using the app's
// private drive.appdata folder. Manual and Google-login token sources share
// this implementation. Sequential uploads update the newest matching file;
// these transport helpers do not provide cross-device synchronization or
// portable encryption. Hosted global workspace routes remain disabled.
import { z } from "zod";
import { randomBytes } from "node:crypto";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files";
const LIST_URL = "https://www.googleapis.com/drive/v3/files";
const FILE_URL = "https://www.googleapis.com/drive/v3/files";
const APPDATA_FOLDER = "appDataFolder";
const BUNDLE_NAME = "muster-workspace.enc";
/** The portable v2 bundle keeps its own file so a v2 push never clobbers a
 * v1 backup the user may still need to restore on an older build. */
export const BUNDLE_V2_NAME = "muster-workspace-v2.enc";

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID?.trim() ?? "";
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET?.trim() ?? "";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.appdata";

/** Uses the same captured client configuration as token exchange/refresh. */
export function driveOAuthConfigured(): boolean {
  return Boolean(CLIENT_ID && CLIENT_SECRET);
}

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
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${accessToken}`);
  const res = await fetch(url, {
    ...init,
    headers,
    signal: AbortSignal.timeout(60_000),
  });
  if (res.status === 401) throw new Error("Drive token expired — reconnect Google Drive in Settings");
  return res;
}

/** Upload (create or overwrite) the workspace bundle in the app folder. */
export async function uploadBundle(accessToken: string, payload: string, fileName = BUNDLE_NAME): Promise<{ id: string }> {
  const fileId = await findBundleFile(accessToken, fileName);
  // Updating content must not try to move the file's parent folder.
  const metadata = JSON.stringify(fileId ? { name: fileName } : { name: fileName, parents: [APPDATA_FOLDER] });
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
  const res = await driveFetch(
    accessToken,
    fileId ? `${UPLOAD_URL}/${encodeURIComponent(fileId)}?uploadType=multipart&fields=id` : `${UPLOAD_URL}?uploadType=multipart&fields=id`,
    {
      method: fileId ? "PATCH" : "POST",
      headers: { "content-type": `multipart/related; boundary=${boundary}` },
      body,
    },
  );
  if (!res.ok) throw new Error(`Drive upload failed: HTTP ${res.status}`);
  const result = driveUploadSchema.safeParse(await res.json().catch(() => null));
  if (!result.success) throw new Error("Drive returned an unreadable upload response");
  if (fileId && result.data.id !== fileId) throw new Error("Drive returned a different backup file after updating it");
  return result.data;
}

const driveFileIdSchema = z.string().min(1)
  .refine((id) => id.trim() === id && id !== "." && id !== ".." && !/[\s/\\?#\p{Cc}]/u.test(id));
const driveUploadSchema = z.object({ id: driveFileIdSchema });
const driveListSchema = z.object({
  files: z.array(z.object({ id: driveFileIdSchema })).default([]),
  nextPageToken: z.string().min(1).optional(),
  incompleteSearch: z.boolean().optional(),
  kind: z.literal("drive#fileList").optional(),
}).strict();

/** Find the existing bundle file id, if any. */
export async function findBundleFile(accessToken: string, fileName = BUNDLE_NAME): Promise<string | null> {
  const query = new URLSearchParams({
    spaces: APPDATA_FOLDER, q: `name = '${fileName}' and trashed = false`,
    orderBy: "modifiedTime desc", pageSize: "100", fields: "files(id),nextPageToken,incompleteSearch",
  });
  const seenPages = new Set<string>();
  for (let page = 0; page < 10; page++) {
    const res = await driveFetch(accessToken, `${LIST_URL}?${query}`);
    if (!res.ok) throw new Error(`Drive list failed: HTTP ${res.status}`);
    const parsed = driveListSchema.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new Error("Drive returned an unreadable file list");
    if (parsed.data.incompleteSearch) throw new Error("Drive could not complete the backup search — try again");
    const fileId = parsed.data.files[0]?.id;
    if (fileId) return fileId;
    const next = parsed.data.nextPageToken;
    if (!next) return null;
    if (seenPages.has(next)) throw new Error("Drive repeated a backup search page");
    seenPages.add(next);
    query.set("pageToken", next);
  }
  throw new Error("Drive backup search exceeded its page limit — try again");
}

/** Download the bundle payload. Returns null when no bundle exists yet. */
export async function downloadBundle(accessToken: string, fileName = BUNDLE_NAME): Promise<string | null> {
  const fileId = await findBundleFile(accessToken, fileName);
  if (!fileId) return null;
  const res = await driveFetch(accessToken, `${FILE_URL}/${encodeURIComponent(fileId)}?alt=media`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Drive download failed: HTTP ${res.status}`);
  return await res.text();
}
