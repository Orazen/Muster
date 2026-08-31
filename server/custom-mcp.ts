// Custom MCP servers — user-registered stdio servers (Settings → MCP Servers).
// Validation, registry invariants, and the secret-redaction wire shape.
import { z } from "zod";

import { schemaIssue } from "./schema.ts";

/** Shape persisted under the `mcpServers` key of ~/.muster/config.json. */
export interface CustomMcpServer {
  id: string;
  /** CLI-safe label: becomes the MCP server key drivers mount (`mcp__<name>`
   * for Claude, the ACP server name, the OpenAI tool-source prefix). */
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
  /** Bot ids this server mounts for. Absent = every bot (workspace-global). */
  bots?: string[];
}

/** What GET /api/mcp-servers returns and what a save accepts for `env`:
 * each key maps to `true`, meaning "unchanged — keep the stored value".
 * Why: env values are credentials; the renderer learns WHICH variables are
 * set, never what they hold, and echoing `true` back renames a server
 * without its secrets ever having been in the browser. */
export type RedactedEnv = Record<string, boolean>;

export interface CustomMcpServerWire extends Omit<CustomMcpServer, "env"> {
  env: RedactedEnv;
}

const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Bare executable names only: letters, digits, dot, underscore, dash.
const BARE_COMMAND_PATTERN = /^[A-Za-z0-9._-]+$/;

export class McpConfigError extends Error {}

function fail(message: string): never {
  throw new McpConfigError(message);
}

// What: decide whether a command string is safe to hand to spawn(shell:false).
// Why: these entries run arbitrary binaries by design — the risks left to
// police are ambiguity, not execution: a relative path silently resolving
// against whatever cwd a turn happens to run in, or a spaced/metacharacter
// string whose argv split differs from what the user pictured. Absolute
// paths may contain spaces; bare names may contain nothing but name
// characters, because PATH lookup is the ONLY thing that will happen to them.
export function validateMcpCommand(command: string): void {
  const trimmed = command.trim();
  if (!trimmed) fail("command is required");
  if (/\r|\n/.test(trimmed) || trimmed.includes("\u0000")) fail("command must not contain control characters");
  const isAbsolute = trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith("\\\\");
  const hasSeparator = /[\\/]/.test(trimmed);
  if (isAbsolute) return;
  if (hasSeparator) fail(`"${trimmed}" is a relative path — use an absolute path or a bare command name`);
  if (!BARE_COMMAND_PATTERN.test(trimmed)) {
    fail(`"${trimmed}" is not a plain command name — use an absolute path (spaces allowed there)`);
  }
  if (trimmed === "." || trimmed === "..") fail("command must name an executable, not a directory");
}

// Validate one entry's editable fields; throws McpConfigError with a
// user-readable message. id/persistence concerns stay with callers.
export function validateParsedCustomMcp(input: ParsedCustomMcpInput): void {
  if (!NAME_PATTERN.test(input.name.trim())) {
    fail("name must be 1-64 characters: letters, digits, dash, underscore (start with a letter or digit)");
  }
  for (const key of Object.keys(input.env)) {
    // checked here, not in the record schema: this zod's record() does not
    // apply a key schema to object keys
    if (!ENV_KEY_PATTERN.test(key)) fail(`env key "${key}" is not a valid variable name`);
  }
  validateMcpCommand(input.command);
  if (input.args.length > 64) fail("too many args (max 64)");
  for (const arg of input.args) {
    if (/\r|\n/.test(arg) || arg.includes("\u0000")) fail("args must not contain control characters");
  }
  if (input.bots?.some((b) => !b.trim())) fail("bots must be an array of bot ids");
}

/** One entry as it crosses the HTTP/persistence boundary — strings already,
 * domain rules not yet applied. */
export interface ParsedCustomMcpInput {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  bots?: string[];
}

// The single parse boundary every save passes through: shape comes from the
// schema, meaning from validateParsedCustomMcp. Hand-edited JSON and hostile
// request bodies meet the exact same two gates.
const mcpServerInputSchema = z.object({
  name: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  env: z.record(z.string(), z.string()),
  bots: z.array(z.string()).optional(),
});

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function IS the I/O boundary parser; raw is its named contract
export function parseAndValidateCustomMcp(raw: unknown): ParsedCustomMcpInput {
  const parsed = mcpServerInputSchema.safeParse(raw);
  if (!parsed.success) throw new McpConfigError(schemaIssue(parsed.error, "Invalid MCP server entry"));
  validateParsedCustomMcp(parsed.data);
  return parsed.data;
}

export type UpsertResult = { ok: true; next: CustomMcpServer[] } | { ok: false; error: string };

// Insert or replace one server inside the stored list, enforcing the two
// invariants that must hold across the whole registry: stable identity
// (the id routes; the name is an editable label) and globally unique names
// (the agent addresses a server by name, so a collision would make one of
// them silently win). Refused at save time, where the error is readable.
export function upsertCustomMcpServer(
  list: CustomMcpServer[],
  incoming: ParsedCustomMcpInput & { id: string; enabled: boolean },
): UpsertResult {
  try {
    validateParsedCustomMcp(incoming);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const nameClash = list.find((s) => s.id !== incoming.id && s.name === incoming.name.trim());
  if (nameClash) return { ok: false, error: `a server named "${incoming.name}" already exists` };
  const normalized: CustomMcpServer = {
    id: incoming.id,
    name: incoming.name.trim(),
    command: incoming.command.trim(),
    args: incoming.args,
    env: incoming.env,
    enabled: incoming.enabled,
  };
  const bots = incoming.bots?.map((b) => b.trim()).filter(Boolean);
  if (bots?.length) normalized.bots = [...new Set(bots)];
  const exists = list.some((s) => s.id === incoming.id);
  const next = exists ? list.map((s) => (s.id === incoming.id ? normalized : s)) : [...list, normalized];
  return { ok: true, next };
}

export function removeCustomMcpServer(list: CustomMcpServer[], id: string): CustomMcpServer[] {
  return list.filter((s) => s.id !== id);
}

export function toWire(server: CustomMcpServer): CustomMcpServerWire {
  const env: RedactedEnv = {};
  for (const key of Object.keys(server.env)) env[key] = true;
  return { ...server, env };
}

/** Env values exactly as they may arrive over the wire: kept-secrets as
 * booleans, fresh values as strings. */
export type WireEnvPatch = Record<string, boolean | string>;

const wireEnvPatchSchema = z.record(z.string(), z.union([z.boolean(), z.string()]));

// Rebuild a full env from a wire-shaped patch: a real string sets/replaces
// the value, `true` keeps whatever was stored under that key.
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- same boundary-parser contract as parseAndValidateCustomMcp
export function parseWireEnvPatch(raw: unknown): WireEnvPatch {
  const parsed = wireEnvPatchSchema.safeParse(raw);
  if (!parsed.success) throw new McpConfigError(schemaIssue(parsed.error, "env must map variable names to strings or true"));
  return parsed.data;
}

export function mergeWireEnv(wireEnv: WireEnvPatch, stored: Record<string, string>) {
  return Object.fromEntries(
    // SAFETY: entries are typed by WireEnvPatch; String() only restates the
    // string half of the union after the `true` branch takes kept secrets.
    Object.entries(wireEnv).map(([key, value]): [string, string] => [key, value === true ? (stored[key] ?? "") : String(value)]),
  );
}

// Which configured servers mount for this bot on this turn: enabled ones,
// scoped to every bot unless they name their audience.
export function customMcpForBot(
  servers: CustomMcpServer[] | undefined,
  botId: string,
): Array<{ name: string; command: string; args: string[]; env: Record<string, string> }> {
  return (servers ?? [])
    .filter((s) => s.enabled && (!s.bots || s.bots.includes(botId)))
    .map((s) => ({ name: s.name, command: s.command, args: [...s.args], env: { ...s.env } }));
}

// Zod face of the persisted shape — config.json parses through it on load,
// so a hand-edited file fails cleanly at startup instead of smuggling an
// unvalidated command into a spawn.
export const customMcpServerSchema = z.object({
  id: z.string().min(1),
  name: z.string().regex(NAME_PATTERN),
  command: z.string().min(1),
  args: z.array(z.string()),
  env: z.record(z.string(), z.string()),
  enabled: z.boolean(),
  bots: z.array(z.string().min(1)).optional(),
});
