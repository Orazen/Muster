// The host-operation boundary (platform audit F1) over real HTTP, with two
// disposable hosted accounts, an INERT probe binary on the server's PATH and
// the deployment's real config.json.
//
// The three routes under test answer questions about the machine the server
// runs on: where its CLIs are, does a given binary run here, and what is in
// the operator's global instance map. A signed-in member is not the operator,
// so none of the three may be reachable for them — not merely hidden in the
// UI. Each case therefore asserts BOTH the refusal and the absence of the
// side effect it would have caused: no host path in the reply, no probe
// marker on disk, and a byte-identical config.json.
//
// The other half of the contract is that the guard must not cost anyone
// anything legitimate: the operator keeps all three routes, a LOCAL
// single-user install keeps all three (no session, no second user), and a
// member's own BYOK key still registers an engine they alone can see.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { pairingServerEnvironment, waitForOwnedServer } from "../e2e/pairing-harness.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { seedConnectedGoogleRow } from "./testing/storage-gate.ts";
import { DatabaseSync } from "node:sqlite";
import type { JsonValue } from "./schema.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
/** On PATH so `?name=` resolves it; spawned to see whether a probe ran. */
const PROBE_NAME = "muster-inert-probe";
const NO_RESOURCE = { error: "no such resource" };
const OPERATOR_ONLY = { error: "only the deployment operator can change configuration" };
const legacyBot = { id: "preownershiphostbot", threadId: "preownershiphostthread" };

interface Account { id: string; cookie: string }
interface DesktopExchangeProbe { code: string; state: string; mailboxProof?: JsonValue }
/** `probeDir` leads this server's PATH, `probePath` is the inert binary in it
 * and `marker` is the file it appends to — per server, so a hosted probe and
 * a local probe can never be mistaken for each other. */
interface OwnedServer { url: string; data: string; networkLog: string; probePath: string; marker: string; configPath: string; port: number; engineMarker: string; apiMarker: string; googleMarker: string; oauthExpectation: string; desktopMode: string; desktopReceipt: string; child: ChildProcess }

const instances = z.object({ instances: z.array(z.object({ instanceId: z.string(), cli: z.string().optional() })) });

describe.skipIf(process.platform === "win32")("host operations belong to the operator, over real HTTP", () => {
  let directory: string;
  let hosted: OwnedServer;
  let local: OwnedServer;
  let pending: OwnedServer;
  let paired: OwnedServer;
  let provedPair: OwnedServer;
  let pendingOwner: Account;
  let pendingMember: Account;
  let unprovenPair: Account;
  const secrets = new Map<string, string>();
  const pinnedEmail = "owned-operator-proof@example.test";
  let operator: Account;
  let member: Account;
  const children: ChildProcess[] = [];
  const servers: OwnedServer[] = [];
  const ports: number[] = [];

  const request = (server: OwnedServer, path: string, method = "GET", body?: JsonValue, account?: Account) => {
    const headers = new Headers({ origin: server.url, "content-type": "application/json" });
    if (account) headers.set("cookie", account.cookie);
    const init: RequestInit = { method, headers, redirect: "error", signal: AbortSignal.timeout(15_000) };
    if (body !== undefined) init.body = JSON.stringify(body);
    return fetch(`${server.url}${path}`, init);
  };
  const json = async (response: Response) => z.record(z.string(), z.unknown()).parse(await response.json());
  const ran = (server: OwnedServer) => existsSync(server.marker);
  const configBytes = (server: OwnedServer) => readFileSync(server.configPath, "utf8");

  async function boot(kind: "hosted" | "local" | "pending" | "paired" | "proved-pair", port: number): Promise<OwnedServer> {
    const root = join(directory, kind);
    const data = join(root, "data");
    const home = join(root, "home");
    const companionDirectory = join(root, "companion");
    for (const path of [data, home, companionDirectory]) mkdirSync(path, { recursive: true, mode: 0o700 });
    const configPath = join(data, "config.json");
    // `ghost` is the operator's global instance. A member patching it is the
    // exact global-mutation case F1 describes.
    writeFileSync(configPath, JSON.stringify({ profile: { name: `${kind} operator profile` }, instances: { ghost: { driver: "not-a-real-driver", displayName: `${kind} ghost` } } }));
    // Lapsed trial, no license: this fixture runs on the FREE tier.
    writeFileSync(join(data, "license.json"), JSON.stringify({ firstLaunchAt: new Date(Date.now() - 30 * 86_400_000).toISOString(), license: null }));
    const engineMarker = join(root, "engine-dispatched");
    const apiMarker = join(root, "api-dispatched");
    if (kind === "pending") {
      const cli = join(root, "owned-engine.ts");
      const fake = readFileSync(join(ROOT, "server/testing/fake-acp-cli.ts"), "utf8");
      writeFileSync(cli, fake.replace('function handle(msg: any) {', `function handle(msg: any) { if (msg.method === "session/prompt") writeFileSync(${JSON.stringify(engineMarker)}, ${JSON.stringify("dispatched\n")}, { flag: "a" });`));
      chmodSync(cli, 0o755);
      writeFileSync(configPath, JSON.stringify({ instances: {
        "": { driver: "grokAgent", config: { cli, fullAuto: true } },
        globalCli: { driver: "grokAgent", config: { cli, fullAuto: true } },
        globalApi: { driver: "deepseek", environment: { DEEPSEEK_API_KEY: "synthetic-global-refused" } },
      } }));
      // Plant a genuine legacy record before any account exists. Boot has
      // no resolved operator to stamp; later authority must resolve it live.
      writeFileSync(join(data, "bots.json"), JSON.stringify([{
        ...legacyBot, name: "Legacy host control", title: "", description: "",
        notifications: true, unread: false, privacyShield: true, color: "orange", character: "star",
        modelSelection: { instanceId: "globalCli", model: "grok-4.5" }, resumeCursors: {}, createdAt: Date.now(),
        tasks: [{ threadId: legacyBot.threadId, title: "First task", createdAt: Date.now(), resumeCursors: {} }],
      }]));
    }
    const googleMarker = join(root, "google-exchanges");
    const oauthExpectation = join(root, "oauth-expectation.json");
    const desktopMode = join(root, "desktop-response-mode.json");
    const desktopReceipt = join(root, "desktop-exchanges.jsonl");
    const networkLog = join(root, "outbound.log");
    const preload = join(root, "block-outbound.mjs");
    const pairTarget = kind === "paired" || kind === "proved-pair" ? pending?.url : undefined;
    writeFileSync(preload, `import { Socket } from "node:net";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { generateKeyPairSync, createHash, sign } from "node:crypto";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "owned-google-key", alg: "RS256", use: "sig" };
const blocked = () => { appendFileSync(${JSON.stringify(networkLog)}, "blocked\\n"); throw new Error("Owned fixture refuses outbound traffic"); };
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const expectation = existsSync(${JSON.stringify(oauthExpectation)}) ? JSON.parse(readFileSync(${JSON.stringify(oauthExpectation)}, "utf8")) : null;
  if (expectation && request.url === "https://oauth2.googleapis.com/token" && request.method === "POST") {
    const form = new URLSearchParams(await request.text());
    if (form.get("grant_type") !== "authorization_code" || form.get("code") !== expectation.code || form.get("redirect_uri") !== ${JSON.stringify(`http://127.0.0.1:${port}/api/auth/callback/google`)} ||
        form.get("client_id") !== process.env.GOOGLE_CLIENT_ID || form.get("client_secret") !== process.env.GOOGLE_CLIENT_SECRET || !/^[A-Za-z0-9_-]{43,128}$/.test(form.get("code_verifier") ?? "") ||
        createHash("sha256").update(form.get("code_verifier")).digest("base64url") !== expectation.challenge) return blocked();
    appendFileSync(${JSON.stringify(googleMarker)}, "token\\n");
    if (expectation.mode === "exchange-refused") return Response.json({ error: "invalid_grant" }, { status: 400 });
    const now = Math.floor(Date.now() / 1000);
    const claims = { sub: expectation.sub, email: expectation.email, email_verified: expectation.mode !== "unverified", name: "Owned Google", picture: "", iat: now, exp: now + 3600,
      iss: expectation.mode === "wrong-issuer" ? "https://untrusted.invalid" : "https://accounts.google.com", aud: expectation.mode === "wrong-audience" ? "another-client" : process.env.GOOGLE_CLIENT_ID, azp: process.env.GOOGLE_CLIENT_ID };
    const signingInput = Buffer.from(JSON.stringify({ alg: "RS256", kid: jwk.kid })).toString("base64url") + "." + Buffer.from(JSON.stringify(claims)).toString("base64url");
    const signature = expectation.mode === "forged" ? Buffer.alloc(256) : sign("RSA-SHA256", Buffer.from(signingInput), privateKey);
    const idToken = signingInput + "." + signature.toString("base64url");
    writeFileSync(${JSON.stringify(oauthExpectation + ".token")}, idToken);
    return Response.json({ access_token: "owned-google-access", token_type: "Bearer", expires_in: 3600, id_token: idToken });
  }
  if (expectation && request.url === "https://www.googleapis.com/oauth2/v3/certs" && request.method === "GET") {
    appendFileSync(${JSON.stringify(googleMarker)}, "jwks\\n");
    return Response.json({ keys: [jwk] });
  }
  if (${JSON.stringify(pairTarget)} && request.url === ${JSON.stringify((pairTarget ?? "") + "/api/pair/verify")} && request.method === "POST") return originalFetch(request);
  if (${JSON.stringify(pairTarget)} && request.url === ${JSON.stringify((pairTarget ?? "") + "/api/desktop-auth/exchange")} && request.method === "POST") {
    const upstream = await originalFetch(request);
    const text = await upstream.text();
    const body = JSON.parse(text);
    const headers = new Headers(upstream.headers);
    const mode = existsSync(${JSON.stringify(desktopMode)}) ? JSON.parse(readFileSync(${JSON.stringify(desktopMode)}, "utf8")) : "valid";
    appendFileSync(${JSON.stringify(desktopReceipt)}, JSON.stringify({ status: upstream.status, body, header: headers.get("x-muster-mailbox-proof"), version: headers.get("x-muster-exchange-version"), mode }) + "\\n");
    if (mode === "missing") headers.delete("x-muster-mailbox-proof");
    if (mode === "mismatch") headers.set("x-muster-mailbox-proof", Buffer.from(JSON.stringify({ version: 1, email: "other-owned@example.test", source: "local-google" })).toString("base64url"));
    if (mode === "forged") headers.set("x-muster-mailbox-proof", Buffer.from(JSON.stringify({ version: 1, email: body.email, source: "paired", elevated: true })).toString("base64url"));
    if (mode === "malformed-identity") return Response.json({ email: 42, name: body.name }, { status: upstream.status, headers });
    return new Response(text, { status: upstream.status, headers });
  }
  if (${JSON.stringify(kind)} === "pending" && request.url === "https://api.deepseek.com/v1/chat/completions" && request.method === "POST" && request.headers.get("authorization") === "Bearer synthetic-member-owned") {
    const body = await request.json();
    appendFileSync(${JSON.stringify(apiMarker)}, body.stream ? "turn\\n" : "auxiliary\\n");
    return body.stream ? new Response('data: {"choices":[{"delta":{"content":"owned response"},"finish_reason":"stop"}]}\\n\\ndata: [DONE]\\n\\n', { headers: { "content-type": "text/event-stream" } }) : Response.json({ choices: [{ message: { content: "owned response" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  }
  return blocked();
};
const connect = Socket.prototype.connect;
Socket.prototype.connect = function (...args) {
  const values = Array.isArray(args[0]) ? args[0] : args;
  const first = values[0];
  const options = first && typeof first === "object" ? first : { port: first, host: values[1] };
  const target = ${JSON.stringify(pairTarget)} ? new URL(${JSON.stringify(pairTarget ?? "http://127.0.0.1")}) : null;
  if (!target || options.path || options.host !== target.hostname || String(options.port) !== target.port) blocked();
  return Reflect.apply(connect, this, args);
};
`);
    // The probe appends to `marker` and prints a version line: inert apart
    // from proving it ran, which is what separates "refused" from "refused
    // after doing it anyway".
    const probeDir = join(root, "hostbin");
    const marker = join(root, "probe-ran");
    mkdirSync(probeDir, { recursive: true });
    const probePath = join(probeDir, PROBE_NAME);
    writeFileSync(probePath, `#!/bin/sh\nprintf 'probe\\n' >> ${JSON.stringify(marker)}\necho "9.9.9-inert"\n`);
    chmodSync(probePath, 0o755);
    const env = pairingServerEnvironment({ home, dataDirectory: data, companionDirectory, staticDir: join(directory, "ui"), port, webhookPort: port + 1, secret: secrets.get(kind) ?? randomBytes(32).toString("hex") });
    secrets.set(kind, env.BETTER_AUTH_SECRET!);
    // The probe dir leads PATH so discovery finds it by bare name.
    env.PATH = [probeDir, ...(env.PATH ?? "").split(delimiter)].filter(Boolean).join(delimiter);
    if (kind !== "local") Object.assign(env, { OMB_PUBLIC_HOST: `127.0.0.1:${port}`, OMB_ALLOW_SIGNUPS: "true", GOOGLE_CLIENT_ID: randomBytes(24).toString("hex"), GOOGLE_CLIENT_SECRET: randomBytes(24).toString("hex") });
    if (kind === "pending" || kind === "paired" || kind === "proved-pair") env.MUSTER_OPERATOR_EMAIL = pinnedEmail;
    if (pairTarget) env.OMB_PAIR_CLOUD_URL = pairTarget;
    const child = spawn(process.execPath, ["--import", preload, "--experimental-strip-types", join(ROOT, "server/index.ts")], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", () => {});
    const server: OwnedServer = { url: `http://127.0.0.1:${port}`, data, networkLog, probePath, marker, configPath, port, engineMarker, apiMarker, googleMarker, oauthExpectation, desktopMode, desktopReceipt, child };
    servers.push(server);
    await waitForOwnedServer(child, server.url);
    return server;
  }

  async function signUp(name: string, server = hosted, email?: string): Promise<Account> {
    const response = await request(server, "/api/auth/sign-up/email", "POST", { name, email: email ?? `${name}-${randomBytes(10).toString("hex")}@example.test`, password: randomBytes(32).toString("base64url") });
    expect(response.status).toBe(200);
    const { user } = z.object({ user: z.object({ id: z.string() }) }).parse(await response.json());
    const header = response.headers.getSetCookie().find((value) => value.startsWith("better-auth.session_token="));
    if (!header) throw new Error("Owned signup did not return a session");
    return { id: user.id, cookie: header.split(";")[0] };
  }

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "muster-host-operator-guard-"));
    mkdirSync(join(directory, "ui"), { recursive: true });
    writeFileSync(join(directory, "ui", "index.html"), "<!doctype html><title>Owned host guard fixture</title>");
    const port = await freePortBlock([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 28200, 8000);
    ports.push(...Array.from({ length: 10 }, (_, index) => port + index));
    hosted = await boot("hosted", port);
    local = await boot("local", port + 2);
    operator = await signUp("operator");
    member = await signUp("member");
    pending = await boot("pending", port + 4);
    pendingOwner = await signUp("pinned owner", pending, pinnedEmail);
    pendingMember = await signUp("pinned-member", pending);
    paired = await boot("paired", port + 6);
    provedPair = await boot("proved-pair", port + 8);
    seedConnectedGoogleRow(pending.data, pendingOwner.id);
    seedConnectedGoogleRow(pending.data, pendingMember.id);
  }, 90_000);

  afterAll(async () => {
    await Promise.all(children.map((child) => waitForExit(child, { signal: "SIGTERM" })));
    const exited = children.every((child) => child.exitCode !== null || child.signalCode !== null);
    const closedPorts = await Promise.all(ports.map((port) => new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.setTimeout(2_000);
      socket.once("connect", () => { socket.destroy(); resolve(false); });
      socket.once("timeout", () => { socket.destroy(); resolve(false); });
      socket.once("error", (error) => { socket.destroy(); resolve("code" in error && error.code === "ECONNREFUSED"); });
    })));
    const noOutbound = servers.every((server) => !existsSync(server.networkLog));
    if (directory && exited) await removeTempDir(directory);
    const rootRemoved = !directory || !existsSync(directory);
    console.info(JSON.stringify({ scope: "host operator guard cleanup", pids: children.map((child) => child.pid), exited, ports, closedPorts, noOutbound, rootRemoved }));
    expect({ exited, noOutbound, rootRemoved, closed: closedPorts.every(Boolean) }).toEqual({ exited: true, noOutbound: true, rootRemoved: true, closed: true });
  }, 20_000);

  it("proves the operator's host is real before asserting the member cannot see it", async () => {
    // A guard that denies because a fixture is empty proves nothing. These
    // three operator calls establish that discovery finds a real file, the
    // probe really spawns it, and the config really holds `ghost`.
    const found = await request(hosted, `/api/cli-candidates?name=${PROBE_NAME}`, "GET", undefined, operator);
    expect(found.status).toBe(200);
    expect(z.object({ candidates: z.array(z.string()) }).parse(await found.json()).candidates).toContain(hosted.probePath);

    const probed = await request(hosted, "/api/cli-test", "POST", { cli: hosted.probePath }, operator);
    expect(probed.status).toBe(200);
    expect(await json(probed)).toMatchObject({ ok: true, version: "9.9.9-inert" });
    expect(ran(hosted)).toBe(true);

    const patched = await request(hosted, "/api/instances/ghost", "PATCH", { cli: "/opt/ghost/operator-only" }, operator);
    expect(patched.status).toBe(200);
    expect(instances.parse(await patched.json()).instances.find((row) => row.instanceId === "ghost")?.cli).toBe("/opt/ghost/operator-only");
    // Reset so the "unchanged bytes" assertions below start from a known
    // operator-owned state rather than the fixture's original one.
    expect((await request(hosted, "/api/instances/ghost", "PATCH", { cli: "" }, operator)).status).toBe(200);
  });

  it("refuses CLI discovery for a member before any host path is disclosed", async () => {
    const response = await request(hosted, `/api/cli-candidates?name=${PROBE_NAME}`, "GET", undefined, member);
    expect(response.status).toBe(404);
    expect(await json(response)).toEqual(NO_RESOURCE);
    // The refusal must not smuggle the answer back: no probe path, no
    // directory fragment, and no candidate list at all.
    const raw = JSON.stringify(await request(hosted, `/api/cli-candidates?name=${PROBE_NAME}`, "GET", undefined, member).then((r) => r.json()));
    expect(raw).not.toContain(hosted.probePath);
    expect(raw).not.toContain(dirname(hosted.probePath));
    // Anonymous is not a member: it never gets past the session gate.
    expect((await request(hosted, `/api/cli-candidates?name=${PROBE_NAME}`)).status).toBe(401);
  });

  it("refuses the CLI probe for a member before the host spawns anything", async () => {
    // A fresh marker per case: a file left by the operator's probe above must
    // not be mistaken for this one having run.
    rmMarker(hosted);
    const response = await request(hosted, "/api/cli-test", "POST", { cli: hosted.probePath, driver: "claudeAgent" }, member);
    expect(response.status).toBe(404);
    expect(await json(response)).toEqual(NO_RESOURCE);
    // The side-effect assertion, not just the status.
    expect(ran(hosted)).toBe(false);
  });

  it("refuses the instance CLI override for a member before global config changes", async () => {
    const before = configBytes(hosted);
    const response = await request(hosted, "/api/instances/ghost", "PATCH", { cli: "/opt/ghost/member-smuggled" }, member);
    expect(response.status).toBe(403);
    expect(await json(response)).toEqual(OPERATOR_ONLY);
    expect(configBytes(hosted)).toBe(before);
    // Re-read through the API the operator uses: the override never landed in
    // the live registry either, not just on disk.
    const rows = instances.parse(await (await request(hosted, "/api/instances", "GET", undefined, operator)).json()).instances;
    expect(rows.find((row) => row.instanceId === "ghost")?.cli).toBeUndefined();
  });

  it("keeps a member's own BYOK usable while the operator's fleet stays theirs", async () => {
    const saved = await request(hosted, "/api/user-keys", "PUT", { providerId: "deepseek", apiKey: "sk-member-own-key" }, member);
    expect(saved.status).toBe(200);
    const own = instances.parse(await (await request(hosted, "/api/instances", "GET", undefined, member)).json()).instances;
    expect(own.map((row) => row.instanceId)).toContain(`deepseekApi:${member.id}`);
    expect(own.map((row) => row.instanceId)).not.toContain("ghost");
    // The operator's own fleet is unaffected by the member saving a key.
    const operatorRows = instances.parse(await (await request(hosted, "/api/instances", "GET", undefined, operator)).json()).instances;
    expect(operatorRows.map((row) => row.instanceId)).toContain("ghost");
    // And the pre-existing infra refusals this slice must not weaken.
    expect((await request(hosted, "/api/mcp-servers", "GET", undefined, member)).status).toBe(404);
    expect((await request(hosted, "/api/local-computer", "GET", undefined, member)).status).toBe(404);
    expect((await request(hosted, "/api/mcp-servers", "GET", undefined, operator)).status).toBe(200);
  });

  it("leaves a local single-user install fully able to manage its own host", async () => {
    // No session, no second user: the operator guard keys off the signed-in
    // identity, so a desktop install must lose nothing.
    expect(ran(local)).toBe(false);
    const found = await request(local, `/api/cli-candidates?name=${PROBE_NAME}`);
    expect(found.status).toBe(200);
    expect(z.object({ candidates: z.array(z.string()) }).parse(await found.json()).candidates).toContain(local.probePath);

    const probed = await request(local, "/api/cli-test", "POST", { cli: local.probePath });
    expect(probed.status).toBe(200);
    expect(await json(probed)).toMatchObject({ ok: true, version: "9.9.9-inert" });
    expect(ran(local)).toBe(true);

    const patched = await request(local, "/api/instances/ghost", "PATCH", { cli: "/opt/ghost/local-only" });
    expect(patched.status).toBe(200);
    expect(instances.parse(await patched.json()).instances.find((row) => row.instanceId === "ghost")?.cli).toBe("/opt/ghost/local-only");
  });

  it("refuses foreign and missing bot previews while preserving the host-operator guard", async () => {
    seedConnectedGoogleRow(hosted.data, member.id);
    const created = await request(hosted, "/api/bots", "POST", {}, member);
    expect(created.status).toBe(201);
    const { bot } = z.object({ bot: z.object({ id: z.string() }) }).parse(await created.json());
    const before = configBytes(hosted);
    for (const [path, method] of [["/api/local-computer", "GET"], ["/api/local-computer/screenshot", "POST"]]) {
      for (const id of [bot.id, "missing-preview-bot", ""]) {
        const response = await request(hosted, `${path}?botId=${encodeURIComponent(id)}`, method, undefined, operator);
        expect(response.status).toBe(404);
        expect(await json(response)).toEqual({ error: "no such bot" });
      }
      // A member cannot access installation runtimes even for their own bot.
      const memberResponse = await request(hosted, `${path}?botId=${bot.id}`, method, undefined, member);
      expect(memberResponse.status).toBe(404);
      expect(await json(memberResponse)).toEqual(NO_RESOURCE);
      const localMissing = await request(local, `${path}?botId=missing-preview-bot`, method);
      expect(localMissing.status).toBe(404);
      expect(await json(localMissing)).toEqual({ error: "no such bot" });
    }
    expect(configBytes(hosted)).toBe(before);
  });

  const botResponse = z.object({ bot: z.object({ id: z.string(), busy: z.boolean().optional() }) });
  async function createPendingBot(account: Account, instanceId: string) {
    const response = await request(pending, "/api/bots", "POST", {}, account);
    expect(response.status).toBe(201);
    const bot = botResponse.parse(await response.json()).bot;
    expect((await request(pending, `/api/bots/${bot.id}`, "PATCH", { computer: "off", modelSelection: { instanceId, model: instanceId === "globalCli" ? "grok-4.5" : "deepseek-chat" } }, account)).status).toBe(200);
    return bot;
  }
  async function pairInto(server: OwnedServer, account: Account) {
    const create = await request(pending, "/api/pair/create", "POST", {}, account);
    expect(create.status).toBe(201);
    const { code } = z.object({ code: z.string() }).parse(await create.json());
    const response = await request(server, "/api/pair/redeem", "POST", { code });
    expect(response.status).toBe(200);
    const cookie = response.headers.getSetCookie().find((value) => value.startsWith("better-auth.session_token="))?.split(";")[0];
    expect(cookie).toBeDefined();
    const session = await request(server, "/api/auth/get-session", "GET", undefined, { id: "unused", cookie: cookie! });
    const { user } = z.object({ user: z.object({ id: z.string(), emailVerified: z.boolean() }) }).parse(await session.json());
    return { id: user.id, cookie: cookie!, verified: user.emailVerified };
  }

  it("an unverified configured upstream can pair a session without acquiring the pinned operator", async () => {
    const identity = await pairInto(paired, pendingOwner);
    unprovenPair = identity;
    expect(identity.verified).toBe(false);
    expect((await request(paired, "/api/cli-candidates?name=" + PROBE_NAME, "GET", undefined, identity)).status).toBe(404);
    const db = new DatabaseSync(join(paired.data, "auth.db"));
    try {
      expect(db.prepare('SELECT count(*) AS n FROM "operator_mailbox_proof" WHERE "userId" = ?').get(identity.id)?.n).toBe(0);
      expect(db.prepare('SELECT count(*) AS n FROM "session" WHERE "userId" = ?').get(identity.id)?.n).toBe(1);
    } finally { db.close(); }
  });

  let googleClient = 0;
  async function googleLogin(server: OwnedServer, profile: { sub: string; email: string }, mode = "valid", invalidState = false) {
    // Each synthetic browser has a distinct proxy client address; production
    // OAuth throttling stays enabled and is not under test in this suite.
    const start = await fetch(`${server.url}/api/auth/sign-in/social`, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(15_000),
      headers: { origin: server.url, "content-type": "application/json", "x-forwarded-for": `198.51.100.${++googleClient}` },
      body: JSON.stringify({ provider: "google", callbackURL: `${server.url}/app` }),
    });
    expect(start.status).toBe(200);
    const { url } = z.object({ url: z.string() }).parse(await start.json());
    const authorization = new URL(url);
    expect(authorization.origin).toBe("https://accounts.google.com");
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    const challenge = authorization.searchParams.get("code_challenge");
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const code = randomBytes(16).toString("hex");
    writeFileSync(server.oauthExpectation, JSON.stringify({ ...profile, mode, code, challenge }));
    const state = invalidState ? "owned-wrong-state" : authorization.searchParams.get("state");
    const cookie = start.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    return fetch(`${server.url}/api/auth/callback/google?${new URLSearchParams({ state: state!, code })}`, {
      headers: { cookie }, redirect: "manual", signal: AbortSignal.timeout(15_000),
    });
  }
  function googleSub(server: OwnedServer, userId: string) {
    const db = new DatabaseSync(join(server.data, "auth.db"));
    try { return z.string().parse(db.prepare('SELECT "accountId" FROM "account" WHERE "userId" = ? AND "providerId" = ?').get(userId, "google")?.accountId); }
    finally { db.close(); }
  }
  function seedOtp(server: OwnedServer, email: string, type = "sign-in") {
    const db = new DatabaseSync(join(server.data, "auth.db"));
    const code = "483927";
    const now = new Date().toISOString();
    try { db.prepare('INSERT INTO "verification" ("id", "identifier", "value", "expiresAt", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?)').run(randomBytes(16).toString("hex"), `${type}-otp-${email}`, `${createHash("sha256").update(code).digest("base64url")}:0`, new Date(Date.now() + 60_000).toISOString(), now, now); }
    finally { db.close(); }
    return code;
  }

  it("a real linked Google callback cannot turn a different current mailbox into local operator proof", async () => {
    const response = await googleLogin(pending, { sub: googleSub(pending, pendingOwner.id), email: "different-current-mailbox@example.test" });
    expect(response.status).toBe(302);
    expect(response.headers.getSetCookie().some((cookie) => cookie.startsWith("better-auth.session_token="))).toBe(false);
    const db = new DatabaseSync(join(pending.data, "auth.db"));
    try {
      expect(db.prepare('SELECT count(*) AS n FROM "operator_mailbox_proof" WHERE "userId" = ?').get(pendingOwner.id)?.n).toBe(0);
      expect(db.prepare('SELECT "emailVerified" FROM "user" WHERE "id" = ?').get(pendingOwner.id)?.emailVerified).toBe(0);
    } finally { db.close(); }
    expect(readFileSync(pending.googleMarker, "utf8")).toContain("token\n");
    expect(readFileSync(pending.googleMarker, "utf8")).toContain("jwks\n");
    expect((await request(pending, "/api/cli-candidates?name=" + PROBE_NAME, "GET", undefined, pendingOwner)).status).toBe(404);
  });

  it.each(["wrong-audience", "wrong-issuer", "forged", "unverified", "exchange-refused"])("refuses actual Google %s callback without a mailbox proof", async (mode) => {
    const response = await googleLogin(pending, { sub: googleSub(pending, pendingOwner.id), email: pinnedEmail }, mode);
    expect(response.status).toBe(302);
    expect(response.headers.getSetCookie().some((cookie) => cookie.startsWith("better-auth.session_token="))).toBe(false);
    const db = new DatabaseSync(join(pending.data, "auth.db"));
    try {
      expect(db.prepare('SELECT count(*) AS n FROM "operator_mailbox_proof" WHERE "userId" = ?').get(pendingOwner.id)?.n).toBe(0);
      expect(db.prepare('SELECT "emailVerified" FROM "user" WHERE "id" = ?').get(pendingOwner.id)?.emailVerified).toBe(0);
    } finally { db.close(); }
  });

  it.each(["wrong-audience", "forged"])("refuses a %s token at the real direct-ID-token entry even with client profile fields", async (mode) => {
    await googleLogin(pending, { sub: googleSub(pending, pendingOwner.id), email: pinnedEmail }, mode);
    const token = readFileSync(pending.oauthExpectation + ".token", "utf8");
    const response = await fetch(`${pending.url}/api/auth/sign-in/social`, {
      method: "POST", redirect: "manual", signal: AbortSignal.timeout(15_000),
      headers: { origin: pending.url, "content-type": "application/json", "x-forwarded-for": `198.51.100.${++googleClient}` },
      body: JSON.stringify({ provider: "google", idToken: { token, user: { email: pinnedEmail, emailVerified: true } }, callbackURL: `${pending.url}/app` }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.getSetCookie().some((cookie) => cookie.startsWith("better-auth.session_token="))).toBe(false);
    const db = new DatabaseSync(join(pending.data, "auth.db"));
    try { expect(db.prepare('SELECT count(*) AS n FROM "operator_mailbox_proof" WHERE "userId" = ?').get(pendingOwner.id)?.n).toBe(0); }
    finally { db.close(); }
  });

  it("rejects a mismatched real OAuth state before any package token request", async () => {
    const before = readFileSync(pending.googleMarker, "utf8");
    const response = await googleLogin(pending, { sub: googleSub(pending, pendingOwner.id), email: pinnedEmail }, "valid", true);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("state_mismatch");
    expect(readFileSync(pending.googleMarker, "utf8")).toBe(before);
  });

  it("a correctly verified fresh Google account records current local mailbox proof", async () => {
    const email = "owned-fresh-google@example.test";
    const response = await googleLogin(pending, { sub: "owned-fresh-google-subject", email });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`${pending.url}/app`);
    const cookie = response.headers.getSetCookie().find((value) => value.startsWith("better-auth.session_token="))?.split(";")[0];
    expect(cookie).toBeDefined();
    const session = z.object({ user: z.object({ id: z.string(), email: z.string(), emailVerified: z.boolean() }) }).parse(await (await request(pending, "/api/auth/get-session", "GET", undefined, { id: "unused", cookie: cookie! })).json());
    expect(session.user).toMatchObject({ email, emailVerified: true });
    const db = new DatabaseSync(join(pending.data, "auth.db"));
    try { expect(db.prepare('SELECT "email", "source" FROM "operator_mailbox_proof" WHERE "userId" = ?').get(session.user.id)).toMatchObject({ email, source: "local-google" }); }
    finally { db.close(); }
  });

  it("quarantines a historical bridge stamp across restart; Google cannot bypass real email-primary cleanup", async () => {
    const db = new DatabaseSync(join(paired.data, "auth.db"));
    try { db.prepare('UPDATE "user" SET "emailVerified" = 1 WHERE "id" = ?').run(unprovenPair.id); }
    finally { db.close(); }
    seedConnectedGoogleRow(paired.data, unprovenPair.id);
    const sub = googleSub(paired, unprovenPair.id);
    await waitForExit(paired.child, { signal: "SIGTERM" });
    paired = await boot("paired", paired.port);
    const oldSession = z.object({ user: z.object({ emailVerified: z.boolean() }) }).parse(await (await request(paired, "/api/auth/get-session", "GET", undefined, unprovenPair)).json());
    expect(oldSession.user.emailVerified).toBe(false);
    const refused = await googleLogin(paired, { sub, email: pinnedEmail });
    expect(refused.status).toBe(302);
    expect(refused.headers.getSetCookie().some((cookie) => cookie.startsWith("better-auth.session_token="))).toBe(false);
    const heldDb = new DatabaseSync(join(paired.data, "auth.db"));
    const lock = `revoke-unproven-account-access:${unprovenPair.id}`;
    try {
      expect(heldDb.prepare('SELECT "emailVerified" FROM "user" WHERE "id" = ?').get(unprovenPair.id)?.emailVerified).toBe(0);
      expect(heldDb.prepare('SELECT count(*) AS n FROM "session" WHERE "userId" = ?').get(unprovenPair.id)?.n).toBe(1);
      const now = new Date().toISOString();
      heldDb.prepare('INSERT INTO "verification" ("id", "identifier", "value", "expiresAt", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?)').run(createHash("sha256").update("reserve:" + lock).digest("base64url"), lock, unprovenPair.id, new Date(Date.now() + 30_000).toISOString(), now, now);
    } finally { heldDb.close(); }
    const failedProof = await request(paired, "/api/auth/email-otp/verify-email", "POST", { email: pinnedEmail, otp: seedOtp(paired, pinnedEmail, "email-verification") }, unprovenPair);
    expect(failedProof.ok).toBe(false);
    const stillHeld = new DatabaseSync(join(paired.data, "auth.db"));
    try {
      expect(stillHeld.prepare('SELECT "emailVerified" FROM "user" WHERE "id" = ?').get(unprovenPair.id)?.emailVerified).toBe(0);
      expect(stillHeld.prepare('SELECT count(*) AS n FROM "operator_mailbox_proof" WHERE "userId" = ?').get(unprovenPair.id)?.n).toBe(0);
      expect(stillHeld.prepare('SELECT count(*) AS n FROM "session" WHERE "userId" = ?').get(unprovenPair.id)?.n).toBe(1);
      stillHeld.prepare('DELETE FROM "verification" WHERE "identifier" = ?').run(lock);
    } finally { stillHeld.close(); }
    const verified = await request(paired, "/api/auth/sign-in/email-otp", "POST", { email: pinnedEmail, otp: seedOtp(paired, pinnedEmail) });
    expect(verified.status).toBe(200);
    const cookie = verified.headers.getSetCookie().find((value) => value.startsWith("better-auth.session_token="))?.split(";")[0];
    expect(cookie).toBeDefined();
    expect(await (await request(paired, "/api/auth/get-session", "GET", undefined, unprovenPair)).json()).toBeNull();
    expect((await request(paired, "/api/cli-candidates?name=" + PROBE_NAME, "GET", undefined, { id: unprovenPair.id, cookie: cookie! })).status).toBe(200);
    const cleanDb = new DatabaseSync(join(paired.data, "auth.db"));
    try {
      expect(cleanDb.prepare('SELECT count(*) AS n FROM "account" WHERE "userId" = ?').get(unprovenPair.id)?.n).toBe(0);
      expect(cleanDb.prepare('SELECT count(*) AS n FROM "session" WHERE "userId" = ?').get(unprovenPair.id)?.n).toBe(1);
      expect(cleanDb.prepare('SELECT count(*) AS n FROM "operator_mailbox_quarantine" WHERE "userId" = ?').get(unprovenPair.id)?.n).toBe(0);
      expect(cleanDb.prepare('SELECT "source" FROM "operator_mailbox_proof" WHERE "userId" = ?').get(unprovenPair.id)?.source).toBe("local-email");
    } finally { cleanDb.close(); }
  }, 30_000);

  it("an unverified upstream cannot pair into an existing locally proven operator", async () => {
    const target = await signUp("Owned target operator", provedPair, pinnedEmail);
    const verified = await request(provedPair, "/api/auth/sign-in/email-otp", "POST", { email: pinnedEmail, otp: seedOtp(provedPair, pinnedEmail) });
    expect(verified.status).toBe(200);
    const localCookie = verified.headers.getSetCookie().find((value) => value.startsWith("better-auth.session_token="))?.split(";")[0];
    expect(localCookie).toBeDefined();
    const create = await request(pending, "/api/pair/create", "POST", {}, pendingOwner);
    expect(create.status).toBe(201);
    const { code } = z.object({ code: z.string() }).parse(await create.json());
    const response = await request(provedPair, "/api/pair/redeem", "POST", { code });
    expect(response.status).toBe(409);
    expect(response.headers.getSetCookie()).toHaveLength(0);
    expect((await request(provedPair, "/api/cli-candidates?name=" + PROBE_NAME, "GET", undefined, { id: target.id, cookie: localCookie! })).status).toBe(200);
    const db = new DatabaseSync(join(provedPair.data, "auth.db"));
    try { expect(db.prepare('SELECT count(*) AS n FROM "session" WHERE "userId" = ?').get(target.id)?.n).toBe(1); }
    finally { db.close(); }
  });

  it("refuses actual global CLI/API and healed-empty dispatch while the pin is pending, releasing the busy claim", async () => {
    for (const instanceId of ["globalCli", "globalApi", ""]) {
      const bot = await createPendingBot(pendingOwner, instanceId);
      const refused = await request(pending, `/api/bots/${bot.id}/messages`, "POST", { text: "owned pending turn" }, pendingOwner);
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ error: expect.stringContaining("model key owned by its account") });
      const fetched = z.object({ bots: z.array(z.object({ id: z.string(), busy: z.boolean() })) }).parse(await (await request(pending, "/api/bots", "GET", undefined, pendingOwner)).json());
      expect(fetched.bots.find((row) => row.id === bot.id)?.busy).toBe(false);
      expect(existsSync(pending.engineMarker)).toBe(false);
      expect(existsSync(pending.apiMarker)).toBe(false);
    }
    const legacy = await request(pending, `/api/bots/${legacyBot.id}/messages`, "POST", { text: "unresolved legacy owner" }, pendingOwner);
    expect(legacy.status).toBe(404);
    expect(await legacy.json()).toEqual({ error: "no such bot" });
    expect(existsSync(pending.engineMarker)).toBe(false);
  });

  it("keeps a member's actual owned BYOK dispatch usable while refusing foreign BYOK", async () => {
    expect((await request(pending, "/api/user-keys", "PUT", { providerId: "deepseek", apiKey: "synthetic-member-owned" }, pendingMember)).status).toBe(200);
    const bot = await createPendingBot(pendingMember, `deepseekApi:${pendingMember.id}`);
    const sent = await request(pending, `/api/bots/${bot.id}/messages`, "POST", { text: "owned BYOK turn" }, pendingMember);
    expect(sent.status).toBe(202);
    const deadline = Date.now() + 10_000;
    while (!existsSync(pending.apiMarker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(existsSync(pending.apiMarker)).toBe(true);
    const foreign = await createPendingBot(pendingOwner, `deepseekApi:${pendingMember.id}`);
    const refused = await request(pending, `/api/bots/${foreign.id}/messages`, "POST", { text: "foreign key" }, pendingOwner);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: expect.stringContaining("another user's engine") });
    expect(readFileSync(pending.apiMarker, "utf8").split("\n").filter((line) => line === "turn")).toHaveLength(1);
    expect(existsSync(pending.engineMarker)).toBe(false);
  });

  it("actual local OTP mailbox proof grants the pin and pairs only current proven mailboxes", async () => {
    const db = new DatabaseSync(join(pending.data, "auth.db"));
    const code = "483927";
    const now = new Date().toISOString();
    try {
      db.prepare('INSERT INTO "verification" ("id", "identifier", "value", "expiresAt", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?)').run(randomBytes(16).toString("hex"), `sign-in-otp-${pinnedEmail}`, `${createHash("sha256").update(code).digest("base64url")}:0`, new Date(Date.now() + 60_000).toISOString(), now, now);
    } finally { db.close(); }
    const proof = await request(pending, "/api/auth/sign-in/email-otp", "POST", { email: pinnedEmail, otp: code });
    expect(proof.status).toBe(200);
    const cookie = proof.headers.getSetCookie().find((value) => value.startsWith("better-auth.session_token="))?.split(";")[0];
    expect(cookie).toBeDefined();
    pendingOwner = { id: pendingOwner.id, cookie: cookie! };
    expect((await request(pending, "/api/cli-candidates?name=" + PROBE_NAME, "GET", undefined, pendingOwner)).status).toBe(200);
    const identity = await pairInto(provedPair, pendingOwner);
    expect(identity.verified).toBe(true);
    expect((await request(provedPair, "/api/cli-candidates?name=" + PROBE_NAME, "GET", undefined, identity)).status).toBe(200);
    const pairDb = new DatabaseSync(join(provedPair.data, "auth.db"));
    try { expect(pairDb.prepare('SELECT "email", "source" FROM "operator_mailbox_proof" WHERE "userId" = ?').get(identity.id)).toMatchObject({ email: pinnedEmail, source: "local-email" }); }
    finally { pairDb.close(); }
    const freshEmail = "owned-fresh-pair@example.test";
    const fresh = await signUp("Owned fresh paired mailbox", pending, freshEmail);
    const freshProof = await request(pending, "/api/auth/sign-in/email-otp", "POST", { email: freshEmail, otp: seedOtp(pending, freshEmail) });
    expect(freshProof.status).toBe(200);
    const freshCookie = freshProof.headers.getSetCookie().find((value) => value.startsWith("better-auth.session_token="))?.split(";")[0];
    expect(freshCookie).toBeDefined();
    const freshPair = await pairInto(provedPair, { id: fresh.id, cookie: freshCookie! });
    expect(freshPair.verified).toBe(true);
    const freshDb = new DatabaseSync(join(provedPair.data, "auth.db"));
    try {
      expect(freshDb.prepare('SELECT "email", "source" FROM "operator_mailbox_proof" WHERE "userId" = ?').get(freshPair.id)).toMatchObject({ email: freshEmail, source: "paired" });
      expect(freshDb.prepare('SELECT count(*) AS n FROM "operator_mailbox_quarantine" WHERE "userId" = ?').get(freshPair.id)?.n).toBe(0);
    } finally { freshDb.close(); }
    const existing = await pairInto(paired, pendingOwner);
    expect(existing.verified).toBe(true);
    expect((await request(paired, "/api/cli-candidates?name=" + PROBE_NAME, "GET", undefined, existing)).status).toBe(200);
    const bot = await createPendingBot(pendingOwner, "globalCli");
    expect((await request(pending, `/api/bots/${bot.id}/messages`, "POST", { text: "proved operator turn" }, pendingOwner)).status).toBe(202);
    const deadline = Date.now() + 10_000;
    while (!existsSync(pending.engineMarker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(existsSync(pending.engineMarker)).toBe(true);
  });

  it("uses the current proven operator for an existing ownerless record, without access to a member's engine", async () => {
    const stored = z.array(z.object({ id: z.string(), ownerId: z.string().optional() })).parse(JSON.parse(readFileSync(join(pending.data, "bots.json"), "utf8")));
    expect(stored.find(bot => bot.id === legacyBot.id)).toEqual(expect.objectContaining({ id: legacyBot.id }));
    expect(stored.find(bot => bot.id === legacyBot.id)?.ownerId).toBeUndefined();
    const before = readFileSync(pending.engineMarker, "utf8").split("\n").filter(line => line === "dispatched").length;
    const sent = await request(pending, `/api/bots/${legacyBot.id}/messages`, "POST", { text: "legacy operator global turn" }, pendingOwner);
    expect(sent.status).toBe(202);
    await expect.poll(() => readFileSync(pending.engineMarker, "utf8").split("\n").filter(line => line === "dispatched").length).toBe(before + 1);
    await expect.poll(async () => {
      const body = await (await request(pending, "/api/bots", "GET", undefined, pendingOwner)).json();
      const bots = z.object({ bots: z.array(z.object({ id: z.string(), busy: z.boolean() })) }).parse(body).bots;
      return bots.find(bot => bot.id === legacyBot.id)?.busy;
    }).toBe(false);
    const apiBefore = readFileSync(pending.apiMarker, "utf8");
    expect((await request(pending, `/api/bots/${legacyBot.id}`, "PATCH", { modelSelection: { instanceId: `deepseekApi:${pendingMember.id}`, model: "deepseek-chat" } }, pendingOwner)).status).toBe(200);
    const refused = await request(pending, `/api/bots/${legacyBot.id}/messages`, "POST", { text: "legacy foreign vault turn" }, pendingOwner);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: expect.stringContaining("another user's engine") });
    expect(readFileSync(pending.apiMarker, "utf8")).toBe(apiBefore);
    expect(readFileSync(pending.engineMarker, "utf8").split("\n").filter(line => line === "dispatched")).toHaveLength(before + 1);
    // The same foreign boundary applies to a record with an explicit primary
    // owner; an operator exception must not spend another account's key.
    const explicit = await createPendingBot(pendingOwner, `deepseekApi:${pendingMember.id}`);
    const explicitRefusal = await request(pending, `/api/bots/${explicit.id}/messages`, "POST", { text: "operator foreign vault turn" }, pendingOwner);
    expect(explicitRefusal.status).toBe(403);
    expect(await explicitRefusal.json()).toMatchObject({ error: expect.stringContaining("another user's engine") });
    expect(readFileSync(pending.apiMarker, "utf8")).toBe(apiBefore);
    const after = z.array(z.object({ id: z.string(), ownerId: z.string().optional() })).parse(JSON.parse(readFileSync(join(pending.data, "bots.json"), "utf8")));
    expect(after.find(bot => bot.id === legacyBot.id)?.ownerId).toBeUndefined();
  });

  async function desktopHandoff(target: OwnedServer, profile: { sub: string; email: string }, cloudAccount?: Account, requestProof?: JsonValue) {
    const attempt = await request(target, "/oauth/attempt/begin", "POST", { redirect: target.url });
    expect(attempt.status).toBe(200);
    const { state, codeChallenge } = z.object({ state: z.string(), codeChallenge: z.string() }).parse(await attempt.json());
    const db = new DatabaseSync(join(pending.data, "auth.db"));
    const previous = new Set(db.prepare('SELECT "id" FROM "verification"').all().map((row) => row.id));
    const query = new URLSearchParams({ redirect: target.url, state, code_challenge: codeChallenge, code_challenge_method: "S256" });
    const start = await fetch(`${pending.url}/desktop-auth/start?${query}`, { redirect: "manual", signal: AbortSignal.timeout(15_000), headers: { "x-forwarded-for": `198.51.100.${++googleClient}` } });
    expect(start.status).toBe(302);
    const authorization = new URL(start.headers.get("location")!);
    expect(authorization.origin).toBe("https://accounts.google.com");
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    let doneURL: string;
    let cookie: string;
    try {
      if (cloudAccount) {
        const row = db.prepare('SELECT "id", "value" FROM "verification"').all().find((entry) => !previous.has(entry.id));
        const { callbackURL } = z.object({ callbackURL: z.string() }).parse(JSON.parse(z.string().parse(row?.value)));
        doneURL = new URL(callbackURL, pending.url).href;
        cookie = cloudAccount.cookie;
      } else {
        const code = randomBytes(16).toString("hex");
        writeFileSync(pending.oauthExpectation, JSON.stringify({ ...profile, mode: "valid", code, challenge: authorization.searchParams.get("code_challenge") }));
        const callback = await fetch(`${pending.url}/api/auth/callback/google?${new URLSearchParams({ state: authorization.searchParams.get("state")!, code })}`, {
          headers: { cookie: start.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ") }, redirect: "manual", signal: AbortSignal.timeout(15_000),
        });
        expect(callback.status).toBe(302);
        doneURL = new URL(callback.headers.get("location")!, pending.url).href;
        expect(new URL(doneURL).pathname).toBe("/desktop-auth/done");
        const sessionCookie = callback.headers.getSetCookie().find((value) => value.startsWith("better-auth.session_token="))?.split(";")[0];
        expect(sessionCookie).toBeDefined();
        cookie = sessionCookie!;
      }
    } finally { db.close(); }
    const done = await fetch(doneURL, { headers: { cookie }, redirect: "manual", signal: AbortSignal.timeout(15_000) });
    expect(done.status).toBe(302);
    const finish = new URL(done.headers.get("location")!);
    expect(finish.origin).toBe(target.url);
    expect(finish.pathname).toBe("/oauth/finish");
    const fragment = new URLSearchParams(finish.hash.slice(1));
    expect(fragment.get("state")).toBe(state);
    expect(fragment.get("v")).toBe("1");
    const body: DesktopExchangeProbe = { code: fragment.get("code")!, state };
    if (requestProof !== undefined) body.mailboxProof = requestProof;
    const response = await fetch(`${target.url}/oauth/finish/exchange`, { method: "POST", headers: { origin: target.url, "content-type": "application/json", "x-forwarded-for": `198.51.100.${++googleClient}` }, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(15_000) });
    const newCookie = response.headers.getSetCookie().find((value) => value.startsWith("better-auth.session_token="))?.split(";")[0];
    return { response, cookie: newCookie };
  }

  it("refuses a currently different Google mailbox for an already-proven operator before creating a session", async () => {
    const linkedAccount = new DatabaseSync(join(pending.data, "auth.db"));
    const now = new Date().toISOString();
    try {
      linkedAccount.prepare('INSERT INTO "account" ("id", "accountId", "providerId", "userId", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?)').run(randomBytes(16).toString("hex"), randomBytes(16).toString("hex"), "google", pendingOwner.id, now, now);
    } finally { linkedAccount.close(); }
    const before = new DatabaseSync(join(pending.data, "auth.db"));
    const sessions = before.prepare('SELECT count(*) AS n FROM "session" WHERE "userId" = ?').get(pendingOwner.id)?.n;
    const proof = before.prepare('SELECT "email", "source" FROM "operator_mailbox_proof" WHERE "userId" = ?').get(pendingOwner.id);
    before.close();
    expect(proof).toMatchObject({ email: pinnedEmail, source: "local-email" });
    const refused = await googleLogin(pending, { sub: googleSub(pending, pendingOwner.id), email: "different-proven-google@example.test" });
    expect(refused.status).toBe(302);
    expect(refused.headers.getSetCookie().some((cookie) => cookie.startsWith("better-auth.session_token="))).toBe(false);
    const after = new DatabaseSync(join(pending.data, "auth.db"));
    try {
      expect(after.prepare('SELECT count(*) AS n FROM "session" WHERE "userId" = ?').get(pendingOwner.id)?.n).toBe(sessions);
      expect(after.prepare('SELECT "email", "source" FROM "operator_mailbox_proof" WHERE "userId" = ?').get(pendingOwner.id)).toEqual(proof);
    } finally { after.close(); }
    expect((await request(pending, "/api/cli-candidates?name=" + PROBE_NAME, "GET", undefined, pendingOwner)).status).toBe(200);
    const legitimate = await googleLogin(pending, { sub: googleSub(pending, pendingOwner.id), email: pinnedEmail });
    expect(legitimate.status).toBe(302);
    const cookie = legitimate.headers.getSetCookie().find((value) => value.startsWith("better-auth.session_token="))?.split(";")[0];
    expect(cookie).toBeDefined();
    expect((await request(pending, "/api/cli-candidates?name=" + PROBE_NAME, "GET", undefined, { id: pendingOwner.id, cookie: cookie! })).status).toBe(200);
  });

  it("refuses current remote mailbox proof into a quarantined existing account without changing old custody", async () => {
    const email = "owned-quarantined-collision@example.test";
    const source = await signUp("Owned collision source", pending, email);
    const unverified = await pairInto(provedPair, source);
    expect(unverified.verified).toBe(false);
    const verified = await request(pending, "/api/auth/sign-in/email-otp", "POST", { email, otp: seedOtp(pending, email) });
    expect(verified.status).toBe(200);
    const cookie = verified.headers.getSetCookie().find((value) => value.startsWith("better-auth.session_token="))?.split(";")[0];
    expect(cookie).toBeDefined();
    const create = await request(pending, "/api/pair/create", "POST", {}, { id: source.id, cookie: cookie! });
    expect(create.status).toBe(201);
    const { code } = z.object({ code: z.string() }).parse(await create.json());
    const refused = await request(provedPair, "/api/pair/redeem", "POST", { code });
    expect(refused.status).toBe(409);
    expect(refused.headers.getSetCookie()).toHaveLength(0);
    const db = new DatabaseSync(join(provedPair.data, "auth.db"));
    try {
      expect(db.prepare('SELECT "emailVerified" FROM "user" WHERE "id" = ?').get(unverified.id)?.emailVerified).toBe(0);
      expect(db.prepare('SELECT count(*) AS n FROM "session" WHERE "userId" = ?').get(unverified.id)?.n).toBe(1);
      expect(db.prepare('SELECT count(*) AS n FROM "operator_mailbox_quarantine" WHERE "userId" = ?').get(unverified.id)?.n).toBe(1);
      expect(db.prepare('SELECT count(*) AS n FROM "operator_mailbox_proof" WHERE "userId" = ?').get(unverified.id)?.n).toBe(0);
    } finally { db.close(); }
    expect(z.object({ user: z.object({ id: z.string(), emailVerified: z.boolean() }) }).parse(await (await request(provedPair, "/api/auth/get-session", "GET", undefined, unverified)).json()).user).toEqual(expect.objectContaining({ id: unverified.id, emailVerified: false }));
  });

  const desktopEmail = "owned-desktop-repeat@example.test";
  let desktopIdentity: Account;
  it("preserves strict desktop response decoding through real fresh and repeat two-server PKCE handoffs", async () => {
    const profile = { sub: "owned-desktop-repeat-google", email: desktopEmail };
    for (let round = 0; round < 2; round++) {
      const result = await desktopHandoff(provedPair, profile);
      expect(result.response.status).toBe(200);
      expect(result.cookie).toBeDefined();
      const session = z.object({ user: z.object({ id: z.string(), email: z.string(), emailVerified: z.boolean() }) }).parse(await (await request(provedPair, "/api/auth/get-session", "GET", undefined, { id: "unused", cookie: result.cookie! })).json());
      expect(session.user).toMatchObject({ email: desktopEmail, emailVerified: true });
      if (round === 0) desktopIdentity = { id: session.user.id, cookie: result.cookie! };
      else expect(session.user.id).toBe(desktopIdentity.id);
    }
    const rows = readFileSync(provedPair.desktopReceipt, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.status).toBe(200);
      expect(row.version).toBe("1");
      expect(z.record(z.string(), z.string()).parse(row.body)).toEqual({ email: desktopEmail, name: "Owned Google" });
      expect(Object.keys(row.body).sort()).toEqual(["email", "name"]);
      expect(JSON.parse(Buffer.from(row.header, "base64url").toString("utf8"))).toEqual({ version: 1, email: desktopEmail, source: "local-google" });
    }
    const db = new DatabaseSync(join(provedPair.data, "auth.db"));
    try {
      expect(db.prepare('SELECT count(*) AS n FROM "session" WHERE "userId" = ?').get(desktopIdentity.id)?.n).toBe(2);
      expect(db.prepare('SELECT "source" FROM "operator_mailbox_proof" WHERE "userId" = ?').get(desktopIdentity.id)?.source).toBe("paired");
    } finally { db.close(); }
  });

  it.each(["missing", "mismatch", "forged"])("refuses a desktop %s provenance response without trusting browser-supplied proof", async (mode) => {
    const db = new DatabaseSync(join(provedPair.data, "auth.db"));
    const before = db.prepare('SELECT count(*) AS n FROM "session" WHERE "userId" = ?').get(desktopIdentity.id)?.n;
    db.close();
    writeFileSync(provedPair.desktopMode, JSON.stringify(mode));
    try {
      const result = await desktopHandoff(provedPair, { sub: "owned-desktop-repeat-google", email: desktopEmail }, undefined, { version: 1, email: desktopEmail, source: "local-google" });
      expect(result.response.status).toBe(409);
      expect(result.cookie).toBeUndefined();
    } finally { rmSync(provedPair.desktopMode); }
    const after = new DatabaseSync(join(provedPair.data, "auth.db"));
    try { expect(after.prepare('SELECT count(*) AS n FROM "session" WHERE "userId" = ?').get(desktopIdentity.id)?.n).toBe(before); }
    finally { after.close(); }
    expect(z.object({ user: z.object({ id: z.string() }) }).parse(await (await request(provedPair, "/api/auth/get-session", "GET", undefined, desktopIdentity)).json()).user.id).toBe(desktopIdentity.id);
  });

  it("refuses a malformed desktop identity even when its response header carries genuine mailbox proof", async () => {
    writeFileSync(provedPair.desktopMode, JSON.stringify("malformed-identity"));
    const db = new DatabaseSync(join(provedPair.data, "auth.db"));
    const sessions = db.prepare('SELECT count(*) AS n FROM "session" WHERE "userId" = ?').get(desktopIdentity.id)?.n;
    db.close();
    try {
      const result = await desktopHandoff(provedPair, { sub: "owned-desktop-repeat-google", email: desktopEmail });
      expect(result.response.status).toBe(502);
      expect(result.cookie).toBeUndefined();
    } finally { rmSync(provedPair.desktopMode); }
    const after = new DatabaseSync(join(provedPair.data, "auth.db"));
    try { expect(after.prepare('SELECT count(*) AS n FROM "session" WHERE "userId" = ?').get(desktopIdentity.id)?.n).toBe(sessions); }
    finally { after.close(); }
  });

  it("allows a first unproven desktop session but refuses its repeat and valid proof before local custody cleanup", async () => {
    const email = "owned-desktop-unproven@example.test";
    const source = await signUp("Owned desktop unproven", pending, email);
    const first = await desktopHandoff(provedPair, { sub: "unused", email }, source);
    expect(first.response.status).toBe(200);
    expect(first.cookie).toBeDefined();
    const original = z.object({ user: z.object({ id: z.string(), emailVerified: z.boolean() }) }).parse(await (await request(provedPair, "/api/auth/get-session", "GET", undefined, { id: "unused", cookie: first.cookie! })).json());
    expect(original.user.emailVerified).toBe(false);
    const repeat = await desktopHandoff(provedPair, { sub: "unused", email }, source, { version: 1, email, source: "local-email" });
    expect(repeat.response.status).toBe(409);
    expect(repeat.cookie).toBeUndefined();
    const verified = await request(pending, "/api/auth/sign-in/email-otp", "POST", { email, otp: seedOtp(pending, email) });
    expect(verified.status).toBe(200);
    const cookie = verified.headers.getSetCookie().find((value) => value.startsWith("better-auth.session_token="))?.split(";")[0];
    expect(cookie).toBeDefined();
    const currentProof = await desktopHandoff(provedPair, { sub: "unused", email }, { id: source.id, cookie: cookie! });
    expect(currentProof.response.status).toBe(409);
    expect(currentProof.cookie).toBeUndefined();
    const db = new DatabaseSync(join(provedPair.data, "auth.db"));
    try {
      expect(db.prepare('SELECT "emailVerified" FROM "user" WHERE "id" = ?').get(original.user.id)?.emailVerified).toBe(0);
      expect(db.prepare('SELECT count(*) AS n FROM "session" WHERE "userId" = ?').get(original.user.id)?.n).toBe(1);
      expect(db.prepare('SELECT count(*) AS n FROM "operator_mailbox_quarantine" WHERE "userId" = ?').get(original.user.id)?.n).toBe(1);
    } finally { db.close(); }
  });

  /** Delete, never truncate: `ran()` is an existence check, and an emptied
   * marker would read as "the probe ran" to the very next assertion. */
  function rmMarker(server: OwnedServer) {
    rmSync(server.marker, { force: true });
    expect(ran(server)).toBe(false);
  }
});
