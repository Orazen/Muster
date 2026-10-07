import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, unlinkSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { DatabaseSync } from "node:sqlite";
import readline from "node:readline";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { z } from "zod";
import { pairingServerEnvironment, waitForOwnedServer } from "../e2e/pairing-harness.ts";
import { freePortBlock } from "./testing/ports.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { writeFileAtomic } from "./atomic.ts";
import { seedConnectedGoogleRow } from "./testing/storage-gate.ts";
import type { JsonObject, JsonValue } from "./schema.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const botWire = z.object({ id: z.string(), threadId: z.string() });
const serversWire = z.array(z.object({ name: z.string(), env: z.array(z.object({ name: z.string(), value: z.string() })) }));
let directory = "", base = "", cookie = "", dump = "";
let child: ChildProcess | undefined;
let runtime: Server | undefined;
let connected = false;
let connectorToken: string | undefined;
const requests: string[] = [];
const runtimeToken = "owned-runtime-token";
const mcpFrames: JsonObject[] = [];
const projectFrames: JsonObject[] = [];
const projectSessions = new Map<string, { userId: string; apiKey: string }>();
let projectSequence = 0, holdProjectRead = false;
let projectHold: { response: ServerResponse; reply: () => void; closed: boolean } | undefined;
const projectKey = "ak_owned_fixture";
const projectDestination = "https://backend.composio.dev/owned-mcp";
const projectConfigWire = z.object({ composio: z.object({ apiKey: z.string(), userId: z.string(), sessionId: z.string() }) });
function projectConfig() { return projectConfigWire.parse(JSON.parse(readFileSync(join(hostedData, "config.json"), "utf8"))).composio; }
function releaseProjectRead() { projectHold?.reply(); }
const mcpPermitHeaders: Array<string | string[] | undefined> = [];
const proxies: ChildProcessWithoutNullStreams[] = [];
const proxyLines: readline.Interface[] = [];
let hostedBase = "", hostedCookie = "", hostedMemberCookie = "", hostedData = "", hostedDump = "";
let hostedChild: ChildProcess | undefined;
let boundPorts: number[] = [];
const hostedPassword = randomBytes(24).toString("base64url");
const frame = (id: number | string, name = "SLACK_POST_MESSAGE", args: JsonObject = { channel: "owned-private-channel", text: "owned-private-message" }): JsonObject =>
  ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
const permitWire = z.object({ approved: z.literal(true), permit: z.string().regex(/^[a-f0-9]{64}$/) });
const cardWire = z.object({ requestId: z.string(), tool: z.literal("connector_call"), subtitle: z.string(), answered: z.string().optional(), dismissed: z.boolean().optional() });

async function api(path: string, method = "GET", body?: JsonObject, token?: string, extraHeaders: Record<string, string> = {}) {
  const options: RequestInit = {
    method, redirect: "error", signal: AbortSignal.timeout(10_000),
    headers: { "content-type": "application/json", origin: base, ...(token ? { authorization: `Bearer ${token}` } : { cookie }), ...extraHeaders },
  };
  if (body !== undefined) options.body = JSON.stringify(body);
  return fetch(`${base}${path}`, options);
}

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "muster-connector-harness-"));
  const home = join(directory, "home"), data = join(directory, "data"), ui = join(directory, "ui");
  for (const path of [home, data, ui]) mkdirSync(path, { recursive: true });
  writeFileSync(join(ui, "index.html"), "<!doctype html><title>Owned connector fixture</title>");
  runtime = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    const path = new URL(req.url ?? "/", "http://fixture").pathname;
    if (path.startsWith("/api/v3.1/tool_router/session") || path === "/project-mcp") {
      const apiKey = z.enum([projectKey, "ak_newer_owned_fixture"]).safeParse(req.headers["x-api-key"]);
      if (!apiKey.success) { res.writeHead(401); res.end(); return; }
      const replySession = (id: string, userId: string) => {
        if (res.destroyed) return;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ session_id: id, config: { user_id: userId }, mcp: { url: projectDestination } }));
      };
      if (path === "/api/v3.1/tool_router/session" && req.method === "POST") {
        let body = "";
        req.on("data", chunk => { body += chunk; });
        req.on("end", () => {
          const value = z.object({ user_id: z.string() }).parse(JSON.parse(body));
          const id = `owned-session-${++projectSequence}`;
          projectSessions.set(id, { userId: value.user_id, apiKey: apiKey.data });
          replySession(id, value.user_id);
        });
        return;
      }
      if (path === "/project-mcp" && req.method === "POST") {
        let body = "";
        req.on("data", chunk => { body += chunk; });
        req.on("end", () => {
          const received = z.record(z.string(), z.json()).parse(JSON.parse(body));
          projectFrames.push(received);
          expect(req.headers["x-muster-connector-permit"]).toBeUndefined();
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: received.id, result: { content: [] } }));
        });
        return;
      }
      if (req.method === "GET") {
        const id = decodeURIComponent(path.split("/").at(-1) ?? "");
        const session = projectSessions.get(id);
        if (!session || session.apiKey !== apiKey.data) { res.writeHead(404); res.end(); return; }
        if (holdProjectRead) {
          holdProjectRead = false;
          const held = { response: res, reply: () => replySession(id, session.userId), closed: false };
          projectHold = held;
          res.once("close", () => { held.closed = true; });
        } else replySession(id, session.userId);
        return;
      }
      res.writeHead(404); res.end(); return;
    }
    if (req.headers.authorization !== `Bearer ${runtimeToken}`) { res.writeHead(401); res.end(); return; }
    let payload: JsonValue;
    if (path === "/v1/providers") payload = [{ service: "googlecalendar", displayName: "Google Calendar", iconUrl: null, homepageUrl: "https://calendar.google.com" }];
    else if (path === "/mcp") {
      let body = "";
      req.on("data", chunk => { body += chunk; });
      req.on("end", () => {
        const received = z.record(z.string(), z.json()).parse(JSON.parse(body));
        mcpFrames.push(received);
        mcpPermitHeaders.push(req.headers["x-muster-connector-permit"]);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: received.id, result: { content: [{ type: "text", text: "owned execution" }] } }));
      });
      return;
    }
    else if (path === "/v1/apps/authenticated") payload = connected ? ["googlecalendar"] : [];
    else if (path === "/v1/connections/googlecalendar/connect" && req.method === "POST") payload = { authorizationUrl: "https://consent.example.test/calendar" };
    else { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ success: true, data: payload }));
  });
  await new Promise<void>((resolve) => runtime!.listen(0, "127.0.0.1", resolve));
  const address = z.object({ port: z.number() }).parse(runtime.address());
  const runtimeUrl = `http://127.0.0.1:${address.port}`;
  dump = join(directory, "engine.json");
  writeFileSync(join(data, "config.json"), JSON.stringify({
    openConnector: { url: runtimeUrl, token: runtimeToken },
    instances: Object.fromEntries(["fake", "optout", "room", "gatey"].map((id) => [id, { driver: "grokAgent", config: { cli: join(root, "server/testing/fake-acp-cli.ts"), fullAuto: true, workspace: home }, environment: { FAKE_ACP_MODE: "echo-gated", FAKE_ACP_GATE_FILE: join(directory, id === "room" ? "release-room" : id === "gatey" ? "release-gate" : "release-turn"), FAKE_ACP_DUMP: id === "fake" ? dump : `${dump}.${id}` } }])),
  }));
  // Only this owned runtime is reachable from the server; no provider account.
  const guard = join(directory, "network.mjs");
  writeFileSync(guard, `import { Socket } from 'node:net'; import { appendFileSync } from 'node:fs';
const originalFetch=globalThis.fetch, originalConnect=Socket.prototype.connect; const denied=()=>{appendFileSync(${JSON.stringify(join(directory, "server-outbound-denied"))},'denied\\n');throw new Error('Owned server outbound denied');};
// Only this exact provider destination is translated to owned HTTP; this is not a TLS/provider acceptance claim.
globalThis.fetch=(input,init)=>{const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(url.href===${JSON.stringify(projectDestination)})return originalFetch(${JSON.stringify(runtimeUrl + '/project-mcp')},init);if(url.origin!==${JSON.stringify(runtimeUrl)})denied();return originalFetch(input,init);};
Socket.prototype.connect=function(...args){const v=Array.isArray(args[0])?args[0]:args;const o=typeof v[0]==='object'?v[0]:{port:v[0],host:v[1]};if(o.path||o.host!=='127.0.0.1'||Number(o.port)!==${address.port})denied();return Reflect.apply(originalConnect,this,args);};`);
  const port = await freePortBlock([0, 1, 2, 3], 23460, 17);
  boundPorts = [port, port + 1, port + 2, port + 3, address.port];
  base = `http://127.0.0.1:${port}`;
  const env = pairingServerEnvironment({ home, dataDirectory: data, companionDirectory: join(directory, "companion"), staticDir: ui, port, webhookPort: port + 1, secret: randomBytes(32).toString("hex") });
  env.OMB_ALLOW_SIGNUPS = "true";
  child = spawn(process.execPath, ["--import", guard, "--experimental-strip-types", join(root, "server/index.ts")], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", () => {}); child.stderr?.on("data", () => {});
  await waitForOwnedServer(child, base);
  const signup = await api("/api/auth/sign-up/email", "POST", { email: "connector-owner@example.test", password: randomBytes(24).toString("base64url"), name: "Owned connector test" });
  expect(signup.status).toBe(200);
  cookie = signup.headers.getSetCookie().find((value) => value.startsWith("better-auth.session_token="))?.split(";")[0] ?? "";
  expect(cookie).not.toBe("");
  const hostedHome = join(directory, "hosted-home");
  hostedData = join(directory, "hosted-data");
  for (const path of [hostedHome, hostedData]) mkdirSync(path);
  hostedDump = join(directory, "hosted-engine.json");
  writeFileSync(join(hostedData, "config.json"), JSON.stringify({ openConnector: { url: runtimeUrl, token: runtimeToken },
    instances: { phase: { driver: "grokAgent", config: { cli: join(root, "server/testing/fake-acp-cli.ts"), fullAuto: true, workspace: hostedHome },
      environment: { FAKE_ACP_MODE: "echo-gated", FAKE_ACP_GATE_FILE: join(directory, "hosted-release"), FAKE_ACP_DUMP: hostedDump } } } }));
  hostedBase = `http://127.0.0.1:${port + 2}`;
  const hostedEnv = pairingServerEnvironment({ home: hostedHome, dataDirectory: hostedData, companionDirectory: join(directory, "hosted-companion"), staticDir: ui, port: port + 2, webhookPort: port + 3, secret: randomBytes(32).toString("hex") });
  hostedEnv.OMB_ALLOW_SIGNUPS = "true";
  hostedEnv.OMB_COMPOSIO_API = `${runtimeUrl}/api/v3.1`;
  hostedEnv.OMB_PUBLIC_HOST = `127.0.0.1:${port + 2}`;
  hostedChild = spawn(process.execPath, ["--import", guard, "--experimental-strip-types", join(root, "server/index.ts")], { cwd: root, env: hostedEnv, stdio: ["ignore", "pipe", "pipe"] });
  hostedChild.stdout?.on("data", () => {}); hostedChild.stderr?.on("data", () => {});
  await waitForOwnedServer(hostedChild, hostedBase);
  for (const [email, name] of [["hosted-connector-owner@example.test", "Owned connector operator"], ["hosted-connector-member@example.test", "Owned connector member"]]) {
    const result = await hostedApi("/api/auth/sign-up/email", "POST", { email, password: hostedPassword, name });
    expect(result.status).toBe(200);
    const account = z.object({ user: z.object({ id: z.string() }) }).parse(await result.json());
    seedConnectedGoogleRow(hostedData, account.user.id);
    const value = result.headers.getSetCookie().find(entry => entry.startsWith("better-auth.session_token="))?.split(";")[0];
    expect(value).toBeDefined();
    if (email.includes("owner")) hostedCookie = value!;
    else hostedMemberCookie = value!;
  }
}, 30_000);

afterAll(async () => {
  await Promise.all(proxies.map(proxy => waitForExit(proxy, { signal: "SIGTERM" })));
  for (const lines of proxyLines) lines.close();
  await Promise.all([child, hostedChild].map(server => waitForExit(server, { signal: "SIGTERM" })));
  projectHold?.response.destroy();
  if (runtime) { runtime.closeAllConnections(); await new Promise<void>((resolve) => runtime!.close(() => resolve())); }
  const closed = await Promise.all(boundPorts.map(port => new Promise<boolean>(resolve => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(2_000);
    socket.once("connect", () => { socket.destroy(); resolve(false); });
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
    socket.once("error", error => { socket.destroy(); resolve("code" in error && error.code === "ECONNREFUSED"); });
  })));
  const children = [child, hostedChild, ...proxies].filter(value => value !== undefined);
  const exited = children.every(server => server.exitCode !== null || server.signalCode !== null);
  const noOutbound = !existsSync(join(directory, "proxy-outbound-denied")) && !existsSync(join(directory, "server-outbound-denied"));
  if (directory && exited) await removeTempDir(directory);
  const rootRemoved = !existsSync(directory);
  console.info(JSON.stringify({ scope: "connected apps owned cleanup", pids: children.map(server => server.pid), exited, ports: boundPorts, closed, noOutbound, rootRemoved }));
  expect({ exited, closed: closed.every(Boolean), noOutbound, rootRemoved }).toEqual({ exited: true, closed: true, noOutbound: true, rootRemoved: true });
}, 20_000);

it("mounts the configured runtime and connects a calendar card without any Composio key", async () => {
  const created = await api("/api/bots", "POST", {});
  expect(created.status).toBe(201);
  const bot = z.object({ bot: botWire }).parse(await created.json()).bot;
  expect((await api(`/api/bots/${bot.id}`, "PATCH", { modelSelection: { instanceId: "fake", model: "fake-acp-model" }, computer: "off" })).status).toBe(200);
  expect((await api(`/api/bots/${bot.id}/messages`, "POST", { text: "Plan my day from my calendar" })).status).toBe(202);
  await expect.poll(() => existsSync(`${dump}.mcp.json`), { timeout: 10_000 }).toBe(true);
  const entries = serversWire.parse(JSON.parse(readFileSync(`${dump}.mcp.json`, "utf8")));
  const connector = entries.find((entry) => entry.name === "composio");
  expect(connector, "OpenConnector-only config must mount connected-app tools").toBeDefined();
  expect(JSON.stringify(entries)).not.toContain(runtimeToken);
  const token = connector?.env.find((entry) => entry.name === "OMB_COMMS_TOKEN")?.value;
  expect(token).toBeTruthy();
  connectorToken = token;
  const siblingResponse = await api("/api/bots", "POST", {});
  const sibling = z.object({ bot: botWire }).parse(await siblingResponse.json()).bot;
  const beforeImpersonation = requests.length;
  const impersonation = await api("/api/internal/connectors/request", "POST", { botId: sibling.id, threadId: sibling.threadId, slugs: ["googlecalendar"], resumeKey: "foreign-conversation" }, token);
  expect(impersonation.status).toBe(403);
  expect(requests.length).toBe(beforeImpersonation);
  const cards = await api("/api/internal/connectors/request", "POST", { botId: bot.id, threadId: bot.threadId, slugs: ["googlecalendar"], resumeKey: "owned-calendar-request" }, token);
  expect(cards.status).toBe(200);
  const listing = await api("/api/bots");
  const roster = z.object({ bots: z.array(botWire.extend({ messages: z.array(z.object({ id: z.string(), connector: z.object({ slug: z.string(), status: z.string(), label: z.string() }).optional() })) })) }).parse(await listing.json());
  const message = roster.bots.find((entry) => entry.id === bot.id)?.messages.find((entry) => entry.connector?.slug === "googlecalendar");
  expect(message?.connector).toMatchObject({ label: "Google Calendar", status: "required" });
  if (!message) throw new Error("No connection card");
  const prefix = `/api/bots/${bot.id}/connector-cards/${message.id}`;
  const authorization = await api(`${prefix}/authorize`, "POST", { threadId: bot.threadId });
  expect(authorization.status).toBe(200);
  expect(await authorization.json()).toEqual({ url: "https://consent.example.test/calendar" });
  connected = true;
  const status = await api(`${prefix}/status?threadId=${bot.threadId}`);
  expect(status.status).toBe(200);
  expect(await status.json()).toMatchObject({ connected: true });
  expect(requests).toContain("POST /v1/connections/googlecalendar/connect");
  // Re-requesting the SAME app on a NEW resume key must not stack a second
  // card: the newest card for a slug wins and older still-pending ones are
  // superseded (the duplicate-Gmail/Calendar-cards bug). The existing card
  // here is already connected, so it survives the re-request untouched and
  // the re-request returns its id rather than minting a new message.
  const rerequest = await api("/api/internal/connectors/request", "POST", { botId: bot.id, threadId: bot.threadId, slugs: ["googlecalendar"], resumeKey: "owned-calendar-request-2" }, connectorToken);
  expect(rerequest.status).toBe(200);
  const rerequestIds = z.object({ messageIds: z.array(z.string()) }).parse(await rerequest.json()).messageIds;
  expect(rerequestIds).toHaveLength(1);
  // The prior card is connected: the re-request reuses it (the app is
  // linked — a second card would be pure noise) instead of minting one.
  expect(rerequestIds[0]).toBe(message.id);
  const calendarDump = await api("/api/bots");
  const calendarRoster = z.object({ bots: z.array(botWire.extend({ messages: z.array(z.object({ id: z.string(), connector: z.object({ slug: z.string(), status: z.string(), dismissed: z.boolean().optional() }).optional() })) })) }).parse(await calendarDump.json());
  const calendarCards = calendarRoster.bots.find((entry) => entry.id === bot.id)?.messages.filter((entry) => entry.connector?.slug === "googlecalendar" && !entry.connector.dismissed) ?? [];
  expect(calendarCards).toHaveLength(1);
  // Status queued a continuation while the real fake-engine turn is held.
  // Revoking app permission must refuse retained credentials and cancel that queue.
  expect((await api(`/api/bots/${bot.id}`, "PATCH", { composio: false })).status).toBe(200);
  const beforeRevoke = requests.length;
  expect((await api(`${prefix}/status?threadId=${bot.threadId}`)).status).toBe(403);
  // No credential request while disabled: switching back on must not restore it.
  expect((await api(`/api/bots/${bot.id}`, "PATCH", { composio: true })).status).toBe(200);
  expect((await api("/api/internal/connectors/mcp", "POST", { jsonrpc: "2.0", id: 1, method: "tools/list" }, token)).status).toBe(401);
  expect(requests.length).toBe(beforeRevoke);
  writeFileSync(join(directory, "release-turn"), "release");
  await expect.poll(async () => {
    const response = await api("/api/bots");
    const rows = z.object({ bots: z.array(botWire.extend({ messages: z.array(z.object({ id: z.string(), connector: z.object({ resumed: z.boolean().optional() }).optional() })) })) }).parse(await response.json());
    return rows.bots.find((entry) => entry.id === bot.id)?.messages.find((entry) => entry.id === message.id)?.connector?.resumed;
  }, { timeout: 10_000 }).toBe(false);
  expect((await api(`/api/bots/${bot.id}`, "PATCH", { composio: true })).status).toBe(200);
  expect((await api("/api/internal/connectors/mcp", "POST", { jsonrpc: "2.0", id: 2, method: "tools/list" }, token)).status).toBe(401);
  // The gate release settles the echo-gated turn: the mounted bot's echoed
  // system prompt carries the connector tool guidance — and never the
  // dead-end "switch engines" instruction (no engine is second-class).
  const echo = z.object({ bots: z.array(z.object({ id: z.string(), messages: z.array(z.object({ role: z.string(), text: z.string().optional() })) })) });
  await expect.poll(async () => {
    const response = await api("/api/bots");
    const rows = echo.parse(await response.json());
    return rows.bots.find((entry) => entry.id === bot.id)?.messages.find((m) => m.role === "bot" && m.text?.includes("echo:"))?.text ?? "";
  }, { timeout: 10_000 }).toContain("Connected-app tools are available");
  const mounted = echo.parse(await (await api("/api/bots")).json());
  expect(mounted.bots.find((entry) => entry.id === bot.id)?.messages.map((m) => m.text ?? "").join("\n")).not.toContain("not reachable from this engine");
}, 30_000);

it("holds write connector actions on approval cards until a human answers", async () => {
  const created = await api("/api/bots", "POST", {});
  const bot = z.object({ bot: botWire }).parse(await created.json()).bot;
  expect((await api(`/api/bots/${bot.id}`, "PATCH", { composio: true, modelSelection: { instanceId: "gatey", model: "fake-acp-model" }, computer: "off" })).status).toBe(200);
  expect((await api(`/api/bots/${bot.id}/messages`, "POST", { text: "run a connector action for me" })).status).toBe(202);
  await expect.poll(() => existsSync(`${dump}.gatey.mcp.json`), { timeout: 10_000 }).toBe(true);
  const entries = serversWire.parse(JSON.parse(readFileSync(`${dump}.gatey.mcp.json`, "utf8")));
  const token = entries.find((entry) => entry.name === "composio")?.env.find((entry) => entry.name === "OMB_COMMS_TOKEN")?.value;
  expect(token).toBeTruthy();

  const cardRoster = () => z.object({ bots: z.array(botWire.extend({
    messages: z.array(z.object({
      card: z.object({
        requestId: z.string().optional(),
        tool: z.string().optional(),
        answered: z.string().optional(),
        dismissed: z.boolean().optional(),
        subtitle: z.string().optional(),
        allowKey: z.string().optional(),
      }).optional(),
    })),
  })) });
  const openGateCard = async () => {
    const roster = cardRoster().parse(await (await api("/api/bots")).json());
    return roster.bots.find((entry) => entry.id === bot.id)?.messages
      .filter((m) => m.card?.tool === "connector_call" && !m.card.answered && !m.card.dismissed)
      .at(-1)?.card ?? null;
  };

  // a foreign credential may not ask on someone else's conversation
  expect((await api("/api/internal/connectors/approve", "POST", { botId: "any", threadId: bot.threadId, actions: ["SLACK_POST_MESSAGE"] }, token ?? "")).status).toBe(403);

  // a write holds: the HTTP response lands only when the human answers
  const held = api("/api/internal/connectors/approve", "POST", { botId: bot.id, threadId: bot.threadId, frame: frame(41) }, token ?? "");
  await expect.poll(async () => (await openGateCard())?.requestId ?? "", { timeout: 10_000 }).toBeTruthy();
  const open = (await openGateCard())!;
  // the card names the action, args stay redacted (names only), and
  // v1 offers no always-allow
  expect(open.subtitle).toContain("SLACK_POST_MESSAGE");
  expect(open.subtitle).not.toContain("#");
  expect(open.allowKey).toBeUndefined();
  expect((await api(`/api/bots/${bot.id}/respond`, "POST", { requestId: open.requestId ?? "", behavior: "deny" })).status).toBe(200);
  expect(await (await held).json()).toMatchObject({ approved: false });

  // v1 has no always-allow: the identical re-ask is carded again, and the
  // human's approval resolves the hold approved
  const heldAgain = api("/api/internal/connectors/approve", "POST", { botId: bot.id, threadId: bot.threadId, frame: frame(41) }, token ?? "");
  await expect.poll(async () => (await openGateCard())?.requestId ?? "", { timeout: 10_000 }).toBeTruthy();
  const reopened = (await openGateCard())!;
  expect(reopened.requestId).not.toBe(open.requestId);
  expect((await api(`/api/bots/${bot.id}/respond`, "POST", { requestId: reopened.requestId ?? "", behavior: "allow" })).status).toBe(200);
  expect(await (await heldAgain).json()).toMatchObject({ approved: true });
  // release the fake engine's held turn so the child exits cleanly
  writeFileSync(join(directory, "release-gate"), "release");
}, 30_000);

it("keeps connected apps unavailable to a bot whose owner switched them off", async () => {
  const created = await api("/api/bots", "POST", {});
  const bot = z.object({ bot: botWire }).parse(await created.json()).bot;
  expect((await api(`/api/bots/${bot.id}`, "PATCH", { composio: false, modelSelection: { instanceId: "optout", model: "fake-acp-model" }, computer: "off" })).status).toBe(200);
  const optoutDump = `${dump}.optout.mcp.json`;
  expect((await api(`/api/bots/${bot.id}/messages`, "POST", { text: "Say hello without accessing apps" })).status).toBe(202);
  await expect.poll(() => existsSync(optoutDump), { timeout: 10_000 }).toBe(true);
  const entries = serversWire.parse(JSON.parse(readFileSync(optoutDump, "utf8")));
  expect(entries.some((entry) => entry.name === "composio")).toBe(false);
  const before = requests.length;
  const refused = await api("/api/internal/connectors/request", "POST", { botId: bot.id, threadId: bot.threadId, slugs: ["googlecalendar"], resumeKey: "owned-optout-request" }, connectorToken);
  expect(refused.status).toBe(401);
  expect(requests.length).toBe(before);
  // The opt-out bot's echoed prompt must point at the switch, not at the
  // engine: the honest "turn it on" guidance, never dead-end engine advice.
  const echo = z.object({ bots: z.array(z.object({ id: z.string(), messages: z.array(z.object({ role: z.string(), text: z.string().optional() })) })) });
  await expect.poll(async () => {
    const response = await api("/api/bots");
    const rows = echo.parse(await response.json());
    return rows.bots.find((entry) => entry.id === bot.id)?.messages.find((m) => m.role === "bot" && m.text?.includes("echo:"))?.text ?? "";
  }, { timeout: 10_000 }).toContain("switched off for you");
  const off = echo.parse(await (await api("/api/bots")).json());
  expect(off.bots.find((entry) => entry.id === bot.id)?.messages.map((m) => m.text ?? "").join("\n")).not.toContain("not reachable from this engine");
}, 30_000);


it("binds a room connector credential to its bot and room and retires it after completion", async () => {
  const created = await api("/api/bots", "POST", {});
  expect(created.status).toBe(201);
  const bot = z.object({ bot: botWire }).parse(await created.json()).bot;
  expect((await api(`/api/bots/${bot.id}`, "PATCH", { name: "RoomHelper", modelSelection: { instanceId: "room", model: "fake-acp-model" }, computer: "off" })).status).toBe(200);
  const roomResponse = await api("/api/groups", "POST", { name: "Owned room", memberIds: [bot.id] });
  expect(roomResponse.status).toBe(201);
  const room = z.object({ group: z.object({ id: z.string(), threadId: z.string() }) }).parse(await roomResponse.json()).group;
  expect((await api(`/api/groups/${room.id}/messages`, "POST", { text: "@RoomHelper review my calendar", expectedThreadId: room.threadId })).status).toBe(202);
  await expect.poll(() => existsSync(`${dump}.room.mcp.json`), { timeout: 10_000 }).toBe(true);
  const entries = serversWire.parse(JSON.parse(readFileSync(`${dump}.room.mcp.json`, "utf8")));
  const token = entries.find((entry) => entry.name === "composio")?.env.find((entry) => entry.name === "OMB_COMMS_TOKEN")?.value;
  expect(token).toBeTruthy();
  expect(token).not.toBe(connectorToken);
  expect((await api("/api/internal/agents", "GET", undefined, token)).status).toBe(401);
  const before = requests.length;
  expect((await api("/api/internal/connectors/request", "POST", { botId: bot.id, threadId: bot.threadId, slugs: ["googlecalendar"], resumeKey: "wrong-room-thread" }, token)).status).toBe(403);
  expect(requests.length).toBe(before);
  expect((await api("/api/internal/connectors/mcp", "POST", { jsonrpc: "2.0", id: 1, method: "tools/list" }, token)).status).toBe(200);
  writeFileSync(join(directory, "release-room"), "release");
  await expect.poll(async () => (await api("/api/internal/connectors/mcp", "POST", { jsonrpc: "2.0", id: 2, method: "tools/list" }, token)).status, { timeout: 10_000 }).toBe(401);
  // A second room turn gets a different credential. Stop cancels the
  // connection continuation rather than letting completion restart work.
  unlinkSync(join(directory, "release-room"));
  unlinkSync(`${dump}.room.mcp.json`);
  expect((await api(`/api/groups/${room.id}/messages`, "POST", { text: "@RoomHelper connect my calendar", expectedThreadId: room.threadId })).status).toBe(202);
  await expect.poll(() => existsSync(`${dump}.room.mcp.json`), { timeout: 10_000 }).toBe(true);
  const nextEntries = serversWire.parse(JSON.parse(readFileSync(`${dump}.room.mcp.json`, "utf8")));
  const nextToken = nextEntries.find((entry) => entry.name === "composio")?.env.find((entry) => entry.name === "OMB_COMMS_TOKEN")?.value;
  expect(nextToken).toBeTruthy();
  expect(nextToken).not.toBe(token);
  const requested = await api("/api/internal/connectors/request", "POST", { botId: bot.id, threadId: room.threadId, slugs: ["googlecalendar"], resumeKey: "room-pending-connection" }, nextToken);
  expect(requested.status).toBe(200);
  const ids = z.object({ messageIds: z.array(z.string()) }).parse(await requested.json()).messageIds;
  expect((await api(`/api/groups/${room.id}/interrupt`, "POST", {})).status).toBe(200);
  writeFileSync(join(directory, "release-room"), "release after Stop");
  await expect.poll(async () => {
    const response = await api("/api/bots");
    const rows = z.object({ groups: z.array(z.object({ id: z.string(), busyBotId: z.string().nullable().optional(), messages: z.array(z.object({ id: z.string(), text: z.string().optional(), connector: z.object({ resumed: z.boolean().optional() }).optional() })) })) }).parse(await response.json());
    const saved = rows.groups.find((entry) => entry.id === room.id);
    return { busy: Boolean(saved?.busyBotId), resumed: saved?.messages.find((message) => ids.includes(message.id))?.connector?.resumed };
  }, { timeout: 10_000 }).toEqual({ busy: false, resumed: false });
  expect((await api("/api/internal/connectors/mcp", "POST", { jsonrpc: "2.0", id: 3, method: "tools/list" }, nextToken)).status).toBe(401);
});


async function hostedApi(path: string, method = "GET", body?: JsonObject, token?: string, viewer = hostedCookie, extraHeaders: Record<string, string> = {}) {
  const options: RequestInit = { method, redirect: "error", signal: AbortSignal.timeout(10_000),
    headers: { origin: hostedBase, "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : { cookie: viewer }), ...extraHeaders } };
  if (body !== undefined) options.body = JSON.stringify(body);
  return fetch(`${hostedBase}${path}`, options);
}
async function hostedTurn(scope: "primary" | "task" | "room" = "primary") {
  rmSync(join(directory, "hosted-release"), { force: true });
  rmSync(`${hostedDump}.mcp.json`, { force: true });
  const created = await hostedApi("/api/bots", "POST", {});
  expect(created.status).toBe(201);
  const bot = z.object({ bot: botWire }).parse(await created.json()).bot;
  expect((await hostedApi(`/api/bots/${bot.id}`, "PATCH", { name: "OwnedRunner", modelSelection: { instanceId: "phase", model: "fake-acp-model" }, computer: "off" })).status).toBe(200);
  let threadId = bot.threadId, roomId: string | undefined;
  if (scope === "task") {
    const response = await hostedApi(`/api/bots/${bot.id}/tasks`, "POST", { title: "Owned connector task" });
    expect(response.status).toBe(201);
    threadId = z.object({ task: z.object({ threadId: z.string() }) }).parse(await response.json()).task.threadId;
  }
  if (scope === "room") {
    const response = await hostedApi("/api/groups", "POST", { name: "Owned connector room", memberIds: [bot.id] });
    expect(response.status).toBe(201);
    const room = z.object({ group: z.object({ id: z.string(), threadId: z.string() }) }).parse(await response.json()).group;
    threadId = room.threadId; roomId = room.id;
  }
  const sent = await hostedApi(roomId ? `/api/groups/${roomId}/messages` : `/api/bots/${bot.id}/messages`, "POST",
    { text: scope === "room" ? "@OwnedRunner inspect a connected app" : "inspect a connected app", expectedThreadId: threadId });
  expect(sent.status).toBe(202);
  await expect.poll(() => existsSync(`${hostedDump}.mcp.json`), { timeout: 10_000 }).toBe(true);
  const entries = serversWire.parse(JSON.parse(readFileSync(`${hostedDump}.mcp.json`, "utf8")));
  const token = entries.find(entry => entry.name === "composio")?.env.find(entry => entry.name === "OMB_COMMS_TOKEN")?.value;
  expect(token).toBeTruthy();
  return { bot, threadId, roomId, token: token! };
}
type HostedTurn = Awaited<ReturnType<typeof hostedTurn>>;
async function retireTurn(turn: HostedTurn) {
  writeFileSync(join(directory, "hosted-release"), "release");
  await expect.poll(async () => (await hostedApi("/api/internal/connectors/mcp", "POST", { jsonrpc: "2.0", id: 40, method: "tools/list" }, turn.token)).status,
    { timeout: 10_000 }).toBe(401);
  await expect.poll(async () => z.object({ bots: z.array(z.object({ id: z.string(), busy: z.boolean().optional() })) }).parse(await (await hostedApi("/api/bots")).json()).bots.find(bot => bot.id === turn.bot.id)?.busy,
    { timeout: 10_000 }).toBe(false);
}
async function threadCards(threadId: string) {
  const response = await hostedApi(`/api/threads/${threadId}/messages`);
  expect(response.status).toBe(200);
  const messages = z.object({ messages: z.array(z.object({ card: z.object({ tool: z.string().optional() }).passthrough().optional() })) }).parse(await response.json()).messages;
  return messages.flatMap(message => message.card?.tool === "connector_call" ? [cardWire.parse(message.card)] : []);
}
async function pendingCard(turn: HostedTurn) {
  await expect.poll(async () => (await threadCards(turn.threadId)).filter(card => !card.answered && !card.dismissed).length, { timeout: 10_000 }).toBe(1);
  return (await threadCards(turn.threadId)).find(card => !card.answered && !card.dismissed)!;
}
async function approve(turn: HostedTurn, request: JsonObject) {
  const held = hostedApi("/api/internal/connectors/approve", "POST", { botId: turn.bot.id, threadId: turn.threadId, frame: request }, turn.token);
  const card = await pendingCard(turn);
  expect((await hostedApi(`/api/threads/${turn.threadId}/respond`, "POST", { requestId: card.requestId, behavior: "allow" })).status).toBe(200);
  return permitWire.parse(await (await held).json()).permit;
}
async function execute(turn: HostedTurn, request: JsonObject, permit?: string) {
  return hostedApi("/api/internal/connectors/mcp", "POST", request, turn.token, hostedCookie,
    permit ? { "x-muster-connector-permit": permit } : {});
}

it("refuses raw executable frames and derives complete redacted cards from the actual frame", async () => {
  const turn = await hostedTurn();
  try {
    const request = frame(51);
    const before = mcpFrames.length;
    expect((await execute(turn, request)).status).toBe(403);
    expect(mcpFrames.length).toBe(before);
    const held = hostedApi("/api/internal/connectors/approve", "POST", { botId: turn.bot.id, threadId: turn.threadId, actions: ["GMAIL_LIST_EMAILS"], toolkits: ["fake"], argsSummary: "fake", frame: request }, turn.token);
    const card = await pendingCard(turn);
    expect(card.subtitle).toContain("SLACK_POST_MESSAGE");
    expect(card.subtitle).not.toContain("GMAIL_LIST_EMAILS");
    expect(card.subtitle).toContain("args: channel, text");
    expect(JSON.stringify(card)).not.toContain("owned-private");
    const wrongBot = z.object({ bot: botWire }).parse(await (await hostedApi("/api/bots", "POST", {})).json()).bot;
    expect((await hostedApi(`/api/bots/${wrongBot.id}/respond`, "POST", { requestId: card.requestId, behavior: "allow" })).status).toBe(409);
    expect((await hostedApi(`/api/bots/${turn.bot.id}/respond`, "POST", { requestId: card.requestId, behavior: "allow" }, undefined, hostedMemberCookie)).status).toBe(404);
    expect((await threadCards(turn.threadId)).find(entry => entry.requestId === card.requestId)?.answered).toBeUndefined();
    expect((await hostedApi(`/api/bots/${turn.bot.id}/respond`, "POST", { requestId: card.requestId, behavior: "allow" })).status).toBe(200);
    const permit = permitWire.parse(await (await held).json()).permit;
    expect(JSON.stringify(await (await hostedApi("/api/bots")).json())).not.toContain(permit);
    expect((await execute(turn, request, permit)).status).toBe(200);
    expect(mcpFrames.slice(before)).toEqual([request]);
    expect(mcpPermitHeaders.at(-1)).toBeUndefined();
    expect((await execute(turn, request, permit)).status).toBe(403);
    expect(mcpFrames.slice(before)).toEqual([request]);
  } finally { await retireTurn(turn); }
}, 30_000);

it.each(["value", "typed-id", "method", "batch-order"])("burns consent on %s mutation while preserving the approved original frame", async mutation => {
  const turn = await hostedTurn();
  try {
    const original = mutation === "batch-order" ? frame(52, "COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [{ tool_slug: "GMAIL_SEND_EMAIL", arguments: { to: "first-owned@example.test" } }, { tool_slug: "SLACK_POST_MESSAGE", arguments: { text: "owned" } }] }) : frame(52);
    const permit = await approve(turn, original);
    const changed = JSON.parse(JSON.stringify(original));
    if (mutation === "value") changed.params.arguments.text = "different-owned-message";
    if (mutation === "typed-id") changed.id = "52";
    if (mutation === "method") changed.method = "tools/list";
    if (mutation === "batch-order") changed.params.arguments.tools.reverse();
    const before = mcpFrames.length;
    expect((await execute(turn, changed, permit)).status).toBe(403);
    expect((await execute(turn, original, permit)).status).toBe(403);
    expect(mcpFrames.length).toBe(before);
    const fresh = await approve(turn, original);
    expect(fresh).not.toBe(permit);
    expect((await execute(turn, original, fresh)).status).toBe(200);
    expect(mcpFrames.slice(before)).toEqual([original]);
  } finally { await retireTurn(turn); }
}, 30_000);

it.each([
  { tools: [] },
  { tools: ["GMAIL_SEND_EMAIL", { invalid: "SLACK_POST_MESSAGE" }] },
  { tools: Array.from({ length: 13 }, () => "GMAIL_SEND_EMAIL") },
  { tools: ["GMAIL_" + "A".repeat(94), "SLACK_" + "B".repeat(94), "NOTION_" + "C".repeat(93)] },
])("rejects the whole invalid or undisplayable inventory without a partial card", async ({ tools }) => {
  const turn = await hostedTurn();
  try {
    const beforeCards = await threadCards(turn.threadId), before = mcpFrames.length;
    const request = frame(53, "COMPOSIO_MULTI_EXECUTE_TOOL", { tools });
    expect((await hostedApi("/api/internal/connectors/approve", "POST", { botId: turn.bot.id, threadId: turn.threadId, frame: request }, turn.token)).status).toBe(400);
    expect((await execute(turn, request)).status).toBe(400);
    expect(await threadCards(turn.threadId)).toEqual(beforeCards);
    expect(mcpFrames.length).toBe(before);
  } finally { await retireTurn(turn); }
}, 30_000);

it.each(["task", "room"] as const)("binds approval and full execution to the actual %s thread", async scope => {
  const turn = await hostedTurn(scope);
  try {
    if (scope === "task") expect((await hostedApi(`/api/bots/${turn.bot.id}/tasks/${turn.bot.threadId}`, "POST", {})).status).toBe(200);
    const request = frame(54);
    const held = hostedApi("/api/internal/connectors/approve", "POST", { botId: turn.bot.id, threadId: turn.threadId, frame: request }, turn.token);
    const card = await pendingCard(turn);
    expect((await hostedApi(`/api/bots/${turn.bot.id}/respond`, "POST", { requestId: card.requestId, behavior: "allow" })).status).toBe(409);
    expect((await threadCards(turn.threadId)).find(entry => entry.requestId === card.requestId)?.answered).toBeUndefined();
    expect((await hostedApi(`/api/threads/${turn.threadId}/respond`, "POST", { requestId: card.requestId, behavior: "allow" })).status).toBe(200);
    const permit = permitWire.parse(await (await held).json()).permit;
    const before = mcpFrames.length;
    expect((await execute(turn, request, permit)).status).toBe(200);
    expect(mcpFrames.slice(before)).toEqual([request]);
  } finally { await retireTurn(turn); }
}, 30_000);

it("retires a disconnected approval so a late Allow cannot execute", async () => {
  const turn = await hostedTurn();
  try {
    const controller = new AbortController();
    const request = frame(55);
    const held = fetch(`${hostedBase}/api/internal/connectors/approve`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${turn.token}` }, body: JSON.stringify({ botId: turn.bot.id, threadId: turn.threadId, frame: request }), signal: controller.signal }).then(() => "response", () => "aborted");
    const card = await pendingCard(turn);
    controller.abort(); expect(await held).toBe("aborted");
    await expect.poll(async () => (await threadCards(turn.threadId)).find(entry => entry.requestId === card.requestId)?.dismissed, { timeout: 5_000 }).toBe(true);
    expect((await hostedApi(`/api/threads/${turn.threadId}/respond`, "POST", { requestId: card.requestId, behavior: "allow" })).status).toBe(409);
    const before = mcpFrames.length;
    expect((await execute(turn, request)).status).toBe(403);
    expect(mcpFrames.length).toBe(before);
  } finally { await retireTurn(turn); }
}, 30_000);

it.each(["account", "lease"])("refuses consent after current %s authority changes", async change => {
  const turn = await hostedTurn();
  const db = new DatabaseSync(join(hostedData, "auth.db"));
  try {
    const request = frame(56);
    const held = hostedApi("/api/internal/connectors/approve", "POST", { botId: turn.bot.id, threadId: turn.threadId, frame: request }, turn.token);
    const card = await pendingCard(turn);
    if (change === "account") db.prepare('UPDATE "user" SET "email" = ? WHERE "email" = ?').run("changed-owned@example.test", "hosted-connector-owner@example.test");
    else expect((await hostedApi(`/api/bots/${turn.bot.id}`, "PATCH", { composio: false })).status).toBe(200);
    const answer = await hostedApi(`/api/threads/${turn.threadId}/respond`, "POST", { requestId: card.requestId, behavior: "allow" });
    expect([200, 409]).toContain(answer.status);
    expect(await (await held).json()).toEqual({ approved: false });
    const before = mcpFrames.length;
    expect([401, 403]).toContain((await execute(turn, request)).status);
    expect(mcpFrames.length).toBe(before);
  } finally {
    db.prepare('UPDATE "user" SET "email" = ? WHERE "email" = ?').run("hosted-connector-owner@example.test", "changed-owned@example.test");
    db.close(); await retireTurn(turn);
  }
}, 30_000);

it.each(["account", "lease"])("burns an already approved permit after current %s authority changes", async change => {
  const turn = await hostedTurn();
  const db = new DatabaseSync(join(hostedData, "auth.db"));
  try {
    const request = frame(57);
    const permit = await approve(turn, request);
    if (change === "account") db.prepare('UPDATE "user" SET "email" = ? WHERE "email" = ?').run("changed-owned@example.test", "hosted-connector-owner@example.test");
    else expect((await hostedApi(`/api/bots/${turn.bot.id}`, "PATCH", { composio: false })).status).toBe(200);
    const before = mcpFrames.length;
    expect((await execute(turn, request, permit)).status).toBe(change === "account" ? 403 : 401);
    expect(mcpFrames.length).toBe(before);
    if (change === "account") {
      db.prepare('UPDATE "user" SET "email" = ? WHERE "email" = ?').run("hosted-connector-owner@example.test", "changed-owned@example.test");
      expect((await execute(turn, request, permit)).status).toBe(403);
      expect(mcpFrames.length).toBe(before);
    }
  } finally {
    db.prepare('UPDATE "user" SET "email" = ? WHERE "email" = ?').run("hosted-connector-owner@example.test", "changed-owned@example.test");
    db.close(); await retireTurn(turn);
  }
}, 30_000);

it("burns a permit presented by a different live bot lease", async () => {
  const first = await hostedTurn();
  let second: HostedTurn | undefined;
  try {
    const request = frame(58);
    const permit = await approve(first, request);
    second = await hostedTurn();
    expect(second.token).not.toBe(first.token);
    expect((await execute(second, { jsonrpc: "2.0", id: 580, method: "tools/list" })).status).toBe(200);
    const before = mcpFrames.length;
    expect((await execute(second, request, permit)).status).toBe(403);
    expect((await execute(first, request, permit)).status).toBe(403);
    expect(mcpFrames.length).toBe(before);
    const fresh = await approve(second, request);
    expect((await execute(second, request, fresh)).status).toBe(200);
    expect(mcpFrames.slice(before)).toEqual([request]);
  } finally { await Promise.all([retireTurn(first), ...(second ? [retireTurn(second)] : [])]); }
}, 30_000);

it("bounds outstanding consent per live lease and releases capacity on consumption", async () => {
  const turn = await hostedTurn();
  try {
    const approved: Array<{ request: JsonObject; permit: string }> = [];
    for (let id = 60; id < 68; id++) {
      const request = frame(id);
      approved.push({ request, permit: await approve(turn, request) });
    }
    const beforeCards = await threadCards(turn.threadId), before = mcpFrames.length;
    expect((await hostedApi("/api/internal/connectors/approve", "POST", { botId: turn.bot.id, threadId: turn.threadId, frame: frame(68) }, turn.token)).status).toBe(409);
    expect(await threadCards(turn.threadId)).toEqual(beforeCards);
    expect(mcpFrames.length).toBe(before);
    expect((await execute(turn, approved[0].request, approved[0].permit)).status).toBe(200);
    const next = frame(68), permit = await approve(turn, next);
    expect((await execute(turn, next, permit)).status).toBe(200);
    expect(mcpFrames.slice(before)).toEqual([approved[0].request, next]);
  } finally { await retireTurn(turn); }
}, 30_000);

it("runs the actual proxy through real approval/respond and exact single-use execution", async () => {
  const turn = await hostedTurn();
  try {
    const guard = join(directory, "proxy-network.mjs");
    writeFileSync(guard, `import { Socket } from 'node:net'; import { appendFileSync } from 'node:fs';
const f=globalThis.fetch,c=Socket.prototype.connect; const denied=()=>{appendFileSync(${JSON.stringify(join(directory, "proxy-outbound-denied"))},'denied\\n');throw Error('Owned proxy outbound denied');};
globalThis.fetch=(input,init)=>{const u=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(u.origin!==${JSON.stringify(hostedBase)})denied();return f(input,init);};
Socket.prototype.connect=function(...args){const v=Array.isArray(args[0])?args[0]:args,o=typeof v[0]==='object'?v[0]:{port:v[0],host:v[1]};if(o.path||o.host!=='127.0.0.1'||Number(o.port)!==${new URL(hostedBase).port})denied();return Reflect.apply(c,this,args);};`);
    const proxy = spawn(process.execPath, ["--import", guard, "--experimental-strip-types", join(root, "server/connector-proxy.ts")], {
      cwd: root, env: { PATH: process.env.PATH, HOME: directory, TMPDIR: directory, OMB_HARNESS_URL: hostedBase, OMB_BOT_ID: turn.bot.id, OMB_THREAD_ID: turn.threadId,
        OMB_COMMS_TOKEN: turn.token, OMB_CONNECTOR_UPSTREAM_URL: `${hostedBase}/api/internal/connectors/mcp`, OMB_CONNECTOR_UPSTREAM_HEADERS: JSON.stringify({ authorization: `Bearer ${turn.token}` }) }, stdio: ["pipe", "pipe", "pipe"] });
    proxies.push(proxy); proxy.stderr.on("data", () => {});
    const lines = readline.createInterface({ input: proxy.stdout }); proxyLines.push(lines);
    const reply = new Promise<JsonObject>(resolve => lines.once("line", line => resolve(z.record(z.string(), z.json()).parse(JSON.parse(line)))));
    const request = frame("owned-proxy-execution");
    const before = mcpFrames.length;
    proxy.stdin.write(JSON.stringify(request) + "\n");
    const card = await pendingCard(turn);
    expect(mcpFrames.length).toBe(before);
    expect((await hostedApi(`/api/threads/${turn.threadId}/respond`, "POST", { requestId: card.requestId, behavior: "allow" })).status).toBe(200);
    expect(await reply).toMatchObject({ id: "owned-proxy-execution", result: { content: [{ text: "owned execution" }] } });
    expect(mcpFrames.slice(before)).toEqual([request]);
    expect(mcpPermitHeaders.at(-1)).toBeUndefined();
    proxy.stdin.end(); await waitForExit(proxy);
    expect(proxy.exitCode).toBe(0);
  } finally { await retireTurn(turn); }
}, 30_000);


async function lazyProjectTurn() {
  // The fixture changes only its owned backend selection on disk. The actual
  // settings consumer then reloads that selection and validates the project key.
  const path = join(hostedData, "config.json");
  const owned = z.record(z.string(), z.json()).parse(JSON.parse(readFileSync(path, "utf8")));
  owned.openConnector = { url: "", token: "" };
  writeFileAtomic(path, JSON.stringify(owned));
  expect((await hostedApi("/api/config", "PATCH", { openConnector: { url: "", token: "" }, composio: { apiKey: projectKey } })).status).toBe(200);
  const before = projectConfig();
  projectSessions.delete(before.sessionId);
  projectHold = undefined;
  holdProjectRead = true;
  const turn = await hostedTurn();
  const request = frame(71);
  const permit = await approve(turn, request);
  return { turn, request, permit, before };
}

it("preserves a valid first project setup and executes the approved full frame only once", async () => {
  const { turn, request, permit, before } = await lazyProjectTurn();
  try {
    const count = projectFrames.length;
    const execution = execute(turn, request, permit);
    await expect.poll(() => Boolean(projectHold), { timeout: 5_000 }).toBe(true);
    expect(projectFrames.length).toBe(count);
    expect(projectConfig()).toEqual(before);
    releaseProjectRead();
    expect((await execution).status).toBe(200);
    expect(projectFrames.slice(count)).toEqual([request]);
    const after = projectConfig();
    expect(after.apiKey).toBe(before.apiKey);
    expect(after.userId).toBe(before.userId);
    expect(after.sessionId).not.toBe(before.sessionId);
    expect(projectSessions.has(after.sessionId)).toBe(true);
    expect((await execute(turn, request, permit)).status).toBe(403);
    expect(projectFrames.slice(count)).toEqual([request]);
  } finally { releaseProjectRead(); await retireTurn(turn); }
}, 30_000);

it.each(["lease", "account", "credential", "disconnect"] as const)("refuses executable frames and late config saves after held project setup %s invalidation", async change => {
  const { turn, request, permit, before } = await lazyProjectTurn();
  const db = new DatabaseSync(join(hostedData, "auth.db"));
  const controller = new AbortController();
  try {
    const count = projectFrames.length;
    const execution = fetch(`${hostedBase}/api/internal/connectors/mcp`, { method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${turn.token}`, "x-muster-connector-permit": permit },
      body: JSON.stringify(request), signal: controller.signal }).then(response => response.status, () => "aborted");
    await expect.poll(() => Boolean(projectHold), { timeout: 5_000 }).toBe(true);
    expect(projectFrames.length).toBe(count);
    expect(projectConfig()).toEqual(before);
    let expected = before;
    if (change === "lease") expect((await hostedApi(`/api/bots/${turn.bot.id}`, "PATCH", { composio: false })).status).toBe(200);
    if (change === "account") db.prepare('UPDATE "user" SET "email" = ? WHERE "email" = ?').run("changed-owned@example.test", "hosted-connector-owner@example.test");
    if (change === "credential") {
      expect((await hostedApi("/api/config", "PATCH", { composio: { apiKey: "ak_newer_owned_fixture" } })).status).toBe(200);
      expected = projectConfig();
      expect(expected.apiKey).toBe("ak_newer_owned_fixture");
    }
    if (change === "disconnect") {
      controller.abort();
      expect(await execution).toBe("aborted");
      // The server must actually cancel its held provider read, not merely hide the response.
      await expect.poll(() => projectHold?.closed, { timeout: 5_000 }).toBe(true);
    }
    releaseProjectRead();
    const status = await execution;
    if (change !== "disconnect") expect(status).toBe(401);
    await expect.poll(() => projectHold?.closed, { timeout: 5_000 }).toBe(true);
    expect(projectFrames.slice(count)).toEqual([]);
    expect(projectConfig()).toEqual(expected);
    expect((await execute(turn, request, permit)).status).not.toBe(200);
    expect(projectFrames.slice(count)).toEqual([]);
  } finally {
    controller.abort(); releaseProjectRead();
    db.prepare('UPDATE "user" SET "email" = ? WHERE "email" = ?').run("hosted-connector-owner@example.test", "changed-owned@example.test");
    db.close(); await retireTurn(turn);
  }
}, 30_000);
