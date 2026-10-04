// ── Pure projection producers for the five visible Drive files ─────────────────
//
// SEAM. Lane B (read-only data source + routes) reads authoritative per-user and
// per-workspace rows and hands typed values here; this module maps those values
// to the exact bytes of `soul.md`, `memory.json`, `sessions.json`, `tasks.json`
// and `settings.json`. It then stops. Nothing in this file reads or writes: no
// database, no authority reader or writer, no OAuth, no route, no Drive
// transport, no appData and no backup logic. Every export is a pure function of
// its arguments, so the whole projection is testable without a server, a
// credential or a network.
//
// CONTRACT NOTE — stated rather than hidden. `server/drive-visible.ts` (PR #62)
// owns the PARSER for these files, but it is not on this branch's base
// (`dc8f8ec`) because #62 has not merged yet. The wire format below therefore
// mirrors #62 byte for byte: the schema comment and persona markers, two-space
// JSON terminated by exactly one newline, and the nine-key settings allowlist.
// A cross-contract check against #62 at `a851dd5` is recorded in the PR body.
// Once #62 lands, this module should import the shared format constants from it
// and DELETE the mirrored copies below rather than let the two drift apart.
//
// CREDENTIAL RULE. Output is built field by field from typed inputs, so a
// credential-shaped property an input happens to carry cannot reach a rendered
// file — it is never named, therefore never copied. `settings.json` is the one
// genuinely open input (an arbitrary upstream map), so it is filtered through an
// explicit allowlist and every dropped key is reported. Keys are what is
// filtered, never values: prose containing the word "state" is not a hit, only a
// field NAMED `state` is.
//
// The soul.md guards exist because that one format fails SILENTLY. A JSON
// document with a bad id is rejected by the parser at read time — loud. A soul
// body containing a persona marker line would be re-read as a second bot and the
// real content silently attached to it — data loss with no error anywhere. So
// the producer refuses to render it instead.

import { exportSoulMd, type BotPersonaFields } from "./soul-md.ts";

/** Mirrors the parser's schema version; bumped only by a deliberate format change. */
export const VISIBLE_SCHEMA_VERSION = 1;

export const VISIBLE_FILE_NAMES = {
  soul: "soul.md",
  memory: "memory.json",
  sessions: "sessions.json",
  tasks: "tasks.json",
  settings: "settings.json",
} as const;

export type VisibleFileKey = keyof typeof VISIBLE_FILE_NAMES;

export type VisibleFileName = (typeof VISIBLE_FILE_NAMES)[VisibleFileKey];

/** Refuses an input that would render a file the parser cannot read back cleanly. */
export class DriveProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DriveProjectionError";
  }
}

/** One bot's identity, already authorized by the caller. */
export interface SoulPersonaInput {
  botId: string;
  persona: BotPersonaFields;
}

// Marker shapes. These duplicate the parser's by necessity — see the contract
// note above. The persona id travels inside a marker line, so it must be a
// single non-empty token with no leading or trailing space; otherwise the
// boundary between two personas becomes ambiguous.
const PERSONA_ID = /^\S(?:.*\S)?$/;
const PERSONA_MARKER = /^<!-- muster-persona (.+) -->$/;
const PERSONA_BODY_MARKER = /^<!-- muster-body (.+) -->$/;

/**
 * Renders `soul.md` as editable Markdown: a schema comment, then one block per
 * bot made of a persona marker, a generated heading, an explicit body boundary,
 * and the bot's SOUL.md body verbatim.
 *
 * The boundary — not heading shape — is what locates the body, so a document
 * whose first real line happens to be `## <its own botId>` still round-trips:
 * it sits after the boundary and is content, never a heading the reader could
 * confuse with the one generated above it.
 *
 * Refuses rather than escapes a body line that reads as a marker. Escaping would
 * invent syntax a person editing the file has to know about; refusing makes the
 * failure loud at the point of the mistake instead of corrupting the next read.
 */
export function produceSoulMd(personas: readonly SoulPersonaInput[]): string {
  const seen = new Set<string>();
  let out = `<!-- muster-visible schemaVersion=${VISIBLE_SCHEMA_VERSION} -->\n`;

  for (const { botId, persona } of personas) {
    if (!PERSONA_ID.test(botId)) {
      throw new DriveProjectionError(
        `soul.md cannot render botId ${JSON.stringify(botId)}: an id must be a single non-empty ` +
          `token, because it is written inside a marker line and whitespace would make the ` +
          `persona boundary ambiguous`,
      );
    }
    if (seen.has(botId)) {
      throw new DriveProjectionError(
        `soul.md lists ${botId} more than once; two entries for one bot would silently ` +
          `overwrite each other on the next write, which is data loss rather than a merge`,
      );
    }
    seen.add(botId);

    const markdown = exportSoulMd(persona);
    for (const line of markdown.split("\n")) {
      if (PERSONA_MARKER.test(line)) {
        throw new DriveProjectionError(
          `${botId}'s soul body contains a line that reads as a persona marker (${line.trim()}); ` +
            `it would be restored as a second bot`,
        );
      }
      if (PERSONA_BODY_MARKER.test(line)) {
        throw new DriveProjectionError(
          `${botId}'s soul body contains a line that reads as a body boundary (${line.trim()}); ` +
            `it would truncate the body on the next read`,
        );
      }
    }

    out += `<!-- muster-persona ${botId} -->\n`;
    out += `## ${botId}\n`;
    out += "\n";
    out += `<!-- muster-body ${botId} -->\n`;
    out += markdown;
    out += "\n\n";
  }
  return out;
}

export interface MemoryTopicInput {
  name: string;
  text: string;
}

/** One bot's memory. Every field except `botId` is optional and has a stated default. */
export interface MemoryBotInput {
  botId: string;
  text?: string;
  truncated?: boolean;
  topics?: readonly MemoryTopicInput[];
}

/** Serializes `memory.json`. Absent optionals become their schema defaults, never `undefined`. */
export function produceMemoryJson(bots: readonly MemoryBotInput[]): string {
  const document = {
    schemaVersion: VISIBLE_SCHEMA_VERSION,
    kind: "memory",
    bots: bots.map((bot) => ({
      botId: bot.botId,
      text: bot.text ?? "",
      truncated: bot.truncated ?? false,
      topics: (bot.topics ?? []).map((topic) => ({ name: topic.name, text: topic.text })),
    })),
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** One message of a conversation. `role` is deliberately narrow: the parser enums it. */
export interface SessionMessageInput {
  id: string;
  role: "bot" | "user";
  at: number;
  kind?: string;
  text?: string;
  parentId?: string | null;
}

/** One thread of conversation history. */
export interface SessionThreadInput {
  threadId: string;
  title?: string;
  messages?: readonly SessionMessageInput[];
}

/** Serializes `sessions.json`. */
export function produceSessionsJson(threads: readonly SessionThreadInput[]): string {
  const document = {
    schemaVersion: VISIBLE_SCHEMA_VERSION,
    kind: "sessions",
    threads: threads.map((thread) => ({
      threadId: thread.threadId,
      title: thread.title ?? "",
      messages: (thread.messages ?? []).map((message) => ({
        id: message.id,
        role: message.role,
        kind: message.kind ?? "text",
        at: message.at,
        text: message.text ?? "",
        parentId: message.parentId ?? null,
      })),
    })),
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** One task row. `updatedAt` defaults to 0 because that is the parser's default. */
export interface TaskInput {
  id: string;
  title?: string;
  status?: string;
  updatedAt?: number;
}

/** Serializes `tasks.json`. */
export function produceTasksJson(tasks: readonly TaskInput[]): string {
  const document = {
    schemaVersion: VISIBLE_SCHEMA_VERSION,
    kind: "tasks",
    tasks: tasks.map((task) => ({
      id: task.id,
      title: task.title ?? "",
      status: task.status ?? "",
      updatedAt: task.updatedAt ?? 0,
    })),
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** Scalars a user preference may hold. Nothing else is representable in `settings.json`. */
export type SettingValue = string | number | boolean | null;

/**
 * The ONLY settings keys `settings.json` may carry. Deliberately tiny and
 * deliberately non-secret: these are user-facing preferences, never tokens,
 * providers or endpoints with embedded keys. Anything not listed is dropped and
 * named, so widening this list stays a visible, reviewed act rather than an
 * accidental leak. Mirrors PR #62's list — see the contract note above.
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
  settings: Record<string, SettingValue>;
  /** Dropped upstream keys, sorted — a drop is reported, never silent. */
  dropped: string[];
}

const ALLOWED_SETTING_KEYS = new Set<string>(SETTINGS_ALLOWLIST);

/**
 * Restricts arbitrary upstream settings to the allowlist.
 *
 * Non-allowlisted keys — credential-shaped or not — are dropped and named rather
 * than emitted, which is what makes the output safe by construction: a key that
 * is not on this list is never copied, so it cannot appear in the file. The
 * caller still learns what was thrown away, so filtering does not become
 * forgetting.
 */
export function projectSettings(upstream: Readonly<Record<string, SettingValue>>): SettingsProjection {
  const settings: Record<string, SettingValue> = {};
  const dropped: string[] = [];

  for (const [key, value] of Object.entries(upstream)) {
    if (ALLOWED_SETTING_KEYS.has(key)) settings[key] = value;
    else dropped.push(key);
  }
  return { settings, dropped: dropped.sort() };
}

function renderSettingsBody(settings: Record<string, SettingValue>): string {
  const document = { schemaVersion: VISIBLE_SCHEMA_VERSION, kind: "settings", settings };
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** Serializes `settings.json` from an arbitrary upstream map, allowlist applied. */
export function produceSettingsJson(upstream: Readonly<Record<string, SettingValue>>): string {
  return renderSettingsBody(projectSettings(upstream).settings);
}

/** The typed inputs lane B supplies. Every domain is optional; absent means empty. */
export interface VisibleFilesInput {
  personas?: readonly SoulPersonaInput[];
  memoryBots?: readonly MemoryBotInput[];
  threads?: readonly SessionThreadInput[];
  tasks?: readonly TaskInput[];
  settings?: Readonly<Record<string, SettingValue>>;
}

export interface VisibleFilesOutput {
  /** All five files, keyed by Drive file name, ready to hand to the writer. */
  files: Record<VisibleFileName, string>;
  /** Upstream settings keys the allowlist rejected, so the drop is never silent. */
  droppedSettings: string[];
}

/**
 * Produces the five visible files from typed, already-authorized inputs.
 *
 * All five are always present, including for empty input: the parser reads each
 * file independently and an absent file would read as "nothing to restore" when
 * the truth is "this workspace has no threads yet". Emitting an empty document
 * keeps those two states distinguishable.
 */
export function produceVisibleFiles(input: VisibleFilesInput): VisibleFilesOutput {
  const projection = projectSettings(input.settings ?? {});
  // `satisfies` rather than an annotated binding: the rule wants the concrete
  // five-key evidence kept and the contract checked against it, not erased.
  const files = {
    [VISIBLE_FILE_NAMES.soul]: produceSoulMd(input.personas ?? []),
    [VISIBLE_FILE_NAMES.memory]: produceMemoryJson(input.memoryBots ?? []),
    [VISIBLE_FILE_NAMES.sessions]: produceSessionsJson(input.threads ?? []),
    [VISIBLE_FILE_NAMES.tasks]: produceTasksJson(input.tasks ?? []),
    [VISIBLE_FILE_NAMES.settings]: renderSettingsBody(projection.settings),
  } satisfies Record<VisibleFileName, string>;
  return { files, droppedSettings: projection.dropped };
}
