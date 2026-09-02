// Config + data dirs. One file, ~/.muster/config.json, env fallbacks:
//   { "xai": {"key":"xai-…"}, "composio": {"apiKey":"ak_…"}, "box": {"token":"…"},
//     "instances": { "<instanceId>": {"driver":"grok", …} } }
import { readFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { customMcpServerSchema, type CustomMcpServer } from "./custom-mcp.ts";
import {
  customProviderInstances,
  customProviderSchema,
  type CustomProvider,
} from "./custom-providers.ts";
import type { InstanceConfigMap } from "./contracts.ts";
import { parseJson, schemaIssue, type JsonObject, type JsonValue } from "./schema.ts";

const optionalText = z.string().optional();
export type LocalVmIsolationMode = "shared" | "perBot";
// The cap bounds keep a per-bot fleet from silently eating the host: 16
// desktops x 4 GB is already the RAM of a well-appointed machine.
const LOCAL_VM_MAX_INSTANCES_MIN = 1;
const LOCAL_VM_MAX_INSTANCES_MAX = 16;
/** Channel turn cap bounds, in minutes. One minute is the shortest useful
 * ceiling; two hours covers a long unattended build without pinning a bot
 * forever if its driver wedges. */
const CHANNEL_TURN_CAP_MIN_MINUTES = 1;
const CHANNEL_TURN_CAP_MAX_MINUTES = 120;
const DEFAULT_CHANNEL_TURN_CAP_MINUTES = 5;
const instanceConfigSchema = z.object({
  driver: z.string().min(1),
  displayName: optionalText,
  accentColor: optionalText,
  environment: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
  config: z.json().optional(),
});
const instanceConfigMapSchema = z.record(z.string(), instanceConfigSchema);
// Metadata half of a BYOK custom provider (server/custom-providers.ts);
// the schema lives there so routes and config share one validation.
const customProviderEntrySchema = customProviderSchema;
const appConfigSchema = z.object({
  xai: z.object({ key: optionalText, url: optionalText }).optional(),
  /** Project key used for Sessions, catalog and agent tools. userId/sessionId
   * are non-secret local identifiers used to reuse one Composio Session. */
  composio: z.object({ apiKey: optionalText, userId: optionalText, sessionId: optionalText }).optional(),
  box: z.object({ token: optionalText }).optional(),
  /** Self-hosted OpenSandbox server: an alternative to box.ascii.dev for the
   * cloud computer feature, running on infrastructure the operator controls
   * instead of a third-party vendor. url defaults to the SDK's own default
   * (its own connectionConfig) when unset. */
  opensandbox: z.object({ url: optionalText, apiKey: optionalText, useServerProxy: z.boolean().optional() }).optional(),
  /** Opt-in identity bridge — see server/muster-cloud.ts. */
  musterCloud: z.object({ url: optionalText }).optional(),
  /** OpenCode Go key; persisted write-only and passed only to its child. */
  opencodeGo: z.object({ apiKey: optionalText }).optional(),
  /** Voice credentials and the selected voice id. */
  tts: z.object({ key: optionalText, voice: optionalText }).optional(),
  /** Non-secret profile details shown in the sidebar. */
  profile: z.object({ name: optionalText, email: optionalText }).optional(),
  /** Local VM desktop isolation. "shared" keeps the historical singleton
   * desktop every bot leases one at a time; "perBot" gives each bot its own
   * container, workspace, viewer port and lease lanes. */
  localVm: z
    .object({
      mode: z.enum(["shared", "perBot"]).optional(),
      maxInstances: z.number().int().min(LOCAL_VM_MAX_INSTANCES_MIN).max(LOCAL_VM_MAX_INSTANCES_MAX).optional(),
    })
    .optional(),
  /** Server-side ceiling for every bot turn in a channel (rooms and
   * bot⇄bot channels). Direct chats are exempt — they already stop on
   * silence via the stall watchdog. */
  channels: z
    .object({
      turnCapMinutes: z.number().int().min(CHANNEL_TURN_CAP_MIN_MINUTES).max(CHANNEL_TURN_CAP_MAX_MINUTES).optional(),
    })
    .optional(),
  /** BYO Linux VPS as a bot computer. The ONLY stored value is the user's
   * SSH config alias: ssh(1) itself resolves host/key/agent from ~/.ssh,
   * and Docker's native ssh:// transport reaches the remote daemon. No
   * credentials ever live in Muster. */
  vps: z.object({ sshAlias: optionalText }).optional(),
  /** Per-provider API keys — write-only, only configured-or-not flags exposed. */
  providers: z.record(z.string(), z.object({ apiKey: optionalText })).optional(),
  /** BYOK custom model providers (Settings → Providers → Add model
   * provider). Metadata only — the key lives in providers["custom-<id>"].
   * Replaced wholesale by its own route, like instances/mcpServers. */
  customProviders: z.array(customProviderEntrySchema).optional(),
  instances: instanceConfigMapSchema.optional(),
  /** User-registered stdio MCP servers (Settings → MCP Servers). Validated
   * field-by-field at save time; parsed here so a hand-edited config.json
   * cannot smuggle an unvalidated command into a spawn. Replaced wholesale,
   * never merged — see saveConfig. */
  mcpServers: z.array(customMcpServerSchema).optional(),
});
// instances, mcpServers, and customProviders have whole-collection write
// semantics (their own routes), not section-merge semantics — the generic
// /api/config patch must not touch them or a profile edit could clobber a
// registry saved a second earlier.
const appConfigPatchSchema = appConfigSchema.omit({ instances: true, mcpServers: true, customProviders: true });
const jsonObjectSchema = z.record(z.string(), z.json());

export interface AppConfig {
  xai?: { key?: string; url?: string };
  composio?: { apiKey?: string; userId?: string; sessionId?: string };
  box?: { token?: string };
  opensandbox?: { url?: string; apiKey?: string; useServerProxy?: boolean };
  /** Opt-in identity bridge — see server/muster-cloud.ts. Off by default;
   * an unset url means fully local, no network dependency, unchanged. */
  musterCloud?: { url?: string };
  opencodeGo?: { apiKey?: string };
  tts?: { key?: string; voice?: string };
  /** Desktop isolation mode and the global per-bot desktop cap. */
  localVm?: { mode?: LocalVmIsolationMode; maxInstances?: number };
  /** Channel settings; see the channels schema note for the turn cap. */
  channels?: { turnCapMinutes?: number };
  /** BYO VPS over SSH; see isValidSshAlias for what may be stored here. */
  vps?: { sshAlias?: string };
  profile?: { name?: string; email?: string };
  providers?: Record<string, { apiKey?: string }>;
  customProviders?: CustomProvider[];
  instances?: InstanceConfigMap;
  mcpServers?: CustomMcpServer[];
}
export type ConfigPatch = z.output<typeof appConfigPatchSchema>;

export function parseStoredConfig(value: JsonValue): AppConfig {
  const parsed = appConfigSchema.safeParse(value);
  if (!parsed.success) throw new Error(schemaIssue(parsed.error, "Invalid stored configuration"));
  return parsed.data;
}

export function parseConfigPatch(value: JsonValue): ConfigPatch {
  const parsed = appConfigPatchSchema.safeParse(value);
  if (!parsed.success) {
    throw Object.assign(new Error(schemaIssue(parsed.error, "Invalid configuration")), { status: 400 });
  }
  return parsed.data;
}

// OMB_DATA_DIR isolates test/soak rigs from the user's real fleet.
export const DATA_DIR = process.env.OMB_DATA_DIR ?? join(homedir(), ".muster");
const LEGACY_DATA_DIR = join(homedir(), ".opengrokbot");
export const EVENTS_DIR = join(DATA_DIR, "events");
export const NATIVE_DIR = join(DATA_DIR, "native");

const DEFAULT_LOCAL_VM_MODE: LocalVmIsolationMode = "shared";
const DEFAULT_LOCAL_VM_MAX_INSTANCES = 4;

/** Parse OMB_MAX_PER_BOT_DESKTOPS. Out-of-range or non-integer values fall
 * back to null so a typo'd env var degrades to the default cap instead of
 * refusing to boot the whole app over a desktop-count setting. */
export function envMaxPerBotDesktops(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const value = Number(raw);
  if (!Number.isInteger(value)) return null;
  if (value < LOCAL_VM_MAX_INSTANCES_MIN || value > LOCAL_VM_MAX_INSTANCES_MAX) return null;
  return value;
}

/** Shared keeps the historical singleton; per-bot gives every bot that needs
 * a computer its own dedicated desktop instance. */
export function localVmMode(cfg: AppConfig): LocalVmIsolationMode {
  return cfg.localVm?.mode ?? DEFAULT_LOCAL_VM_MODE;
}

/** Global ceiling on simultaneously existing per-bot desktops. Config wins
 * over the env knob so the Settings UI stays authoritative once saved. */
export function localVmMaxInstances(cfg: AppConfig): number {
  return cfg.localVm?.maxInstances ?? envMaxPerBotDesktops(process.env.OMB_MAX_PER_BOT_DESKTOPS) ?? DEFAULT_LOCAL_VM_MAX_INSTANCES;
}

/** Minutes before a channel turn is stopped server-side. Config wins over
 * the built-in default so the Settings input is authoritative once saved.
 * Out-of-range stored values cannot happen (the schema clamps at parse),
 * but hand-edited files pass through parseStoredConfig too. */
export function channelTurnCapMinutes(cfg: AppConfig): number {
  return cfg.channels?.turnCapMinutes ?? DEFAULT_CHANNEL_TURN_CAP_MINUTES;
}

// ── BYO VPS (SSH alias) ────────────────────────────────────────────────────

/** What a safe SSH config alias looks like. The alias is handed to ssh(1)
 * as a single argv element and into a DOCKER_HOST URL — never through a
 * shell — but keeping it to this charset also makes config files, logs and
 * error messages unambiguous. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- stored config values arrive untyped off disk; this guard IS the I/O-boundary parser for the alias field.
export function isValidSshAlias(value: unknown): value is string {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- JSON values carry no tag; typeof is the only discriminator for a bare string.
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && value.length <= 128;
}

/** The configured alias, or null when unset/invalid. Invalid stored values
 * degrade to "not configured" rather than throwing mid-turn. */
export function vpsSshAlias(cfg: AppConfig): string | null {
  return isValidSshAlias(cfg.vps?.sshAlias) ? cfg.vps!.sshAlias : null;
}

export function ensureDirs() {
  // one-time migration from the pre-rename data dir — bots, transcripts,
  // config and keys all carry over
  if (!existsSync(DATA_DIR) && existsSync(LEGACY_DATA_DIR)) {
    try {
      renameSync(LEGACY_DATA_DIR, DATA_DIR);
    } catch {
      /* cross-device or busy — fall through to a fresh dir */
    }
  }
  for (const dir of [DATA_DIR, EVENTS_DIR, NATIVE_DIR]) mkdirSync(dir, { recursive: true });
}

export function loadConfig(): AppConfig {
  let cfg: AppConfig = {};
  try {
    cfg = parseStoredConfig(parseJson(readFileSync(join(DATA_DIR, "config.json"), "utf8")));
  } catch {
    /* first run — env fallbacks below */
  }
  cfg.xai = { key: process.env.XAI_API_KEY, ...cfg.xai };
  cfg.composio = { ...cfg.composio };
  if (process.env.COMPOSIO_API_KEY !== undefined) cfg.composio.apiKey = process.env.COMPOSIO_API_KEY;
  cfg.box = { token: process.env.BOX_TOKEN, ...cfg.box };
  cfg.opencodeGo = { apiKey: process.env.OPENCODE_API_KEY, ...cfg.opencodeGo };
  cfg.tts = { key: process.env.OMB_TTS_KEY, ...cfg.tts };
  return cfg;
}

/** Merge a partial config into ~/.muster/config.json (secrets never
 * echoed back — callers report configured-or-not booleans only). */
export function saveConfig(patch: Partial<AppConfig>): void {
  const p = join(DATA_DIR, "config.json");
  let disk: JsonObject = {};
  try {
    const parsed = jsonObjectSchema.safeParse(parseJson(readFileSync(p, "utf8")));
    if (parsed.success) disk = parsed.data;
  } catch {
    /* first write */
  }
  const checkedPatch = appConfigSchema.partial().parse(patch);
  for (const key of ["xai", "composio", "box", "opensandbox", "opencodeGo", "tts", "profile", "musterCloud", "localVm", "channels", "vps"] as const) {
    const section = checkedPatch[key];
    if (!section) continue;
    const current = jsonObjectSchema.safeParse(disk[key]);
    const merged: JsonObject = current.success ? { ...current.data } : {};
    Object.assign(merged, section);
    disk[key] = merged;
  }
  if (checkedPatch.instances) {
    const currentInstances = jsonObjectSchema.safeParse(disk.instances);
    const diskInstances: JsonObject = currentInstances.success ? currentInstances.data : {};
    for (const [instanceId, entry] of Object.entries(checkedPatch.instances)) {
      const current = jsonObjectSchema.safeParse(diskInstances[instanceId]);
      const merged: JsonObject = current.success ? { ...current.data } : {};
      Object.assign(merged, entry);
      diskInstances[instanceId] = merged;
    }
    disk.instances = diskInstances;
  }
  if (checkedPatch.providers) {
    const currentProviders = jsonObjectSchema.safeParse(disk.providers);
    const diskProviders: JsonObject = currentProviders.success ? currentProviders.data : {};
    for (const [providerId, entry] of Object.entries(checkedPatch.providers)) {
      const current = jsonObjectSchema.safeParse(diskProviders[providerId]);
      const merged: JsonObject = current.success ? { ...current.data } : {};
      Object.assign(merged, entry);
      diskProviders[providerId] = merged;
    }
    disk.providers = diskProviders;
  }
  // The MCP registry replaces as one array: entries carry identity (id) and
  // unique-name invariants that a per-key merge would silently break.
  if (checkedPatch.mcpServers) {
    disk.mcpServers = checkedPatch.mcpServers;
  }
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileAtomic(p, JSON.stringify(disk, null, 2), { mode: 0o600 });
}

/** Set one instance's `config.cli` ("" clears the override back to the
 * driver default). Creating the instance entry is fine — a config-less
 * entry rides driver.defaultConfig(). Returns false for unknown instances
 * when the fleet is explicitly configured. The returned map must stay
 * PERSISTABLE: instanceConfigs() injects credential env into every entry
 * for the live fleet, so those injected keys are stripped back out before
 * the map is returned — otherwise saving an override would copy xai/box/
 * opencodeGo secrets into the instances section of config.json. */
export function withInstanceCli(
  cfg: AppConfig,
  instanceId: string,
  cli: string,
): InstanceCliUpdate {
  const next: AppConfig = structuredClone(cfg);
  const injected = injectedEnvironment(next);
  const map = instanceConfigs(next);
  // hasOwn, not truthiness: map is a plain object literal, so
  // map["__proto__"] resolves to Object.prototype — truthy — and the
  // assignment below would poison EVERY object in the process (instanceId
  // comes off the URL, where `__proto__` passes the route's [\w.-]+ regex)
  if (!Object.hasOwn(map, instanceId)) return { ok: false, config: cfg };
  const entry = map[instanceId];
  const cliKey = cli.trim();
  const currentConfig = jsonObjectSchema.safeParse(entry.config);
  if (cliKey) {
    const nextConfig: JsonObject = currentConfig.success ? { ...currentConfig.data } : {};
    nextConfig.cli = cliKey;
    entry.config = nextConfig;
  } else if (currentConfig.success && Object.hasOwn(currentConfig.data, "cli")) {
    const rest = { ...currentConfig.data };
    delete rest.cli;
    entry.config = Object.keys(rest).length ? rest : undefined;
  }
  for (const e of Object.values(map)) {
    if (!e.environment) continue;
    for (const [k, v] of Object.entries(e.environment)) {
      if (injected.get(k) === v) delete e.environment[k];
    }
    if (!Object.keys(e.environment).length) delete e.environment;
  }
  next.instances = map;
  return { ok: true, config: next };
}

interface InstanceCliUpdate {
  ok: boolean;
  config: AppConfig;
}

/** The credential env instanceConfigs() injects — same keys, same rule. */
// driver kind -> env var name, for every server/providers.ts catalog entry
// that rides a direct-API driver (no local CLI). Single source of truth for
// both instanceConfigs() (which injects these) and injectedEnvironment()
// (which withInstanceCli() uses to strip them back out before persisting an
// override) — defined once at module scope so the two can never drift out
// of sync with each other.
export const PROVIDER_DRIVER_ENV = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  mistral: "MISTRAL_API_KEY",
  cohere: "COHERE_API_KEY",
  groq: "GROQ_API_KEY",
  together: "TOGETHER_API_KEY",
  fireworks: "FIREWORKS_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  // Same OPENCODE_API_KEY the CLI-driven opencodeGo instance already reads
  // (see injectedEnvironment above) — Zen and Go share one key, so a saved
  // providers.opencodeZen.apiKey lights up both the API-key engine here and
  // the CLI engine there.
  opencodeZen: "OPENCODE_API_KEY",
} satisfies Record<string, string>;

function injectedEnvironment(cfg: AppConfig): Map<string, string> {
  const environment = new Map<string, string>();
  if (cfg.xai?.key) environment.set("XAI_API_KEY", cfg.xai.key);
  if (cfg.box?.token) environment.set("BOX_TOKEN", cfg.box.token);
  if (cfg.opencodeGo?.apiKey) environment.set("OPENCODE_API_KEY", cfg.opencodeGo.apiKey);
  for (const [driver, envVar] of Object.entries(PROVIDER_DRIVER_ENV)) {
    const key = cfg.providers?.[driver]?.apiKey;
    if (key) environment.set(envVar, key);
  }
  return environment;
}

// Default fleet: one instance per built-in driver (upstream
// defaultInstanceIdForDriver — instanceId defaults to the driver kind).
// Config-file keys are injected as per-instance environment so drivers
// see them without needing real process env vars.
export function instanceConfigs(cfg: AppConfig): InstanceConfigMap {
  // The default `grok` instance rides the `grokAgent` driver, not the API-key
  // one: like claude and codex it needs no credential from us, just the CLI
  // installed and logged in (it shows up unavailable otherwise). The API-key
  // `grok` driver stays registered but out of the default fleet — that key is
  // a credential the user doesn't want to manage; an `instances` entry brings
  // it back anytime.
  //
  // Google rides `antigravityAgent` (the `agy` CLI), not `geminiAgent`:
  // Google retired Gemini CLI for the free/Pro/Ultra tiers on 2026-06-18
  // (developers.googleblog.com, "transitioning Gemini CLI to Antigravity
  // CLI"), so a default `gemini` instance could only ever show unavailable.
  // The driver stays registered for enterprise licences, which keep Gemini
  // CLI — `{"instances": {"gemini": {"driver": "geminiAgent"}}}` restores it.
  const DEFAULT_FLEET: InstanceConfigMap = {
    grok: { driver: "grokAgent" },
    kimi: { driver: "kimiAgent" },
    droid: { driver: "droidAgent" },
    claude: { driver: "claudeAgent" },
    codex: { driver: "codex" },
    antigravity: { driver: "antigravityAgent" },
    opencodeGo: { driver: "opencodeGo" },
    computer: { driver: "boxAgent" },
    qwen: { driver: "qwenAgent" },
    hermes: { driver: "hermesAgent" },
  };
  // Bring-your-own-key API engines appear as extra instances once their key
  // is saved in Settings → Providers (server/providers.ts catalog): no CLI
  // install required, alongside the CLI-driven instances above. The xAI one
  // bills via XAI_API_KEY over plain HTTPS and shows up as a second Grok
  // option.
  if (cfg.xai?.key) DEFAULT_FLEET.grokApi = { driver: "grok", displayName: "Grok (API)" };
  if (cfg.providers?.openai?.apiKey) DEFAULT_FLEET.openaiApi = { driver: "openai", displayName: "OpenAI (API)" };
  if (cfg.providers?.anthropic?.apiKey) {
    DEFAULT_FLEET.anthropicApi = { driver: "anthropic", displayName: "Anthropic (API)" };
  }
  if (cfg.providers?.google?.apiKey) DEFAULT_FLEET.googleApi = { driver: "google", displayName: "Google (API)" };
  if (cfg.providers?.deepseek?.apiKey) {
    DEFAULT_FLEET.deepseekApi = { driver: "deepseek", displayName: "DeepSeek (API)" };
  }
  if (cfg.providers?.mistral?.apiKey) DEFAULT_FLEET.mistralApi = { driver: "mistral", displayName: "Mistral (API)" };
  if (cfg.providers?.cohere?.apiKey) DEFAULT_FLEET.cohereApi = { driver: "cohere", displayName: "Cohere (API)" };
  if (cfg.providers?.groq?.apiKey) DEFAULT_FLEET.groqApi = { driver: "groq", displayName: "Groq (API)" };
  if (cfg.providers?.together?.apiKey) {
    DEFAULT_FLEET.togetherApi = { driver: "together", displayName: "Together AI (API)" };
  }
  if (cfg.providers?.fireworks?.apiKey) {
    DEFAULT_FLEET.fireworksApi = { driver: "fireworks", displayName: "Fireworks AI (API)" };
  }
  if (cfg.providers?.openrouter?.apiKey) {
    DEFAULT_FLEET.openrouterApi = { driver: "openrouter", displayName: "OpenRouter (API)" };
  }
  if (cfg.providers?.opencodeZen?.apiKey) {
    DEFAULT_FLEET.opencodeZenApi = { driver: "opencodeZen", displayName: "OpenCode Zen (API)" };
  }
  // BYOK custom providers (Settings → Providers → Add model provider):
  // one instance each, wired through the same key discipline — metadata
  // in cfg.customProviders, key in cfg.providers["custom-<id>"].
  const apiKeyOf = (id: string): string | undefined =>
    cfg.providers?.[`custom-${id}`]?.apiKey || undefined;
  const customEntries = customProviderInstances(cfg.customProviders ?? [], apiKeyOf);
  for (const [instanceId, entry] of Object.entries(customEntries)) {
    DEFAULT_FLEET[instanceId] = entry;
  }
  const CUSTOM_ONLY = {
    qwen: { driver: "qwenAgent" },
    hermes: { driver: "hermesAgent" },
  } as const;
  const configured = cfg.instances && Object.keys(cfg.instances).length ? cfg.instances : null;
  const map: InstanceConfigMap = configured ? { ...configured } : { ...DEFAULT_FLEET };
  // Product fleets pick up newly shipped custom-only engines. A one-off
  // test/shadow map (no claude/grok/codex) is left exactly as written.
  if (
    configured &&
    (Object.hasOwn(configured, "claude") || Object.hasOwn(configured, "grok") || Object.hasOwn(configured, "codex"))
  ) {
    for (const [id, entry] of Object.entries(CUSTOM_ONLY)) {
      if (!Object.hasOwn(map, id)) map[id] = { ...entry };
    }
  }
  for (const entry of Object.values(map)) {
    const environment = { ...entry.environment };
    if (cfg.xai?.key) environment.XAI_API_KEY = cfg.xai.key;
    if (cfg.box?.token) environment.BOX_TOKEN = cfg.box.token;
    if (entry.driver === "opencodeGo" && cfg.opencodeGo?.apiKey) {
      environment.OPENCODE_API_KEY = cfg.opencodeGo.apiKey;
    }
    // SAFETY: guarded by the `in` check, so entry.driver is one of the
    // direct-API kinds PROVIDER_DRIVER_ENV maps to an env var.
    const envVar = entry.driver in PROVIDER_DRIVER_ENV
      ? PROVIDER_DRIVER_ENV[entry.driver as keyof typeof PROVIDER_DRIVER_ENV]
      : undefined;
    const providerKey = cfg.providers?.[entry.driver]?.apiKey;
    if (envVar && providerKey) environment[envVar] = providerKey;
    entry.environment = environment;
  }
  return map;
}
