// BYOK custom model providers — Settings → Providers → "Add model
// provider". Anyone can point Muster at any OpenAI- or
// Anthropic-compatible endpoint: a name, a base URL, an API key, and the
// model list to expose in the picker. The endpoint rides the existing
// chat-completions (openai-compatible) or Anthropic-messages driver, so a
// custom provider is a first-class instance: health, picker, chat, usage —
// everything the built-in twins get.
//
// Storage follows the provider-key discipline: metadata (name/url/format/
// models) lives in config.json `customProviders`; the API key lives in the
// write-only `providers["custom-<id>"].apiKey` record, surfaced to the UI
// as a configured-or-not flag, never echoed back.
//
// SSRF posture: the BASE URL is user-supplied and the server turns it into
// outbound requests (model-list fetches, chat turns). Scheme is always
// http/https. Self-hosted multi-tenant deployments reject loopback,
// private, and reserved hosts outright — one account must not probe the
   // deployment's internal network through a "provider". Desktop
// single-user installs keep loopback allowed: pointing at Ollama or LM
// Studio on 127.0.0.1 is the headline local-models use case, and the only
// person reachable is the operator.
import { z } from "zod";

import type { InstanceConfigMap } from "./contracts.ts";
import {
  isPrivateOrReservedIpv4,
  isPrivateOrReservedIpv6,
  parseIpv4,
  parseIpv6,
} from "./vm-bootstrap.ts";

export const CUSTOM_MODELS_MIN = 1;
export const CUSTOM_MODELS_MAX = 64;
export const CUSTOM_PROVIDER_MAX = 12;

export const customProviderSchema = z.object({
  /** Stable url-safe id, derived from the name at create time. */
  id: z.string().regex(/^[\w-]{1,64}$/),
  /** Display name in the picker, e.g. "DeepSeek" or "My Gateway". */
  name: z.string().min(1).max(60),
  /** API root — driver appends /chat/completions, /models, /v1/messages. */
  baseUrl: z.string().min(1).max(300),
  /** Wire format the endpoint speaks. */
  format: z.enum(["openai", "anthropic"]),
  /** Model ids to expose in the picker, user-ordered. */
  models: z.array(z.string().min(1).max(120)).min(CUSTOM_MODELS_MIN).max(CUSTOM_MODELS_MAX),
});
export type CustomProvider = z.infer<typeof customProviderSchema>;

export type CustomProviderInput = Omit<CustomProvider, "id">;

/** The wire shape POST /api/custom-providers accepts — everything but the
 * server-derived id. */
export const customProviderInputSchema = customProviderSchema.omit({ id: true });

/** "My Gateway ✨" → "my-gateway" — instance/env-var safe, collisions
 * broken by the caller's suffix. Non-ASCII names transliterate to
 * alphanumerics; a name made of nothing usable falls back to "provider". */
export function sanitizeCustomProviderId(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "provider";
}

/** Loopback or link-local host? Hostnames (api.example.com) never match —
 * only literal IPs and the localhost names do, mirroring what a DNS
 * lookup of a public name cannot resolve to without rebinding. */
function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.startsWith("localhost:") || h.endsWith(".localhost")) return true;
  const v4 = parseIpv4(h);
  if (v4) return v4[0] === 127 || v4[0] === 0 || (v4[0] === 169 && v4[1] === 254);
  return h === "::1";
}

export type BaseUrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

/** Validate a user-supplied provider base URL before the server ever
 * fetches it. http/https only; scheme+host required. Self-hosted
 * multi-tenant deployments reject loopback/private/reserved targets —
 * see the module header. Desktop keeps local endpoints (Ollama). */
export function validateProviderBaseUrl(raw: string, selfHosted: boolean): BaseUrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "Base URL must be a valid absolute URL" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, reason: "Base URL must use http or https" };
  }
  const host = url.hostname;
  if (!host) return { ok: false, reason: "Base URL needs a host" };
  if (selfHosted) {
    if (isLoopbackHost(host)) {
      return { ok: false, reason: "Self-hosted deployments block loopback provider endpoints (SSRF) — use the machine's public hostname" };
    }
    const v4 = parseIpv4(host);
    if (v4 && isPrivateOrReservedIpv4(v4)) {
      return { ok: false, reason: "Self-hosted deployments block private/reserved provider endpoints (SSRF)" };
    }
    const v6 = parseIpv6(host);
    if (v6 && isPrivateOrReservedIpv6(v6)) {
      return { ok: false, reason: "Self-hosted deployments block private/reserved provider endpoints (SSRF)" };
    }
  }
  return { ok: true, url };
}

/** The env-var name a custom provider's key rides into its instance.
 * Deterministic from the id so config round-trips are stable. */
export function customProviderKeyEnv(id: string): string {
  const upper = id.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();
  return `CUSTOM_PROVIDER_${upper}_API_KEY`;
}

export const customKeyProviderId = (id: string): string => `custom-${id}`;

/** The instance-map entries every custom provider contributes. Driver kind
 * follows the wire format; the key rides the instance's own environment
 * (never global process env), and the model list lands in instance config
 * so the picker shows exactly what the user asked for. */
export function customProviderInstances(
  providers: readonly CustomProvider[],
  apiKeyOf: (id: string) => string | undefined,
): InstanceConfigMap {
  const map: InstanceConfigMap = {};
  for (const provider of providers) {
    const keyEnv = customProviderKeyEnv(provider.id);
    const apiKey = apiKeyOf(provider.id) ?? "";
    const environment: Record<string, string> = {};
    if (apiKey) environment[keyEnv] = apiKey;
    const options = provider.models.map((id) => ({ id, label: id }));
    map[`custom-${provider.id}`] = {
      driver: provider.format === "anthropic" ? "anthropic" : "customOpenai",
      displayName: provider.name,
      environment,
      config: {
        url: provider.baseUrl,
        apiKeyEnv: keyEnv,
        models: { default: options[0]!.id, options },
      },
    };
  }
  return map;
}

/** GET {baseUrl}/models and pull the model-id list. Both OpenAI-compatible
 * chat endpoints and Anthropic's /v1/models answer `{ data: [{ id }] }`;
 * anything else (or a failure) yields an empty list the caller treats as
 * "enter models manually". */
export async function fetchProviderModelIds(
  baseUrl: string,
  apiKey: string | undefined,
  timeoutMs = 6_000,
): Promise<string[]> {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/models`;
  const res = await fetch(url, {
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) return [];
  // The model-list wire contract across OpenAI-compatible and Anthropic
  // /models endpoints: { data: [{ id }] }. zod at the I/O boundary —
  // anything else parses to an empty list and the caller falls back to
  // manual entry.
  const payload = z
    .object({ data: z.array(z.object({ id: z.string().min(1) }).passthrough()).max(CUSTOM_MODELS_MAX * 4) })
    .safeParse(await res.json().catch(() => null));
  if (!payload.success) return [];
  const ids: string[] = [];
  for (const row of payload.data.data) {
    if (!ids.includes(row.id)) ids.push(row.id);
    if (ids.length >= CUSTOM_MODELS_MAX) break;
  }
  return ids;
}
