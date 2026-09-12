// Genuine hosted dispatches into the offline ACP driver issue the credentials
// under test. Private receipts stay in the owned temp root and never enter logs.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { JsonObject } from "./schema.ts";
import { pairingServerEnvironment, waitForOwnedServer } from "../e2e/pairing-harness.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const receiptSchema = z.object({ pid: z.number().int(), method: z.enum(["session/new", "session/load"]), servers: z.array(z.object({ name: z.string(), env: z.array(z.object({ name: z.string(), value: z.string() })).optional() })) });
type Receipt = z.infer<typeof receiptSchema>;
const botSchema = z.object({ id: z.string(), threadId: z.string(), busy: z.boolean().optional() });
type Bot = z.infer<typeof botSchema>;
interface Lease { pid: number; token: string; connectorToken: string; threadId: string; method: Receipt["method"] }

describe.skipIf(process.platform === "win32")("peer capabilities from actual offline ACP dispatch", () => {
  let directory: string;
  let data: string;
  let receipts: string;
  let networkLog: string;
  let url: string;
  let port: number;
  let env: NodeJS.ProcessEnv;
  let preload: string;
  let server: ChildProcess;
  let cookie: string;
  let caller: Bot;
  let helper: Bot;
  let alternateThread: string;
  let current: Lease | undefined;
  const children: ChildProcess[] = [];
  const foreignId = randomUUID();
  const operatorId = randomUUID();
  const hiddenId = randomUUID();

  const api = (path: string, method = "GET", body?: JsonObject, token?: string) => {
    const request: RequestInit = { method, headers: { origin: url, "content-type": "application/json", ...(token === undefined ? { cookie } : { authorization: `Bearer ${token}` }) }, redirect: "error", signal: AbortSignal.timeout(15_000) };
    if (body !== undefined) request.body = JSON.stringify(body);
    return fetch(url + path, request);
  };
  const sessionReceipts = () => readdirSync(receipts).filter((name) => name.endsWith(".session.json")).map((name) => receiptSchema.parse(JSON.parse(readFileSync(join(receipts, name), "utf8"))));
  const promptCount = () => readdirSync(receipts).filter((name) => name.endsWith(".prompt.json")).length;
  const messagesFor = (threadId: string) => {
    const db = new DatabaseSync(join(data, "messages.db"), { readOnly: true });
    try { return db.prepare("SELECT * FROM messages WHERE thread_id = ? ORDER BY rowid").all(threadId); }
    finally { db.close(); }
  };
  const peerCard = () => {
    const db = new DatabaseSync(join(data, "messages.db"), { readOnly: true });
    try {
      const row = db.prepare("SELECT json_extract(json, '$.card') AS card FROM messages WHERE thread_id = ? AND json_extract(json, '$.card.tool') = 'ask_bot' ORDER BY rowid DESC LIMIT 1").get(lease().threadId);
      const parsed = z.object({ card: z.string() }).safeParse(row);
      return parsed.success ? z.object({ requestId: z.string(), answered: z.string().optional(), dismissed: z.boolean().optional() }).parse(JSON.parse(parsed.data.card)) : undefined;
    } finally { db.close(); }
  };
  const snapshot = () => {
    const db = new DatabaseSync(join(data, "messages.db"), { readOnly: true });
    try { return { messages: db.prepare("SELECT * FROM messages ORDER BY rowid").all(), heads: db.prepare("SELECT * FROM thread_state ORDER BY thread_id").all(), files: ["bots.json", "groups.json", "delegations.json"].map((name) => existsSync(join(data, name)) ? readFileSync(join(data, name), "utf8") : null), prompts: promptCount() }; }
    finally { db.close(); }
  };
  const roster = async () => {
    const response = await api("/api/bots");
    expect(response.status).toBe(200);
    return z.object({ bots: z.array(botSchema) }).parse(await response.json()).bots;
  };
  const idle = () => expect.poll(async () => (await roster()).find((bot) => bot.id === caller.id)?.busy ?? false, { timeout: 10_000 }).toBe(false);
  const release = async (lease: Lease) => {
    writeFileSync(join(receipts, `${lease.pid}.release`), "release", { mode: 0o600 });
    await idle();
  };
  async function begin(): Promise<Lease> {
    const known = new Set(sessionReceipts().map((receipt) => receipt.pid));
    caller = (await roster()).find((bot) => bot.id === caller.id) ?? caller;
    const response = await api(`/api/bots/${caller.id}/messages`, "POST", { text: "Owned capability turn", expectedThreadId: caller.threadId });
    expect(response.status).toBe(202);
    await expect.poll(() => sessionReceipts().filter((receipt) => !known.has(receipt.pid) && receipt.servers.some((entry) => entry.name === "agents")).length, { timeout: 15_000 }).toBe(1);
    const receipt = sessionReceipts().find((entry) => !known.has(entry.pid) && entry.servers.some((integration) => integration.name === "agents"));
    if (!receipt) throw new Error("No owned issued credential receipt");
    await expect.poll(() => existsSync(join(receipts, `${receipt.pid}.prompt.json`)), { timeout: 5_000 }).toBe(true);
    const values = (name: string) => Object.fromEntries((receipt.servers.find((entry) => entry.name === name)?.env ?? []).map((entry) => [entry.name, entry.value]));
    const peer = values("agents");
    const connector = values("composio");
    if (!peer.OMB_COMMS_TOKEN || !connector.OMB_COMMS_TOKEN) throw new Error("Actual dispatch omitted a required fixture integration");
    expect(statSync(join(receipts, `${receipt.pid}.session.json`)).mode & 0o777).toBe(0o600);
    expect(peer.OMB_BOT_ID).toBe(caller.id);
    expect(peer.OMB_THREAD_ID).toBe(caller.threadId);
    return { pid: receipt.pid, token: peer.OMB_COMMS_TOKEN, connectorToken: connector.OMB_COMMS_TOKEN, threadId: peer.OMB_THREAD_ID, method: receipt.method };
  }
  const lease = () => { if (!current) throw new Error("No current fixture lease"); return current; };
  async function boot() {
    server = spawn(process.execPath, ["--import", preload, "--experimental-strip-types", join(ROOT, "server/index.ts")], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    children.push(server);
    writeFileSync(join(directory, "ownership.json"), JSON.stringify({ directory, ports: [port, port + 1], serverPids: children.map((child) => child.pid) }), { mode: 0o600 });
    server.stdout?.on("data", () => {});
    server.stderr?.on("data", () => {});
    await waitForOwnedServer(server, url);
  }
  async function create(name: string, instanceId: string): Promise<Bot> {
    const created = await api("/api/bots", "POST", {});
    expect(created.status).toBe(201);
    const bot = z.object({ bot: botSchema }).parse(await created.json()).bot;
    expect((await api(`/api/bots/${bot.id}`, "PATCH", { name, modelSelection: { instanceId, model: "fake-acp-model" }, computer: "off", composio: true })).status).toBe(200);
    return bot;
  }

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "muster-peer-capabilities-"));
    data = join(directory, "data"); receipts = join(directory, "receipts"); networkLog = join(directory, "outbound.log");
    for (const path of [data, receipts, join(directory, "home"), join(directory, "companion"), join(directory, "ui")]) mkdirSync(path, { recursive: true, mode: 0o700 });
    writeFileSync(join(directory, "ui", "index.html"), "<!doctype html><title>Owned peer fixture</title>");
    const fake = join(ROOT, "server/testing/fake-acp-cli.ts");
    const instance = (mode: string) => ({ driver: "grokAgent", config: { cli: fake, fullAuto: true }, environment: { FAKE_ACP_MODE: mode, FAKE_ACP_PEER_DIRECTORY: receipts } });
    writeFileSync(join(data, "config.json"), JSON.stringify({ instances: { held: instance("peer-capability"), happy: instance("happy") }, composio: { apiKey: "owned-nonfunctional-project-key" } }), { mode: 0o600 });
    const seed = (id: string, name: string) => ({ id, name, threadId: randomUUID(), title: "Owned fixture", description: `${name} private description`, color: "orange", notifications: true, unread: false, modelSelection: { instanceId: "happy", model: "fake-acp-model" }, resumeCursors: {}, createdAt: Date.now(), computer: "off" });
    writeFileSync(join(data, "bots.json"), JSON.stringify([{ ...seed(foreignId, "Foreign private sentinel"), ownerId: "synthetic-foreign-owner" }, seed(operatorId, "Legacy operator peer"), { ...seed(hiddenId, "Hidden private peer"), hidden: true }]), { mode: 0o600 });
    preload = join(directory, "block-outbound.mjs");
    writeFileSync(preload, `import { Socket } from "node:net"; import { appendFileSync } from "node:fs"; const blocked=()=>{appendFileSync(${JSON.stringify(networkLog)},"blocked\\n");throw new Error("Owned peer fixture denies outbound traffic");};globalThis.fetch=blocked;Socket.prototype.connect=blocked;`);
    port = await freePortBlock([0, 1], 26000, 10000); url = `http://127.0.0.1:${port}`;
    env = pairingServerEnvironment({ home: join(directory, "home"), dataDirectory: data, companionDirectory: join(directory, "companion"), staticDir: join(directory, "ui"), port, webhookPort: port + 1, secret: randomBytes(32).toString("hex") });
    Object.assign(env, { OMB_PUBLIC_HOST: `127.0.0.1:${port}`, OMB_ALLOW_SIGNUPS: "true", GOOGLE_CLIENT_ID: "owned-client-id", GOOGLE_CLIENT_SECRET: "owned-client-secret" });
    cookie = "";
    await boot();
    const signed = await api("/api/auth/sign-up/email", "POST", { name: "Owned primary", email: `owner-${randomBytes(10).toString("hex")}@example.test`, password: randomBytes(32).toString("base64url") });
    expect(signed.status).toBe(200);
    const header = signed.headers.getSetCookie().find((value) => value.startsWith("better-auth.session_token="));
    if (!header) throw new Error("No owned primary session");
    cookie = header.split(";")[0];
    caller = await create("Capability caller", "held"); helper = await create("Allowed helper", "happy");
    alternateThread = caller.threadId;
    const task = await api(`/api/bots/${caller.id}/tasks`, "POST", { title: "Current owned task" });
    expect(task.status).toBe(201);
    caller = z.object({ bot: botSchema }).parse(await task.json()).bot;
    expect((await api("/api/instances")).status).toBe(200);
  }, 60_000);
  beforeEach(async () => { current = await begin(); }, 25_000);
  afterEach(async () => { if (current) await release(current); current = undefined; }, 15_000);
  afterAll(async () => {
    const observed = receipts && existsSync(receipts) ? sessionReceipts() : [];
    for (const receipt of observed) writeFileSync(join(receipts, `${receipt.pid}.release`), "cleanup", { mode: 0o600 });
    await Promise.all(children.map((child) => waitForExit(child, { signal: "SIGTERM" })));
    const processGone = (pid: number) => { try { process.kill(pid, 0); return false; } catch (error) { return error instanceof Error && "code" in error && error.code === "ESRCH"; } };
    const deadline = Date.now() + 10_000;
    while (!observed.every((receipt) => processGone(receipt.pid)) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    const providerExited = observed.every((receipt) => processGone(receipt.pid));
    const exited = children.every((child) => child.exitCode !== null || child.signalCode !== null);
    const closed = await Promise.all([port, port + 1].map((ownedPort) => new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port: ownedPort }); socket.setTimeout(2_000);
      socket.once("connect", () => { socket.destroy(); resolve(false); }); socket.once("timeout", () => { socket.destroy(); resolve(false); });
      socket.once("error", (error) => { socket.destroy(); resolve("code" in error && error.code === "ECONNREFUSED"); });
    })));
    const noOutbound = !networkLog || !existsSync(networkLog);
    if (directory && exited && providerExited && closed.every(Boolean)) await removeTempDir(directory);
    const rootRemoved = !directory || !existsSync(directory);
    console.info(JSON.stringify({ scope: "peer capability fixture cleanup", serverPids: children.map((child) => child.pid), providerPids: observed.map((receipt) => receipt.pid), exited, providerExited, ports: [port, port + 1], closed, noOutbound, rootRemoved }));
    expect({ exited, providerExited, closed: closed.every(Boolean), noOutbound, rootRemoved }).toEqual({ exited: true, providerExited: true, closed: true, noOutbound: true, rootRemoved: true });
  }, 25_000);

  it("lists only owned eligible peers including primary fallback, without mutations", async () => {
    const before = snapshot();
    const response = await api(`/api/internal/agents?self=${caller.id}`, "GET", undefined, lease().token);
    expect(response.status).toBe(200);
    expect(z.object({ bots: z.array(z.object({ id: z.string() })) }).parse(await response.json()).bots.map((bot) => bot.id).sort()).toEqual([helper.id, operatorId].sort());
    expect(snapshot()).toEqual(before);
  });

  it.each(["/api/internal/agents", "/api/internal/ask-bot", "/api/internal/delegate-bot"])("rejects the genuinely injected connector bearer for %s", async (path) => {
    expect(lease().connectorToken !== lease().token).toBe(true);
    const before = snapshot();
    const response = await api(path, path.endsWith("/agents") ? "GET" : "POST", path.endsWith("/agents") ? undefined : { toBotId: helper.id, message: "Do not send" }, lease().connectorToken);
    expect(response.status).toBe(401);
    expect(snapshot()).toEqual(before);
  });

  it("rejects a forged list self and a random credential without roster disclosure", async () => {
    const before = snapshot();
    const forged = await api(`/api/internal/agents?self=${foreignId}`, "GET", undefined, lease().token);
    expect(forged.status).toBe(403);
    expect((await api("/api/internal/agents", "GET", undefined, randomBytes(32).toString("hex"))).status).toBe(401);
    expect(snapshot()).toEqual(before);
  });

  it.each(["ask-bot", "delegate-bot"])("rejects forged identity/depth on %s without any work", async (operation) => {
    const before = snapshot();
    const identities: JsonObject[] = [{ fromBotId: helper.id }, { fromThreadId: helper.threadId }, { fromThreadId: alternateThread }, { taskId: alternateThread }, { depth: 1 }, { depth: -1 }, { self: foreignId }];
    for (const identity of identities) {
      const response = await api(`/api/internal/${operation}`, "POST", { toBotId: helper.id, message: "Forbidden forged send", ...identity }, lease().token);
      expect(response.status).toBe(403);
    }
    expect(snapshot()).toEqual(before);
  });

  it.each(["ask-bot", "delegate-bot"])("makes missing, foreign and hidden targets indistinguishable on %s", async (operation) => {
    const before = snapshot(); const responses = [];
    for (const toBotId of [randomUUID(), foreignId, hiddenId]) {
      const response = await api(`/api/internal/${operation}`, "POST", { toBotId, message: "Forbidden cross-owner send" }, lease().token);
      expect(response.status).toBe(404); responses.push(await response.json());
    }
    expect(responses[0]).toEqual(responses[1]); expect(responses[1]).toEqual(responses[2]);
    expect(JSON.stringify(responses)).not.toMatch(/Foreign private|Hidden private|busy/);
    expect(snapshot()).toEqual(before);
  });

  it("runs a genuine same-owner ask with omitted identity and a depth-one provider", async () => {
    const before = promptCount();
    const response = await api("/api/internal/ask-bot", "POST", { toBotId: helper.id, message: "Owned question" }, lease().token);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ botName: "Allowed helper", text: "hello from fake acp" });
    expect(promptCount()).toBe(before + 1);
    const helperReceipts = sessionReceipts().filter((receipt) => receipt.pid !== lease().pid && existsSync(join(receipts, `${receipt.pid}.prompt.json`)));
    expect(helperReceipts.some((receipt) => !receipt.servers.some((entry) => entry.name === "agents"))).toBe(true);
  });

  it("accepts a queued delegation only once the real source turn completes", async () => {
    const before = promptCount();
    const response = await api("/api/internal/delegate-bot", "POST", { toBotId: helper.id, message: "Owned queued task", fromBotId: caller.id, fromThreadId: lease().threadId, depth: 0 }, lease().token);
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ queued: true });
    expect(promptCount()).toBe(before);
    await release(lease());
    await expect.poll(promptCount, { timeout: 10_000 }).toBe(before + 1);
    await expect.poll(async () => (await roster()).find((bot) => bot.id === helper.id)?.busy ?? false, { timeout: 10_000 }).toBe(false);
  });

  it("denies a waiting ask when its real target is deleted, without execution or a mirror", async () => {
    const target = await create("Deleted approval target", "happy");
    expect((await api(`/api/bots/${caller.id}`, "PATCH", { approvePeerComms: true })).status).toBe(200);
    const previousId = peerCard()?.requestId;
    const before = snapshot();
    const pending = api("/api/internal/ask-bot", "POST", { toBotId: target.id, message: "Never deliver deleted-target question" }, lease().token);
    try {
      await expect.poll(() => { const card = peerCard(); return !!card && card.requestId !== previousId && !card.answered; }, { timeout: 5_000 }).toBe(true);
      expect(promptCount()).toBe(before.prompts);
      expect((await api(`/api/bots/${target.id}`, "DELETE")).status).toBe(200);
      const response = await pending;
      // Deletion cancels the approval before awaiting provider shutdown and
      // removing the bot record, so the waiting request observes denial first.
      expect(response.status).toBe(200); expect(await response.json()).toEqual({ error: "denied by user" });
      expect(peerCard()).toMatchObject({ answered: "deny", dismissed: true });
      expect(promptCount()).toBe(before.prompts);
      expect(messagesFor(target.threadId).filter((row) => row.role === "user")).toEqual([]);
      expect(snapshot().files[1]).toBe(before.files[1]);
    } finally {
      if (!peerCard()?.answered) await api(`/api/bots/${caller.id}/interrupt`, "POST", {});
      await pending;
      expect((await api(`/api/bots/${caller.id}`, "PATCH", { approvePeerComms: false })).status).toBe(200);
    }
  });

  it("revokes a waiting ask on actual source Stop and never dispatches or mirrors it", async () => {
    expect((await api(`/api/bots/${caller.id}`, "PATCH", { approvePeerComms: true })).status).toBe(200);
    const previousId = peerCard()?.requestId;
    const before = snapshot(); const targetMessages = messagesFor(helper.threadId);
    const pending = api("/api/internal/ask-bot", "POST", { toBotId: helper.id, message: "Never deliver stopped-source question" }, lease().token);
    try {
      await expect.poll(() => { const card = peerCard(); return !!card && card.requestId !== previousId && !card.answered; }, { timeout: 5_000 }).toBe(true);
      expect((await api(`/api/bots/${caller.id}/interrupt`, "POST", {})).status).toBe(200);
      await idle();
      const response = await pending;
      expect(response.status).toBe(401); expect(await response.json()).toEqual({ error: "unauthorized" });
      expect(peerCard()).toMatchObject({ answered: "deny", dismissed: true });
      expect((await api("/api/internal/agents", "GET", undefined, lease().token)).status).toBe(401);
      expect(promptCount()).toBe(before.prompts);
      expect(messagesFor(helper.threadId)).toEqual(targetMessages);
      expect(snapshot().files[1]).toBe(before.files[1]);
    } finally {
      if (!peerCard()?.answered) await api(`/api/bots/${caller.id}/interrupt`, "POST", {});
      await pending;
      expect((await api(`/api/bots/${caller.id}`, "PATCH", { approvePeerComms: false })).status).toBe(200);
    }
  });

  it("reports a failed durable queue cancellation on Stop and clears it on explicit retry", async () => {
    const before = promptCount();
    const queued = await api("/api/internal/delegate-bot", "POST", { toBotId: helper.id, message: "Never dispatch after failed Stop" }, lease().token);
    expect(queued.status).toBe(200); expect(await queued.json()).toMatchObject({ queued: true });
    const file = join(data, "delegations.json"); const backup = join(directory, "saved-delegations.json");
    const saved = readFileSync(file, "utf8");
    expect(z.record(z.string(), z.array(z.object({ toBotId: z.string() }))).parse(JSON.parse(saved))[lease().threadId]).toEqual([{ toBotId: helper.id }]);
    renameSync(file, backup); mkdirSync(file);
    try {
      const stopped = await api(`/api/bots/${caller.id}/interrupt`, "POST", {});
      expect(stopped.status).toBe(503);
      expect(await stopped.json()).toEqual({ error: "The turn was stopped, but queued handoffs could not be durably canceled. Retry Stop before restarting Muster." });
      expect(promptCount()).toBe(before);
      expect((await api("/api/internal/agents", "GET", undefined, lease().token)).status).toBe(401);
    } finally { rmdirSync(file); renameSync(backup, file); }
    const retry = await api(`/api/bots/${caller.id}/interrupt`, "POST", {});
    expect(retry.status).toBe(200); await idle();
    expect(z.record(z.string(), z.array(z.object({ toBotId: z.string() }))).parse(JSON.parse(readFileSync(file, "utf8")))[lease().threadId] ?? []).toEqual([]);
    expect(promptCount()).toBe(before);
  });

  it("keeps the captured source task valid while the UI selects another task", async () => {
    const captured = lease();
    expect((await api(`/api/bots/${caller.id}/tasks/${alternateThread}`, "POST", {})).status).toBe(200);
    try {
      const response = await api("/api/internal/agents", "GET", undefined, captured.token);
      expect(response.status).toBe(200);
      const forged = await api("/api/internal/ask-bot", "POST", { toBotId: helper.id, message: "Wrong selected thread", fromThreadId: alternateThread }, captured.token);
      expect(forged.status).toBe(403);
    } finally { expect((await api(`/api/bots/${caller.id}/tasks/${captured.threadId}`, "POST", {})).status).toBe(200); }
  });

  it("retires a completed token and injects a different one into session/load", async () => {
    const previous = lease(); await release(previous);
    expect((await api("/api/internal/agents", "GET", undefined, previous.token)).status).toBe(401);
    current = await begin();
    expect(current.method).toBe("session/load"); expect(current.token !== previous.token).toBe(true);
    const before = snapshot();
    for (const operation of ["ask-bot", "delegate-bot"]) expect((await api(`/api/internal/${operation}`, "POST", { toBotId: helper.id, message: "Retired send" }, previous.token)).status).toBe(401);
    expect(snapshot()).toEqual(before);
    expect((await api("/api/internal/agents", "GET", undefined, current.token)).status).toBe(200);
  });

  it("retires a token on actual interruption before a replacement turn", async () => {
    const previous = lease();
    expect((await api(`/api/bots/${caller.id}/interrupt`, "POST", {})).status).toBe(200); await idle();
    expect((await api("/api/internal/agents", "GET", undefined, previous.token)).status).toBe(401);
    current = await begin();
    expect(current.token !== previous.token).toBe(true);
    expect((await api("/api/internal/agents", "GET", undefined, previous.token)).status).toBe(401);
  });

  it("does not resurrect a completed capability after a real server restart", async () => {
    const previous = lease(); await release(previous);
    await waitForExit(server, { signal: "SIGTERM" }); await boot();
    expect((await api("/api/internal/agents", "GET", undefined, previous.token)).status).toBe(401);
    current = await begin();
    expect(current.token !== previous.token).toBe(true);
    expect((await api("/api/internal/agents", "GET", undefined, current.token)).status).toBe(200);
  });
});
