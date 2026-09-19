// Backend selection shared by bot dispatch and connection cards. Settings
// already prefers OpenConnector; a task must use that same configured backend.
import type { AppConfig } from "./config.ts";
import * as composio from "./composio.ts";
import * as openconnector from "./openconnector.ts";

export function configured(cfg: AppConfig): boolean {
  return openconnector.configured(cfg) || composio.configured(cfg);
}

export function mcpIntegration(cfg: AppConfig, context: Parameters<typeof composio.mcpIntegration>[1]) {
  return openconnector.configured(cfg)
    ? openconnector.mcpIntegration(cfg, context)
    : composio.mcpIntegration(cfg, context);
}

export function connectionStatus(cfg: AppConfig, slugs: string[]) {
  return openconnector.configured(cfg)
    ? openconnector.connectionStatus(cfg, slugs)
    : composio.connectionStatus(cfg, slugs);
}

export function authorizeService(cfg: AppConfig, slug: string) {
  return openconnector.configured(cfg)
    ? openconnector.authorizeService(cfg, slug)
    : composio.authorizeService(cfg, slug);
}

export async function toolkitCard(cfg: AppConfig, slug: string): Promise<composio.ToolkitCard> {
  if (!openconnector.configured(cfg)) return composio.toolkitCard(cfg, slug);
  const { cards } = await openconnector.listToolkits(cfg);
  return cards.find((card) => card.slug === slug)
    ?? { slug, label: slug, blurb: `Connect ${slug} so the bot can continue`, logo: null, domain: null };
}

export function toolGuidance(cfg: AppConfig): string {
  return openconnector.configured(cfg)
    ? " Connected-app tools are available through Muster Connector. Inspect the mounted tools and their schemas to find the requested service; do not assume Composio tool names exist. Use only the user's granted connections and permissions. If the service is unavailable, explain the missing connection instead of inventing its data."
    : " The user's connected apps (Gmail, Calendar, Slack, Notion, and the rest) are reachable through the composio tools — find the right one with COMPOSIO_SEARCH_TOOLS, read its arguments with COMPOSIO_GET_TOOL_SCHEMAS, then run it with COMPOSIO_MULTI_EXECUTE_TOOL. Reach for them before telling the user you have no access to a service.";
}
