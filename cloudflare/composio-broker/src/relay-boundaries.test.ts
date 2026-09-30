import type { MockInterceptor } from "undici/types/mock-interceptor.js";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, Headers as MockHeaders } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { sha256 } from "./index";

type WireValue = string | number | boolean | null | WireValue[] | WireObject;
interface WireObject { [key: string]: WireValue }

const API = "https://backend.composio.dev";
const MCP = "https://app.composio.dev";
const OUTSIDE = "https://outside.muster-fixture.invalid";
const KEY = "synthetic-broker-project-key";
const TOKEN = "a".repeat(64);
const BODY = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { text: "synthetic private task" } });
const good = (id = "session-1", url = `${MCP}/mcp`) => ({ session_id: id, mcp: { url, headers: { "x-session": "synthetic-session-header", "X-API-KEY": "synthetic-upstream-key", host: "untrusted-host" } } });
let agent: MockAgent;
let previous: ReturnType<typeof getGlobalDispatcher>;
let tokenHash = "";
let sessionId: string | null;
let databaseReads: number;
let writes: Array<{ sql: string; values: unknown[] }>;
let waiters: Promise<unknown>[];
let outsideHits: MockInterceptor.MockResponseCallbackOptions[];
let sourceHits: MockInterceptor.MockResponseCallbackOptions[];
let errors: string[];

function reply(origin: string, method: string, path: string | RegExp, value: WireValue, status = 200) {
  return agent.get(origin).intercept({ method, path }).reply(status, JSON.stringify(value), { headers: { "content-type": "application/json" } });
}

function lookup(value: WireValue = good(), status = 200) {
  return reply(API, "GET", "/api/v3.1/tool_router/session/session-1", value, status);
}

function redirect(origin: string, method: string, path: string | RegExp, status = 307) {
  agent.get(origin).intercept({ method, path }).reply(options => {
    sourceHits.push(options);
    return { statusCode: status, data: "", responseOptions: { headers: { location: `${OUTSIDE}/capture` } } };
  });
}

function database(): D1Database {
  return {
    prepare(sql: string) {
      let values: unknown[] = [];
      const statement: D1PreparedStatement = {
        bind(...input: unknown[]) { values = input; return statement; },
        async first<T>(column?: string): Promise<T | null> {
          expect(column).toBeUndefined();
          expect(sql).toBe("SELECT id, composio_user_id, session_id, disabled_at FROM installations WHERE token_hash = ?");
          databaseReads++;
          if (values[0] !== tokenHash) return null;
          const row = { id: "installation-1", composio_user_id: "user-1", session_id: sessionId, disabled_at: null };
          // SAFETY: D1's caller-specified generic represents the exact selected
          // row; this fixture rejects every query except that verified shape.
          return row as T;
        },
        async run<T>(): Promise<D1Result<T>> {
          expect(sql).toMatch(/^UPDATE installations SET (session_id = \?, )?last_seen_at = \? WHERE id = \?$/);
          expect(values.at(-1)).toBe("installation-1");
          writes.push({ sql, values });
          return { success: true, results: [], meta: { duration: 0, size_after: 0, rows_read: 0, rows_written: 1, last_row_id: 0, changed_db: true, changes: 1 } };
        },
        all() { throw new Error("unexpected fixture D1 all"); },
        raw() { throw new Error("unexpected fixture D1 raw"); },
      };
      return statement;
    },
    batch() { throw new Error("unexpected fixture D1 batch"); },
    exec() { throw new Error("unexpected fixture D1 exec"); },
    withSession() { throw new Error("unexpected fixture D1 withSession"); },
    dump() { throw new Error("unexpected fixture D1 dump"); },
  };
}

async function request(path = "/v1/mcp", authorized = true, method = "POST") {
  const env: Env = {
    COMPOSIO_API_KEY: KEY,
    COMPOSIO_API_BASE: "https://backend.composio.dev/api/v3.1",
    COMPOSIO_TOOLKIT_BASE: "https://backend.composio.dev/api/v3",
    REGISTRATION_MODE: "open",
    REGISTRATION_LIMITER: { limit: async () => ({ success: true }) },
    SESSION_LIMITER: { limit: async () => ({ success: true }) },
    DB: database(),
  };
  const ctx = { waitUntil(promise: Promise<unknown>) { waiters.push(promise); } };
  const headers = new Headers({ "content-type": "application/json", "mcp-session-id": "client-session" });
  if (authorized) headers.set("authorization", `Bearer ${TOKEN}`);
  const init: RequestInit = { method, headers };
  if (method === "POST") init.body = BODY;
  const req = new Request(`https://broker.muster-fixture.invalid${path}`, init);
  // SAFETY: worker routes use only waitUntil, whose promises are drained.
  const context = ctx as ExecutionContext;
  return worker.fetch(req, env, context);
}

beforeEach(async () => {
  tokenHash = await sha256(TOKEN);
  sessionId = "session-1"; databaseReads = 0; writes = []; waiters = []; outsideHits = []; sourceHits = []; errors = [];
  vi.spyOn(console, "error").mockImplementation((...values) => { errors.push(values.map(String).join(" ")); });
  previous = getGlobalDispatcher();
  agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
  for (const method of ["GET", "POST"]) {
    agent.get(OUTSIDE).intercept({ method, path: /.*/ }).reply(options => {
      outsideHits.push(options);
      return { statusCode: 200, data: JSON.stringify({ ...good(), result: "outside response", items: [] }), responseOptions: { headers: { "content-type": "application/json" } } };
    }).persist();
  }
});

afterEach(async () => {
  await Promise.all(waiters);
  setGlobalDispatcher(previous); await agent.close(); vi.restoreAllMocks();
});

describe("authenticated worker relay boundaries with native fetch", () => {
  it("rejects unauthenticated requests before D1 or HTTP", async () => {
    expect((await request("/v1/mcp", false)).status).toBe(401);
    expect(databaseReads).toBe(0); expect(writes).toEqual([]); expect(outsideHits).toEqual([]);
  });

  it.each([
    { label: "untrusted origin", value: good("session-1", `${OUTSIDE}/capture`) },
    { label: "empty id", value: good("") },
    { label: "wrong envelope", value: { session_id: 42, mcp: { url: `${MCP}/mcp` } } },
    { label: "userinfo", value: good("session-1", "https://synthetic-user:synthetic-password@app.composio.dev/mcp") },
    { label: "nondefault port", value: good("session-1", "https://app.composio.dev:8443/mcp") },
    { label: "malformed URL", value: good("session-1", "malformed?synthetic-private-query") },
  ])("refuses invalid reused200 $label without recreation or D1 update", async ({ value }) => {
    lookup(value);
    let creations = 0;
    agent.get(API).intercept({ method: "POST", path: "/api/v3.1/tool_router/session" }).reply(() => { creations++; return { statusCode: 201, data: good() }; });
    expect((await request()).status).toBe(503);
    expect(creations).toBe(0); expect(writes).toEqual([]); expect(outsideHits).toEqual([]);
    expect(errors.join(" ")).not.toMatch(/synthetic-user|synthetic-password|synthetic-private-query/);
  });

  it.each(["lookup", "create"])("rejects invalid JSON during %s without disclosing body or saving", async operation => {
    if (operation === "create") sessionId = null;
    agent.get(API).intercept({ method: operation === "lookup" ? "GET" : "POST", path: operation === "lookup" ? "/api/v3.1/tool_router/session/session-1" : "/api/v3.1/tool_router/session" }).reply(200, "synthetic-private-query invalid JSON", { headers: { "content-type": "application/json" } });
    const response = await request();
    expect(response.status).toBe(503);
    expect(errors.join(" ")).not.toContain("synthetic-private-query");
    expect(writes).toEqual([]); expect(outsideHits).toEqual([]);
  });

  it("does not persist an invalid newly created session", async () => {
    sessionId = null;
    reply(API, "POST", "/api/v3.1/tool_router/session", good("created", `${OUTSIDE}/capture`), 201);
    expect((await request()).status).toBe(503);
    expect(writes).toEqual([]); expect(outsideHits).toEqual([]);
  });

  it("recreates only404 and persists the validated session ID", async () => {
    lookup(null, 404);
    reply(API, "POST", "/api/v3.1/tool_router/session", good("created"), 201);
    reply(MCP, "POST", "/mcp", { result: "ok" });
    expect((await request()).status).toBe(200);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.sql).toContain("session_id = ?");
    expect(writes[0]?.values[0]).toBe("created");
    expect(outsideHits).toEqual([]);
  });

  it("preserves direct HTTPS443 MCP credentials, request body and session response", async () => {
    lookup(good("session-1", `${MCP}:443/mcp`));
    agent.get(MCP).intercept({ method: "POST", path: "/mcp" }).reply(options => {
      sourceHits.push(options);
      return { statusCode: 200, data: "data: fixture\n\n", responseOptions: { headers: { "content-type": "text/event-stream", "mcp-session-id": "response-session" } } };
    });
    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("data: fixture\n\n");
    expect(response.headers.get("mcp-session-id")).toBe("response-session");
    expect(sourceHits).toHaveLength(1);
    const headers = new MockHeaders(sourceHits[0]?.headers);
    expect(headers.get("x-api-key")).toBe(KEY);
    expect(headers.get("x-session")).toBe("synthetic-session-header");
    expect(headers.get("mcp-session-id")).toBe("client-session");
    expect(headers.get("host")).not.toBe("untrusted-host");
    // SAFETY: the worker passes its request.arrayBuffer() body unchanged;
    // the native-fetch MockAgent callback receives that same ArrayBuffer.
    expect(new TextDecoder().decode(sourceHits[0]?.body as ArrayBuffer)).toBe(BODY);
  });

  it.each(["lookup", "create", "catalog", "relay307", "relay308"])("refuses credentialed redirect from %s before outside dispatch", async operation => {
    if (operation === "lookup") redirect(API, "GET", "/api/v3.1/tool_router/session/session-1");
    else if (operation === "create") { sessionId = null; redirect(API, "POST", "/api/v3.1/tool_router/session"); }
    else if (operation === "catalog") redirect(API, "GET", "/api/v3/toolkits?limit=500&sort_by=usage");
    else { lookup(); redirect(MCP, "POST", "/mcp", operation === "relay308" ? 308 : 307); }
    const response = await request(operation === "catalog" ? "/v1/catalog" : "/v1/mcp", true, operation === "catalog" ? "GET" : "POST");
    expect(response.status).toBe(503);
    expect(sourceHits).toHaveLength(1);
    expect(new MockHeaders(sourceHits[0]?.headers).get("x-api-key")).toBe(KEY);
    expect(outsideHits).toEqual([]);
    expect(errors.join(" ")).not.toContain(KEY);
  });

  it.each(["https://synthetic-user:synthetic-password@app.composio.dev/auth", "https://app.composio.dev:8443/auth", "malformed?synthetic-private-query"])("rejects untrusted authorization link %s", async url => {
    lookup(); reply(API, "POST", "/api/v3.1/tool_router/session/session-1/link", { redirect_url: url });
    const response = await request("/v1/connectors/gmail/authorize");
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(await response.text()).not.toMatch(/synthetic-user|synthetic-password|synthetic-private-query/);
    expect(errors.join(" ")).not.toMatch(/synthetic-user|synthetic-password|synthetic-private-query/);
    expect(outsideHits).toEqual([]);
  });
});
