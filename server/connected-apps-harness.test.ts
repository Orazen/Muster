import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { z } from "zod";
import { pairingServerEnvironment, waitForOwnedServer } from "../e2e/pairing-harness.ts";
import { freePortBlock } from "./testing/ports.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
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

async function api(path: string, method = "GET", body?: JsonObject, token?: string) {
  const options: RequestInit = {
    method, redirect: "error", signal: AbortSignal.timeout(10_000),
    headers: { "content-type": "application/json", origin: base, ...(token ? { authorization: `Bearer ${token}` } : { cookie }) },
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
    if (req.headers.authorization !== `Bearer ${runtimeToken}`) { res.writeHead(401); res.end(); return; }
    const path = new URL(req.url ?? "/", "http://fixture").pathname;
    let payload: JsonValue;
    if (path === "/v1/providers") payload = [{ service: "googlecalendar", displayName: "Google Calendar", iconUrl: null, homepageUrl: "https://calendar.google.com" }];
    else if (path === "/mcp") payload = {};
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
    instances: Object.fromEntries(["fake", "optout", "room"].map((id) => [id, { driver: "grokAgent", config: { cli: join(root, "server/testing/fake-acp-cli.ts"), fullAuto: true, workspace: home }, environment: { FAKE_ACP_MODE: id === "optout" ? "happy" : "echo-gated", FAKE_ACP_GATE_FILE: join(directory, id === "room" ? "release-room" : "release-turn"), FAKE_ACP_DUMP: id === "fake" ? dump : `${dump}.${id}` } }])),
  }));
  // Only this owned runtime is reachable from the server; no provider account.
  const guard = join(directory, "network.mjs");
  writeFileSync(guard, `import { Socket } from 'node:net';
const originalFetch=globalThis.fetch, originalConnect=Socket.prototype.connect;
globalThis.fetch=(input,init)=>{const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(url.origin!==${JSON.stringify(runtimeUrl)})throw new Error('Outbound denied');return originalFetch(input,init);};
Socket.prototype.connect=function(...args){const v=Array.isArray(args[0])?args[0]:args;const o=typeof v[0]==='object'?v[0]:{port:v[0],host:v[1]};if(o.path||o.host!=='127.0.0.1'||Number(o.port)!==${address.port})throw new Error('Outbound socket denied');return Reflect.apply(originalConnect,this,args);};`);
  const port = await freePortBlock([0, 1], 26000, 10000);
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
}, 30_000);

afterAll(async () => {
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (runtime) await new Promise<void>((resolve) => runtime!.close(() => resolve()));
  if (directory) await removeTempDir(directory);
});

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
