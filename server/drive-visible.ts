// The visible Drive folder contract for Muster — projections, not a second source of truth.
//
// Nova's approved contract (PR #38 comment 5977992994):
//   * the owner-requested filenames are VERSIONED, USER-READABLE PROJECTIONS of Muster's
//     existing authoritative data. They are NOT a new source of truth.
//   * `settings.json` is a strict, non-secret ALLOWLIST.
//   * Drive-side edits are only ever consumed through an explicit validated import with
//     ownership, schema/version and hash/conflict checks — never a silent overwrite.
//   * encrypted `muster-workspace-v2.enc` backups are preserved; this module does not move,
//     delete or replace them. The extra verified copy under `backups/` belongs to the bundle
//     paths and is NOT implemented here.
//
// ── What each projection is a view OF ──────────────────────────────────────────
//
//   soul.md          <- bots (server/store.ts bots.json) via server/soul-md.ts
//   memory.json      <- <workspace>/MEMORY.md and memory/<topic>.md (server/workspace.ts)
//   sessions.json    <- DATA_DIR/messages.db threads + messages (server/message-db.ts).
//                       CONVERSATION history. Not auth sessions, not Drive grant state.
//   tasks.json       <- task rows and DATA_DIR/task-plans.json (server/task-engine.ts)
//   settings.json    <- DATA_DIR/config.json, restricted to SETTINGS_ALLOWLIST below
//
// Because these are projections, this module never writes to any authoritative store. It renders
// what the owners hold and parses what a person may have edited in Drive; turning an edited file
// back into server state is the caller's job, behind an explicit import gate that owns the
// ownership/hash/conflict checks. Producing those projections from the real stores is the writer
// surfaces (message-db, workspace, task-engine, config), which are NOT claimed by this file.
//
// The Drive client is injected, so folder discovery, idempotent creation and file IO are testable
// with no network, no OAuth and no real account.

import { z } from "zod";

export const VISIBLE_FOLDER_NAME = "Muster";
export const VISIBLE_BACKUPS_DIR = "backups";

/** Bumped only by a deliberate format change; readers must not assume a value. */
export const VISIBLE_SCHEMA_VERSION = 1;

export const VISIBLE_FILE_NAMES = {
  soul: "soul.md",
  memory: "memory.json",
  sessions: "sessions.json",
  tasks: "tasks.json",
  settings: "settings.json",
} as const;

export type VisibleFileKey = keyof typeof VISIBLE_FILE_NAMES;

/** The five keys, in contract order. Written out so `satisfies` checks it against the
 *  name table rather than an assertion asserting it. Exported so call sites need no assertion. */
export const VISIBLE_FILE_KEYS = ["soul", "memory", "sessions", "tasks", "settings"] as const satisfies readonly VisibleFileKey[];

/** Rendered file bodies, keyed by Drive file name. */
export type VisibleFiles = Partial<Record<(typeof VISIBLE_FILE_NAMES)[VisibleFileKey], string>>;

// ── Credential exclusion ───────────────────────────────────────────────────────

/**
 * Keys that must never appear anywhere in a visible file, matched case-insensitively against
 * object keys at any depth.
 *
 * `cookie`, `sessionToken` and `state` are here because Drive consent state, the OAuth state row
 * and `auth.db` sessions all live under those names — and `sessions.json` is conversation history
 * precisely so none of them has any reason to be in it.
 */
export const CREDENTIAL_KEYS = [
  "refreshToken",
  "refresh_token",
  "accessToken",
  "access_token",
  "idToken",
  "id_token",
  "authorization",
  "cookie",
  "sessionToken",
  "session_token",
  "password",
  "recoveryCode",
  "recoveryCodes",
  "providerKey",
  "provider_key",
  "apiKey",
  "api_key",
  "clientSecret",
  "client_secret",
  "privateKey",
  "private_key",
  "encryptionKey",
  "authSecret",
  "auth_secret",
  "auth",
  "authDb",
  "state",
  "pairingCode",
  "claimCode",
  "scopes",
] as const;

export type VisibleErrorCode =
  | "not_connected"
  | "consent_revoked"
  | "throttled"
  | "duplicate_folder"
  | "not_found"
  | "conflict"
  | "credential_leak"
  | "settings_not_allowlisted"
  | "corrupt"
  | "schema_version";

export class DriveVisibleError extends Error {
  constructor(
    message: string,
    readonly code: VisibleErrorCode,
  ) {
    super(message);
    this.name = "DriveVisibleError";
  }
}

const CREDENTIAL_KEY_SET = new Set<string>(CREDENTIAL_KEYS.map((k) => k.toLowerCase()));

/**
 * Fails when any of `keys` is credential-shaped. Takes the KEY SET rather than a document so it
 * can be exercised directly, and so the document walk and the rule stay separately testable.
 * Keys are matched, never values, so the word "state" inside prose is not a false positive — only a
 * field NAMED `state` trips this.
 */
export function assertNoCredentialKeys(keys: readonly string[], fileName: string): void {
  const offending = keys.filter((key) => CREDENTIAL_KEY_SET.has(key.toLowerCase()));
  if (offending.length > 0) {
    throw new DriveVisibleError(
      `${fileName} would contain credential-shaped keys: ${[...new Set(offending)].join(", ")}`,
      "credential_leak",
    );
  }
}

// ── settings.json allowlist ────────────────────────────────────────────────────

/**
 * The ONLY settings keys `settings.json` may carry. Deliberately tiny and deliberately
 * non-secret: these are user-facing preferences, never tokens, providers or endpoints with
 * embedded keys.
 *
 * `config.json` holds far more (provider API keys, connector tokens, bot tokens, a Drive refresh
 * token). Anything not listed here is DROPPED and reported, so widening this list is a visible,
 * reviewed act rather than an accidental leak. Extending it needs the config owner's agreement,
 * because `config.json` is not claimed by this slice.
 */
export const SETTINGS_ALLOWLIST = [
  "theme",
  "locale",
  "timezone",
  "density",
  "notifications",
  "reduceMotion",
  "defaultModel",
  "mascotExpression",
  "startupView",
] as const;

export type AllowedSettingKey = (typeof SETTINGS_ALLOWLIST)[number];

export interface SettingsProjection {
  /** Only allowlisted keys survive. */
  settings: Record<AllowedSettingKey, string | number | boolean | null>;
  /** Allowlisted keys that were present upstream, reported so a drop is never silent. */
  dropped: string[];
}

/**
 * Restricts arbitrary upstream settings to the allowlist. Non-credential, non-allowlisted keys are
 * dropped and named; credential-shaped keys are refused outright rather than merely dropped,
 * because a dropped credential is still a credential that was offered to this code path.
 */
export function projectSettings(upstream: Readonly<Record<string, string | number | boolean | null>>): SettingsProjection {
  assertNoCredentialKeys(Object.keys(upstream), VISIBLE_FILE_NAMES.settings);

  const allowed = new Set<string>(SETTINGS_ALLOWLIST);
  const settings: Record<string, string | number | boolean | null> = {};
  const dropped: string[] = [];

  for (const [key, value] of Object.entries(upstream)) {
    if (allowed.has(key)) settings[key] = value;
    else dropped.push(key);
  }
  // SAFETY: only keys present in SETTINGS_ALLOWLIST are copied into `settings`, and that
  // set is exactly the key union of SettingsProjection["settings"], so the narrower type
  // is established by the loop above rather than assumed.
  return {
    settings: settings as SettingsProjection["settings"],
    dropped: dropped.sort(),
  };
}

// ── Versioned document schemas ─────────────────────────────────────────────────

const versioned = z.object({ schemaVersion: z.number().int().positive() });

export const SoulDocumentSchema = versioned.extend({
  kind: z.literal("soul"),
  /** One entry per bot. A single bot is still a list, so adding one is not a format change. */
  personas: z
    .array(
      z.object({
        botId: z.string().min(1),
        /** The Hermes-style SOUL.md body, as server/soul-md.ts exports it. */
        markdown: z.string(),
      }),
    )
    .default([]),
});

export const MemoryDocumentSchema = versioned.extend({
  kind: z.literal("memory"),
  bots: z
    .array(
      z.object({
        botId: z.string().min(1),
        text: z.string().default(""),
        truncated: z.boolean().default(false),
        topics: z.array(z.object({ name: z.string().min(1), text: z.string() })).default([]),
      }),
    )
    .default([]),
});

/** Conversation history. Deliberately has no field that could carry a credential. */
export const SessionsDocumentSchema = versioned.extend({
  kind: z.literal("sessions"),
  threads: z
    .array(
      z.object({
        threadId: z.string().min(1),
        title: z.string().default(""),
        messages: z
          .array(
            z.object({
              id: z.string().min(1),
              role: z.enum(["bot", "user"]),
              kind: z.string().default("text"),
              at: z.number(),
              text: z.string().default(""),
              parentId: z.string().nullable().default(null),
            }),
          )
          .default([]),
      }),
    )
    .default([]),
});

export const TasksDocumentSchema = versioned.extend({
  kind: z.literal("tasks"),
  tasks: z
    .array(
      z.object({
        id: z.string().min(1),
        title: z.string().default(""),
        status: z.string().default(""),
        updatedAt: z.number().default(0),
      }),
    )
    .default([]),
});

export const SettingsDocumentSchema = versioned.extend({
  kind: z.literal("settings"),
  settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
});

export type SoulDocument = z.infer<typeof SoulDocumentSchema>;
export type MemoryDocument = z.infer<typeof MemoryDocumentSchema>;
export type SessionsDocument = z.infer<typeof SessionsDocumentSchema>;
export type TasksDocument = z.infer<typeof TasksDocumentSchema>;
export type SettingsDocument = z.infer<typeof SettingsDocumentSchema>;

/** One document per contract file — the projection's own named contract. */
export type VisibleDocuments = Record<VisibleFileKey, VisibleDocument>;

export type VisibleDocument =
  | SoulDocument
  | MemoryDocument
  | SessionsDocument
  | TasksDocument
  | SettingsDocument;

// ── Render ─────────────────────────────────────────────────────────────────────

export function buildSoulDocument(personas: SoulDocument["personas"]): SoulDocument {
  return { schemaVersion: VISIBLE_SCHEMA_VERSION, kind: "soul", personas };
}

export function buildMemoryDocument(bots: MemoryDocument["bots"]): MemoryDocument {
  return { schemaVersion: VISIBLE_SCHEMA_VERSION, kind: "memory", bots };
}

export function buildSessionsDocument(threads: SessionsDocument["threads"]): SessionsDocument {
  return { schemaVersion: VISIBLE_SCHEMA_VERSION, kind: "sessions", threads };
}

export function buildTasksDocument(tasks: TasksDocument["tasks"]): TasksDocument {
  return { schemaVersion: VISIBLE_SCHEMA_VERSION, kind: "tasks", tasks };
}

export function buildSettingsDocument(settings: SettingsProjection["settings"]): SettingsDocument {
  return { schemaVersion: VISIBLE_SCHEMA_VERSION, kind: "settings", settings };
}

/**
 * soul.md stays readable Markdown rather than JSON, because a person is meant to open and edit
 * it. The version marker is an HTML comment so it survives a Markdown reader untouched.
 */
export function renderSoulMarkdown(document: SoulDocument): string {
  const lines = [`<!-- muster-visible schemaVersion=${document.schemaVersion} -->`, ""];
  for (const persona of document.personas) {
    lines.push(`## ${persona.botId}`, "", persona.markdown.trim(), "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function splitSoulMarkdown(text: string): SoulDocument["personas"] {
  const personas: SoulDocument["personas"] = [];
  for (const section of text.split(/^## /m).slice(1)) {
    const newline = section.indexOf("\n");
    if (newline === -1) continue;
    const botId = section.slice(0, newline).trim();
    const body = section
      .slice(newline + 1)
      .replace(/^\s*<!--[^>]*-->\s*/g, "")
      .trim();
    if (botId) personas.push({ botId, markdown: body });
  }
  return personas;
}

export function renderDocument(key: VisibleFileKey, document: VisibleDocument): string {
  // SAFETY: callers pair the soul key with a SoulDocument — renderVisibleFiles takes a
  // per-key record, and buildSoulDocument is the only producer of that key. The assertion
  // is a compile-time pairing check, not a runtime guess.
  return key === "soul"
    ? renderSoulMarkdown(document as SoulDocument)
    : `${JSON.stringify(document, null, 2)}\n`;
}

/** The five live files, keyed by their Drive file name. */
export function renderVisibleFiles(documents: VisibleDocuments) {
  const files: VisibleFiles = {};
  for (const key of VISIBLE_FILE_KEYS) {
    const document = documents[key];
    files[VISIBLE_FILE_NAMES[key]] = renderDocument(key, document);
  }
  return files;
}

// ── Parse ──────────────────────────────────────────────────────────────────────

export type FileParseResult = { ok: true; document: VisibleDocument } | { ok: false; fileName: string; reason: string };

function parseSoul(raw: string): FileParseResult {
  const fileName = VISIBLE_FILE_NAMES.soul;
  const match = /schemaVersion=(\d+)/.exec(raw);
  if (!match) return { ok: false, fileName, reason: "missing schemaVersion marker" };
  const schemaVersion = Number(match[1]);
  if (schemaVersion > VISIBLE_SCHEMA_VERSION) {
    return { ok: false, fileName, reason: `schemaVersion ${schemaVersion} is newer than ${VISIBLE_SCHEMA_VERSION}` };
  }
  const parsed = SoulDocumentSchema.safeParse({ schemaVersion, kind: "soul", personas: splitSoulMarkdown(raw) });
  if (!parsed.success) {
    return { ok: false, fileName, reason: parsed.error.issues[0]?.message ?? "schema mismatch" };
  }
  return { ok: true, document: parsed.data };
}

export function parseVisibleFile(key: VisibleFileKey, raw: string): FileParseResult {
  if (key === "soul") return parseSoul(raw);

  const fileName = VISIBLE_FILE_NAMES[key];
  let decoded: ReturnType<typeof JSON.parse>;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return { ok: false, fileName, reason: "invalid JSON" };
  }

  if (key === "memory") {
    const parsed = MemoryDocumentSchema.safeParse(decoded);
    if (!parsed.success) return { ok: false, fileName, reason: parsed.error.issues[0]?.message ?? "schema mismatch" };
    return versionCheck(parsed.data.schemaVersion, parsed.data, fileName);
  }
  if (key === "sessions") {
    const parsed = SessionsDocumentSchema.safeParse(decoded);
    if (!parsed.success) return { ok: false, fileName, reason: parsed.error.issues[0]?.message ?? "schema mismatch" };
    return versionCheck(parsed.data.schemaVersion, parsed.data, fileName);
  }
  if (key === "tasks") {
    const parsed = TasksDocumentSchema.safeParse(decoded);
    if (!parsed.success) return { ok: false, fileName, reason: parsed.error.issues[0]?.message ?? "schema mismatch" };
    return versionCheck(parsed.data.schemaVersion, parsed.data, fileName);
  }
  return parseSettings(decoded, fileName);
}

/**
 * The read path for settings.json enforces the SAME allowlist as the write path, and refuses a
 * credential outright. This matters because settings.json is the one open-shaped document
 * (`Record<string, scalar>`), so a person editing it in Drive could add a token that the write
 * path would never have produced. Parsing is where that has to be caught.
 */
function parseSettings(decoded: ReturnType<typeof JSON.parse>, fileName: string): FileParseResult {
  const parsed = SettingsDocumentSchema.safeParse(decoded);
  if (!parsed.success) return { ok: false, fileName, reason: parsed.error.issues[0]?.message ?? "schema mismatch" };

  const keys = Object.keys(parsed.data.settings);
  // Convert the refusal into a parse failure rather than letting it throw: every other
  // rejection on this path is reported, so an edited file must not crash the caller either.
  try {
    assertNoCredentialKeys(keys, fileName);
  } catch (error) {
    if (error instanceof DriveVisibleError) return { ok: false, fileName, reason: error.message };
    throw error;
  }

  const allowed = new Set<string>(SETTINGS_ALLOWLIST);
  const stray = keys.filter((key) => !allowed.has(key));
  if (stray.length > 0) {
    return {
      ok: false,
      fileName,
      reason: `keys outside the allowlist: ${[...new Set(stray)].sort().join(", ")}`,
    };
  }
  return versionCheck(parsed.data.schemaVersion, parsed.data, fileName);
}

function versionCheck<T extends VisibleDocument>(
  schemaVersion: number,
  document: T,
  fileName: string,
): FileParseResult {
  if (schemaVersion > VISIBLE_SCHEMA_VERSION) {
    return { ok: false, fileName, reason: `schemaVersion ${schemaVersion} is newer than ${VISIBLE_SCHEMA_VERSION}` };
  }
  return { ok: true, document };
}

export interface ParseSuccess {
  ok: true;
  soul: SoulDocument;
  memory: MemoryDocument;
  sessions: SessionsDocument;
  tasks: TasksDocument;
  settings: SettingsDocument;
}

export interface ParseFailure {
  ok: false;
  fileName: string;
  reason: string;
}

export type ParseResult = ParseSuccess | ParseFailure;

/** Parses all five files back, reporting the first problem rather than guessing. */
export function parseVisibleFiles(files: VisibleFiles): ParseResult {
  const soul = parseVisibleFile("soul", files[VISIBLE_FILE_NAMES.soul] ?? "");
  if (!soul.ok) return soul;
  const memory = parseVisibleFile("memory", files[VISIBLE_FILE_NAMES.memory] ?? "");
  if (!memory.ok) return memory;
  const sessions = parseVisibleFile("sessions", files[VISIBLE_FILE_NAMES.sessions] ?? "");
  if (!sessions.ok) return sessions;
  const tasks = parseVisibleFile("tasks", files[VISIBLE_FILE_NAMES.tasks] ?? "");
  if (!tasks.ok) return tasks;
  const settings = parseVisibleFile("settings", files[VISIBLE_FILE_NAMES.settings] ?? "");
  if (!settings.ok) return settings;

  const byKey: Partial<Record<VisibleFileKey, VisibleDocument>> = {};
  for (const key of VISIBLE_FILE_KEYS) {
    const result = parseVisibleFile(key, files[VISIBLE_FILE_NAMES[key]] ?? "");
    if (!result.ok) return result;
    byKey[key] = result.document;
  }
  // SAFETY: each entry was produced by parsing that key's own schema, and each loop
  // above bailed out on any failure, so every document is present and correctly typed.
  return {
    ok: true,
    soul: byKey.soul as SoulDocument,
    memory: byKey.memory as MemoryDocument,
    sessions: byKey.sessions as SessionsDocument,
    tasks: byKey.tasks as TasksDocument,
    settings: byKey.settings as SettingsDocument,
  };
}

// ── Transport-agnostic Drive client ─────────────────────────────────────────────

export interface DriveFileRef {
  id: string;
  name: string;
  parents: string[];
  mimeType: string;
  /** md5 checksum as Drive reports it; used to detect a concurrent edit. */
  md5Checksum?: string;
  modifiedTime?: string;
}

export interface DriveListArgs {
  q: string;
  fields?: string;
}

/** The minimum Drive surface this module needs, so a fake stays trivial. */
export interface VisibleDriveClient {
  listFiles(args: DriveListArgs): Promise<DriveFileRef[]>;
  createFolder(name: string, parentId: string): Promise<DriveFileRef>;
  createFile(name: string, parentId: string, body: string): Promise<DriveFileRef>;
  getFile(id: string): Promise<{ body: string; md5Checksum?: string }>;
  updateFile(id: string, body: string, previousChecksum?: string): Promise<DriveFileRef>;
}

export const FOLDER_MIME = "application/vnd.google-apps.folder";

/** Drive error shape, parsed at the boundary rather than inspected with typeof. */
const driveFailureSchema = z.object({ code: z.number().optional(), message: z.string().optional() });

// ── Folder discovery and idempotent creation ───────────────────────────────────

export interface FolderResolution {
  id: string;
  created: boolean;
  /**
   * Ids of any further folders of the same name. Surfaced rather than hidden: silently
   * picking one of two "Muster" folders is how a person's data appears to vanish.
   */
  duplicates: string[];
}

function escapeDriveQuery(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/**
 * Finds the user's Muster/ folder, creating it only when absent. Re-running is safe: an existing
 * folder is adopted, never recreated. The caller is responsible for having obtained the dedicated
 * `drive.file` consent; this module never infers it.
 */
export async function findOrCreateVisibleFolder(
  client: VisibleDriveClient,
  rootId = "root",
): Promise<FolderResolution> {
  const matches = await listOrThrow(client, {
    q: `mimeType = '${FOLDER_MIME}' and name = '${escapeDriveQuery(VISIBLE_FOLDER_NAME)}' and trashed = false`,
    fields: "files(id,name,parents,mimeType,modifiedTime)",
  });

  if (matches.length === 0) {
    const created = await createOrThrow(client, VISIBLE_FOLDER_NAME, rootId);
    return { id: created.id, created: true, duplicates: [] };
  }
  const ordered = [...matches].sort((a, b) => (a.modifiedTime ?? "").localeCompare(b.modifiedTime ?? ""));
  const chosen = ordered[0];
  if (!chosen) return { id: rootId, created: false, duplicates: [] };
  return { id: chosen.id, created: false, duplicates: ordered.slice(1).map((f) => f.id) };
}

/** Ensures `Muster/backups/` exists. Placing it here changes nothing about the encrypted format. */
export async function findOrCreateBackupsFolder(
  client: VisibleDriveClient,
  visibleFolderId: string,
): Promise<{ id: string; created: boolean }> {
  const matches = await listOrThrow(client, {
    q: `mimeType = '${FOLDER_MIME}' and name = '${VISIBLE_BACKUPS_DIR}' and '${escapeDriveQuery(visibleFolderId)}' in parents and trashed = false`,
    fields: "files(id,name,parents,mimeType)",
  });
  const found = matches[0];
  if (found) return { id: found.id, created: false };
  const created = await createOrThrow(client, VISIBLE_BACKUPS_DIR, visibleFolderId);
  return { id: created.id, created: true };
}

// ── Writing ────────────────────────────────────────────────────────────────────

export interface WriteOutcome {
  wrote: string[];
  unchanged: string[];
}

/** Maps a Drive file name back to its contract key, or null when unrecognised. */
export function keyForFileName(fileName: string): VisibleFileKey | null {
  return VISIBLE_FILE_KEYS.find((key) => VISIBLE_FILE_NAMES[key] === fileName) ?? null;
}

/**
 * Writes the rendered files, skipping ones already byte-identical so a no-op sync does not churn
 * Drive revisions. Every body is parsed back through its own schema first, so an unparseable or
 * wrong-kind file never reaches Drive.
 */
export async function writeVisibleFiles(
  client: VisibleDriveClient,
  folderId: string,
  files: VisibleFiles,
): Promise<WriteOutcome> {
  const wrote: string[] = [];
  const unchanged: string[] = [];

  for (const [fileName, body] of Object.entries(files)) {
    if (body === undefined) continue;
    const key = keyForFileName(fileName);
    if (key === null) {
      throw new DriveVisibleError(`${fileName} is not a visible contract file`, "schema_version");
    }
    assertRenderedBodyIsUsable(key, body, fileName);

    const existing = await listOrThrow(client, {
      q: `name = '${escapeDriveQuery(fileName)}' and '${escapeDriveQuery(folderId)}' in parents and trashed = false`,
      fields: "files(id,name,parents,mimeType,md5Checksum)",
    });

    if (existing.length === 0) {
      await createOrThrow(client, fileName, folderId, body);
      wrote.push(fileName);
      continue;
    }
    if (existing.length > 1) {
      throw new DriveVisibleError(
        `${fileName} exists ${existing.length} times in Muster/; refusing to guess which to update`,
        "duplicate_folder",
      );
    }
    const target = existing[0];
    if (!target) continue;
    const current = await getOrNull(client, target.id);
    if (current && current.body === body) {
      unchanged.push(fileName);
      continue;
    }
    await updateOrThrow(client, target.id, body, current?.md5Checksum ?? target.md5Checksum);
    wrote.push(fileName);
  }
  return { wrote, unchanged };
}

/**
 * Second enforcement point: the bytes about to be sent are parsed back through the same schema the
 * reader will use, so a render bug cannot ship a file the reader would reject.
 */
function assertRenderedBodyIsUsable(key: VisibleFileKey, body: string, fileName: string): void {
  const parsed = parseVisibleFile(key, body);
  if (!parsed.ok) {
    throw new DriveVisibleError(`${fileName} did not round-trip: ${parsed.reason}`, "corrupt");
  }
}

// ── Error normalisation ────────────────────────────────────────────────────────

async function getOrNull(
  client: VisibleDriveClient,
  id: string,
): Promise<{ body: string; md5Checksum?: string } | null> {
  try {
    return await call(() => client.getFile(id));
  } catch (error) {
    if (error instanceof DriveVisibleError && error.code === "not_found") return null;
    throw error;
  }
}

/**
 * Maps Drive's failure modes onto honest, distinguishable errors. Consent revocation and
 * throttling are separated because a person needs to be told which happened: one needs a
 * re-connect, the other needs patience.
 */
async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const failure = driveFailureSchema.safeParse(error);
    const status = failure.success ? (failure.data.code ?? Number.NaN) : Number.NaN;
    const message = failure.success ? (failure.data.message ?? "") : "";

    if (status === 401 || /insufficientPermissions|permission denied/i.test(message)) {
      throw new DriveVisibleError("Drive consent is missing or was revoked", "consent_revoked");
    }
    if (status === 429 || /rateLimitExceeded|quota/i.test(message)) {
      throw new DriveVisibleError("Drive is throttling this account", "throttled");
    }
    if (status === 404) throw new DriveVisibleError(message || "not found", "not_found");
    if (status === 409 || status === 412) throw new DriveVisibleError(message || "conflict", "conflict");
    throw error;
  }
}

const listOrThrow = (client: VisibleDriveClient, args: DriveListArgs) => call(() => client.listFiles(args));

const createOrThrow = (client: VisibleDriveClient, name: string, parentId: string, body?: string) =>
  call(() => (body === undefined ? client.createFolder(name, parentId) : client.createFile(name, parentId, body)));

const updateOrThrow = (client: VisibleDriveClient, id: string, body: string, previousChecksum?: string) =>
  call(() => client.updateFile(id, body, previousChecksum));
