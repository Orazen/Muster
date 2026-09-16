// Real hosted accounts and local HTTP routes, with owned files and all child
// outbound traffic refused. No providers, browser sessions or shared services.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { pairingServerEnvironment, waitForOwnedServer } from "../e2e/pairing-harness.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import type { JsonValue } from "./schema.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const botSchema = z.object({ id: z.string(), name: z.string(), ownerId: z.string().optional(), hidden: z.boolean().optional(), description: z.string() }).passthrough();
const groupSchema = z.object({ id: z.string(), threadId: z.string(), memberIds: z.array(z.string()), name: z.string(), defaultResponder: z.unknown() }).passthrough();
type Bot = z.infer<typeof botSchema>;
interface Account { id: string; cookie: string; bots: Bot[] }
interface OwnedServer { url: string; data: string; networkLog: string; operatorId: string; legacyRoomId: string; legacyThreadId: string }
const INVALID_MEMBERS = { error: "invalid room members" };

describe.skipIf(process.platform === "win32")("team owner boundaries over real HTTP", () => {
  let directory: string;
  let hosted: OwnedServer;
  let local: OwnedServer;
  let primary: Account;
  let alice: Account;
  let bob: Account;
  const children: ChildProcess[] = [];
  const servers: OwnedServer[] = [];
  const ports: number[] = [];
  const role = (name: "primary" | "alice" | "bob") => ({ primary, alice, bob })[name];
  const rows = (server: OwnedServer) => z.array(botSchema).parse(JSON.parse(readFileSync(join(server.data, "bots.json"), "utf8")));
  const files = (server: OwnedServer) => ["bots.json", "groups.json", "config.json"].map((name) => existsSync(join(server.data, name)) ? readFileSync(join(server.data, name), "utf8") : null);
  const transcript = (threadId: string) => {
    const db = new DatabaseSync(join(hosted.data, "messages.db"), { readOnly: true });
    try { return { messages: db.prepare("SELECT * FROM messages WHERE thread_id = ? ORDER BY rowid").all(threadId), head: db.prepare("SELECT * FROM thread_state WHERE thread_id = ?").all(threadId) }; }
    finally { db.close(); }
  };
  const owned = (account: Account) => rows(hosted).filter((bot) => bot.ownerId === account.id || (!bot.ownerId && account === primary));
  const request = (server: OwnedServer, path: string, method = "GET", body?: JsonValue, account?: Account) => {
    const headers = new Headers({ origin: server.url, "content-type": "application/json" });
    if (account) headers.set("cookie", account.cookie);
    const init: RequestInit = { method, headers, redirect: "error", signal: AbortSignal.timeout(10_000) };
    if (body !== undefined) init.body = JSON.stringify(body);
    return fetch(`${server.url}${path}`, init);
  };
  async function createBot(server: OwnedServer, name: string, account?: Account) {
    const response = await request(server, "/api/bots", "POST", {}, account);
    expect(response.status).toBe(201);
    const { bot } = z.object({ bot: botSchema }).parse(await response.json());
    // Creation ignores profile fields; use the actual edit route so exports
    // must preserve this account's distinct name and private description.
    const patched = await request(server, `/api/bots/${bot.id}`, "PATCH", { name, description: `private-description-${name}` }, account);
    expect(patched.status).toBe(200);
    const saved = z.object({ bot: botSchema }).parse(await patched.json()).bot;
    expect(saved).toMatchObject({ name, description: `private-description-${name}` });
    return saved;
  }
  async function room(account: Account) {
    const response = await request(hosted, "/api/groups", "POST", { name: "Original room", memberIds: account.bots.map((bot) => bot.id) }, account);
    expect(response.status).toBe(201);
    return z.object({ group: groupSchema }).parse(await response.json()).group;
  }
  async function boot(kind: "hosted" | "local", port: number): Promise<OwnedServer> {
    const root = join(directory, kind);
    const data = join(root, "data");
    const home = join(root, "home");
    const companionDirectory = join(root, "companion");
    for (const path of [data, home, companionDirectory]) mkdirSync(path, { recursive: true, mode: 0o700 });
    writeFileSync(join(data, "config.json"), JSON.stringify({ profile: { name: "Operator private profile" }, instances: { ghost: { driver: "not-a-real-driver", displayName: "Offline owner fixture" } } }));
    const operatorId = randomUUID();
    // A legacy unowned record is valid input data, not an authenticated user.
    const operator = { id: operatorId, threadId: randomUUID(), name: `${kind} operator bot`, description: `private-${kind}-operator`, title: "Operator only", color: "orange", notifications: true, unread: false, modelSelection: { instanceId: "ghost", model: "" }, resumeCursors: {}, createdAt: Date.now() };
    const foreignId = randomUUID();
    writeFileSync(join(data, "bots.json"), JSON.stringify([operator, ...(kind === "hosted" ? [{ ...operator, id: foreignId, threadId: randomUUID(), name: "Legacy foreign owner", ownerId: "owned-absent-account", description: "Foreign legacy private description" }] : [])]));
    const legacyRoomId = randomUUID();
    const legacyThreadId = randomUUID();
    if (kind === "hosted") writeFileSync(join(data, "groups.json"), JSON.stringify([{ id: legacyRoomId, threadId: legacyThreadId, name: "Legacy mixed operator room", memberIds: [operatorId, foreignId], defaultResponder: { kind: "everyone" }, bulletin: "Legacy private instructions", unread: false, createdAt: Date.now() }]));
    const networkLog = join(root, "outbound.log");
    const preload = join(root, "block-outbound.mjs");
    writeFileSync(preload, `import { Socket } from "node:net";\nimport { appendFileSync } from "node:fs";\nconst blocked = () => { appendFileSync(${JSON.stringify(networkLog)}, "blocked\\n"); throw new Error("Owned fixture refuses outbound traffic"); };\nglobalThis.fetch = blocked; Socket.prototype.connect = blocked;\n`);
    const env = pairingServerEnvironment({ home, dataDirectory: data, companionDirectory, staticDir: join(directory, "ui"), port, webhookPort: port + 1, secret: randomBytes(32).toString("hex") });
    if (kind === "hosted") Object.assign(env, { OMB_PUBLIC_HOST: `127.0.0.1:${port}`, OMB_ALLOW_SIGNUPS: "true", GOOGLE_CLIENT_ID: randomBytes(24).toString("hex"), GOOGLE_CLIENT_SECRET: randomBytes(24).toString("hex") });
    const child = spawn(process.execPath, ["--import", preload, "--experimental-strip-types", join(ROOT, "server/index.ts")], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", () => {});
    const server = { url: `http://127.0.0.1:${port}`, data, networkLog, operatorId, legacyRoomId, legacyThreadId };
    servers.push(server);
    await waitForOwnedServer(child, server.url);
    return server;
  }
  async function signUp(name: string): Promise<Account> {
    const response = await request(hosted, "/api/auth/sign-up/email", "POST", { name, email: `${name}-${randomBytes(10).toString("hex")}@example.test`, password: randomBytes(32).toString("base64url") });
    expect(response.status).toBe(200);
    const { user } = z.object({ user: z.object({ id: z.string() }) }).parse(await response.json());
    const header = response.headers.getSetCookie().find((value) => value.startsWith("better-auth.session_token="));
    if (!header) throw new Error("Owned signup did not return a session");
    const account: Account = { id: user.id, cookie: header.split(";")[0], bots: [] };
    account.bots.push(await createBot(hosted, `${name}-one`, account), await createBot(hosted, `${name}-two`, account));
    return account;
  }

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "muster-team-ownership-"));
    mkdirSync(join(directory, "ui"));
    writeFileSync(join(directory, "ui", "index.html"), "<!doctype html><title>Owned team fixture</title>");
    const port = await freePortBlock([0, 1, 2, 3], 28000, 10000);
    ports.push(port, port + 1, port + 2, port + 3);
    hosted = await boot("hosted", port);
    local = await boot("local", port + 2);
    primary = await signUp("primary");
    alice = await signUp("alice");
    bob = await signUp("bob");
  }, 60_000);

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
    console.info(JSON.stringify({ scope: "team ownership cleanup", pids: children.map((child) => child.pid), exited, ports, closedPorts, noOutbound, rootRemoved }));
    expect({ exited, noOutbound, rootRemoved, closed: closedPorts.every(Boolean) }).toEqual({ exited: true, noOutbound: true, rootRemoved: true, closed: true });
  }, 20_000);

  it("establishes distinct real hosted identities and the primary-only legacy roster", async () => {
    expect((await request(hosted, "/api/instances", "GET", undefined, primary)).status).toBe(200);
    // Non-primary gets 200 with ONLY their own engines — before they've
    // configured anything that's an honest empty list (the operator's
    // "ghost" fleet is not offered to them; it would be unusable anyway).
    const aliceInstances = z
      .object({ instances: z.array(z.object({ instanceId: z.string() })) })
      .parse(await (await request(hosted, "/api/instances", "GET", undefined, alice)).json());
    expect(aliceInstances.instances.map((i) => i.instanceId)).not.toContain("ghost");
    for (const account of [primary, alice, bob]) {
      const response = await request(hosted, "/api/bots", "GET", undefined, account);
      expect(response.status).toBe(200);
      expect(z.object({ bots: z.array(botSchema) }).parse(await response.json()).bots.map((bot) => bot.id).sort()).toEqual(owned(account).map((bot) => bot.id).sort());
    }
  });

  it("engine guard: a non-primary bot refuses on foreign engines with an actionable path, and rides its own vault instance", async () => {
    const bot = alice.bots[0];
    // Fresh account, no vault keys: the bot's selection is not a
    // user-scoped instance, so the turn must refuse — and say HOW to fix
    // it (Settings → Providers), never the old "run your own server"
    // dead-end that stranded users who had already brought their keys.
    const denied = await request(hosted, `/api/bots/${bot.id}/messages`, "POST", { text: "hello" }, alice);
    expect(denied.status).toBe(403);
    expect(z.object({ error: z.string() }).parse(await denied.json()).error).toContain("power this bot with your own model key");
    // Pointing at ANOTHER user's vault instance refuses with the
    // isolation note, not the setup note.
    await request(hosted, `/api/bots/${bot.id}`, "PATCH", { modelSelection: { instanceId: `deepseekApi:${bob.id}`, model: "x" } }, alice);
    const foreign = await request(hosted, `/api/bots/${bot.id}/messages`, "POST", { text: "hello" }, alice);
    expect(foreign.status).toBe(403);
    expect(z.object({ error: z.string() }).parse(await foreign.json()).error).toContain("another user's engine");
    // Own-suffixed instance: the guard passes. The turn then fails at
    // instance resolution (no such engine registered) — an engine-setup
    // error, NOT the operator-policy refusal.
    await request(hosted, `/api/bots/${bot.id}`, "PATCH", { modelSelection: { instanceId: `deepseekApi:${alice.id}`, model: "x" } }, alice);
    const past = await request(hosted, `/api/bots/${bot.id}/messages`, "POST", { text: "hello" }, alice);
    const body = z.object({ error: z.string().optional() }).parse(await past.json());
    expect(body.error ?? "").not.toContain("your own model key");
    expect(body.error ?? "").not.toContain("another user's engine");
  });

  it("refuses a legacy mixed-owner room before any user echo, head or activity changes", async () => {
    const before = { files: files(hosted), transcript: transcript(hosted.legacyThreadId), fleet: await (await request(hosted, "/api/bots", "GET", undefined, primary)).json() };
    const response = await request(hosted, `/api/groups/${hosted.legacyRoomId}/messages`, "POST", { text: "Must not reach the foreign member", expectedThreadId: hosted.legacyThreadId }, primary);
    expect.soft({ status: response.status, body: await response.json() }).toEqual({ status: 409, body: { error: "room members are unavailable" } });
    expect({ files: files(hosted), transcript: transcript(hosted.legacyThreadId), fleet: await (await request(hosted, "/api/bots", "GET", undefined, primary)).json() }).toEqual(before);
    expect(existsSync(hosted.networkLog)).toBe(false);
  });

  it("still accepts a clean owned room message and records truthful unavailable-model activity", async () => {
    const group = await room(alice);
    const response = await request(hosted, `/api/groups/${group.id}/messages`, "POST", { text: "Owned local-only message", expectedThreadId: group.threadId }, alice);
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ ok: true, threadId: group.threadId, message: { role: "user", kind: "text", text: "Owned local-only message" } });
    await expect.poll(() => JSON.stringify(transcript(group.threadId)), { timeout: 5_000 }).toContain("model is unavailable");
    expect(transcript(group.threadId).messages).toHaveLength(2);
    expect(existsSync(hosted.networkLog)).toBe(false);
  });

  it.each(["alice-to-bob", "alice-to-unowned", "primary-to-bob"] as const)("rejects the entire mixed PATCH: %s", async (mode) => {
    const account = mode === "primary-to-bob" ? primary : alice;
    const foreignId = mode === "alice-to-unowned" ? hosted.operatorId : bob.bots[0].id;
    const group = await room(account);
    const before = files(hosted);
    const response = await request(hosted, `/api/groups/${group.id}`, "PATCH", { name: "Must not rename", bulletin: "Must not save", memberIds: [account.bots[0].id, foreignId], defaultResponder: { kind: "member", botId: foreignId } }, account);
    expect.soft({ status: response.status, body: await response.json() }).toEqual({ status: 400, body: INVALID_MEMBERS });
    expect(files(hosted)).toEqual(before);
  });

  it("gives unknown and foreign member IDs the same refusal without changing the responder", async () => {
    const group = await room(alice);
    const before = files(hosted);
    const results = [];
    for (const id of [randomUUID(), bob.bots[0].id]) {
      const response = await request(hosted, `/api/groups/${group.id}`, "PATCH", { memberIds: [alice.bots[0].id, id] }, alice);
      results.push({ status: response.status, body: await response.json() });
    }
    expect.soft(results).toEqual([{ status: 400, body: INVALID_MEMBERS }, { status: 400, body: INVALID_MEMBERS }]);
    expect(files(hosted)).toEqual(before);
  });

  it.each([{ memberIds: null }, { memberIds: "not-an-array" }, { memberIds: [] }, { memberIds: [42] }])("rejects malformed memberIds $memberIds before applying other fields", async ({ memberIds }) => {
    const group = await room(alice);
    const before = files(hosted);
    const response = await request(hosted, `/api/groups/${group.id}`, "PATCH", { memberIds, name: "Rejected rename", bulletin: "Rejected bulletin", defaultResponder: { kind: "mentions" } }, alice);
    expect.soft({ status: response.status, body: await response.json() }).toEqual({ status: 400, body: INVALID_MEMBERS });
    expect(files(hosted)).toEqual(before);
  });

  it("accepts owned members once and validates default responders without partial updates", async () => {
    const group = await room(alice);
    const ids = [alice.bots[1].id, alice.bots[0].id];
    const response = await request(hosted, `/api/groups/${group.id}`, "PATCH", { name: "Owned update", bulletin: "Owned bulletin", memberIds: [ids[0], ids[0], ids[1]], defaultResponder: { kind: "member", botId: ids[0] } }, alice);
    expect(response.status).toBe(200);
    expect(z.object({ group: groupSchema }).parse(await response.json()).group).toMatchObject({ memberIds: ids, name: "Owned update", bulletin: "Owned bulletin", defaultResponder: { kind: "member", botId: ids[0] } });
    const before = files(hosted);
    const invalid = await request(hosted, `/api/groups/${group.id}`, "PATCH", { name: "Not saved", defaultResponder: { kind: "member", botId: bob.bots[0].id } }, alice);
    expect(invalid.status).toBe(400);
    expect(files(hosted)).toEqual(before);
    const mentions = await request(hosted, `/api/groups/${group.id}`, "PATCH", { defaultResponder: { kind: "mentions" } }, alice);
    expect(mentions.status).toBe(200);
  });

  it("preserves the room-owner guard even for the deployment primary", async () => {
    const group = await room(bob);
    const before = files(hosted);
    for (const account of [alice, primary]) expect((await request(hosted, `/api/groups/${group.id}`, "PATCH", { name: "Foreign rename" }, account)).status).toBe(404);
    expect(files(hosted)).toEqual(before);
  });

  it("retains POST room filtering while accepting primary-owned unowned records", async () => {
    for (const account of [primary, alice]) {
      const response = await request(hosted, "/api/groups", "POST", { memberIds: [account.bots[0].id, bob.bots[0].id, hosted.operatorId, randomUUID()] }, account);
      expect(response.status).toBe(201);
      expect(z.object({ group: groupSchema }).parse(await response.json()).group.memberIds).toEqual(account === primary ? [account.bots[0].id, hosted.operatorId] : [account.bots[0].id]);
    }
    expect((await request(hosted, "/api/groups", "POST", { memberIds: [bob.bots[0].id, hosted.operatorId] }, alice)).status).toBe(400);
  });

  it.each(["primary", "alice", "bob"] as const)("exports only %s's visible team, not foreign descriptions or the operator profile", async (name) => {
    const account = role(name);
    const before = files(hosted);
    const response = await request(hosted, "/api/teams/export", "POST", {}, account);
    expect(response.status).toBe(200);
    const manifest = z.object({ team: z.object({ name: z.string(), members: z.array(z.object({ name: z.string(), description: z.string() })) }) }).parse(await response.json());
    expect.soft(manifest.team.members.map((member) => ({ name: member.name, description: member.description })).sort((a, b) => a.name.localeCompare(b.name))).toEqual(owned(account).filter((bot) => !bot.hidden).map((bot) => ({ name: bot.name, description: bot.description })).sort((a, b) => a.name.localeCompare(b.name)));
    if (account !== primary) expect.soft(manifest.team.name).not.toContain("Operator private profile");
    expect(files(hosted)).toEqual(before);
  });

  it.each(["primary", "alice", "bob"] as const)("scans only %s's bots and includes no foreign identifiers", async (name) => {
    const account = role(name);
    const before = files(hosted);
    const response = await request(hosted, "/api/security-scan", "GET", undefined, account);
    expect(response.status).toBe(200);
    const { findings } = z.object({ findings: z.array(z.object({ botId: z.string(), botName: z.string() })) }).parse(await response.json());
    expect.soft([...new Set(findings.map((finding) => finding.botId))].sort()).toEqual(owned(account).filter((bot) => !bot.hidden).map((bot) => bot.id).sort());
    expect(files(hosted)).toEqual(before);
  });

  it.each(["alice", "primary"] as const)("replace-import archives only %s's old team and preserves every foreign record", async (name) => {
    const account = role(name);
    const before = rows(hosted);
    const ownIds = new Set(owned(account).map((bot) => bot.id));
    const foreign = before.filter((bot) => !ownIds.has(bot.id));
    const response = await request(hosted, "/api/teams/import?mode=replace", "POST", { format: "muster.team", version: 2, team: { name: "Owned import", members: [{ key: "worker", name: `${name} imported`, description: "Owned imported description", appearance: { color: "blue" } }] } }, account);
    expect(response.status).toBe(201);
    const result = z.object({ bots: z.array(botSchema), archivedBots: z.array(botSchema), archived: z.array(z.object({ id: z.string() })) }).parse(await response.json());
    const archived = before.filter((bot) => ownIds.has(bot.id) && !bot.hidden).map((bot) => bot.id).sort();
    expect.soft(result.archived.map((bot) => bot.id).sort()).toEqual(archived);
    expect.soft(result.archivedBots.map((bot) => bot.id).sort()).toEqual(archived);
    expect.soft(result.bots).toHaveLength(1);
    expect.soft(result.bots[0].ownerId).toBeUndefined();
    const after = rows(hosted);
    expect.soft(after.find((bot) => bot.id === result.bots[0].id)?.ownerId).toBe(account.id);
    expect.soft(after.filter((bot) => foreign.some((record) => record.id === bot.id))).toEqual(foreign);
    expect(after.filter((bot) => archived.includes(bot.id)).every((bot) => bot.hidden === true)).toBe(true);
  });

  it("refuses anonymous hosted access to each exposed operation", async () => {
    const before = files(hosted);
    for (const [path, method] of [["/api/teams/export", "POST"], ["/api/teams/import?mode=replace", "POST"], ["/api/security-scan", "GET"], ["/api/groups", "POST"]]) expect((await request(hosted, path, method, method === "GET" ? undefined : {})).status).toBe(401);
    expect(files(hosted)).toEqual(before);
  });

  it("retains global local export, scan, room membership and replace-import behavior", async () => {
    const bot = await createBot(local, "local teammate");
    const before = rows(local);
    const exported = await request(local, "/api/teams/export", "POST", {});
    expect(exported.status).toBe(200);
    const manifest = z.object({ team: z.object({ members: z.array(z.object({ name: z.string() })) }) }).passthrough().parse(await exported.json());
    expect(manifest.team.members.map((member) => member.name).sort()).toEqual(before.map((entry) => entry.name).sort());
    const scan = await request(local, "/api/security-scan");
    expect(scan.status).toBe(200);
    expect([...new Set(z.object({ findings: z.array(z.object({ botId: z.string() })) }).parse(await scan.json()).findings.map((finding) => finding.botId))].sort()).toEqual(before.map((entry) => entry.id).sort());
    const created = await request(local, "/api/groups", "POST", { memberIds: [bot.id] });
    expect(created.status).toBe(201);
    const group = z.object({ group: groupSchema }).parse(await created.json()).group;
    const patched = await request(local, `/api/groups/${group.id}`, "PATCH", { memberIds: [bot.id, local.operatorId], defaultResponder: { kind: "member", botId: local.operatorId } });
    expect(patched.status).toBe(200);
    expect(z.object({ group: groupSchema }).parse(await patched.json()).group.memberIds).toEqual([bot.id, local.operatorId]);
    const imported = await request(local, "/api/teams/import?mode=replace", "POST", { format: "muster.team", version: 2, team: { name: "Local imported", members: [{ key: "worker", name: "Local replacement", appearance: { color: "blue" } }] } });
    expect(imported.status).toBe(201);
    expect(rows(local).filter((entry) => before.some((old) => old.id === entry.id)).every((entry) => entry.hidden)).toBe(true);
  });

  it("keeps aggregate read surfaces and engine-fleet routes free of foreign tenants", async () => {
    // Give bob's bot a global instance id so the usage route WOULD list it
    // if it iterated the shared store unfiltered (PATCH accepts an offline
    // instance by design — only startTurn refuses to run on it).
    const patched = await request(hosted, `/api/bots/${bob.bots[0].id}`, "PATCH", { modelSelection: { instanceId: "ghost", model: "" } }, bob);
    expect(patched.status).toBe(200);
    // A canary message inside bob's own room: search indexes the global
    // message DB, so this is the content-leak probe.
    const bobRoom = await room(bob);
    const canary = `cross-tenant-canary-${randomBytes(6).toString("hex")}`;
    const sent = await request(hosted, `/api/groups/${bobRoom.id}/messages`, "POST", { text: canary, expectedThreadId: bobRoom.threadId }, bob);
    expect(sent.status).toBe(202);
    await expect.poll(() => JSON.stringify(transcript(bobRoom.threadId).messages), { timeout: 5_000 }).toContain(canary);

    const searchAs = async (account: Account) => z.object({ hits: z.array(z.record(z.string(), z.unknown())) })
      .parse(await (await request(hosted, `/api/search?q=${canary}`, "GET", undefined, account)).json()).hits;
    expect(await searchAs(alice)).toEqual([]);
    expect((await searchAs(bob)).length).toBeGreaterThan(0);

    const usageText = async (account: Account) => JSON.stringify(await (await request(hosted, "/api/usage/providers", "GET", undefined, account)).json());
    expect(await usageText(alice)).not.toContain("bob-one");
    expect(await usageText(bob)).toContain("bob-one");

    const wrappedText = JSON.stringify(await (await request(hosted, "/api/wrapped", "GET", undefined, alice)).json());
    expect(wrappedText).not.toContain("bob-one");

    // Engine-fleet metadata is operator-only: free-best answers before the
    // infra guard runs, so it gates itself.
    expect((await request(hosted, "/api/models/free-best", "GET", undefined, alice)).status).toBe(404);
    expect((await request(hosted, "/api/models/free-best", "GET", undefined, primary)).status).toBe(200);
    // Custom providers are PER-USER on hosted: the routes answer from the
    // caller's own store, never the operator's global config. This closes
    // the "no such resource" dead-end that left non-primary accounts with
    // an empty model picker and no way to add their own endpoint.
    const added = await request(
      hosted,
      "/api/custom-providers",
      "POST",
      { name: "Bai", baseUrl: "https://api.b.ai/v1", format: "openai", models: ["glm-4.5"], apiKey: "sk-alice-bai" },
      alice,
    );
    expect(added.status).toBe(201);
    const addedBody = z.object({ id: z.string(), instanceId: z.string() }).parse(await added.json());
    expect(addedBody.id).toBe("bai");
    expect(addedBody.instanceId).toBe(`custom-baiApi:${alice.id}`);
    const aliceProviders = z
      .object({ providers: z.array(z.object({ id: z.string(), configured: z.boolean(), instanceId: z.string() })) })
      .parse(await (await request(hosted, "/api/custom-providers", "GET", undefined, alice)).json());
    expect(aliceProviders.providers).toEqual([{ id: "bai", configured: true, instanceId: `custom-baiApi:${alice.id}` }]);
    // Neither bob nor the operator can see or clobber it.
    expect((await request(hosted, "/api/custom-providers", "GET", undefined, bob)).status).toBe(200);
    const bobProviders = z
      .object({ providers: z.array(z.object({ id: z.string() })) })
      .parse(await (await request(hosted, "/api/custom-providers", "GET", undefined, bob)).json());
    expect(bobProviders.providers.map((p) => p.id)).not.toContain("bai");
    const primaryProviders = z
      .object({ providers: z.array(z.object({ id: z.string() })) })
      .parse(await (await request(hosted, "/api/custom-providers", "GET", undefined, primary)).json());
    expect(primaryProviders.providers.map((p) => p.id)).not.toContain("bai");
    // The picker now lists her own instance and nothing of the operator's.
    const aliceFleet = z
      .object({ instances: z.array(z.object({ instanceId: z.string() })) })
      .parse(await (await request(hosted, "/api/instances", "GET", undefined, alice)).json());
    expect(aliceFleet.instances.map((i) => i.instanceId)).toContain(`custom-baiApi:${alice.id}`);
    expect(aliceFleet.instances.map((i) => i.instanceId)).not.toContain("ghost");
    // fetch-models is reachable for her (SSRF refusal, not 404): the route
    // validates scheme/host before any network call.
    expect(
      (await request(hosted, "/api/custom-providers/fetch-models", "POST", { baseUrl: "http://127.0.0.1:9/v1" }, alice)).status,
    ).toBe(400);
    // Deleting clears her metadata and her vault key; bob adds his own
    // "bai" in his own namespace — same id, different engine.
    expect((await request(hosted, `/api/custom-providers/bai`, "DELETE", undefined, alice)).status).toBe(200);
    expect(
      z
        .object({ providers: z.array(z.object({ id: z.string() })) })
        .parse(await (await request(hosted, "/api/custom-providers", "GET", undefined, alice)).json())
        .providers,
    ).toEqual([]);
    const bobAdd = await request(
      hosted,
      "/api/custom-providers",
      "POST",
      { name: "Bai", baseUrl: "https://api.b.ai/v1", format: "openai", models: ["glm-4.5"] },
      bob,
    );
    expect(bobAdd.status).toBe(201);
    expect(z.object({ instanceId: z.string() }).parse(await bobAdd.json()).instanceId).toBe(`custom-baiApi:${bob.id}`);
  });

  it("runs the full social journey across tenants: profile, request, consent, directory, page", async () => {
    // both owners publish public profiles
    const aliceProfile = await request(hosted, "/api/social/profile", "PUT", { botId: alice.bots[0].id, visibility: "public", tagline: "research lead" }, alice);
    expect(aliceProfile.status).toBe(200);
    const aliceHandle = z.object({ profile: z.object({ handle: z.string(), visibility: z.string() }) }).parse(await aliceProfile.json()).profile.handle;
    expect(aliceHandle).toBe("alice-one");
    expect((await request(hosted, "/api/social/profile", "PUT", { botId: bob.bots[0].id, visibility: "public" }, bob)).status).toBe(200);
    // a bot with no profile cannot publish one through someone else
    expect((await request(hosted, "/api/social/profile", "PUT", { botId: bob.bots[0].id, visibility: "public" }, alice)).status).toBe(404);

    // anonymous directory sees only public profiles
    const directory = z.object({ agents: z.array(z.object({ handle: z.string(), name: z.string() })) })
      .parse(await (await request(hosted, "/api/directory/agents")).json()).agents;
    expect(directory.map((a) => a.handle).sort()).toEqual(["alice-one", "bob-one"]);

    // bob's bot requests alice's; the sender cannot accept it
    const created = await request(hosted, "/api/social/friend-requests", "POST", { fromBotId: bob.bots[0].id, toHandle: aliceHandle, message: "collaborate?" }, bob);
    expect(created.status).toBe(201);
    const requestId = z.object({ request: z.object({ id: z.string() }) }).parse(await created.json()).request.id;
    expect((await request(hosted, `/api/social/friend-requests/${requestId}/accept`, "POST", undefined, bob)).status).toBe(400);
    // a stranger cannot even probe it
    expect((await request(hosted, `/api/social/friend-requests/${requestId}/accept`, "POST", undefined, primary)).status).toBe(400);

    // alice accepts; both see the friendship, the bystander never does
    expect((await request(hosted, `/api/social/friend-requests/${requestId}/accept`, "POST", undefined, alice)).status).toBe(200);
    // SAFETY: the social-state route answers with this envelope for every
    // account; the JSON round-trip only deep-copies it so each call is fresh.
    const stateOf = async (account: Account) => JSON.parse(JSON.stringify(await (await request(hosted, "/api/social/state", "GET", undefined, account)).json())) as {
      friends: { theirName: string }[]; incoming: unknown[]; outgoing: unknown[];
    };
    expect((await stateOf(alice)).friends.map((f) => f.theirName)).toEqual(["bob-one"]);
    expect((await stateOf(bob)).friends.map((f) => f.theirName)).toEqual(["alice-one"]);
    const primaryState = await stateOf(primary);
    expect(primaryState.friends).toEqual([]);
    expect(primaryState.incoming).toEqual([]);

    // the public profile page renders for the public handle only
    const page = await fetch(`${hosted.url}/p/${aliceHandle}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("alice-one");
    expect((await fetch(`${hosted.url}/p/no-such-handle`)).status).toBe(404);

    // unfriending by one owner removes the edge for both
    const friendshipId = (await stateOf(alice)).friends.length ? JSON.parse(JSON.stringify(await (await request(hosted, "/api/social/state", "GET", undefined, alice)).json())).friends[0].friendship.id : "";
    expect((await request(hosted, `/api/social/friends/${friendshipId}`, "DELETE", undefined, bob)).status).toBe(200);
    expect((await stateOf(alice)).friends).toEqual([]);
    expect((await stateOf(bob)).friends).toEqual([]);
  });
});
