// Shared local-host inject — the sidecar workflow, inside the picker.
// Probe oMLX / Ollama / EXO / LM Studio / Unsloth, list whatever they
// serve under Custom on every agent, and decode a pick back into a host
// + API id the selected driver can inject.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import type { ModelCatalog } from "../contracts.ts";
import { parseJson, type JsonObject, type JsonValue } from "../schema.ts";

export interface LocalHost {
  id: string;
  label: string;
  baseUrl: string;
  apiKey?: string;
  apiKeyEnv?: string;
}

export const LOCAL_HOSTS: LocalHost[] = [
  { id: "omlx", label: "oMLX", baseUrl: "http://127.0.0.1:8080/v1", apiKey: "omlx" },
  { id: "ollama", label: "Ollama", baseUrl: "http://127.0.0.1:11434/v1", apiKey: "ollama" },
  { id: "local_ollama", label: "Ollama", baseUrl: "http://127.0.0.1:11434/v1", apiKey: "ollama" },
  { id: "exo", label: "EXO", baseUrl: "http://127.0.0.1:52415/v1", apiKey: "exo" },
  { id: "lmstudio", label: "LM Studio", baseUrl: "http://127.0.0.1:1234/v1", apiKey: "lm-studio" },
  { id: "unsloth", label: "Unsloth", baseUrl: "http://127.0.0.1:8888/v1", apiKeyEnv: "UNSLOTH_STUDIO_AUTH_TOKEN" },
  { id: "unsloth_api", label: "Unsloth", baseUrl: "http://127.0.0.1:8888/v1", apiKeyEnv: "UNSLOTH_STUDIO_AUTH_TOKEN" },
];

export const INJECT_SEP = "::";

/** A process environment as the injectors see it: a present key means the
 * variable is set, an absent key means unset. */
export type ProviderEnvironment = Record<string, string | undefined>;

const HOST_BY_ID = new Map(LOCAL_HOSTS.map((host) => [host.id, host]));
const MODEL_ID = /^[\w][\w./:+-]*$/;

export interface InjectedModel {
  id: string;
  host: string;
  model: string;
  label: string;
  /** In VRAM / running on the host right now — Custom pins these first. */
  loaded?: boolean;
}

export function encodeInjectId(host: string, model: string): string {
  return `${host}${INJECT_SEP}${model}`;
}

export function decodeInjectId(id: string | null | undefined): { host: string; model: string } | null {
  if (!id) return null;
  const sep = id.indexOf(INJECT_SEP);
  if (sep <= 0) return null;
  const host = id.slice(0, sep);
  const model = id.slice(sep + INJECT_SEP.length);
  if (!HOST_BY_ID.has(host) || !MODEL_ID.test(model)) return null;
  return { host, model };
}

export function localHost(id: string): LocalHost | undefined {
  return HOST_BY_ID.get(id);
}

export function injectedApiModel(id: string | null | undefined): string | null {
  return decodeInjectId(id)?.model ?? null;
}

/** Anthropic-compatible base (Claude Code wants this without a trailing /v1). */
export function anthropicBaseUrl(host: LocalHost): string {
  return host.baseUrl.replace(/\/v1\/?$/, "");
}

export function hostApiKey(host: LocalHost, env: ProviderEnvironment = process.env): string {
  if (host.apiKeyEnv && env[host.apiKeyEnv]) return env[host.apiKeyEnv]!;
  if (host.apiKey) return host.apiKey;
  if (host.id === "unsloth" || host.id === "unsloth_api") {
    const fromFile = readUnslothKey(env);
    if (fromFile) return fromFile;
  }
  return "local";
}

const CODEX_RESERVED_PROVIDERS = new Set(["openai", "ollama", "lmstudio"]);

/**
 * Configure the custom local providers on the Codex app-server without
 * rewriting the user's config.toml. Provider secrets ride in the child
 * environment; argv only contains the corresponding environment key name.
 */
export function codexLocalProviderArgs(
  env: ProviderEnvironment,
  modelId: string | null | undefined,
): string[] {
  const inject = decodeInjectId(modelId);
  if (!inject || CODEX_RESERVED_PROVIDERS.has(inject.host)) return [];
  const host = localHost(inject.host);
  if (!host) return [];
  const envKey = `MUSTER_LOCAL_${host.id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
  env[envKey] = hostApiKey(host, env);
  return [
    "-c",
    `model_providers.${host.id}.name=${JSON.stringify(host.label)}`,
    "-c",
    `model_providers.${host.id}.base_url=${JSON.stringify(host.baseUrl)}`,
    "-c",
    `model_providers.${host.id}.env_key=${JSON.stringify(envKey)}`,
  ];
}

/** Result of pointing a CLI environment at an injected local host. */
export interface InjectApplication {
  model: string | null;
  injected: boolean;
}

const JSON_RECORD = z.record(z.string(), z.unknown());

/** View a decoded JSON value as a string-keyed record, or null when it is not an object. */
function jsonRecord(value: JsonValue): JsonObject | null {
  // SAFETY: zod verified value is a non-null object; entries came from JSON.parse so they are JSON-compatible.
  return JSON_RECORD.safeParse(value).success ? (value as JsonObject) : null;
}

/** Decode a JSON wire value into text, or null when it is not a string. */
function jsonText(value: JsonValue | undefined): string | null {
  const decoded = z.string().safeParse(value);
  return decoded.success ? decoded.data : null;
}

const UNSLOTH_KEY_FILE = z.object({ api_key: z.string().min(1) });

function readUnslothKey(env: ProviderEnvironment): string | null {
  const home = env.HOME || env.USERPROFILE || homedir();
  try {
    const raw = UNSLOTH_KEY_FILE.parse(
      parseJson(readFileSync(join(home, ".unsloth", "studio", "auth", "agent_api_key.json"), "utf8")),
    );
    return raw.api_key;
  } catch {
    return null;
  }
}

/** Model ids from any of the /models payload dialects local servers speak. */
function idsFromModelsPayload(payload: JsonValue): string[] {
  const record = jsonRecord(payload);
  const records = Array.isArray(payload)
    ? payload
    : Array.isArray(record?.data)
      ? record.data
      : Array.isArray(record?.models)
        ? record.models
        : [];
  return records.flatMap((entry): string[] => {
    const asText = jsonText(entry);
    if (asText !== null) return MODEL_ID.test(asText) ? [asText] : [];
    const fields = jsonRecord(entry);
    if (!fields) return [];
    const id = jsonText(fields.id ?? fields.name) ?? "";
    if (!MODEL_ID.test(id)) return [];
    const low = id.toLowerCase();
    if (low.includes("embed") || low.includes("bge-") || low.includes("nomic")) return [];
    return [id];
  });
}

async function timedJson(
  url: string,
  env: ProviderEnvironment,
  host: LocalHost,
  fetchImpl: typeof fetch,
): Promise<JsonValue | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1200);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${hostApiKey(host, env)}` },
    });
    if (!response.ok) return null;
    return parseJson(await response.text());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Which of this host's models are actually in memory / running. */
export function loadedIdsFromPayloads(_host: LocalHost, catalog: JsonValue, extra: JsonValue): Set<string> {
  const loaded = new Set<string>();
  const catalogIds = new Set(idsFromModelsPayload(catalog));
  const add = (id: string) => {
    const base = id.split(":")[0]!;
    if (catalogIds.size && !catalogIds.has(id) && !catalogIds.has(base)) return;
    if (!MODEL_ID.test(id)) return;
    loaded.add(id);
    if (catalogIds.has(base)) loaded.add(base);
  };

  const extraFields = jsonRecord(extra);
  if (extraFields) {
    const running = Array.isArray(extraFields.models)
      ? extraFields.models
      : Array.isArray(extraFields.data)
        ? extraFields.data
        : [];
    // oMLX /v1/models/status lists every model with loaded:true/false.
    // /health only has default_model, which is the configured default — not
    // necessarily what is in memory. Prefer explicit flags when present.
    const hasLoadedFlags = running.some((row) => {
      const rowRecord = jsonRecord(row);
      return rowRecord !== null && ("loaded" in rowRecord || "state" in rowRecord);
    });
    if (!hasLoadedFlags) {
      const defaultModel = jsonText(extraFields.default_model);
      if (defaultModel !== null) add(defaultModel);
    }
    for (const row of running) {
      const rowText = jsonText(row);
      if (rowText !== null) {
        if (!hasLoadedFlags) add(rowText);
        continue;
      }
      const item = jsonRecord(row);
      if (!item) continue;
      const id = jsonText(item.name) || jsonText(item.model) || jsonText(item.id) || "";
      if (!id) continue;
      const state = jsonText(item.state)?.toLowerCase() ?? "";
      if (item.loaded === false || state === "not-loaded" || state === "unloaded") continue;
      if (item.loaded === true || state === "loaded" || state === "idle" || !hasLoadedFlags) {
        add(id);
      }
    }
  }

  if (!loaded.size) {
    const catalogFields = jsonRecord(catalog);
    if (catalogFields) {
      const defaultModel = jsonText(catalogFields.default_model);
      if (defaultModel !== null) add(defaultModel);
      const records = Array.isArray(catalogFields.data) ? catalogFields.data : [];
      for (const row of records) {
        const item = jsonRecord(row);
        if (!item) continue;
        const id = jsonText(item.id);
        if (id === null) continue;
        const state = jsonText(item.state)?.toLowerCase() ?? "";
        if (item.loaded === true || state === "loaded") add(id);
      }
    }
  }

  return loaded;
}

function loadedProbeUrl(host: LocalHost): string | null {
  const origin = anthropicBaseUrl(host);
  if (host.id === "omlx") return `${origin}/v1/models/status`;
  if (host.id === "ollama" || host.id === "local_ollama") return `${origin}/api/ps`;
  if (host.id === "lmstudio") return `${origin}/api/v0/models`;
  return null;
}

/** Live models from the same local hosts the sidecar probed. */
export async function probeLocalInjects(
  env: ProviderEnvironment = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<InjectedModel[]> {
  const seenHosts = new Set<string>();
  const hosts = LOCAL_HOSTS.filter((host) => {
    const key = host.baseUrl.replace(/\/$/, "");
    if (seenHosts.has(key)) return false;
    seenHosts.add(key);
    return true;
  });
  const found: InjectedModel[] = [];
  const pages = await Promise.all(
    hosts.map(async (host) => {
      const catalogUrl = `${host.baseUrl.replace(/\/$/, "")}/models`;
      const extraUrl = loadedProbeUrl(host);
      const [catalog, extra] = await Promise.all([
        timedJson(catalogUrl, env, host, fetchImpl),
        extraUrl ? timedJson(extraUrl, env, host, fetchImpl) : Promise.resolve(null),
      ]);
      const catalogIds = catalog ? idsFromModelsPayload(catalog) : [];
      const extraIds = extra ? idsFromModelsPayload(extra) : [];
      const loaded = loadedIdsFromPayloads(host, catalog ?? extra, extra);
      const ids = [...new Set([...catalogIds, ...extraIds, ...loaded])];
      return { host, ids, loaded };
    }),
  );
  for (const { host, ids, loaded } of pages) {
    for (const model of ids) {
      found.push({
        id: encodeInjectId(host.id, model),
        host: host.id,
        model,
        label: `${model} (${host.label})`,
        loaded: loaded.has(model),
      });
    }
  }
  return found;
}

/** Append live local models as custom rows. Official rows stay first. */
export async function mergeLocalInject(
  catalog: ModelCatalog,
  env: ProviderEnvironment = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<ModelCatalog> {
  const vitest = env.VITEST ?? process.env.VITEST;
  const probe = env.MUSTER_PROBE_LOCAL_INJECT ?? process.env.MUSTER_PROBE_LOCAL_INJECT;
  if (vitest === "true" && probe !== "1") return catalog;
  const extras = await probeLocalInjects(env, fetchImpl);
  if (!extras.length) return catalog;
  const options = catalog.options.map((option) => ({ ...option }));
  const seen = new Set(options.map((option) => option.id));
  for (const extra of extras) {
    const existing = options.find((option) => option.id === extra.id);
    if (existing) {
      if (extra.loaded) existing.loaded = true;
      continue;
    }
    seen.add(extra.id);
    const option: ModelCatalog["options"][number] = { id: extra.id, label: extra.label, custom: true };
    if (extra.loaded) option.loaded = true;
    options.push(option);
  }
  return { default: catalog.default, options };
}

/** Point an OpenAI-compatible CLI at the injected host. */
export function applyOpenAIInject(
  env: ProviderEnvironment,
  modelId: string | null | undefined,
): InjectApplication {
  const inject = decodeInjectId(modelId);
  if (!inject) return { model: modelId ?? null, injected: false };
  const host = localHost(inject.host);
  if (!host) return { model: modelId ?? null, injected: false };
  const key = hostApiKey(host, env);
  env.OPENAI_BASE_URL = host.baseUrl;
  env.OPENAI_API_KEY = key;
  return { model: inject.model, injected: true };
}

/** Point Claude Code at the injected host instead of Anthropic cloud. */
export function applyClaudeInject(
  env: ProviderEnvironment,
  modelId: string | null | undefined,
): InjectApplication {
  const inject = decodeInjectId(modelId);
  if (!inject) return { model: modelId ?? null, injected: false };
  const host = localHost(inject.host);
  if (!host) return { model: modelId ?? null, injected: false };
  const key = hostApiKey(host, env);
  env.ANTHROPIC_BASE_URL = anthropicBaseUrl(host);
  env.ANTHROPIC_AUTH_TOKEN = key;
  env.ANTHROPIC_API_KEY = key;
  env.ANTHROPIC_MODEL = inject.model;
  return { model: inject.model, injected: true };
}
