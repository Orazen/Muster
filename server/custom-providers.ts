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

/** The host in the form every address test below expects: lowercased, with
 * the IPv6 literal brackets and the DNS root's trailing dot removed.
 *
 * Both spellings matter and neither is exotic. `new URL("http://[::1]:8000")`
 * yields the hostname "[::1]", which parseIpv6 cannot read — so before this,
 * `http://[fc00::1]/v1` and `http://[fe80::1]/v1` passed the self-hosted
 * private/reserved check untouched while `http://127.0.0.1/v1` was refused.
 * And `new URL("http://localhost./v1").hostname` is "localhost." — the
 * trailing dot is the DNS root, resolvers ignore it, and
 * `dns.lookup("localhost.")` answers ::1 and 127.0.0.1. */
function normalizeHost(raw: string): string {
  return raw.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
}

/** Loopback or link-local host? Hostnames (api.example.com) never match —
 * only literal IPs and the localhost names do, mirroring what a DNS
 * lookup of a public name cannot resolve to without rebinding. */
function isLoopbackHost(host: string): boolean {
  const h = normalizeHost(host);
  if (h === "localhost" || h.endsWith(".localhost")) return true;
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
    // The SAME normalized host the loopback test above read. Testing the raw
    // one missed every bracketed IPv6 literal, so an fc00::/7 unique-local or
    // fe80::/10 link-local (cloud metadata) endpoint passed on self-hosted
    // while the IPv4 spellings of the same ranges were refused.
    const normalized = normalizeHost(host);
    const v4 = parseIpv4(normalized);
    if (v4 && isPrivateOrReservedIpv4(v4)) {
      return { ok: false, reason: "Self-hosted deployments block private/reserved provider endpoints (SSRF)" };
    }
    const v6 = parseIpv6(normalized);
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

/** undici's `cause` for a 3xx refused by `redirect: "error"` — see the
 * fetchProviderModelIds doc comment. Compared as a string because the value
 * crosses the undici/Node boundary as an Error, not a typed code. */
const REDIRECT_CAUSE = "Error: unexpected redirect";

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
 * "enter models manually".
 *
 * `redirect: "error"` is the house rule for a fetch aimed at a user-supplied
 * host — team-library.ts, drive-sync.ts and decision-client.ts all set it —
 * and here it is load-bearing rather than tidy. Every SSRF decision about
 * this base URL was made by validateProviderBaseUrl BEFORE this call, on the
 * string the user typed. `fetch` follows 3xx by default, so a base URL
 * answering 302 to `http://127.0.0.1:…` was fetched anyway, the private
 * target's body came back as a model list, and the caller's
 * `authorization: Bearer` header rode along on the first hop.
 *
 * A redirect REJECTS rather than returning an empty list, unlike every other
 * bad answer here. An empty list is what the UI already says means "the
 * endpoint answered, list the models by hand" — a redirect is not that, it is
 * "this base URL is not the address you are talking to", and the person
 * editing the form can only fix that if they are told. Rejecting is what the
 * caller turns into a 502 naming the base URL, so the distinction survives
 * the trip to the screen. */
export async function fetchProviderModelIds(
  baseUrl: string,
  apiKey: string | undefined,
  timeoutMs = 6_000,
): Promise<string[]> {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/models`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // undici reports a refused redirect as a generic `fetch failed` whose
    // cause is `unexpected redirect` — the same signal
    // server/storage-gate-harness.test.ts reads. Named here because the bare
    // message tells the person editing a provider nothing about what to fix.
    // SAFETY: a fetch rejection is an Error; `cause` is the undici-attached
    // diagnostic this comparison only stringifies — a non-Error rejection
    // stringifies to something that simply never equals REDIRECT_CAUSE.
    if (String((error as { cause?: unknown }).cause) === REDIRECT_CAUSE) {
      throw new Error(`${url.origin}${url.pathname} answered with a redirect — enter the address it redirects to as the Base URL`);
    }
    throw error;
  }
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
