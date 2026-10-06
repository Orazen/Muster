// Drive transport for the legacy local workspace bundle, using the app's
// private drive.appdata folder. Manual and Google-login token sources share
// this implementation. Sequential uploads update the newest matching file;
// these transport helpers do not provide cross-device synchronization or
// portable encryption. Hosted global workspace routes remain disabled.
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { driveSyncGeneration, loadConfig } from "./config.ts";
import { SyncPassInvalidatedError } from "./sync-pass.ts";

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

export class DriveSyncInvalidatedError extends SyncPassInvalidatedError {
  constructor(message = "Google Drive connection changed during the operation — check the connection and try again.") {
    super(message);
    this.name = "DriveSyncInvalidatedError";
  }
}

interface DriveAccessLifecycle {
  generation: number;
  refreshToken: string;
  signal: AbortSignal;
  assertCurrent(): Promise<void>;
}

let observedDriveGeneration = driveSyncGeneration();
let observedDriveController = new AbortController();
const accessTokenLifecycles = new Map<string, DriveAccessLifecycle>();

/** Keep all legacy installation Drive users on the same persisted epoch. */
export function observeDriveSyncGeneration(generation: number): void {
  if (generation === observedDriveGeneration) return;
  observedDriveController.abort(new DriveSyncInvalidatedError());
  observedDriveController = new AbortController();
  observedDriveGeneration = generation;
}

function captureConfiguredDriveLifecycle(refreshToken: string): DriveAccessLifecycle | null {
  if (loadConfig().driveSync?.refreshToken?.trim() !== refreshToken) return null;
  const generation = driveSyncGeneration();
  observeDriveSyncGeneration(generation);
  const controller = observedDriveController;
  const assertCurrent = async (): Promise<void> => {
    if (controller.signal.aborted) {
      const reason = controller.signal.reason;
      throw reason instanceof Error ? reason : new DriveSyncInvalidatedError();
    }
    const currentGeneration = driveSyncGeneration();
    observeDriveSyncGeneration(currentGeneration);
    if (currentGeneration !== generation || controller !== observedDriveController) throw new DriveSyncInvalidatedError();
    if (loadConfig().driveSync?.refreshToken?.trim() !== refreshToken) throw new DriveSyncInvalidatedError();
  };
  return { generation, refreshToken, signal: controller.signal, assertCurrent };
}

function mergedSignal(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return AbortSignal.any(present);
}

function driveRequestContext(
  accessToken: string,
  guard?: () => Promise<void>,
  signal?: AbortSignal,
) {
  const lifecycle = guard === undefined ? accessTokenLifecycles.get(accessToken) : undefined;
  return {
    async guard() {
      await lifecycle?.assertCurrent();
      await guard?.();
      signal?.throwIfAborted();
    },
    signal: mergedSignal(signal, lifecycle?.signal),
  };
}

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
export async function exchangeDriveCode(code: string, redirectUri: string, signal?: AbortSignal): Promise<DriveTokens> {
  if (!CLIENT_ID || !CLIENT_SECRET) throw new Error("Google OAuth is not configured on this deployment");
  signal?.throwIfAborted();
  let res: Response;
  try {
    res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
      signal: boundedSignal(signal, 15_000),
    });
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  }
  signal?.throwIfAborted();
  const data = tokenResponseSchema.safeParse(await res.json().catch(() => null));
  signal?.throwIfAborted();
  if (!res.ok || !data.success) throw new Error("Google rejected the authorization code");
  return {
    accessToken: data.data.access_token,
    refreshToken: data.data.refresh_token,
    expiresAt: data.data.expires_in ? Date.now() + data.data.expires_in * 1000 : undefined,
  };
}

/** Refresh an expired access token. */
export async function refreshDriveToken(
  refreshToken: string,
  signal?: AbortSignal,
  guard?: () => Promise<void>,
): Promise<DriveTokens> {
  if (!CLIENT_ID || !CLIENT_SECRET) throw new Error("Google OAuth is not configured on this deployment");
  const lifecycle = captureConfiguredDriveLifecycle(refreshToken);
  const combinedSignal = mergedSignal(signal, lifecycle?.signal);
  const assertCurrent = async () => {
    await lifecycle?.assertCurrent();
    await guard?.();
    signal?.throwIfAborted();
  };
  await assertCurrent();
  let res: Response;
  try {
    res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: "refresh_token",
      }),
      signal: boundedSignal(combinedSignal, 15_000),
    });
  } catch (error) {
    await assertCurrent();
    combinedSignal?.throwIfAborted();
    throw error;
  }
  await assertCurrent();
  const data = tokenResponseSchema.safeParse(await res.json().catch(() => null));
  await assertCurrent();
  if (!res.ok || !data.success) throw new Error("could not refresh the Drive token — reconnect Google Drive in Settings");
  if (lifecycle) accessTokenLifecycles.set(data.data.access_token, lifecycle);
  return { accessToken: data.data.access_token, refreshToken, expiresAt: data.data.expires_in ? Date.now() + data.data.expires_in * 1000 : undefined };
}

async function driveFetch(accessToken: string, url: string, init?: RequestInit, guard?: () => Promise<void>, signal?: AbortSignal): Promise<Response> {
  const request = driveRequestContext(accessToken, guard, signal);
  await request.guard();
  request.signal?.throwIfAborted();
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${accessToken}`);
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers,
      redirect: "error",
      signal: boundedSignal(request.signal, 60_000),
    });
  } catch (error) {
    await request.guard();
    request.signal?.throwIfAborted();
    throw error;
  }
  await request.guard();
  request.signal?.throwIfAborted();
  if (res.status === 401) throw new Error("Drive token expired — reconnect Google Drive in Settings");
  return res;
}

/** Upload (create or overwrite) the workspace bundle in the app folder. */
export async function uploadBundle(accessToken: string, payload: string, fileName = BUNDLE_NAME, guard?: () => Promise<void>, signal?: AbortSignal): Promise<{ id: string }> {
  const request = driveRequestContext(accessToken, guard, signal);
  guard = request.guard;
  signal = request.signal;
  const fileId = await findBundleFile(accessToken, fileName, guard, signal);
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
    guard,
    signal,
  );
  if (!res.ok) throw new Error(`Drive upload failed: HTTP ${res.status}`);
  const result = driveUploadSchema.safeParse(await res.json().catch(() => null));
  await guard();
  signal?.throwIfAborted();
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
export async function findBundleFile(accessToken: string, fileName = BUNDLE_NAME, guard?: () => Promise<void>, signal?: AbortSignal): Promise<string | null> {
  const request = driveRequestContext(accessToken, guard, signal);
  guard = request.guard;
  signal = request.signal;
  const query = new URLSearchParams({
    spaces: APPDATA_FOLDER, q: `name = '${fileName}' and trashed = false`,
    orderBy: "modifiedTime desc", pageSize: "100", fields: "files(id),nextPageToken,incompleteSearch",
  });
  const seenPages = new Set<string>();
  for (let page = 0; page < 10; page++) {
    const res = await driveFetch(accessToken, `${LIST_URL}?${query}`, undefined, guard, signal);
    if (!res.ok) throw new Error(`Drive list failed: HTTP ${res.status}`);
    const parsed = driveListSchema.safeParse(await res.json().catch(() => null));
    await guard();
    signal?.throwIfAborted();
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
export async function downloadBundle(accessToken: string, fileName = BUNDLE_NAME, guard?: () => Promise<void>, signal?: AbortSignal): Promise<string | null> {
  const request = driveRequestContext(accessToken, guard, signal);
  guard = request.guard;
  signal = request.signal;
  const fileId = await findBundleFile(accessToken, fileName, guard, signal);
  if (!fileId) return null;
  const res = await driveFetch(accessToken, `${FILE_URL}/${encodeURIComponent(fileId)}?alt=media`, undefined, guard, signal);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Drive download failed: HTTP ${res.status}`);
  const payload = await res.text();
  await guard();
  signal?.throwIfAborted();
  return payload;
}

function boundedSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([timeout, signal]) : timeout;
}

/** A file's identity for optimistic concurrency. Drive v3 has no If-Match
 * header, so `modifiedTime` is the strongest guard the API offers: callers
 * stat BEFORE download (so the guard predates the bytes they hold) and
 * re-stat BEFORE writing (so a stale guard cannot overwrite newer content).
 * The stat→write window that remains is real — see sync-wiring, which
 * documents it rather than pretending the header exists. */
export interface BundleFileStat {
  id: string;
  modifiedTime: string;
}

const driveStatSchema = z.object({
  files: z
    .array(z.object({ id: driveFileIdSchema, modifiedTime: z.string().min(1) }))
    .default([]),
}).strict();

export async function statBundleFile(
  accessToken: string,
  fileName = BUNDLE_NAME,
  guard?: () => Promise<void>,
  signal?: AbortSignal,
): Promise<BundleFileStat | null> {
  const request = driveRequestContext(accessToken, guard, signal);
  guard = request.guard;
  signal = request.signal;
  const query = new URLSearchParams({
    spaces: APPDATA_FOLDER,
    q: `name = '${fileName}' and trashed = false`,
    orderBy: "modifiedTime desc",
    pageSize: "1",
    fields: "files(id,modifiedTime)",
  });
  const res = await driveFetch(accessToken, `${LIST_URL}?${query}`, undefined, guard, signal);
  if (!res.ok) throw new Error(`Drive list failed: HTTP ${res.status}`);
  const parsed = driveStatSchema.safeParse(await res.json().catch(() => null));
  await guard();
  signal?.throwIfAborted();
  if (!parsed.success) throw new Error("Drive returned an unreadable file stat");
  const file = parsed.data.files[0];
  return file === undefined ? null : { id: file.id, modifiedTime: file.modifiedTime };
}

/** Immutable v2 backups each live in their own uniquely-named file. The suffix is
 * the upload's wall-clock time plus a random token so that two devices (or two
 * pushes from a stale device) can never collide onto the same file id. The dash
 * after `v2` also keeps these distinct from the legacy single `muster-workspace-v2.enc`
 * file in any Drive `name contains` query. */
const SNAPSHOT_PREFIX = "muster-workspace-v2-";
const SNAPSHOT_SUFFIX = ".enc";

/** A remote v2 snapshot, newest first by modified time. */
export interface SnapshotInfo {
  id: string;
  name: string;
  createdTime: string;
  size?: string;
}

const driveSnapshotUploadSchema = z.object({ id: driveFileIdSchema, name: z.string().min(1) });
const driveSnapshotListSchema = z.object({
  files: z.array(z.object({
    id: driveFileIdSchema,
    name: z.string().min(1),
    createdTime: z.string().min(1),
    size: z.string().optional(),
  })).default([]),
  nextPageToken: z.string().min(1).optional(),
  incompleteSearch: z.boolean().optional(),
  kind: z.literal("drive#fileList").optional(),
}).strict();

/** List immutable v2 backup snapshots, newest first. Excludes the legacy single
 * v2 file because its name lacks the `muster-workspace-v2-` snapshot suffix.
 * Paginates exactly like the bundle search and surfaces the same guard errors. */
export async function listSnapshots(
  accessToken: string,
  guard?: () => Promise<void>,
  signal?: AbortSignal,
): Promise<SnapshotInfo[]> {
  const request = driveRequestContext(accessToken, guard, signal);
  guard = request.guard;
  const query = new URLSearchParams({
    spaces: APPDATA_FOLDER,
    q: `name contains '${SNAPSHOT_PREFIX}' and trashed = false`,
    orderBy: "modifiedTime desc",
    pageSize: "100",
    fields: "files(id,name,createdTime,size),nextPageToken,incompleteSearch",
  });
  const seenPages = new Set<string>();
  const snapshots: SnapshotInfo[] = [];
  for (let page = 0; page < 10; page++) {
    const res = await driveFetch(accessToken, `${LIST_URL}?${query}`, undefined, guard, request.signal);
    if (!res.ok) throw new Error(`Drive list failed: HTTP ${res.status}`);
    const parsed = driveSnapshotListSchema.safeParse(await res.json().catch(() => null));
    await guard();
    if (!parsed.success) throw new Error("Drive returned an unreadable snapshot list");
    if (parsed.data.incompleteSearch) throw new Error("Drive could not complete the backup search — try again");
    for (const f of parsed.data.files) snapshots.push(f);
    const next = parsed.data.nextPageToken;
    if (!next) return snapshots;
    if (seenPages.has(next)) throw new Error("Drive repeated a snapshot page");
    seenPages.add(next);
    query.set("pageToken", next);
  }
  throw new Error("Drive snapshot search exceeded its page limit — try again");
}

/** Immutably upload a new v2 workspace snapshot — always creates a fresh file
 * (POST) and never updates or removes an existing one. A stale or empty device
 * therefore can never clobber the newest real backup; it merely becomes an
 * older snapshot that explicit restore selection can ignore. */
export async function uploadSnapshot(
  accessToken: string,
  payload: string,
  guard?: () => Promise<void>,
  signal?: AbortSignal,
): Promise<{ id: string; name: string }> {
  const request = driveRequestContext(accessToken, guard, signal);
  guard = request.guard;
  const name = `${SNAPSHOT_PREFIX}${Date.now()}-${randomBytes(4).toString("hex")}${SNAPSHOT_SUFFIX}`;
  const boundary = `muster-${randomBytes(8).toString("hex")}`;
  const body = [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    JSON.stringify({ name, parents: [APPDATA_FOLDER] }),
    `--${boundary}`,
    "Content-Type: application/octet-stream",
    "",
    payload,
    `--${boundary}--`,
  ].join("\r\n");
  const res = await driveFetch(
    accessToken,
    `${UPLOAD_URL}?uploadType=multipart&fields=id,name`,
    {
      method: "POST",
      headers: { "content-type": `multipart/related; boundary=${boundary}` },
      body,
    },
    guard,
    request.signal,
  );
  if (!res.ok) throw new Error(`Drive upload failed: HTTP ${res.status}`);
  const result = driveSnapshotUploadSchema.safeParse(await res.json().catch(() => null));
  await guard();
  if (!result.success) throw new Error("Drive returned an unreadable upload response");
  return { id: result.data.id, name: result.data.name };
}

/** Download a specific snapshot by its Drive file id (explicit restore). */
export async function downloadSnapshot(
  accessToken: string,
  snapshotId: string,
  guard?: () => Promise<void>,
  signal?: AbortSignal,
): Promise<string> {
  const request = driveRequestContext(accessToken, guard, signal);
  const res = await driveFetch(accessToken, `${FILE_URL}/${encodeURIComponent(snapshotId)}?alt=media`, undefined, request.guard, request.signal);
  if (res.status === 404) throw new Error("Snapshot not found");
  if (!res.ok) throw new Error(`Drive download failed: HTTP ${res.status}`);
  const payload = await res.text();
  await request.guard();
  return payload;
}

/** Retention's delete primitive (DESIGN §11's ladder needs one). A 404
 * resolves: the file being already gone IS the desired end state, so a
 * retried prune converges instead of failing on the first missing id. */
export async function deleteSnapshot(
  accessToken: string,
  snapshotId: string,
  guard?: () => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const request = driveRequestContext(accessToken, guard, signal);
  const res = await driveFetch(accessToken, `${FILE_URL}/${encodeURIComponent(snapshotId)}?fields=id`, { method: "DELETE" }, request.guard, request.signal);
  if (res.status === 404) return;
  if (!res.ok) throw new Error(`Drive delete failed: HTTP ${res.status}`);
}

/** Download the most recent snapshot (newest by modified time). Returns null
 * when no snapshot exists yet. Callers offering an explicit restore selection
 * should use listSnapshots + downloadSnapshot by chosen id instead. */
export async function downloadLatestSnapshot(
  accessToken: string,
  guard?: () => Promise<void>,
  signal?: AbortSignal,
): Promise<string | null> {
  const request = driveRequestContext(accessToken, guard, signal);
  const snapshots = await listSnapshots(accessToken, request.guard, request.signal);
  const latest = snapshots[0];
  if (!latest) return null;
  return downloadSnapshot(accessToken, latest.id, request.guard, request.signal);
}
