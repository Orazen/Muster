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

/**
 * Persona boundary marker. A persona body is ordinary Markdown and may itself contain `## `
 * headings, so heading shape cannot delimit personas. Each persona is therefore introduced by this
 * comment line, which renders invisibly and is not something a hand-written document produces by
 * accident. Parsing starts a new persona ONLY at a marker, so internal headings stay in the body.
 *
 * Known limit, stated rather than hidden: a persona body containing this exact marker at column 0
 * would still be read as a boundary. Rendered output never produces one, and the round-trip tests
 * cover realistic bodies; a document hand-crafted to contain the marker is not defended against.
 */
const PERSONA_MARKER = /^<!-- muster-persona (.+) -->$/;

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

/**
 * A persona id must be a single non-empty token. It travels inside a marker line, so a newline or a
 * stray space would make the boundary ambiguous and could let one persona masquerade as two.
 * Duplicate ids are rejected because two entries for one bot would silently overwrite each other on
 * the next write, which is data loss rather than a merge.
 */
const PERSONA_ID = /^\S(?:.*\S)?$/;

export class DuplicatePersonaError extends DriveVisibleError {
  constructor(readonly botId: string) {
    super(`soul.md lists ${botId} more than once; two entries for one bot would silently overwrite each other`, "corrupt");
    this.name = "DuplicatePersonaError";
  }
}

export function assertPersonaIdsSane(personas: readonly SoulDocument["personas"][number][]): void {
  const seen = new Set<string>();
  for (const persona of personas) {
    if (!PERSONA_ID.test(persona.botId) || persona.botId.trim() === "") {
      throw new DriveVisibleError(`invalid persona id ${JSON.stringify(persona.botId)}`, "corrupt");
    }
    if (seen.has(persona.botId)) throw new DuplicatePersonaError(persona.botId);
    seen.add(persona.botId);
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

/**
 * UNKNOWN-KEY POLICY: these schemas are ordinary zod objects, so a key the reader does not know is
 * STRIPPED on parse rather than rejected. That is deliberate and safe in this direction: a person
 * adding `{"theme":"dark","apiKey":"sk-..."}` to settings.json cannot get the credential back out,
 * because `settings.json` additionally enforces the allowlist and refuses credentials outright
 * (see `parseSettings`), and for the other documents an unknown key is dropped before it can ever be
 * re-rendered. Stripping is therefore a privacy-preserving normalisation, not silent acceptance of
 * bad data: the value is never written back.
 */
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
/**
 * Byte-exact round-trip contract for soul.md.
 *
 * For each persona the renderer emits EXACTLY these five slots, newline-joined, and appends the
 * body verbatim with no trimming:
 *
 *     <!-- muster-persona ID -->
 *     ## ID
 *     <one blank line>
 *     <body, byte for byte>
 *     <one trailing blank line>
 *
 * The parser removes exactly what was added - the heading when it is the generated one, the blank
 * line that follows it, and one trailing blank line - and nothing else. No `trim()`, so leading
 * indentation, trailing spaces and blank lines inside the body survive unchanged. A body that would
 * not survive this contract is refused at render time rather than written lossy.
 *
 * Refusing marker-shaped lines (see `assertBodyIsRenderable`) is what keeps the contract total: a
 * literal marker in a body would otherwise read back as a second persona.
 */
export function renderSoulMarkdown(document: SoulDocument): string {
  assertPersonaIdsSane(document.personas);
  let out = `<!-- muster-visible schemaVersion=${document.schemaVersion} -->\n`;
  for (const persona of document.personas) {
    assertBodyIsRenderable(persona.botId, persona.markdown);
    out += `<!-- muster-persona ${persona.botId} -->\n`;
    out += `## ${persona.botId}\n`;
    out += "\n";
    out += persona.markdown;
    out += "\n\n";
  }
  return out;
}

/** A body containing a persona-marker line could never round-trip, so it is refused, not escaped. */
function assertBodyIsRenderable(botId: string, markdown: string): void {
  for (const line of markdown.split("\n")) {
    if (PERSONA_MARKER.test(line)) {
      throw new DriveVisibleError(
        `${botId}'s soul body contains a line that reads as a persona marker ` +
          `(${line.trim()}); it would be restored as a second bot`,
        "corrupt",
      );
    }
  }
}

/**
 * Splits on persona MARKERS, never on heading shape. Everything between two markers is that
 * persona's body verbatim — internal `## ` headings and fenced code included — except for the
 * decorative `## <botId>` heading this module writes, which is stripped so the round trip is exact.
 * Text before the first marker is ignored rather than guessed at.
 */
/**
 * Splits on persona MARKERS, never on heading shape, and removes exactly the lines the renderer
 * added so the body is returned byte for byte.
 *
 * Heading handling is deliberately narrow: the generated heading is removed ONLY when the first line
 * is exactly `## <the persona's own id>`. A person who deletes the generated heading keeps their real
 * first heading (`## Voice`) as content, instead of having it silently deleted.
 *
 * `strayContent` is returned so the caller can REJECT a document that has versioned, non-empty
 * content but no persona markers. That is malformed input, not an empty workspace, and reporting it as
 * `[]` would let a truncated or hand-mangled file read as "nothing to restore".
 */
/** Named so the round-trip contract is a stated type, not an anonymous shape. */
export interface SoulSplitResult {
  personas: SoulDocument["personas"];
  /** True when versioned content appeared outside any persona marker. */
  strayContent: boolean;
}

export function splitSoulMarkdownDetailed(text: string): SoulSplitResult {
  const personas: SoulDocument["personas"] = [];
  let currentBotId: string | null = null;
  let body: string[] = [];
  let strayContent = false;
  let seenMarker = false;

  const flush = (): void => {
    if (currentBotId === null) return;
    let rest = body;
    // Remove the generated heading only on an exact match with this persona's id.
    if (rest[0] === `## ${currentBotId}`) {
      rest = rest.slice(1);
      // The renderer put exactly one blank line after the heading.
      if (rest[0] === "") rest = rest.slice(1);
    }
    // The renderer put exactly one trailing blank line.
    if (rest.length > 0 && rest[rest.length - 1] === "") rest = rest.slice(0, -1);
    personas.push({ botId: currentBotId, markdown: rest.join("\n") });
    currentBotId = null;
    body = [];
  };

  // The renderer terminates the file with one newline. Removing that terminator FIRST is what
  // makes "drop exactly one trailing blank line" mean the generated one, rather than accidentally
  // consuming the terminator and leaving a stray newline attached to the body.
  const withoutTerminator = text.endsWith("\n") ? text.slice(0, -1) : text;

  for (const line of withoutTerminator.split("\n")) {
    const marker = PERSONA_MARKER.exec(line);
    if (marker?.[1]) {
      flush();
      seenMarker = true;
      currentBotId = marker[1].trim();
      continue;
    }
    if (currentBotId !== null) {
      body.push(line);
      continue;
    }
    // Before the first marker: the schema comment and blank lines are expected, anything else is stray.
    if (line.trim() === "") continue;
    if (!seenMarker && line.startsWith("<!-- muster-visible schemaVersion=")) continue;
    strayContent = true;
  }
  flush();
  return { personas, strayContent };
}

/** Convenience wrapper for callers that only want the personas. */
export function splitSoulMarkdown(text: string): SoulDocument["personas"] {
  return splitSoulMarkdownDetailed(text).personas;
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
  const { personas, strayContent } = splitSoulMarkdownDetailed(raw);
  // Versioned, non-empty content with no persona markers is MALFORMED. An intentionally empty
  // document is one that carries the version marker and nothing else, which parses to no personas.
  if (strayContent) {
    return {
      ok: false,
      fileName,
      reason: "content outside any persona marker; the document is malformed, not empty",
    };
  }
  try {
    assertPersonaIdsSane(personas);
  } catch (error) {
    if (error instanceof DriveVisibleError) return { ok: false, fileName, reason: error.message };
    throw error;
  }
  const parsed = SoulDocumentSchema.safeParse({ schemaVersion, kind: "soul", personas });
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
  /** Drive's creation timestamp. Selection between duplicate folders is based on this. */
  createdTime?: string;
  modifiedTime?: string;
}

export interface DriveListArgs {
  q: string;
  fields?: string;
}

/**
 * GUARANTEE BOUNDARY — read this before trusting a green test run.
 *
 * Everything this module guarantees is guaranteed **against the injected client**. Concretely, the
 * synthetic suite proves: folder selection is parent-scoped and deterministic; duplicate selection is
 * total; a stale revision is refused; a write with no revision evidence is refused; a file that did
 * not change is not rewritten; a partial write is reported with its progress.
 *
 * What it does NOT prove, because a fake cannot: that Google Drive actually enforces `md5Checksum`
 * preconditions (Drive v3 has no `If-Match`; it is emulated here), that its 412/404/429/401 statuses
 * are what the real API returns, that `in parents` and `root` behave as modelled, that a real
 * concurrent edit is actually caught, or that rate limits and consent revocation behave as modelled.
 * **None of this is real Drive acceptance, and none of it is real sync or restore.**
 */
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
  // The parent constraint is essential: without it this adopts a nested "Muster" folder that has
  // nothing to do with the selected parent, which is how a folder belonging to someone else, or to
  // a different account tree, gets adopted as the user's own.
  const matches = await listOrThrow(client, {
    q:
      `mimeType = '${FOLDER_MIME}' and name = '${escapeDriveQuery(VISIBLE_FOLDER_NAME)}'` +
      ` and '${escapeDriveQuery(rootId)}' in parents and trashed = false`,
    fields: "files(id,name,parents,mimeType,createdTime,modifiedTime)",
  });

  if (matches.length === 0) {
    const created = await createOrThrow(client, VISIBLE_FOLDER_NAME, rootId);
    return { id: created.id, created: true, duplicates: [] };
  }
  const ordered = orderForSelection(matches);
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

/**
 * Thrown when a multi-file write fails partway. The files already written are NOT rolled back -
 Drive has no transaction here - so the caller is told exactly how far it got, because a partial
 * Drive folder that is silently reported as "sync failed" is indistinguishable from one that never
 * started.
 */
export class PartialWriteError extends DriveVisibleError {
  constructor(
    message: string,
    readonly wrote: readonly string[],
    readonly cause: DriveVisibleError,
  ) {
    super(message, cause.code);
    this.name = "PartialWriteError";
  }
}

export interface WriteOptions {
  /**
   * Require a revision token (md5 checksum) before overwriting an existing file. Default true,
   * because Drive's v3 API has no `If-Match` and the ONLY protection against clobbering someone
   * else's edit is a conditional request. Setting this false opts out of conflict protection and must
   * be a deliberate choice by the caller.
   */
  requireRevisionEvidence?: boolean;
}

/**
 * Duplicate-folder selection rule, stated because "oldest" is otherwise ambiguous:
 *
 *  1. EARLIEST `createdTime` wins. `modifiedTime` is deliberately NOT used — a folder somebody just
 *     edited is not thereby the oldest, and ordering by it would pick a different folder depending
 *     on when the list was fetched.
 *  2. A folder with NO `createdTime` sorts AFTER every folder that has one. Unknown age is never
 *     preferred for "oldest".
 *  3. Remaining ties are broken by `id` ascending, so the result cannot depend on the order Drive
 *     happened to list the folders in.
 *
 * The returned list is in selection order, so `duplicates` is deterministic too.
 */
export function orderForSelection(files: readonly DriveFileRef[]): DriveFileRef[] {
  return [...files].sort((a, b) => {
    const aCreated = a.createdTime;
    const bCreated = b.createdTime;
    if (aCreated !== bCreated) {
      if (aCreated === undefined) return 1;
      if (bCreated === undefined) return -1;
      return aCreated.localeCompare(bCreated);
    }
    return a.id.localeCompare(b.id);
  });
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
  options: WriteOptions = {},
): Promise<WriteOutcome> {
  const wrote: string[] = [];
  const unchanged: string[] = [];
  const requireRevision = options.requireRevisionEvidence !== false;

  try {
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
      const current = await readCurrent(client, target.id, fileName);
      if (current && current.body === body) {
        unchanged.push(fileName);
        continue;
      }
      const revision = current?.md5Checksum ?? target.md5Checksum;
      if (revision === undefined && requireRevision) {
        // Writing with no revision token would be an unconditional overwrite. Reporting that as a
        // successful sync would claim conflict protection this call does not have.
        throw new DriveVisibleError(
          `${fileName} has no revision evidence (no md5 checksum), so it cannot be updated safely; ` +
            `refusing rather than overwriting unconditionally`,
          "conflict",
        );
      }
      await updateOrThrow(client, target.id, body, revision);
      wrote.push(fileName);
    }
  } catch (error) {
    if (error instanceof DriveVisibleError) {
      throw new PartialWriteError(
        wrote.length === 0
          ? `visible folder write failed before any file was written: ${error.message}`
          : `visible folder write failed after ${wrote.length} file(s) (${wrote.join(", ")}); they were NOT rolled back: ${error.message}`,
        wrote,
        error,
      );
    }
    throw error;
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

/**
 * Reads the current body, distinguishing "gone" from "present". A file that vanished between the
 * list and the read is NOT the same as one that is unchanged, and must not fall through to be
 * reported as a conflict or silently recreated over a race.
 */
async function readCurrent(
  client: VisibleDriveClient,
  id: string,
  fileName: string,
): Promise<{ body: string; md5Checksum?: string } | null> {
  try {
    return await call(() => client.getFile(id));
  } catch (error) {
    if (error instanceof DriveVisibleError && error.code === "not_found") {
      throw new DriveVisibleError(
        `${fileName} was listed but has since been deleted; refusing to write over a deletion race`,
        "not_found",
      );
    }
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
