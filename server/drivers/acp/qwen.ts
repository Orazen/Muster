// Qwen Code — Alibaba's `qwen --acp` CLI. Custom-only in Muster:
// the official pane has no Qwen Cloud catalog; live local hosts land in
// Custom and are written into ~/.qwen/settings.json modelProviders.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ModelCatalog } from "../../contracts.ts";
import { parseJson, type JsonObject, type JsonValue } from "../../schema.ts";
import { decodeInjectId, hostApiKey, localHost, mergeLocalInject } from "../local-inject.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";

const EMPTY: ModelCatalog = { default: "", options: [] };

function qwenHome(env: Record<string, string | undefined>): string {
  return join(env.HOME || env.USERPROFILE || homedir(), ".qwen");
}

function envKeyFor(hostId: string): string {
  return `MUSTER_QWEN_${hostId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
}

/** Upsert an OpenAI-compatible provider row so `qwen -m` can reach the host. */
export function ensureQwenInjectModel(
  modelId: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const inject = decodeInjectId(modelId);
  if (!inject) return modelId;
  const host = localHost(inject.host);
  if (!host) return modelId;

  const dir = qwenHome(env);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "settings.json");
  let settings: JsonObject = {};
  if (existsSync(path)) {
    try {
      // SAFETY: user-edited settings.json is decoded JSON; the env and
      // modelProviders fields are re-proven below before they are read.
      settings = parseJson(readFileSync(path, "utf8")) as JsonObject;
    } catch {
      // Malformed user config — inject into a fresh object rather than fail the turn.
    }
  }
  const keyName = envKeyFor(inject.host);
  const key = hostApiKey(host, env);
  const envMap = settings.env instanceof Object && !Array.isArray(settings.env) ? { ...settings.env } : {};
  envMap[keyName] = key;
  settings.env = envMap;

  const providers =
    settings.modelProviders instanceof Object && !Array.isArray(settings.modelProviders)
      ? { ...settings.modelProviders }
      : {};
  const openai = Array.isArray(providers.openai) ? [...providers.openai] : [];
  const match = openai.find((row) => {
    if (!(row instanceof Object) || Array.isArray(row)) return false;
    // SAFETY: provider rows are decoded JSON records; id/baseUrl are compared by value
    const candidate = row as { id?: JsonValue; baseUrl?: JsonValue };
    return candidate.id === inject.model && candidate.baseUrl === host.baseUrl;
  });
  if (!match) {
    openai.push({
      id: inject.model,
      name: `${inject.model} (${host.label})`,
      baseUrl: host.baseUrl,
      envKey: keyName,
    });
    providers.openai = openai;
    settings.modelProviders = providers;
  }
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows ignores POSIX modes; keep the inject even if chmod is unsupported.
  }
  return inject.model;
}

async function resolveModels(env: Record<string, string | undefined>): Promise<ModelCatalog> {
  const catalog = await mergeLocalInject(EMPTY, env);
  return { default: catalog.options[0]?.id ?? "", options: catalog.options };
}

const support: AcpSupport = {
  driverKind: "qwenAgent",
  displayName: "Qwen",
  access: "custom",
  models: EMPTY,
  resolveModels,
  resolveTurnModel: (model, env) => (model ? ensureQwenInjectModel(model, env) : model),
  defaultCli: "qwen",
  nativeSource: "qwen.acp",
  loginNote: "Qwen Code CLI is not installed",
  install: {
    command: {
      darwin: "curl -fsSL https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.sh | bash",
      linux: "curl -fsSL https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.sh | bash",
      win32: "irm https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.ps1 | iex",
    },
    docsUrl: "https://qwenlm.github.io/qwen-code-docs/en/users/overview/",
  },
  spawnArgs: (_config, turn) => ["--acp", ...(turn.model ? ["-m", turn.model] : [])],
  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: () => true,
  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};

export const QwenAgentDriver = createAcpDriver(support);
