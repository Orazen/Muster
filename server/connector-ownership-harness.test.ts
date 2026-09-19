// Real hosted sessions against an owned server and connector runtime only.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { z } from "zod";
import { pairingServerEnvironment, waitForOwnedServer } from "../e2e/pairing-harness.ts";
import { seedConnectedGoogleRow } from "./testing/storage-gate.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import type { JsonValue } from "./schema.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
let directory = "", base = "", primary = "", secondary = "";
let child: ChildProcess | undefined;
let runtime: Server | undefined;
const requests: string[] = [];
const runtimeToken = "owned-connector-token";
const engineIds: Record<string, string> = {};
const dumps: Record<string, string> = {};
const serversWire = z.array(z.object({ name: z.string(), env: z.array(z.object({ name: z.string(), value: z.string() })) }));
function api(path: string, cookie: string, method = "GET", body?: JsonValue) {
  const init: RequestInit = { method, headers: { cookie, origin: base, "content-type": "application/json" }, redirect: "error", signal: AbortSignal.timeout(10_000) };
  if (body !== undefined) init.body = JSON.stringify(body);
  return fetch(`${base}${path}`, init);
}

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "muster-connector-ownership-"));
  const home = join(directory, "home"), data = join(directory, "data"), ui = join(directory, "ui");
  for (const path of [home, data, ui]) mkdirSync(path, { recursive: true });
  writeFileSync(join(ui, "index.html"), "<!doctype html><title>Owned connector boundary fixture</title>");
  runtime = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.headers.authorization !== `Bearer ${runtimeToken}`) { res.writeHead(401); res.end(); return; }
    const path = new URL(req.url ?? "/", "http://fixture").pathname;
    let payload: JsonValue;
    if (path === "/v1/providers") payload = [{ service: "googlecalendar", displayName: "Operator Calendar", iconUrl: null, homepageUrl: "https://calendar.google.com" }];
    else if (path === "/v1/apps/authenticated") payload = ["googlecalendar"];
    else if (path === "/v1/connections/googlecalendar/connect" && req.method === "POST") payload = { authorizationUrl: "https://consent.example.test/operator-calendar" };
    else { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ success: true, data: payload }));
  });
  await new Promise<void>((resolve) => runtime!.listen(0, "127.0.0.1", resolve));
  const address = z.object({ port: z.number() }).parse(runtime.address());
  const runtimeUrl = `http://127.0.0.1:${address.port}`;
  writeFileSync(join(data, "config.json"), JSON.stringify({ openConnector: { url: runtimeUrl, token: runtimeToken } }));
  const guard = join(directory, "network.mjs");
  writeFileSync(guard, `import { Socket } from 'node:net';
const originalFetch=globalThis.fetch, originalConnect=Socket.prototype.connect;
globalThis.fetch=(input,init)=>{const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(url.origin!==${JSON.stringify(runtimeUrl)})throw new Error('Outbound denied');return originalFetch(input,init);};
Socket.prototype.connect=function(...args){const v=Array.isArray(args[0])?args[0]:args;const o=typeof v[0]==='object'?v[0]:{port:v[0],host:v[1]};if(o.path||o.host!=='127.0.0.1'||Number(o.port)!==${address.port})throw new Error('Outbound socket denied');return Reflect.apply(originalConnect,this,args);};`);
  const port = await freePortBlock([0, 1], 26000, 10000);
  base = `http://127.0.0.1:${port}`;
  const env = pairingServerEnvironment({ home, dataDirectory: data, companionDirectory: join(directory, "companion"), staticDir: ui, port, webhookPort: port + 1, secret: randomBytes(32).toString("hex") });
  Object.assign(env, { OMB_COMPOSIO_BROKER_URL: runtimeUrl, OMB_COMPOSIO_BROKER_TOKEN: "owned-unused-broker-token", OMB_PUBLIC_HOST: `127.0.0.1:${port}`, OMB_ALLOW_SIGNUPS: "true", GOOGLE_CLIENT_ID: randomBytes(24).toString("hex"), GOOGLE_CLIENT_SECRET: randomBytes(24).toString("hex") });
  child = spawn(process.execPath, ["--import", guard, "--experimental-strip-types", join(root, "server/index.ts")], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", () => {}); child.stderr?.on("data", () => {});
  await waitForOwnedServer(child, base);
  async function signup(name: string) {
    const response = await api("/api/auth/sign-up/email", "", "POST", { name, email: `${name}@example.test`, password: randomBytes(24).toString("base64url") });
    expect(response.status).toBe(200);
    const { user } = z.object({ user: z.object({ id: z.string() }) }).parse(await response.json());
    seedConnectedGoogleRow(data, user.id);
    engineIds[name] = name === "secondary" ? `providerApi:${user.id}` : "owned-primary";
    const cookie = response.headers.getSetCookie().find((value) => value.startsWith("better-auth.session_token="))?.split(";")[0] ?? "";
    expect(cookie).not.toBe("");
    return cookie;
  }
  primary = await signup("primary");
  secondary = await signup("secondary");
  // Synthetic ownership identity, deliberately not a provider integration:
  // a fake ACP driver is registered under the same per-user namespace that
  // real vault engines use. Real HTTP auth and dispatch guards still run.
  await waitForExit(child, { signal: "SIGTERM" });
  const configPath = join(data, "config.json");
  const config = z.record(z.string(), z.unknown()).parse(JSON.parse(readFileSync(configPath, "utf8")));
  const instances = Object.fromEntries(["primary", "secondary"].flatMap((name) => ["direct", "group"].map((kind) => {
    const key = `${name}-${kind}`;
    const id = kind === "direct" ? engineIds[name] : `group${engineIds[name]}`;
    engineIds[key] = id;
    dumps[key] = join(directory, `${key}.json`);
    return [id, { driver: "grokAgent", config: { cli: join(root, "server/testing/fake-acp-cli.ts"), fullAuto: true, workspace: home }, environment: { FAKE_ACP_MODE: "echo-gated", FAKE_ACP_DUMP: dumps[key] } }];
  })));
  // Separate deterministic fallback providers share only the secondary account namespace.
  const fallbackInstances = Object.fromEntries(["healthy", "quota", "progress"].map(kind => {
    const id = engineIds.secondary.replace("providerApi:", `fallback${kind}Api:`);
    engineIds[`fallback-${kind}`] = id;
    dumps[`fallback-${kind}`] = join(directory, `fallback-${kind}.rpc.json`);
    return [id, { driver: "grokAgent", config: { cli: join(root, "server/testing/fake-acp-cli.ts"), fullAuto: true, workspace: home }, environment: { FAKE_ACP_MODE: kind === "quota" ? "quota-error" : kind === "progress" ? "quota-after-progress" : "fallback-healthy", FAKE_ACP_RPC_DUMP: dumps[`fallback-${kind}`] } }];
  }));
  writeFileSync(configPath, JSON.stringify({ ...config, instances: { ...fallbackInstances, ...instances } }));
  child = spawn(process.execPath, ["--import", guard, "--experimental-strip-types", join(root, "server/index.ts")], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", () => {}); child.stderr?.on("data", () => {});
  await waitForOwnedServer(child, base);
}, 30_000);

afterAll(async () => {
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (runtime) await new Promise<void>((resolve) => runtime!.close(() => resolve()));
  if (directory) await removeTempDir(directory);
});

it("withholds installation connector status and catalog from another hosted owner without runtime traffic", async () => {
  const before = requests.length;
  const status = await api("/api/connectors?services=googlecalendar", secondary);
  expect.soft(status.status).toBe(200);
  const state = z.object({ configured: z.boolean(), services: z.record(z.string(), z.unknown()), reason: z.string().optional() }).parse(await status.json());
  expect.soft(state).toEqual({ configured: false, services: {}, reason: expect.any(String) });
  const catalog = await api("/api/connectors/catalog", secondary);
  expect.soft(catalog.status).toBe(200);
  expect.soft(await catalog.json()).toMatchObject({ configured: false, cards: [] });
  expect(requests.length).toBe(before);
});

it.each(["POST", "DELETE"])("refuses secondary %s connection mutation before reaching the runtime", async (method) => {
  const before = requests.length;
  const response = await api(`/api/connectors/googlecalendar${method === "POST" ? "/authorize" : ""}`, secondary, method, method === "POST" ? {} : undefined);
  expect.soft(response.status).toBe(403);
  expect(requests.length).toBe(before);
});

it("does not advertise installation connector credentials as configured for another hosted owner", async () => {
  const response = await api("/api/config", secondary);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ openConnector: { configured: false }, composio: { configured: false } });
});

it("preserves primary operator status, catalog and authorization against the configured runtime", async () => {
  const before = requests.length;
  const status = await api("/api/connectors?services=googlecalendar", primary);
  expect(status.status).toBe(200);
  expect(await status.json()).toMatchObject({ configured: true, services: { googlecalendar: { connected: true } } });
  const catalog = await api("/api/connectors/catalog", primary);
  expect(catalog.status).toBe(200);
  expect(await catalog.json()).toMatchObject({ configured: true, cards: [{ slug: "googlecalendar", label: "Operator Calendar" }] });
  const authorize = await api("/api/connectors/googlecalendar/authorize", primary, "POST", {});
  expect(authorize.status).toBe(200);
  expect(await authorize.json()).toEqual({ url: "https://consent.example.test/operator-calendar" });
  expect(requests.slice(before)).toEqual(["GET /v1/apps/authenticated?service=googlecalendar", "GET /v1/providers", "POST /v1/connections/googlecalendar/connect"]);
  const config = await api("/api/config", primary);
  expect(await config.json()).toMatchObject({ openConnector: { configured: true } });
});


it.each(["primary", "secondary"])("mounts operator connectors only for primary-owned direct turns: %s", async (name) => {
  const cookie = name === "primary" ? primary : secondary;
  const created = await api("/api/bots", cookie, "POST", {});
  expect(created.status).toBe(201);
  const bot = z.object({ bot: z.object({ id: z.string(), threadId: z.string() }) }).parse(await created.json()).bot;
  const key = `${name}-direct`;
  expect((await api(`/api/bots/${bot.id}`, cookie, "PATCH", { composio: true, modelSelection: { instanceId: engineIds[key], model: "fake-acp-model" }, computer: "off" })).status).toBe(200);
  const before = requests.length;
  expect((await api(`/api/bots/${bot.id}/messages`, cookie, "POST", { text: "Inspect my available tools" })).status).toBe(202);
  await expect.poll(() => existsSync(`${dumps[key]}.mcp.json`), { timeout: 10_000 }).toBe(true);
  const entries = serversWire.parse(JSON.parse(readFileSync(`${dumps[key]}.mcp.json`, "utf8")));
  const connector = entries.find((entry) => entry.name === "composio");
  expect(Boolean(connector)).toBe(name === "primary");
  if (name === "primary") {
    expect(connector?.env).toEqual(expect.arrayContaining([
      { name: "OMB_BOT_ID", value: bot.id },
      { name: "OMB_THREAD_ID", value: bot.threadId },
      { name: "OMB_COMMS_TOKEN", value: expect.any(String) },
    ]));
  }
  expect(JSON.stringify(entries)).not.toContain(runtimeToken);
  expect(requests.length).toBe(before);
}, 20_000);

it.each(["primary", "secondary"])("mounts operator connectors only for primary-owned group turns: %s", async (name) => {
  const cookie = name === "primary" ? primary : secondary;
  const created = await api("/api/bots", cookie, "POST", {});
  expect(created.status).toBe(201);
  const bot = z.object({ bot: z.object({ id: z.string() }) }).parse(await created.json()).bot;
  const key = `${name}-group`;
  expect((await api(`/api/bots/${bot.id}`, cookie, "PATCH", { composio: true, modelSelection: { instanceId: engineIds[key], model: "fake-acp-model" }, computer: "off" })).status).toBe(200);
  const made = await api("/api/groups", cookie, "POST", { name: "Owned connector group", memberIds: [bot.id], defaultResponder: { kind: "member", botId: bot.id } });
  expect(made.status).toBe(201);
  const group = z.object({ group: z.object({ id: z.string(), threadId: z.string() }) }).parse(await made.json()).group;
  const before = requests.length;
  expect((await api(`/api/groups/${group.id}/messages`, cookie, "POST", { text: "Inspect my available tools", expectedThreadId: group.threadId })).status).toBe(202);
  await expect.poll(() => existsSync(`${dumps[key]}.mcp.json`), { timeout: 10_000 }).toBe(true);
  const entries = serversWire.parse(JSON.parse(readFileSync(`${dumps[key]}.mcp.json`, "utf8")));
  const connector = entries.find((entry) => entry.name === "composio");
  expect(Boolean(connector)).toBe(name === "primary");
  if (name === "primary") {
    expect(connector?.env).toEqual(expect.arrayContaining([
      { name: "OMB_BOT_ID", value: bot.id },
      { name: "OMB_THREAD_ID", value: group.threadId },
      { name: "OMB_COMMS_TOKEN", value: expect.any(String) },
    ]));
  }
  expect(JSON.stringify(entries)).not.toContain(runtimeToken);
  expect(requests.length).toBe(before);
}, 20_000);

it("personal Calendar requires a real hosted session and allows each account its own consent", async () => {
  expect((await api("/api/calendar/status", "")).status).toBe(401);
  for (const cookie of [primary, secondary]) {
    const status = await api("/api/calendar/status", cookie);
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ configured: true, connected: false });
    const started = await api("/api/calendar/connect", cookie, "POST", {});
    expect(started.status).toBe(200);
    const { url } = z.object({ url: z.string() }).parse(await started.json());
    const consent = new URL(url);
    expect(consent.origin).toBe("https://accounts.google.com");
    expect(consent.searchParams.get("scope")).toContain("calendar.readonly");
    expect(consent.searchParams.get("code_challenge_method")).toBe("S256");
    expect(consent.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  }
});


it("persists explicit provider fallback per account through real authenticated routes", async () => {
  for (const cookie of [primary, secondary]) {
    const result = await api("/api/provider-fallback", cookie);
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ enabled: false, generation: 0, requiresSignIn: false });
  }
  expect((await api("/api/provider-fallback", primary, "PATCH", { enabled: "true" })).status).toBe(400);
  const enabled = await api("/api/provider-fallback", primary, "PATCH", { enabled: true });
  expect(enabled.status, await enabled.clone().text()).toBe(200);
  expect(await enabled.json()).toEqual({ enabled: true, generation: 1, requiresSignIn: false });
  expect(await (await api("/api/provider-fallback", secondary)).json()).toEqual({ enabled: false, generation: 0, requiresSignIn: false });
  expect((await api("/api/provider-fallback", primary, "PATCH", { enabled: false })).status).toBe(200);
});

it("keeps failed turns on their provider by default and after revoke, with one resend only when opted in", async () => {
  const botSchema = z.object({ id: z.string(), threadId: z.string(), activity: z.string(), modelSelection: z.object({ instanceId: z.string() }) });
  const messagesSchema = z.object({ messages: z.array(z.object({ role: z.string(), kind: z.string(), text: z.string().optional(), tool: z.object({ name: z.string() }).passthrough().optional() })) });
  for (const [index, enabled] of [false, true, false].entries()) {
    if (index > 0) expect((await api("/api/provider-fallback", secondary, "PATCH", { enabled })).status).toBe(200);
    const created = await api("/api/bots", secondary, "POST", {});
    expect(created.status).toBe(201);
    const { bot } = z.object({ bot: z.object({ id: z.string(), threadId: z.string() }) }).parse(await created.json());
    expect((await api(`/api/bots/${bot.id}`, secondary, "PATCH", { composio: false, modelSelection: { instanceId: engineIds["fallback-quota"], model: "fake-acp-model" }, computer: "off" })).status).toBe(200);
    const text = `Owned fallback ${bot.id}`;
    expect((await api(`/api/bots/${bot.id}/messages`, secondary, "POST", { text })).status).toBe(202);
    const readMessages = async () => messagesSchema.parse(await (await api(`/api/threads/${bot.threadId}/messages`, secondary)).json()).messages;
    // Observe the real driver error before checking terminal state; creation starts idle.
    await expect.poll(async () => JSON.stringify(await readMessages()), { timeout: 15_000 }).toContain("quota exceeded");
    if (enabled) await expect.poll(async () => JSON.stringify(await readMessages()), { timeout: 15_000 }).toContain("hello from fake acp");
    await expect.poll(async () => {
      const { bots } = z.object({ bots: z.array(botSchema) }).parse(await (await api("/api/bots", secondary)).json());
      return bots.find(candidate => candidate.id === bot.id)?.activity;
    }, { timeout: 15_000 }).toBe("idle");
    const { bots } = z.object({ bots: z.array(botSchema) }).parse(await (await api("/api/bots", secondary)).json());
    const finalBot = bots.find(candidate => candidate.id === bot.id);
    const messages = await readMessages();
    expect(finalBot?.modelSelection.instanceId).toBe(engineIds["fallback-quota"]);
    expect(messages.filter(message => message.role === "user" && message.kind === "text")).toHaveLength(1);
    expect(messages.filter(message => message.role === "bot" && message.kind === "text" && message.text?.includes("hello from fake acp"))).toHaveLength(enabled ? 1 : 0);
  }
}, 60_000);


it("does not silently replace an unavailable explicit provider even with fallback consent", async () => {
  expect((await api("/api/provider-fallback", secondary, "PATCH", { enabled: true })).status).toBe(200);
  const created = await api("/api/bots", secondary, "POST", {});
  expect(created.status).toBe(201);
  const { bot } = z.object({ bot: z.object({ id: z.string(), threadId: z.string() }) }).parse(await created.json());
  const missingInstance = engineIds.secondary.replace("providerApi:", "missingOwnedApi:");
  expect((await api(`/api/bots/${bot.id}`, secondary, "PATCH", { modelSelection: { instanceId: missingInstance, model: "fake-acp-model" }, computer: "off" })).status).toBe(200);
  const sent = await api(`/api/bots/${bot.id}/messages`, secondary, "POST", { text: "Keep my explicit provider choice" });
  expect(sent.status).toBe(409);
  expect(await sent.json()).toMatchObject({ error: expect.stringContaining("unavailable") });
  const { bots } = z.object({ bots: z.array(z.object({ id: z.string(), modelSelection: z.object({ instanceId: z.string() }) })) }).parse(await (await api("/api/bots", secondary)).json());
  expect(bots.find(candidate => candidate.id === bot.id)?.modelSelection.instanceId).toBe(missingInstance);
  const messages = await (await api(`/api/threads/${bot.threadId}/messages`, secondary)).json();
  expect(JSON.stringify(messages)).not.toContain("hello from fake acp");
  expect((await api("/api/provider-fallback", secondary, "PATCH", { enabled: false })).status).toBe(200);
});


it("returns a recoverable Calendar plan failure after reading the body without a grant", async () => {
  const response = await api("/api/calendar/plan", secondary, "POST", {
    calendarId: "primary", date: "2026-09-21", timeZone: "UTC", workStart: "09:00", workEnd: "17:00",
    commitments: [{ title: "Owned calendar task", minutes: 30 }],
  });
  expect(response.status, await response.clone().text()).toBe(409);
  expect(await response.json()).toMatchObject({ error: expect.stringContaining("Could not prepare a complete plan") });
});


it("interrupts the actual temporary alternate while preserving the preferred provider", async () => {
  expect((await api("/api/provider-fallback", secondary, "PATCH", { enabled: true })).status).toBe(200);
  const created = await api("/api/bots", secondary, "POST", {});
  expect(created.status).toBe(201);
  const { bot } = z.object({ bot: z.object({ id: z.string(), threadId: z.string() }) }).parse(await created.json());
  expect((await api(`/api/bots/${bot.id}`, secondary, "PATCH", { composio: false, modelSelection: { instanceId: engineIds["fallback-quota"], model: "fake-acp-model" }, computer: "off" })).status).toBe(200);
  const receipt = dumps["fallback-healthy"];
  writeFileSync(receipt, "[]");
  expect((await api(`/api/bots/${bot.id}/messages`, secondary, "POST", { text: "Owned FAKE_FALLBACK_HANG cancellation" })).status).toBe(202);
  const methods = () => z.array(z.string()).parse(JSON.parse(readFileSync(receipt, "utf8")));
  await expect.poll(methods, { timeout: 15_000 }).toContain("session/prompt");
  expect(methods()).not.toContain("session/prompt.result");
  const state = async () => z.object({ bots: z.array(z.object({ id: z.string(), activity: z.string(), modelSelection: z.object({ instanceId: z.string() }) })) }).parse(await (await api("/api/bots", secondary)).json()).bots.find(candidate => candidate.id === bot.id);
  expect(await state()).toMatchObject({ activity: "working", modelSelection: { instanceId: engineIds["fallback-quota"] } });
  const stopped = await api(`/api/bots/${bot.id}/interrupt`, secondary, "POST", {});
  expect(stopped.status, await stopped.clone().text()).toBe(200);
  await expect.poll(methods, { timeout: 10_000 }).toContain("session/cancel");
  expect(methods().filter(method => method === "session/cancel")).toHaveLength(1);
  await expect.poll(async () => (await state())?.activity, { timeout: 10_000 }).toBe("idle");
  expect((await state())?.modelSelection.instanceId).toBe(engineIds["fallback-quota"]);
  expect((await api("/api/provider-fallback", secondary, "PATCH", { enabled: false })).status).toBe(200);
}, 30_000);

it("does not replay quota failures after tool progress even with explicit consent", async () => {
  expect((await api("/api/provider-fallback", secondary, "PATCH", { enabled: true })).status).toBe(200);
  const created = await api("/api/bots", secondary, "POST", {});
  expect(created.status).toBe(201);
  const { bot } = z.object({ bot: z.object({ id: z.string(), threadId: z.string() }) }).parse(await created.json());
  expect((await api(`/api/bots/${bot.id}`, secondary, "PATCH", { composio: false, modelSelection: { instanceId: engineIds["fallback-progress"], model: "fake-acp-model" }, computer: "off" })).status).toBe(200);
  writeFileSync(dumps["fallback-healthy"], "[]");
  expect((await api(`/api/bots/${bot.id}/messages`, secondary, "POST", { text: "Owned progress must not replay" })).status).toBe(202);
  const readMessages = async () => z.object({ messages: z.array(z.object({ role: z.string(), kind: z.string(), text: z.string().optional(), tool: z.object({ name: z.string() }).passthrough().optional() })) }).parse(await (await api(`/api/threads/${bot.threadId}/messages`, secondary)).json()).messages;
  await expect.poll(async () => JSON.stringify(await readMessages()), { timeout: 15_000 }).toContain("quota exceeded");
  await expect.poll(async () => z.object({ bots: z.array(z.object({ id: z.string(), activity: z.string() })) }).parse(await (await api("/api/bots", secondary)).json()).bots.find(candidate => candidate.id === bot.id)?.activity, { timeout: 10_000 }).toBe("idle");
  const messages = await readMessages();
  expect(JSON.stringify(messages)).toContain("Owned work already started");
  expect(messages.filter(message => message.role === "user" && message.kind === "text")).toHaveLength(1);
  expect(JSON.stringify(messages)).not.toContain("hello from fake acp");
  expect(JSON.parse(readFileSync(dumps["fallback-healthy"], "utf8"))).toEqual([]);
  expect((await api("/api/provider-fallback", secondary, "PATCH", { enabled: false })).status).toBe(200);
}, 25_000);
