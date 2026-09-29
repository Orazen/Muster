// Owned hosted/local fixtures; real ingress, management, live SSE and replay.
// Never use an existing installation or a model/container runtime.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { pairingServerEnvironment, waitForOwnedServer } from "../e2e/pairing-harness.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { seedConnectedGoogleRow } from "./testing/storage-gate.ts";
import { freePortBlock } from "./testing/ports.ts";
import type { JsonValue } from "./schema.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const webhookSchema = z.object({ id: z.string(), endpointId: z.string(), name: z.string(), botId: z.string(), owner: z.string().optional() }).passthrough();
const listSchema = z.object({ webhooks: z.array(webhookSchema), attempts: z.array(z.object({ webhookId: z.string(), preview: z.string().optional() }).passthrough()) });
const credentialSchema = z.object({ endpointUrl: z.string(), secret: z.string() });
const frameSchema = z.object({
  kind: z.string(), cursor: z.string().optional(), resumed: z.boolean().optional(),
  webhook: z.object({ id: z.string() }).passthrough().optional(),
  attempt: z.object({ webhookId: z.string() }).passthrough().optional(), webhookId: z.string().optional(),
}).passthrough();
type Frame = z.infer<typeof frameSchema>;
interface Account { id: string; cookie: string; botId: string }
interface Hook { id: string; endpointId: string; name: string; botId: string; owner?: string; credential: z.infer<typeof credentialSchema> }
const hookId = (frame: Frame) => frame.webhook?.id ?? frame.attempt?.webhookId ?? frame.webhookId;
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

describe.skipIf(process.platform === "win32")("webhook account isolation", () => {
  let directory = "", url = "", ingress = "";
  let env: NodeJS.ProcessEnv;
  let child: ChildProcess | undefined;
  let operator: Account, alice: Account, bob: Account;
  const localBotId = randomUUID();
  const legacy = [undefined, "local"].map(owner => {
    const endpointId = `wh_${randomBytes(18).toString("base64url")}`;
    const secret = randomBytes(32).toString("base64url");
    return {
      id: randomUUID(), endpointId, botId: localBotId, owner,
      name: owner ? "Legacy local marker" : "Legacy unowned", prompt: "Keep this private",
      runOn: "agent", enabled: false, verificationPending: true,
      createdAt: Date.now(), updatedAt: Date.now(), deliveryCount: 0,
      secretHash: createHash("sha256").update(secret).digest("hex"), secret,
    };
  });
  const streams: Array<{ close(): Promise<void> }> = [];
  let aliceHistory: Hook;

  async function request(path: string, method = "GET", body?: JsonValue, account?: Account) {
    const headers = new Headers({ origin: url, "content-type": "application/json" });
    if (account) headers.set("cookie", account.cookie);
    const init: RequestInit = { method, headers, redirect: "error", signal: AbortSignal.timeout(15_000) };
    if (body !== undefined) init.body = JSON.stringify(body);
    return fetch(`${url}${path}`, init);
  }
  async function list(account: Account) {
    const res = await request("/api/webhooks", "GET", undefined, account);
    expect(res.status).toBe(200);
    return listSchema.parse(await res.json());
  }
  async function createHook(account: Account, name: string, botId = account.botId): Promise<Hook> {
    // Capture-only delivery proves privacy without asking a model to execute.
    const res = await request("/api/webhooks", "POST", { name, prompt: "Review privately", botId, enabled: false, verificationPending: true }, account);
    expect(res.status).toBe(201);
    const parsed = z.object({ webhook: webhookSchema, credential: credentialSchema }).parse(await res.json());
    return { ...parsed.webhook, credential: parsed.credential };
  }
  async function deliver(hook: Hook, marker: string, secret = hook.credential.secret) {
    const res = await fetch(`${ingress}/hooks/${hook.endpointId}`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${secret}`, "idempotency-key": randomUUID() },
      body: JSON.stringify({ privateMarker: marker }), redirect: "error", signal: AbortSignal.timeout(15_000),
    });
    return res;
  }
  function legacyHook(index: number): Hook {
    const row = legacy[index];
    return { ...row, credential: { endpointUrl: `${ingress}/hooks/${row.endpointId}`, secret: row.secret } };
  }
  async function start() {
    child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "server/index.ts")], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.on("data", () => {}); child.stderr?.on("data", () => {});
    await waitForOwnedServer(child, url);
    const health = await fetch(`${ingress}/health`, { signal: AbortSignal.timeout(10_000) });
    expect(await health.json()).toMatchObject({ app: "muster-webhooks", ready: true });
  }
  async function stop() {
    await Promise.all(streams.splice(0).map(stream => stream.close()));
    await waitForExit(child, { signal: "SIGINT" });
    child = undefined;
  }
  async function openStream(account: Account, since?: string) {
    const controller = new AbortController();
    const headers = new Headers({ cookie: account.cookie, accept: "text/event-stream" });
    if (since) headers.set("last-event-id", since);
    const response = await fetch(`${url}/api/events`, { headers, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(45_000)]), redirect: "error" });
    expect(response.status).toBe(200);
    if (!response.body) throw new Error("Owned SSE fixture has no body");
    const reader = response.body.getReader(), decoder = new TextDecoder();
    const frames: Frame[] = [];
    let fault: unknown, ended = false;
    const pump = (async () => {
      let buffer = "";
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) { ended = true; break; }
          buffer += decoder.decode(next.value, { stream: true });
          const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
          for (const line of lines) if (line.startsWith("data: ")) frames.push(frameSchema.parse(JSON.parse(line.slice(6))));
        }
      } catch (error) { if (!controller.signal.aborted) fault = error; }
      finally { reader.releaseLock(); }
    })();
    const stream = {
      frames,
      async waitFor(predicate: (frame: Frame) => boolean) {
        const deadline = Date.now() + 10_000;
        for (;;) {
          if (fault) throw fault;
          const found = frames.find(predicate); if (found) return found;
          if (ended || Date.now() > deadline) throw new Error("Owned SSE fixture missed its expected frame");
          await delay(15);
        }
      },
      async close() { controller.abort(); await pump; },
    };
    streams.push(stream);
    const hello = await stream.waitFor(frame => frame.kind === "hello");
    expect(hello.cursor).toEqual(expect.any(String));
    return { ...stream, hello, cursor: hello.cursor! };
  }
  const noForeign = (frames: Frame[], forbidden: string[]) => {
    const serialized = JSON.stringify(frames.filter(frame => frame.kind.startsWith("webhook")));
    for (const token of forbidden) expect(serialized).not.toContain(token);
  };

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "muster-webhook-isolation-"));
    const data = join(directory, "data"), home = join(directory, "home"), companion = join(directory, "companion"), ui = join(directory, "ui");
    for (const path of [data, home, companion, ui]) mkdirSync(path, { recursive: true, mode: 0o700 });
    writeFileSync(join(data, "bots.json"), JSON.stringify([{ id: localBotId, threadId: randomUUID(), name: "Operator bot", description: "operator", title: "Operator", color: "orange", notifications: true, unread: false, modelSelection: { instanceId: "ghost", model: "" }, resumeCursors: {}, createdAt: Date.now() }]));
    writeFileSync(join(data, "config.json"), JSON.stringify({ profile: { name: "Isolation fixture" }, instances: { ghost: { driver: "not-a-real-driver", displayName: "Offline fixture" } } }));
    writeFileSync(join(data, "license.json"), JSON.stringify({ firstLaunchAt: new Date(Date.now() - 30 * 86_400_000).toISOString(), license: null }));
    writeFileSync(join(data, "webhooks.json"), JSON.stringify({ version: 1, webhooks: legacy.map(({ secret: _secret, ...row }) => row), deliveries: [], attempts: [] }), { mode: 0o600 });
    const port = await freePortBlock([0, 1], 49200, 8000);
    url = `http://127.0.0.1:${port}`; ingress = `http://127.0.0.1:${port + 1}`;
    env = pairingServerEnvironment({ home, dataDirectory: data, companionDirectory: companion, staticDir: ui, port, webhookPort: port + 1, secret: randomBytes(32).toString("hex") });
    Object.assign(env, { OMB_PUBLIC_HOST: `127.0.0.1:${port}`, OMB_ALLOW_SIGNUPS: "true", GOOGLE_CLIENT_ID: randomBytes(24).toString("hex"), GOOGLE_CLIENT_SECRET: randomBytes(24).toString("hex") });
    await start();
    async function signUp(name: string): Promise<Account> {
      const res = await request("/api/auth/sign-up/email", "POST", { name, email: `${name}-${randomBytes(8).toString("hex")}@example.test`, password: randomBytes(32).toString("base64url") });
      expect(res.status).toBe(200);
      const { user } = z.object({ user: z.object({ id: z.string() }) }).parse(await res.json());
      const header = res.headers.getSetCookie().find(value => value.startsWith("better-auth.session_token="));
      if (!header) throw new Error("Owned signup did not return a session");
      seedConnectedGoogleRow(data, user.id);
      return { id: user.id, cookie: header.split(";")[0], botId: "" };
    }
    operator = await signUp("operator"); operator.botId = localBotId;
    alice = await signUp("alice"); bob = await signUp("bob");
    for (const account of [alice, bob]) {
      const created = await request("/api/bots", "POST", {}, account);
      expect(created.status).toBe(201);
      account.botId = z.object({ bot: z.object({ id: z.string() }) }).parse(await created.json()).bot.id;
    }
  }, 90_000);
  afterAll(async () => { await stop(); if (directory) await removeTempDir(directory); });

  it("keeps account CRUD private and unknown/foreign mutation responses equivalent", async () => {
    const a = await createHook(alice, "Alice private"), b = await createHook(bob, "Bob private");
    expect((await list(alice)).webhooks.map(h => h.id)).toEqual([a.id]);
    expect((await list(bob)).webhooks.map(h => h.id)).toEqual([b.id]);
    const before = (await list(alice)).webhooks;
    for (const [method, suffix, body] of [["PATCH", "", { name: "Hijacked" }], ["POST", "/rotate", {}], ["POST", "/test", {}], ["DELETE", "", undefined]] as const) {
      const foreign = await request(`/api/webhooks/${a.id}${suffix}`, method, body, bob);
      const unknown = await request(`/api/webhooks/${randomUUID()}${suffix}`, method, body, bob);
      expect(foreign.status).toBe(404); expect(unknown.status).toBe(404);
      expect(await foreign.json()).toEqual(await unknown.json());
    }
    expect((await list(alice)).webhooks).toEqual(before);
    const delivered = await deliver(a, "still-authorized-after-foreign-rotation");
    expect(delivered.status).toBe(202);
  });

  it("reserves both legacy formats to the actual operator without erasing records", async () => {
    expect((await list(operator)).webhooks.map(h => h.id).sort()).toEqual(legacy.map(h => h.id).sort());
    for (const account of [alice, bob]) {
      noForeign([{ kind: "webhook.fixture", snapshot: await list(account) }], legacy.map(h => h.id));
      for (const hook of legacy) {
        expect((await request(`/api/webhooks/${hook.id}`, "PATCH", { name: "Hijacked" }, account)).status).toBe(404);
        expect((await request(`/api/webhooks/${hook.id}/rotate`, "POST", {}, account)).status).toBe(404);
        expect((await request(`/api/webhooks/${hook.id}/test`, "POST", {}, account)).status).toBe(404);
        expect((await request(`/api/webhooks/${hook.id}`, "DELETE", undefined, account)).status).toBe(404);
      }
    }
    const changed = await request(`/api/webhooks/${legacy[0].id}`, "PATCH", { name: "Operator still has access" }, operator);
    expect(changed.status).toBe(200);
  });

  it("refuses foreign bot assignment on create and update", async () => {
    expect((await request("/api/webhooks", "POST", { name: "Cross account", prompt: "x", botId: alice.botId }, bob)).status).toBe(403);
    const mine = await createHook(bob, "Bob reassign");
    expect((await request(`/api/webhooks/${mine.id}`, "PATCH", { botId: alice.botId }, bob)).status).toBe(403);
    expect((await list(bob)).webhooks.find(h => h.id === mine.id)?.botId).toBe(bob.botId);
  });

  it("records real authenticated ingress and keeps nonempty history private", async () => {
    aliceHistory = await createHook(alice, "Alice history");
    const marker = "history-private-marker";
    expect((await deliver(aliceHistory, "must-not-be-read", "wrong-fixture-secret")).status).toBe(401);
    const accepted = await deliver(aliceHistory, marker);
    expect(accepted.status).toBe(202); expect(await accepted.json()).toMatchObject({ captured: true });
    const ownAttempts = (await list(alice)).attempts.filter(a => a.webhookId === aliceHistory.id);
    expect(ownAttempts).toHaveLength(2);
    expect(JSON.stringify(ownAttempts)).toContain(marker);
    expect(JSON.stringify(ownAttempts)).not.toContain("must-not-be-read");
    for (const account of [operator, bob]) {
      expect(JSON.stringify(await list(account))).not.toContain(aliceHistory.id);
      expect(JSON.stringify(await list(account))).not.toContain(marker);
    }
  });

  it("scopes create, delivery, update and delete in live streams and Last-Event-ID replay", async () => {
    const [a, b, op] = await Promise.all([openStream(alice), openStream(bob), openStream(operator)]);
    const hook = await createHook(alice, "Private live hook");
    expect((await deliver(hook, "alice-private-live-marker")).status).toBe(202);
    expect((await request(`/api/webhooks/${hook.id}`, "PATCH", { name: "Alice live rename" }, alice)).status).toBe(200);
    expect((await request(`/api/webhooks/${hook.id}`, "DELETE", undefined, alice)).status).toBe(200);
    for (let i = 0; i < legacy.length; i++) expect((await deliver(legacyHook(i), `operator-private-marker-${i}`)).status).toBe(202);
    expect((await request(`/api/webhooks/${legacy[0].id}`, "DELETE", undefined, operator)).status).toBe(200);
    const bobHook = await createHook(bob, "Bob private live hook");
    expect((await deliver(bobHook, "bob-private-live-marker")).status).toBe(202);
    // Per-account visible sentinels establish ordered delivery, without
    // treating a sleep or a dead connection as proof of negative results.
    const sentinelA = await createHook(alice, "Alice stream barrier");
    const sentinelOp = await createHook(operator, "Operator stream barrier");
    const sentinelB = await createHook(bob, "Bob stream barrier");
    await Promise.all([a.waitFor(f => hookId(f) === sentinelA.id), b.waitFor(f => hookId(f) === sentinelB.id), op.waitFor(f => hookId(f) === sentinelOp.id)]);
    function check(aFrames: Frame[], bFrames: Frame[], opFrames: Frame[]) {
      for (const kind of ["webhook", "webhook.attempt", "webhook.deleted"]) expect(aFrames.some(f => f.kind === kind && hookId(f) === hook.id)).toBe(true);
      for (const old of legacy) expect(opFrames.some(f => f.kind === "webhook.attempt" && hookId(f) === old.id)).toBe(true);
      expect(opFrames.some(f => f.kind === "webhook.deleted" && hookId(f) === legacy[0].id)).toBe(true);
      expect(bFrames.some(f => f.kind === "webhook.attempt" && hookId(f) === bobHook.id)).toBe(true);
      noForeign(aFrames, [...legacy.map(h => h.id), "operator-private-marker", bobHook.id, "bob-private-live-marker"]);
      noForeign(bFrames, [hook.id, ...legacy.map(h => h.id), "alice-private-live-marker", "operator-private-marker"]);
      noForeign(opFrames, [hook.id, "alice-private-live-marker", bobHook.id, "bob-private-live-marker"]);
    }
    check(a.frames, b.frames, op.frames);
    await Promise.all([a.close(), b.close(), op.close()]);
    const [ar, br, opr] = await Promise.all([openStream(alice, a.cursor), openStream(bob, b.cursor), openStream(operator, op.cursor)]);
    for (const replay of [ar, br, opr]) expect(replay.hello.resumed).toBe(true);
    await Promise.all([ar.waitFor(f => hookId(f) === sentinelA.id), br.waitFor(f => hookId(f) === sentinelB.id), opr.waitFor(f => hookId(f) === sentinelOp.id)]);
    check(ar.frames, br.frames, opr.frames);
    await Promise.all([ar.close(), br.close(), opr.close()]);
  }, 45_000);

  it("preserves legacy credentials and scoped history across a real server restart", async () => {
    const before = readFileSync(join(directory, "data", "webhooks.json"), "utf8");
    await stop(); await start();
    expect(readFileSync(join(directory, "data", "webhooks.json"), "utf8")).toBe(before);
    expect((await list(operator)).webhooks.some(h => h.id === legacy[1].id)).toBe(true);
    expect((await list(operator)).attempts.some(a => a.webhookId === legacy[1].id)).toBe(true);
    expect((await list(alice)).attempts.filter(a => a.webhookId === aliceHistory.id)).toHaveLength(2);
    for (const account of [alice, bob]) expect(JSON.stringify(await list(account))).not.toContain(legacy[1].id);
    expect(JSON.stringify(await list(bob))).not.toContain(aliceHistory.id);
    // The old capability still authenticates; capture-only rows are now paused.
    expect((await deliver(legacyHook(1), "after-restart")).status).toBe(409);
    expect((await deliver(legacyHook(1), "after-restart", "wrong-fixture-secret")).status).toBe(401);
  }, 45_000);

  it("keeps local desktop events available with a signed-in account cookie", async () => {
    await stop(); delete env.OMB_PUBLIC_HOST; await start();
    const stream = await openStream(operator);
    const local = await createHook(operator, "Local desktop fixture");
    expect(local.owner).toBeUndefined();
    expect((await deliver(local, "local-desktop-marker")).status).toBe(202);
    await stream.waitFor(f => f.kind === "webhook.attempt" && hookId(f) === local.id);
    expect(JSON.stringify(stream.frames)).toContain("local-desktop-marker");
    await stream.close();
  }, 45_000);
});
