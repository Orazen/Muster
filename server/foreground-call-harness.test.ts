// Real host routing and turn dispatch, with network-denied owned fake providers.
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { startPairingHarness, pairingServerEnvironment, waitForOwnedServer } from "../e2e/pairing-harness.ts";
import { freePortBlock } from "./testing/ports.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { seedConnectedGoogleRow } from "./testing/storage-gate.ts";
import type { JsonValue } from "./schema.ts";

const callWire = z.object({ call: z.object({ id: z.string(), botId: z.string(), threadId: z.string(), state: z.string(), turn: z.object({ requestId: z.string(), state: z.string(), reply: z.string().optional() }).optional() }) });
const botWire = z.object({ bot: z.object({ id: z.string(), threadId: z.string() }) });
interface RequestOptions { method?: string; body?: JsonValue; cookie?: string; token?: string; origin?: string | null }
async function api(base: string, path: string, options: RequestOptions = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  if (options.origin !== null) headers.set("origin", options.origin ?? base);
  if (options.cookie) headers.set("cookie", options.cookie);
  if (options.token) headers.set("x-muster-call-token", options.token);
  const init: RequestInit = { method: options.method ?? "GET", headers, redirect: "error", signal: AbortSignal.timeout(12_000) };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  return fetch(base + path, init);
}
function sessionCookie(response: Response) {
  const cookie = response.headers.getSetCookie().find(value => value.startsWith("better-auth.session_token="))?.split(";")[0];
  if (!cookie) throw new Error("Owned signup did not return a session cookie");
  return cookie;
}

describe.skipIf(process.platform === "win32")("foreground calls through the real owned host", () => {
  let harness: Awaited<ReturnType<typeof startPairingHarness>>;
  let staticDir = "", receipts = "", primaryCookie = "", secondaryCookie = "";
  let hosted: ChildProcess | undefined, hostedUrl = "";
  let cloudBot: z.infer<typeof botWire>["bot"];
  beforeAll(async () => {
    staticDir = mkdtempSync(join(tmpdir(), "muster-call-ui-"));
    writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>Owned call fixture</title>");
    harness = await startPairingHarness({ staticDir, engineMode: "peer-capability" });
    receipts = join(harness.rootDirectory, "desktop", "peer-receipts");
    const hostedRoot = join(staticDir, "hosted"), home = join(hostedRoot, "home"), data = join(hostedRoot, "data");
    for (const directory of [home, data]) mkdirSync(directory, { recursive: true });
    writeFileSync(join(data, "config.json"), JSON.stringify({ instances: { ghost: { driver: "not-a-real-driver", displayName: "Owned offline fixture" } } }));
    const guard = join(hostedRoot, "guard.mjs");
    writeFileSync(guard, "import { Socket } from 'node:net'; globalThis.fetch=()=>{throw new Error('Outbound denied');}; Socket.prototype.connect=function(){throw new Error('Outbound denied');};");
    const port = await freePortBlock([0, 1], 27000, 10000);
    hostedUrl = `http://127.0.0.1:${port}`;
    const env = pairingServerEnvironment({ home, dataDirectory: data, companionDirectory: join(hostedRoot, "companion"), staticDir, port, webhookPort: port + 1, secret: randomBytes(32).toString("hex") });
    Object.assign(env, { OMB_PUBLIC_HOST: `127.0.0.1:${port}`, OMB_ALLOW_SIGNUPS: "true", GOOGLE_CLIENT_ID: randomBytes(24).toString("hex"), GOOGLE_CLIENT_SECRET: randomBytes(24).toString("hex") });
    const root = fileURLToPath(new URL("../", import.meta.url));
    hosted = spawn(process.execPath, ["--import", guard, "--experimental-strip-types", join(root, "server/index.ts")], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    hosted.stdout?.on("data", () => {}); hosted.stderr?.on("data", () => {});
    await waitForOwnedServer(hosted, hostedUrl);
    const primary = await api(hostedUrl, "/api/auth/sign-up/email", { method: "POST", body: { name: "Owned call owner", email: harness.email, password: harness.password } });
    expect(primary.status).toBe(200); primaryCookie = sessionCookie(primary);
    const signedIn = z.object({ user: z.object({ id: z.string() }) }).parse(await primary.json());
    seedConnectedGoogleRow(data, signedIn.user.id);
    const created = await api(hostedUrl, "/api/bots", { method: "POST", cookie: primaryCookie, body: {} });
    expect(created.status).toBe(201); cloudBot = botWire.parse(await created.json()).bot;
    const other = await api(hostedUrl, "/api/auth/sign-up/email", { method: "POST", body: { name: "Other owner", email: `${randomUUID()}@example.test`, password: randomBytes(24).toString("base64url") } });
    expect(other.status).toBe(200); secondaryCookie = sessionCookie(other); await other.arrayBuffer();
  }, 45_000);
  afterAll(async () => { await harness?.stop(); if (hosted) await waitForExit(hosted, { signal: "SIGTERM" }); if (staticDir) await removeTempDir(staticDir); });

  async function newCall() {
    const created = await api(harness.desktopUrl, "/api/bots", { method: "POST", body: {} });
    expect(created.status).toBe(201);
    const bot = botWire.parse(await created.json()).bot;
    expect((await api(harness.desktopUrl, `/api/bots/${bot.id}`, { method: "PATCH", body: { computer: "off", composio: false } })).status).toBe(200);
    const token = randomBytes(32).toString("hex"), id = randomUUID(), path = `/api/bots/${bot.id}/calls`;
    const started = await api(harness.desktopUrl, path, { method: "POST", origin: null, token, body: { requestId: id, threadId: bot.threadId } });
    expect(started.status, await started.clone().text()).toBe(201);
    expect(callWire.parse(await started.json()).call.state).toBe("ringing");
    return { bot, token, id, path: `${path}/${id}` };
  }
  const knownPrompts = () => new Set(readdirSync(receipts).filter(file => file.endsWith(".prompt.json")));
  async function awaitPrompt(before: Set<string>) {
    let found = "";
    await expect.poll(() => {
      found = readdirSync(receipts).find(file => file.endsWith(".prompt.json") && !before.has(file)) ?? "";
      return Boolean(found);
    }, { timeout: 15_000 }).toBe(true);
    return found.replace(".prompt.json", "");
  }
  async function messages(threadId: string) {
    return z.object({ messages: z.array(z.object({ role: z.string(), kind: z.string(), text: z.string().optional() })) }).parse(await (await api(harness.desktopUrl, `/api/threads/${threadId}/messages`)).json()).messages;
  }
  async function activity(botId: string) {
    return z.object({ bots: z.array(z.object({ id: z.string(), activity: z.string().optional() })) }).parse(await (await api(harness.desktopUrl, "/api/bots")).json()).bots.find(bot => bot.id === botId)?.activity;
  }

  it("starts only after explicit acceptance and sends an idempotent message through the real runner once", async () => {
    const before = knownPrompts(), call = await newCall();
    expect(knownPrompts()).toEqual(before);
    const request = { requestId: randomUUID(), text: "Owned foreground request" };
    expect((await api(harness.desktopUrl, `${call.path}/messages`, { method: "POST", token: call.token, body: request })).status).toBe(409);
    expect((await api(harness.desktopUrl, `${call.path}/accept`, { method: "POST", token: call.token, body: {} })).status).toBe(200);
    expect(knownPrompts()).toEqual(before);
    for (let i = 0; i < 2; i++) {
      const sent = await api(harness.desktopUrl, `${call.path}/messages`, { method: "POST", token: call.token, body: request });
      expect(sent.status, await sent.clone().text()).toBe(202);
    }
    const pid = await awaitPrompt(before);
    expect([...knownPrompts()].filter(file => !before.has(file))).toHaveLength(1);
    expect((await messages(call.bot.threadId)).filter(message => message.role === "user" && message.kind === "text")).toHaveLength(1);
    writeFileSync(join(receipts, `${pid}.release`), "release owned fake provider");
    await expect.poll(async () => callWire.parse(await (await api(harness.desktopUrl, call.path, { token: call.token })).json()).call.turn, { timeout: 15_000 })
      .toMatchObject({ requestId: request.requestId, state: "completed", reply: "Owned held turn completed" });
    const duplicate = await api(harness.desktopUrl, `${call.path}/messages`, { method: "POST", token: call.token, body: request });
    expect(duplicate.status).toBe(202);
    expect(callWire.parse(await duplicate.json()).call.turn?.state).toBe("completed");
    expect((await messages(call.bot.threadId)).filter(message => message.role === "user" && message.kind === "text")).toHaveLength(1);
    expect([...knownPrompts()].filter(file => !before.has(file))).toHaveLength(1);
    expect((await api(harness.desktopUrl, `${call.path}/end`, { method: "POST", token: call.token, body: {} })).status).toBe(200);
  }, 30_000);

  it("ends exactly its held turn and cannot interrupt a subsequent ordinary task", async () => {
    const before = knownPrompts(), call = await newCall();
    await api(harness.desktopUrl, `${call.path}/accept`, { method: "POST", token: call.token, body: {} });
    expect((await api(harness.desktopUrl, `${call.path}/messages`, { method: "POST", token: call.token, body: { requestId: randomUUID(), text: "Owned cancellable call" } })).status).toBe(202);
    const first = await awaitPrompt(before);
    const ended = await api(harness.desktopUrl, `${call.path}/end`, { method: "POST", token: call.token, body: {} });
    expect(ended.status, await ended.clone().text()).toBe(200);
    expect(callWire.parse(await ended.json()).call.state).toBe("ended");
    await expect.poll(() => existsSync(join(receipts, `${first}.cancel.json`)), { timeout: 10_000 }).toBe(true);
    expect(z.object({ canceled: z.number() }).parse(JSON.parse(readFileSync(join(receipts, `${first}.cancel.json`), "utf8"))).canceled).toBe(1);
    await expect.poll(() => activity(call.bot.id), { timeout: 10_000 }).toBe("idle");
    const nextBefore = knownPrompts();
    expect((await api(harness.desktopUrl, `/api/bots/${call.bot.id}/messages`, { method: "POST", body: { text: "Owned newer ordinary task" } })).status).toBe(202);
    const next = await awaitPrompt(nextBefore);
    expect((await api(harness.desktopUrl, `${call.path}/end`, { method: "POST", token: call.token, body: {} })).status).toBe(200);
    expect(existsSync(join(receipts, `${next}.cancel.json`))).toBe(false);
    expect(await activity(call.bot.id)).toBe("working");
    writeFileSync(join(receipts, `${next}.release`), "release newer owned task");
    await expect.poll(() => activity(call.bot.id), { timeout: 10_000 }).toBe("idle");
    expect(existsSync(join(receipts, `${next}.cancel.json`))).toBe(false);
  }, 35_000);

  it("enforces hosted authentication, ownership, origin and per-call capability", async () => {
    const base = `/api/bots/${cloudBot.id}/calls`, id = randomUUID(), token = randomBytes(32).toString("hex");
    const body = { requestId: id, threadId: cloudBot.threadId };
    expect((await api(hostedUrl, base, { method: "POST", token, body })).status).toBe(401);
    expect((await api(hostedUrl, base, { method: "POST", cookie: secondaryCookie, token, body })).status).toBe(404);
    expect((await api(hostedUrl, base, { method: "POST", cookie: primaryCookie, token, body, origin: null })).status).toBe(403);
    expect((await api(hostedUrl, base, { method: "POST", cookie: primaryCookie, token, body, origin: "https://foreign.test" })).status).toBe(403);
    expect((await api(hostedUrl, base, { method: "POST", cookie: primaryCookie, token, body })).status).toBe(201);
    expect((await api(hostedUrl, `${base}/${id}`, { cookie: secondaryCookie, token })).status).toBe(404);
    expect((await api(hostedUrl, `${base}/${id}`, { cookie: primaryCookie, token: randomBytes(32).toString("hex") })).status).toBe(404);
    const status = await api(hostedUrl, `${base}/${id}`, { cookie: primaryCookie, token });
    expect(status.status).toBe(200); expect(await status.text()).not.toContain(token);
    expect((await api(hostedUrl, `${base}/${id}/end`, { method: "POST", cookie: primaryCookie, token, body: {} })).status).toBe(200);
  });
});
