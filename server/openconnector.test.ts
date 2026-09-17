// Pins for the Muster Connector transport: every call carries the Bearer
// runtime token, the runtime envelope is unwrapped once, failures surface
// the runtime's own message, and HTTPS is enforced for remote runtimes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authorizeService, configured, connectionStatus, listToolkits, relayMcp, runAction } from "./openconnector.ts";
import type { AppConfig } from "./config.ts";
import type { JsonValue } from "./schema.ts";

const fetchMock = vi.fn<typeof fetch>();
// SAFETY: the transport reads only cfg.openConnector; the cast builds that
// one slice instead of a whole fixture config.
const cfg = (env: Record<string, string> = {}) => ({
  openConnector: { url: env.url ?? "https://connector.example.com", token: env.token ?? "runtime-token-1" },
}) as AppConfig;

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const ok = (data: JsonValue) => new Response(JSON.stringify({ success: true, message: "OK", data, meta: {} }), { status: 200, headers: { "content-type": "application/json" } });

describe("Muster Connector (OpenConnector runtime)", () => {
  it("is unconfigured without url+token and refuses non-HTTPS remote runtimes", () => {
    // SAFETY: the transport reads only cfg.openConnector, so a one-slice
    // object literal satisfies the AppConfig parameter for negative cases.
    const empty = {} as AppConfig;
    expect(configured(empty)).toBe(false);
    // SAFETY: this slice carries the non-HTTPS url the guard must reject.
    const insecure = { openConnector: { url: "http://connector.example.com", token: "t" } } as AppConfig;
    expect(() => configured(insecure)).toThrow(/HTTPS/);
    expect(configured(cfg())).toBe(true);
  });

  it("lists the catalog as branded cards from /v1/providers with the Bearer token", async () => {
    fetchMock.mockResolvedValueOnce(ok([
      { service: "github", displayName: "GitHub", iconUrl: "https://x/gh.png", homepageUrl: "https://github.com", scenario: "dev", categories: [], authTypes: ["oauth2"] },
      { service: "notion", displayName: "Notion", iconUrl: null, homepageUrl: "https://notion.so", scenario: "docs", categories: [], authTypes: ["oauth2"] },
      { service: "broken-row", displayName: 42 },
    ]));
    const { cards, source } = await listToolkits(cfg());
    expect(fetchMock.mock.calls[0][0]).toBe("https://connector.example.com/v1/providers");
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("authorization")).toBe("Bearer runtime-token-1");
    expect(source).toBe("api");
    expect(cards).toEqual([
      { slug: "github", label: "GitHub", blurb: "Connect your GitHub account", logo: "https://x/gh.png", domain: "github.com" },
      { slug: "notion", label: "Notion", blurb: "Connect your Notion account", logo: null, domain: "notion.so" },
    ]);
  });

  it("answers connection status for every candidate in one authenticated call", async () => {
    fetchMock.mockResolvedValueOnce(ok(["github"]));
    const status = await connectionStatus(cfg(), ["github", "slack"]);
    expect(fetchMock.mock.calls[0][0]).toBe("https://connector.example.com/v1/apps/authenticated?service=github&service=slack");
    expect(status).toEqual({ github: { connected: true, status: "ACTIVE" }, slack: { connected: false, status: "not_connected" } });
  });

  it("starts an OAuth connection and surfaces the runtime's authorization link", async () => {
    fetchMock.mockResolvedValueOnce(ok({ authorizationUrl: "https://runtime.example.com/oauth/github?state=s1", connectionRequestId: "cr-1", status: "initiated" }));
    const { url } = await authorizeService(cfg(), "github");
    expect(url).toBe("https://runtime.example.com/oauth/github?state=s1");
    const [url_, init] = fetchMock.mock.calls[0];
    expect(String(url_)).toBe("https://connector.example.com/v1/connections/github/connect");
    expect(init?.method).toBe("POST");
    expect(String(init?.body)).toContain("connectionName");
  });

  it("runs an action through POST /v1/actions/{id} with the input as the body", async () => {
    fetchMock.mockResolvedValueOnce(ok({ result: "done" }));
    await expect(runAction(cfg(), "github.create_issue", { title: "hi" })).resolves.toEqual({ result: "done" });
    expect(fetchMock.mock.calls[0][0]).toBe("https://connector.example.com/v1/actions/github.create_issue");
    expect(String(fetchMock.mock.calls[0][1]?.body)).toBe(JSON.stringify({ title: "hi" }));
  });

  it("surfaces the runtime's own failure message instead of a generic error", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ success: false, message: "oauth_client_config_required" }), { status: 400 }));
    await expect(authorizeService(cfg(), "github")).rejects.toThrow(/oauth_client_config_required/);
  });

  it("relays MCP to the runtime with the session id forwarded", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ jsonrpc: "2.0", result: {} }), { status: 200, headers: { "content-type": "application/json", "mcp-session-id": "sess-9" } }));
    const relayed = await relayMcp(cfg(), { jsonrpc: "2.0", method: "tools/list" }, "sess-1");
    expect(fetchMock.mock.calls[0][0]).toBe("https://connector.example.com/mcp");
    // SAFETY: the relay passes a Headers instance; read the wire values
    // back through the Headers API rather than property access.
    const sentHeaders = new Headers(fetchMock.mock.calls[0][1]?.headers ?? undefined);
    expect(sentHeaders.get("mcp-session-id")).toBe("sess-1");
    expect(sentHeaders.get("authorization")).toBe("Bearer runtime-token-1");
    expect(relayed.transportSessionId).toBe("sess-9");
    expect(relayed.status).toBe(200);
  });
});
