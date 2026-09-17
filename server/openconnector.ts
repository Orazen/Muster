// The Muster Connector: an own-branded backend for connected apps backed by
// a self-hosted OpenConnector runtime (github.com/oomol-lab/open-connector).
// Its runtime API is the contract: Bearer runtime token, `{success,data}`
// envelope, GET /v1/providers (catalog), GET /v1/apps/authenticated
// (connection checks), POST /v1/connections/{service}/connect (+ /api-key,
// + /custom-credential) with GET /api/connection-requests/{id} polling for
// OAuth, POST /v1/actions/{actionId} for execution, POST /mcp for tools.
// OpenConnector has no runtime DELETE for disconnects — a disconnect here
// means Muster stops advertising that service to its agents.
import { SPAWNED_PROXIES } from "./proxy-paths.ts";
import type { AppConfig } from "./config.ts";
import type { JsonValue } from "./schema.ts";
import { z } from "zod";

interface OpenConnectorConfig {
  url: string;
  token: string;
}

/** The runtime base URL + token. Config only, or env for headless boots —
 * the token is a runtime credential and never rendered back to the UI. */
function access(cfg: AppConfig): OpenConnectorConfig | null {
  const url = (cfg.openConnector?.url ?? process.env.OMB_OPENCONNECTOR_URL ?? "").trim().replace(/\/$/, "");
  const token = (cfg.openConnector?.token ?? process.env.OMB_OPENCONNECTOR_TOKEN ?? "").trim();
  if (!url || !token) return null;
  const parsed = new URL(url);
  // The runtime can be local (loopback) or remote; remote must be HTTPS —
  // the same rule the Composio broker enforces.
  if (parsed.protocol !== "https:" && parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
    throw new Error("The Muster Connector runtime must use HTTPS");
  }
  return { url, token };
}

export function configured(cfg: AppConfig): boolean {
  return access(cfg) !== null;
}

async function request(cfg: AppConfig, path: string, init?: RequestInit): Promise<Response> {
  const backend = access(cfg);
  if (!backend) throw new Error("The Muster Connector is unavailable");
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set("content-type", "application/json");
  // The runtime credential is set last: call sites may add their own
  // headers (the MCP relay's session id), but they cannot override the
  // credential. Headers construction also normalizes any caller object.
  headers.set("authorization", `Bearer ${backend.token}`);
  return fetch(`${backend.url}${path}`, {
    ...init,
    headers,
    signal: init?.signal ?? AbortSignal.timeout(30_000),
  });
}

const runtimeEnvelopeSchema = z.object({ data: z.unknown().optional() });
const runtimeFailureSchema = z.object({ message: z.string().optional() });

/** Unwrap the runtime envelope. Failures surface the runtime's message. */
async function envelope<T>(res: Response, fallback: string): Promise<T> {
  const raw = await res.text().catch(() => "");
  // SAFETY: JSON.parse of arbitrary runtime bytes IS the boundary; the
  // result is held at JsonValue and every read below goes through zod.
  // SAFETY: the parse-to-JsonValue cast records the boundary contract.
  const body: JsonValue = (() => { try { return raw ? JSON.parse(raw) as JsonValue : null; } catch { return null; } })();
  if (!res.ok) {
    const failure = runtimeFailureSchema.catch({}).parse(body).message ?? raw.trim().slice(0, 300);
    throw new Error(`${fallback}${failure ? `: ${failure}` : ` (HTTP ${res.status})`}`);
  }
  const parsed = runtimeEnvelopeSchema.safeParse(body);
  if (!parsed.success) throw new Error(`${fallback}: malformed runtime response`);
  // SAFETY: the generic is each call site's named contract for the `data`
  // payload; the envelope itself is validated by runtimeEnvelopeSchema.
  return parsed.data.data as T;
}

// ── catalog ──────────────────────────────────────────────────────────────
const providerSchema = z.object({
  service: z.string(),
  displayName: z.string(),
  iconUrl: z.string().nullable(),
  homepageUrl: z.string().nullable(),
});

export interface ToolkitCard {
  slug: string;
  label: string;
  blurb: string;
  logo: string | null;
  /** used for the client-side favicon fallback when logo is null/broken */
  domain: string | null;
}

/** The marketplace catalog: every provider the runtime ships, alphabetized.
 * Blurb falls back to the scenario/homepage facts the catalog row carries. */
export async function listToolkits(cfg: AppConfig): Promise<{ cards: ToolkitCard[]; source: "api" }> {
  const rows = await envelope<unknown[]>(await request(cfg, "/v1/providers"), "Muster Connector catalog");
  const cards = (Array.isArray(rows) ? rows : []).flatMap((row) => {
    const parsed = providerSchema.safeParse(row);
    if (!parsed.success) return [];
    const { service, displayName, iconUrl, homepageUrl } = parsed.data;
    const domain = homepageUrl ? safeHost(homepageUrl) : null;
    return [{
      slug: service,
      label: displayName,
      blurb: domain ? `Connect your ${displayName} account` : `Connect ${displayName}`,
      logo: iconUrl,
      domain,
    }];
  });
  cards.sort((a, b) => a.label.localeCompare(b.label));
  return { cards, source: "api" };
}

function safeHost(value: string): string | null {
  try { return new URL(value).hostname; } catch { return null; }
}

// ── connections ──────────────────────────────────────────────────────────
/** Connection state per service slug: { slack: { connected, status } }.
 * One `/v1/apps/authenticated` call answers every candidate at once. */
export async function connectionStatus(cfg: AppConfig, slugs: string[]): Promise<Record<string, { connected: boolean; pending?: boolean; status?: string }>> {
  if (!slugs.length) return {};
  const params = new URLSearchParams();
  for (const slug of slugs) params.append("service", slug);
  const authenticated = await envelope<string[]>(
    await request(cfg, `/v1/apps/authenticated?${params.toString()}`),
    "Muster Connector connection check",
  );
  const connectedSet = new Set(Array.isArray(authenticated) ? authenticated : []);
  return Object.fromEntries(slugs.map((slug) => [slug, {
    connected: connectedSet.has(slug),
    status: connectedSet.has(slug) ? "ACTIVE" : "not_connected",
  }]));
}

/** Start the OAuth consent for one service. Returns { url } for the browser.
 * The runtime binds the flow to a connection request; the redirect lands on
 * its own console/completion page and the poll below sees the connection. */
export async function authorizeService(cfg: AppConfig, slug: string) {
  const started = await envelope<{ authorizationUrl?: string }>(
    await request(cfg, `/v1/connections/${encodeURIComponent(slug)}/connect`, {
      method: "POST",
      body: JSON.stringify({ connectionName: `muster-${slug}-${Date.now().toString(36)}` }),
    }),
    `Muster Connector connect for ${slug}`,
  );
  const url = started.authorizationUrl;
  if (!url) throw new Error(`The Muster Connector returned no authorization link for ${slug}`);
  return { url };
}

/** No runtime disconnect exists: a disconnect means Muster stops
 * advertising the service; the runtime keeps no deletion endpoint. */
export async function removeService(_cfg: AppConfig, _slug: string) {
  return { removed: 0 };
}

/** Execution and tools both ride the runtime: actions by id, MCP at /mcp.
 * The result schema is action-specific, so callers receive the runtime's
 * JSON envelope data as JsonValue and validate against the action's own
 * output schema. */
export async function runAction(cfg: AppConfig, actionId: string, input: JsonValue): Promise<JsonValue> {
  return envelope(await request(cfg, `/v1/actions/${encodeURIComponent(actionId)}`, {
    method: "POST",
    body: JSON.stringify(input ?? {}),
  }), `Muster Connector action ${actionId}`);
}

export function mcpIntegration(_cfg: AppConfig, context: {
  harnessUrl: string;
  commsToken: string;
  botId: string;
  threadId: string;
}) {
  return {
    command: process.execPath,
    args: [SPAWNED_PROXIES.connectors],
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      // The provider-facing bridge receives only this boot's loopback token.
      // Runtime credentials stay in the harness process, so a coding agent
      // that prints its environment cannot export a durable secret.
      OMB_CONNECTOR_UPSTREAM_URL: `${context.harnessUrl}/api/internal/connectors/mcp`,
      OMB_CONNECTOR_UPSTREAM_HEADERS: JSON.stringify({ authorization: `Bearer ${context.commsToken}` }),
      OMB_HARNESS_URL: context.harnessUrl,
      OMB_COMMS_TOKEN: context.commsToken,
      OMB_BOT_ID: context.botId,
      OMB_THREAD_ID: context.threadId,
    },
  };
}

/** Relay an MCP payload to the runtime's MCP endpoint. */
export async function relayMcp(
  cfg: AppConfig,
  payload: JsonValue,
  transportSessionId?: string,
): Promise<{ status: number; bytes: Uint8Array; contentType: string; transportSessionId?: string }> {
  const headers = new Headers({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  });
  if (transportSessionId) headers.set("mcp-session-id", transportSessionId);
  const response = await request(cfg, "/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10 * 60_000),
  });
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > 20 * 1024 * 1024) throw new Error("Connected-app response exceeded 20 MB");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 20 * 1024 * 1024) throw new Error("Connected-app response exceeded 20 MB");
  return {
    status: response.status,
    bytes,
    contentType: response.headers.get("content-type") ?? "application/json",
    transportSessionId: response.headers.get("mcp-session-id") ?? undefined,
  };
}
