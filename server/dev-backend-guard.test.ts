import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createDevBackendGuard, devBackendPreview, type DevBackendEnvironment } from "../scripts/dev-backend-guard.ts";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
const servers: Server[] = [];
let created = 0;
let closed = 0;
interface FixtureBody { app?: string; pid?: string | number; ok?: boolean }

async function listen(handler: Handler): Promise<number> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  created += 1;
  return z.object({ port: z.number() }).parse(server.address()).port;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
    expect(server.listening).toBe(false);
    closed += 1;
  }
});

afterAll(() => {
  expect(closed).toBe(created);
  console.log(JSON.stringify({ scope: "owned dev-backend guard fixtures", serversCreated: created, serversClosed: closed, processesSpawned: 0 }));
});

function json(res: ServerResponse, body: FixtureBody, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function preview(environment: DevBackendEnvironment, upstream: number, timeoutMs = 200) {
  const guard = createDevBackendGuard(environment, { timeoutMs });
  let forwarded = 0;
  const port = await listen((req, res) => guard(req, res, () => {
    forwarded += 1;
    if (!req.url?.startsWith("/api")) { res.end("owned preview page"); return; }
    const outgoing = request({ hostname: "127.0.0.1", port: upstream, method: req.method, path: req.url, headers: req.headers }, (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
    });
    outgoing.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(outgoing);
  }));
  return { port, forwarded: () => forwarded };
}

async function post(port: number, path = "/api/bots/owned/messages") {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST", body: "exact owned body", redirect: "manual",
    headers: { cookie: "owned-cookie=fixture", authorization: "Bearer owned-fixture" },
    signal: AbortSignal.timeout(3_000),
  });
}

describe("development backend identity boundary", () => {
  it.each([undefined, "", "0", "65536", "5199/evil", "NaN", "1.5"])("does not forward any API request for missing/invalid explicit port %s", async (portValue) => {
    let upstreamCalls = 0;
    const upstream = await listen((_req, res) => { upstreamCalls += 1; json(res, { app: "muster", pid: 101 }); });
    const front = await preview({ OMB_PORT: portValue }, upstream);
    const response = await post(front.port);
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("Set OMB_PORT (or OGB_PORT)");
    expect(front.forwarded()).toBe(0);
    expect(upstreamCalls).toBe(0);
  });

  it.each([
    { app: "OpenMausBot", pid: 101 }, { pid: 101 }, { app: "muster" },
    { app: "muster", pid: 0 }, { app: "muster", pid: -1 }, { app: "muster", pid: 1.5 },
    { app: "muster", pid: "101" },
  ])("refuses unrecognized backend identity %# without forwarding body or credentials", async (health) => {
    const paths: string[] = [];
    const upstream = await listen((req, res) => {
      paths.push(req.url ?? "");
      expect(req.method).toBe("GET");
      expect(req.headers.cookie).toBeUndefined();
      expect(req.headers.authorization).toBeUndefined();
      expect(req.headers["cache-control"]).toBe("no-store");
      json(res, health);
    });
    const front = await preview({ OMB_PORT: String(upstream) }, upstream);
    const response = await post(front.port);
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(front.forwarded()).toBe(0);
    expect(paths).toEqual(["/api/health"]);
  });

  it("does not follow a health redirect or send the pending POST", async () => {
    let sinkCalls = 0;
    const sink = await listen((_req, res) => { sinkCalls += 1; json(res, { app: "muster", pid: 101 }); });
    const upstream = await listen((_req, res) => { res.writeHead(302, { location: `http://127.0.0.1:${sink}/api/health` }); res.end(); });
    const front = await preview({ OMB_PORT: String(upstream) }, upstream);
    expect((await post(front.port)).status).toBe(503);
    expect(sinkCalls).toBe(0);
    expect(front.forwarded()).toBe(0);
  });

  it.each(["invalid-json", "large-body", "http-error"])("rejects %s health responses before proxying", async (mode) => {
    const upstream = await listen((_req, res) => {
      if (mode === "http-error") json(res, { app: "muster", pid: 101 }, 503);
      else res.end(mode === "large-body" ? "x".repeat(16_385) : "<html>not JSON</html>");
    });
    const front = await preview({ OMB_PORT: String(upstream) }, upstream);
    expect((await post(front.port)).status).toBe(503);
    expect(front.forwarded()).toBe(0);
  });

  it("bounds a stalled health request and never forwards its pending POST", async () => {
    let calls = 0;
    const upstream = await listen(() => { calls += 1; });
    const front = await preview({ OMB_PORT: String(upstream) }, upstream, 40);
    const response = await post(front.port);
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("timed out");
    expect(calls).toBe(1);
    expect(front.forwarded()).toBe(0);
  });

  it("forwards a healthy explicit request unchanged only after a credential-free health read", async () => {
    const seen: { path: string; method: string; cookie?: string; authorization?: string; body: string }[] = [];
    const upstream = await listen((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => { body += chunk; });
      req.on("end", () => {
        seen.push({ path: req.url ?? "", method: req.method ?? "", cookie: req.headers.cookie, authorization: req.headers.authorization, body });
        json(res, req.url === "/api/health" ? { app: "muster", pid: 101 } : { ok: true }, req.url === "/api/health" ? 200 : 202);
      });
    });
    const front = await preview({ OGB_PORT: String(upstream) }, upstream);
    expect((await post(front.port, "/api?owned=1")).status).toBe(202);
    expect(front.forwarded()).toBe(1);
    expect(seen).toEqual([
      { path: "/api/health", method: "GET", cookie: undefined, authorization: undefined, body: "" },
      { path: "/api?owned=1", method: "POST", cookie: "owned-cookie=fixture", authorization: "Bearer owned-fixture", body: "exact owned body" },
    ]);
  });

  it("pins the first PID, refuses a later replacement, and permits it only in a new preview", async () => {
    let pid = 101;
    let writes = 0;
    const upstream = await listen((req, res) => {
      if (req.url === "/api/health") json(res, { app: "muster", pid });
      else { writes += 1; json(res, { ok: true }); }
    });
    const environment = { OMB_PORT: String(upstream) };
    const first = await preview(environment, upstream);
    expect((await post(first.port)).status).toBe(200);
    pid = 202;
    const blocked = await post(first.port);
    expect(blocked.status).toBe(503);
    expect(await blocked.text()).toContain("process changed");
    expect(writes).toBe(1);
    const restarted = await preview(environment, upstream);
    expect((await post(restarted.port)).status).toBe(200);
    expect(writes).toBe(2);
  });

  it("enforces an explicit expected child PID on the first request", async () => {
    const upstream = await listen((_req, res) => json(res, { app: "muster", pid: 101 }));
    const front = await preview({ OMB_PORT: String(upstream), MUSTER_DEV_SERVER_PID: "202" }, upstream);
    expect((await post(front.port)).status).toBe(503);
    expect(front.forwarded()).toBe(0);
  });

  it("leaves non-API pages available even without a backend", async () => {
    const front = await preview({}, 1);
    const response = await fetch(`http://127.0.0.1:${front.port}/app`);
    expect(await response.text()).toBe("owned preview page");
    expect(front.forwarded()).toBe(1);
  });

  it("installs both Vite hooks and provides no implicit proxy target", () => {
    const absent = devBackendPreview({});
    expect(absent.proxy).toEqual({});
    expect(absent.plugin.configureServer).toBeDefined();
    expect(absent.plugin.configurePreviewServer).toBeDefined();
    const explicit = devBackendPreview({ OMB_PORT: "32100" });
    expect(explicit.proxy).toEqual({ "^/api(?:/|\\?|$)": { target: "http://127.0.0.1:32100" } });
  });
});
