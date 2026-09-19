import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configured, mcpIntegration, toolGuidance, connectionStatus, authorizeService } from "./connected-apps.ts";
import type { AppConfig } from "./config.ts";

const context = { harnessUrl: "http://127.0.0.1:18888", commsToken: "owned-ephemeral", botId: "bot", threadId: "thread" };
const cfg: AppConfig = { instances: {}, openConnector: { url: "https://runtime.example.test", token: "owned-runtime" }, composio: { apiKey: "owned-composio" } };

beforeEach(() => {
  vi.stubEnv("OMB_OPENCONNECTOR_URL", "");
  vi.stubEnv("OMB_OPENCONNECTOR_TOKEN", "");
  vi.stubEnv("OMB_COMPOSIO_BROKER_URL", "");
  vi.stubEnv("OMB_COMPOSIO_BROKER_TOKEN", "");
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it("chooses the runtime for status and authorization when both backends are configured", async () => {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: ["googlecalendar"] })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: { authorizationUrl: "https://consent.example.test" } })));
  vi.stubGlobal("fetch", fetchMock);
  expect((await connectionStatus(cfg, ["googlecalendar"])).googlecalendar.connected).toBe(true);
  expect(await authorizeService(cfg, "googlecalendar")).toEqual({ url: "https://consent.example.test" });
  for (const [url, init] of fetchMock.mock.calls) {
    expect(String(url)).toMatch(/^https:\/\/runtime\.example\.test\//);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer owned-runtime");
    expect(new Headers(init?.headers).has("x-api-key")).toBe(false);
  }
  expect(toolGuidance(cfg)).not.toContain("COMPOSIO_SEARCH_TOOLS");
});

it("keeps the Composio bridge when no runtime is configured without exposing its project key", async () => {
  const fallback: AppConfig = { instances: {}, composio: { apiKey: "owned-composio" } };
  expect(configured(fallback)).toBe(true);
  const integration = await mcpIntegration(fallback, context);
  expect(integration?.env.OMB_CONNECTOR_UPSTREAM_URL).toBe(`${context.harnessUrl}/api/internal/connectors/mcp`);
  expect(JSON.stringify(integration)).not.toContain("owned-composio");
  expect(toolGuidance(fallback)).toContain("COMPOSIO_SEARCH_TOOLS");
});

it("does not mount a bridge when neither backend is configured", async () => {
  const empty: AppConfig = { instances: {} };
  expect(configured(empty)).toBe(false);
  expect(await mcpIntegration(empty, context)).toBeNull();
});

it("does not silently switch to Composio after a configured runtime fails", async () => {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ success: false, message: "Runtime temporarily unavailable" }), { status: 503 }));
  vi.stubGlobal("fetch", fetchMock);
  await expect(authorizeService(cfg, "googlecalendar")).rejects.toThrow("Runtime temporarily unavailable");
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
