import type { MockInterceptor } from "undici/types/mock-interceptor.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonValue } from "./schema.ts";
import type { AppConfig } from "./config.ts";

const API = "https://backend.composio.dev";
const MCP = "https://app.composio.dev";
const BROKER = "https://broker.muster-fixture.invalid";
const OUTSIDE = "https://outside.muster-fixture.invalid";
const KEY = "ak_synthetic_composio_fixture";
const TOKEN = "synthetic-broker-token";
const payload = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { text: "synthetic private task" } };
const goodSession = (id = "session-1", url = `${MCP}/mcp`) => ({ session_id: id, mcp: { url }, config: { user_id: "muster-existing" } });
const baseline = JSON.stringify({ composio: { userId: "muster-existing", sessionId: "missing" } });
let agent: MockAgent;
let originalDispatcher: ReturnType<typeof getGlobalDispatcher>;
let api: typeof import("./composio.ts");
let directory = "";
let outsideHits: MockInterceptor.MockResponseCallbackOptions[];
let sourceHits: MockInterceptor.MockResponseCallbackOptions[];

function cfg(sessionId = "session-1"): AppConfig {
  return { composio: { apiKey: KEY, userId: "muster-existing", sessionId } };
}

function reply(origin: string, method: string, path: string | RegExp, data: JsonValue, status = 200) {
  return agent.get(origin).intercept({ method, path }).reply(status, JSON.stringify(data), { headers: { "content-type": "application/json" } });
}

function session(data: JsonValue = goodSession(), id = "session-1", status = 200) {
  return reply(API, "GET", `/api/v3.1/tool_router/session/${id}`, data, status);
}

function redirect(origin: string, method: string, path: string | RegExp, status = 307) {
  agent.get(origin).intercept({ method, path }).reply(options => {
    sourceHits.push(options);
    return { statusCode: status, data: "", responseOptions: { headers: { location: `${OUTSIDE}/capture` } } };
  });
}

function managed() {
  vi.stubEnv("OMB_COMPOSIO_BROKER_URL", BROKER);
  vi.stubEnv("OMB_COMPOSIO_BROKER_TOKEN", TOKEN);
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "mcb-"));
  writeFileSync(join(directory, "config.json"), baseline);
  vi.stubEnv("OMB_DATA_DIR", directory);
  vi.stubEnv("OMB_COMPOSIO_API", `${API}/api/v3.1`);
  vi.stubEnv("OMB_COMPOSIO_TOOLKITS_API", `${API}/api/v3`);
  vi.stubEnv("OMB_COMPOSIO_BROKER_URL", undefined);
  vi.stubEnv("OMB_COMPOSIO_BROKER_TOKEN", undefined);
  vi.resetModules();
  api = await import("./composio.ts");
  originalDispatcher = getGlobalDispatcher();
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  outsideHits = []; sourceHits = [];
  for (const method of ["GET", "POST", "DELETE"]) {
    agent.get(OUTSIDE).intercept({ method, path: /.*/ }).reply(options => {
      outsideHits.push(options);
      return { statusCode: 200, data: JSON.stringify({ ...goodSession(), items: [{ slug: "gmail", is_no_auth: true }], services: {}, result: "outside response", redirect_url: `${MCP}/authorize`, url: `${MCP}/authorize` }), responseOptions: { headers: { "content-type": "application/json" } } };
    }).persist();
  }
});

afterEach(async () => {
  setGlobalDispatcher(originalDispatcher);
  await agent.close();
  vi.unstubAllEnvs(); vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

const rejectedSessions: Array<{ label: string; value: JsonValue }> = [
  { label: "missing session id", value: { mcp: { url: `${MCP}/mcp` } } },
  { label: "numeric session id", value: { session_id: 42, mcp: { url: `${MCP}/mcp` } } },
  { label: "empty session id", value: goodSession("") },
  { label: "invalid identity config", value: { ...goodSession(), config: { user_id: 42 } } },
  { label: "numeric MCP URL", value: { session_id: "session-1", mcp: { url: 42 } } },
  { label: "unrelated origin", value: goodSession("session-1", `${OUTSIDE}/capture`) },
  { label: "hostname suffix deception", value: goodSession("session-1", "https://composio.dev.evil.example/mcp") },
  { label: "private HTTP destination", value: goodSession("session-1", "http://127.0.0.1:7/private") },
  { label: "embedded credentials", value: goodSession("session-1", "https://synthetic-user:synthetic-password@app.composio.dev/mcp") },
  { label: "nondefault port", value: goodSession("session-1", "https://app.composio.dev:8443/mcp") },
  { label: "malformed URL", value: goodSession("session-1", "not-a-url?synthetic-private-query") },
];

describe("Composio session trust and persistence", () => {
  it.each(rejectedSessions)("rejects reused200 session: $label without recreation", async ({ value }) => {
    session(value);
    let creations = 0;
    agent.get(API).intercept({ method: "POST", path: "/api/v3.1/tool_router/session" }).reply(() => { creations++; return { statusCode: 201, data: goodSession() }; });
    const current = cfg();
    await expect(api.prepareProjectSession(KEY, current.composio)).rejects.toThrow();
    expect(current).toEqual(cfg());
    expect(creations).toBe(0);
    expect(readFileSync(join(directory, "config.json"), "utf8")).toBe(baseline);
    expect(outsideHits).toEqual([]);
  });

  it.each(rejectedSessions)("rejects created session: $label", async ({ value }) => {
    reply(API, "POST", "/api/v3.1/tool_router/session", value, 201);
    await expect(api.prepareProjectSession(KEY, { userId: "muster-existing" })).rejects.toThrow();
    expect(readFileSync(join(directory, "config.json"), "utf8")).toBe(baseline);
    expect(outsideHits).toEqual([]);
  });

  it.each(["GET", "POST"])("rejects invalid %s session JSON without echoing its contents", async method => {
    agent.get(API).intercept({ method, path: method === "GET" ? "/api/v3.1/tool_router/session/session-1" : "/api/v3.1/tool_router/session" }).reply(200, "synthetic-private-query invalid JSON", { headers: { "content-type": "application/json" } });
    const error = await api.prepareProjectSession(KEY, method === "GET" ? cfg().composio : undefined).then(() => null, reason => reason);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("synthetic-private-query");
    expect(readFileSync(join(directory, "config.json"), "utf8")).toBe(baseline);
  });

  it("does not mutate or save after valid creation until the final GET validates", async () => {
    session(null, "missing", 404).persist();
    reply(API, "POST", "/api/v3.1/tool_router/session", goodSession("created"), 201);
    session(goodSession("created", `${OUTSIDE}/capture`), "created");
    const current = cfg("missing");
    const before = structuredClone(current);
    await expect(api.relayMcp(current, payload)).rejects.toThrow();
    expect(current).toEqual(before);
    expect(readFileSync(join(directory, "config.json"), "utf8")).toBe(baseline);
    expect(outsideHits).toEqual([]);
  });

  it("recreates a404 and persists identifiers only after a valid final GET", async () => {
    session(null, "missing", 404).persist();
    reply(API, "POST", "/api/v3.1/tool_router/session", goodSession("created"), 201);
    session(goodSession("created"), "created");
    reply(MCP, "POST", "/mcp", { result: "ok" });
    const current = cfg("missing");
    expect((await api.relayMcp(current, payload)).status).toBe(200);
    expect(current.composio?.sessionId).toBe("created");
    expect(JSON.parse(readFileSync(join(directory, "config.json"), "utf8"))).toEqual({ composio: { userId: "muster-existing", sessionId: "created" } });
    expect(outsideHits).toEqual([]);
  });

  it("preserves documented app HTTPS443 endpoint, project key, body and transport headers", async () => {
    session(goodSession("session-1", `${MCP}:443/mcp`));
    agent.get(MCP).intercept({ method: "POST", path: "/mcp" }).reply(options => {
      sourceHits.push(options);
      return { statusCode: 200, data: "data: fixture\n\n", responseOptions: { headers: { "content-type": "text/event-stream", "mcp-session-id": "response-session" } } };
    });
    const result = await api.relayMcp(cfg(), payload, "request-session");
    expect(sourceHits).toHaveLength(1);
    expect(new Headers(sourceHits[0]?.headers).get("x-api-key")).toBe(KEY);
    expect(new Headers(sourceHits[0]?.headers).get("mcp-session-id")).toBe("request-session");
    expect(sourceHits[0]?.body).toBe(JSON.stringify(payload));
    expect(result).toMatchObject({ status: 200, contentType: "text/event-stream", transportSessionId: "response-session" });
    expect(new TextDecoder().decode(result.bytes)).toBe("data: fixture\n\n");
  });

  it("preserves a trusted operator HTTP loopback API override", async () => {
    vi.stubEnv("OMB_COMPOSIO_API", "http://127.0.0.1:45678/api/v3.1");
    reply("http://127.0.0.1:45678", "POST", "/api/v3.1/tool_router/session", goodSession(), 201);
    expect(await api.prepareProjectSession(KEY, { userId: "muster-existing" })).toEqual({ apiKey: KEY, userId: "muster-existing", sessionId: "session-1" });
  });
});

describe("native fetch refusal across credentialed Composio boundaries", () => {
  it.each(["lookup", "create", "relay", "managed relay", "managed request", "toolkit status", "optional accounts", "remove lookup", "account delete", "authorize", "catalog"])("does not follow307 from %s", async operation => {
    let work: Promise<unknown>;
    if (operation === "lookup") {
      redirect(API, "GET", "/api/v3.1/tool_router/session/session-1");
      work = api.prepareProjectSession(KEY, cfg().composio);
    } else if (operation === "create") {
      redirect(API, "POST", "/api/v3.1/tool_router/session");
      work = api.prepareProjectSession(KEY);
    } else if (operation === "managed relay") {
      managed(); redirect(BROKER, "POST", "/v1/mcp"); work = api.relayMcp({}, payload, "request-session");
    } else if (operation === "managed request") {
      managed(); redirect(BROKER, "POST", "/v1/connectors/gmail/authorize"); work = api.authorizeService({}, "gmail");
    } else if (operation === "catalog") {
      redirect(API, "GET", "/api/v3/toolkits?limit=500&sort_by=usage"); work = api.listToolkits(cfg());
    } else {
      session();
      if (operation === "relay") { redirect(MCP, "POST", "/mcp"); work = api.relayMcp(cfg(), payload, "request-session"); }
      else if (operation === "toolkit status" || operation === "optional accounts") {
        const toolkit = "/api/v3.1/tool_router/session/session-1/toolkits?limit=50&toolkits=gmail";
        const accounts = "/api/v3.1/connected_accounts?limit=50&user_ids=muster-existing";
        if (operation === "toolkit status") { redirect(API, "GET", toolkit); reply(API, "GET", accounts, { items: [] }); }
        else { reply(API, "GET", toolkit, { items: [{ slug: "gmail", is_no_auth: true }] }); redirect(API, "GET", accounts); }
        work = api.connectionStatus(cfg(), ["gmail"]);
      } else if (operation === "authorize") {
        redirect(API, "POST", "/api/v3.1/tool_router/session/session-1/link"); work = api.authorizeService(cfg(), "gmail");
      } else {
        const path = "/api/v3.1/tool_router/session/session-1/toolkits?limit=50&toolkits=gmail";
        if (operation === "remove lookup") redirect(API, "GET", path);
        else { reply(API, "GET", path, { items: [{ slug: "gmail", connected_account: { id: "account-1" } }] }); redirect(API, "DELETE", "/api/v3.1/connected_accounts/account-1?revoke_on_delete=true"); }
        work = api.removeService(cfg(), "gmail");
      }
    }
    if (operation === "optional accounts") expect(await work).toEqual({ gmail: { connected: true, pending: false, status: "ACTIVE" } });
    else if (operation === "catalog") expect(await work).toMatchObject({ source: "curated" });
    else await expect(work).rejects.toThrow();
    expect(sourceHits).toHaveLength(1);
    const headers = new Headers(sourceHits[0]?.headers);
    expect(headers.get(operation.startsWith("managed") ? "authorization" : "x-api-key")).toBe(operation.startsWith("managed") ? `Bearer ${TOKEN}` : KEY);
    expect(outsideHits).toEqual([]);
  });
});

describe("Composio authorization URL trust", () => {
  it.each(["direct", "managed"])("rejects userinfo, nondefault port and malformed links in %s mode", async mode => {
    for (const url of ["https://synthetic-user:synthetic-password@app.composio.dev/auth", "https://app.composio.dev:8443/auth", "malformed?synthetic-private-query"]) {
      if (mode === "managed") { managed(); reply(BROKER, "POST", "/v1/connectors/gmail/authorize", { url }); }
      else { session(); reply(API, "POST", "/api/v3.1/tool_router/session/session-1/link", { redirect_url: url }); }
      const error = await api.authorizeService(cfg(), "gmail").then(() => null, reason => reason);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toMatch(/synthetic-user|synthetic-password|synthetic-private-query/);
    }
    expect(outsideHits).toEqual([]);
  });
});
