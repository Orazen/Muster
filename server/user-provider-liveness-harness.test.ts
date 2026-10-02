// Real hosted routes and store folds; provider responses are synthetic and
// every outbound socket in the owned child is blocked before server imports.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { pairingServerEnvironment, waitForOwnedServer } from "../e2e/pairing-harness.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { seedConnectedGoogleRow } from "./testing/storage-gate.ts";
import type { JsonValue } from "./schema.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const botSchema = z.object({ id: z.string(), threadId: z.string(), busy: z.boolean().default(false) });
type Bot = z.infer<typeof botSchema>;
interface Account { id: string; cookie: string }
const rowsSchema = z.array(z.object({ action: z.string(), text: z.string() }));

describe.skipIf(process.platform === "win32")("user provider lifecycle over hosted HTTP", () => {
  let directory: string;
  let data: string;
  let url: string;
  let port: number;
  let preload: string;
  let transportLog: string;
  let blockedLog: string;
  let child: ChildProcess;
  let alice: Account;
  let bob: Account;
  let operator: Account;
  const children: ChildProcess[] = [];
  const secret = randomBytes(32).toString("hex");
  let output = "";

  const request = (path: string, account: Account | undefined, method = "GET", body?: JsonValue) => {
    const headers = new Headers({ origin: url, "content-type": "application/json" });
    if (account) headers.set("cookie", account.cookie);
    const init: RequestInit = { method, headers, redirect: "error", signal: AbortSignal.timeout(10_000) };
    if (body !== undefined) init.body = JSON.stringify(body);
    return fetch(`${url}${path}`, init);
  };
  async function until(check: () => boolean | Promise<boolean>, label: string) {
    const end = Date.now() + 4_000;
    while (!(await check())) {
      if (Date.now() > end) throw new Error(`Timed out: ${label}. ${output.slice(-1_000)}`);
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  }
  const transport = () => rowsSchema.parse(existsSync(transportLog)
    ? readFileSync(transportLog, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : []);
  const saw = (action: string, text: string) => transport().some(row => row.action === action && row.text === text);
  const bot = async (account: Account, id: string) => {
    const response = await request("/api/bots", account);
    expect(response.status).toBe(200);
    const found = z.object({ bots: z.array(botSchema) }).parse(await response.json()).bots.find(row => row.id === id);
    if (!found) throw new Error("Owned bot missing");
    return found;
  };
  async function createBot(account: Account, instanceId = `opencodeZenApi:${account.id}`): Promise<Bot> {
    const created = await request("/api/bots", account, "POST", {});
    expect(created.status).toBe(201);
    const result = z.object({ bot: botSchema }).parse(await created.json()).bot;
    expect((await request(`/api/bots/${result.id}`, account, "PATCH", {
      modelSelection: { instanceId, model: "deepseek-v4-flash-free" }, apps: false,
    })).status).toBe(200);
    return result;
  }
  async function send(account: Account, target: Bot, text: string) {
    const response = await request(`/api/bots/${target.id}/messages`, account, "POST", { text });
    expect(response.status).toBe(202);
    await until(() => saw("start", text), `provider received ${text}`);
  }
  async function idle(account: Account, target: Bot) {
    await until(async () => !(await bot(account, target.id)).busy, "terminal event returned bot to idle");
  }
  async function completions(account: Account, target: Bot) {
    const response = await request(`/api/threads/${target.threadId}/events`, account);
    const { entries } = z.object({ entries: z.array(z.object({ kind: z.string(), data: z.object({ type: z.string().optional() }).passthrough() })) }).parse(await response.json());
    return entries.filter(entry => entry.kind === "runtime" && entry.data.type === "turn.completed");
  }
  async function reply(account: Account, target: Bot, text: string, count = 1) {
    await idle(account, target);
    const response = await request(`/api/threads/${target.threadId}/messages`, account);
    const { messages } = z.object({ messages: z.array(z.object({ text: z.string().optional() })) }).parse(await response.json());
    expect(messages.filter(row => row.text === `reply:${text}`)).toHaveLength(1);
    expect(await completions(account, target)).toHaveLength(count);
  }
  async function saveKey(account: Account, suffix: string) {
    expect((await request("/api/user-keys", account, "PUT", { providerId: "opencodeZen", apiKey: `owned-synthetic-${suffix}` })).status).toBe(200);
  }
  async function signUp(name: string): Promise<Account> {
    const response = await request("/api/auth/sign-up/email", undefined, "POST", {
      name, email: `${name}-${randomBytes(8).toString("hex")}@example.test`, password: randomBytes(24).toString("base64url"),
    });
    expect(response.status).toBe(200);
    const { user } = z.object({ user: z.object({ id: z.string() }) }).parse(await response.json());
    const cookie = response.headers.getSetCookie().find(value => value.startsWith("better-auth.session_token="))?.split(";")[0];
    if (!cookie) throw new Error("Owned signup did not return a session");
    seedConnectedGoogleRow(data, user.id);
    return { id: user.id, cookie };
  }
  async function boot() {
    const env = pairingServerEnvironment({ home: join(directory, "home"), dataDirectory: data,
      companionDirectory: join(directory, "companion"), staticDir: join(directory, "ui"), port, webhookPort: port + 1, secret });
    Object.assign(env, { OMB_PUBLIC_HOST: `127.0.0.1:${port}`, OMB_ALLOW_SIGNUPS: "true" });
    child = spawn(process.execPath, ["--import", preload, "--experimental-strip-types", join(ROOT, "server/index.ts")], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    child.stdout?.on("data", chunk => { output = (output + String(chunk)).slice(-4_000); });
    child.stderr?.on("data", chunk => { output = (output + String(chunk)).slice(-4_000); });
    await waitForOwnedServer(child, url);
  }
  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "muster-user-provider-liveness-"));
    data = join(directory, "data");
    for (const path of [data, join(directory, "home"), join(directory, "companion"), join(directory, "ui")]) mkdirSync(path, { recursive: true });
    writeFileSync(join(directory, "ui", "index.html"), "<!doctype html><title>Owned provider fixture</title>");
    writeFileSync(join(data, "config.json"), JSON.stringify({ instances: { ghost: { driver: "not-a-real-driver" } } }));
    transportLog = join(directory, "provider.ndjson");
    blockedLog = join(directory, "blocked.log");
    preload = join(directory, "synthetic-provider.mjs");
    writeFileSync(preload, `
import { Socket } from "node:net";
import { appendFileSync } from "node:fs";
const record = (action, text) => appendFileSync(${JSON.stringify(transportLog)}, JSON.stringify({action,text})+"\\n");
const blocked = () => { appendFileSync(${JSON.stringify(blockedLog)}, "blocked\\n"); throw new Error("Owned fixture blocks outbound traffic"); };
Socket.prototype.connect = blocked;
const sourceSignals = new WeakMap();
const cleanupFaults = new WeakMap();
const originalAny = AbortSignal.any.bind(AbortSignal);
AbortSignal.any = signals => { const signal = originalAny(signals); sourceSignals.set(signal, signals[0]); return signal; };
const originalAbort = AbortController.prototype.abort;
AbortController.prototype.abort = function (...args) {
  const text = cleanupFaults.get(this.signal);
  if (text) { cleanupFaults.delete(this.signal); record("cleanup-fault", text); throw new Error("Synthetic disposer failure"); }
  return originalAbort.apply(this, args);
};
globalThis.fetch = async (input, init = {}) => {
  const target = new URL(String(input));
  if (target.origin !== "https://opencode.ai" || target.pathname !== "/zen/v1/chat/completions") return blocked();
  const body = JSON.parse(init.body);
  const text = body.messages.at(-1)?.content;
  if (typeof text !== "string") throw new Error("Unexpected synthetic message");
  record("start", text);
  const authorization = new Headers(init.headers).get("authorization");
  if (["owned-synthetic-configured", "owned-synthetic-explicit-collision", "owned-synthetic-custom-collision"].some(key => authorization === "Bearer " + key)) record("configured-source", text);
  if (text.startsWith("hold:")) return new Promise((_resolve, reject) => {
    if (text === "hold:global-cleanup-failure") cleanupFaults.set(sourceSignals.get(init.signal) ?? init.signal, text);
    const abort = () => { record("abort", text); reject(init.signal.reason); };
    if (init.signal.aborted) abort(); else init.signal.addEventListener("abort", abort, {once:true});
  });
  const content = "reply:" + text;
  if (!body.stream) return Response.json({ choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  return new Response("data: " + JSON.stringify({ choices: [{ delta: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) + "\\n\\ndata: [DONE]\\n\\n", { headers: { "content-type": "text/event-stream" } });
};
`);
    port = await freePortBlock([0, 1], 28600, 7000);
    url = `http://127.0.0.1:${port}`;
    await boot();
    operator = await signUp("operator");
    alice = await signUp("alice"); bob = await signUp("bob");
    await saveKey(alice, "alice-boot"); await saveKey(bob, "bob-boot");
    await saveKey(operator, "operator-before-config-collision");
    await waitForExit(child, { signal: "SIGTERM" });
    // Authorization namespaces also occur in explicit operator configs.
    // They are not registrations owned by the per-user vault loader.
    writeFileSync(join(data, "config.json"), JSON.stringify({ instances: {
      ghost: { driver: "not-a-real-driver" },
      [`configuredApi:${alice.id}`]: { driver: "opencodeZen", environment: { OPENCODE_API_KEY: "owned-synthetic-configured" } },
      [`opencodeZenApi:${operator.id}`]: { driver: "opencodeZen", environment: { OPENCODE_API_KEY: "owned-synthetic-explicit-collision" } },
      [`custom-configured-collisionApi:${alice.id}`]: { driver: "opencodeZen", environment: { OPENCODE_API_KEY: "owned-synthetic-custom-collision" } },
    } }));
    await boot();
  }, 60_000);
  afterAll(async () => {
    await Promise.all(children.map(process => waitForExit(process, { signal: "SIGTERM" })));
    const exited = children.every(process => process.exitCode !== null || process.signalCode !== null);
    const noOutbound = !existsSync(blockedLog);
    if (directory && exited) await removeTempDir(directory);
    const removed = !existsSync(directory);
    console.info(JSON.stringify({ scope: "user provider lifecycle cleanup", exited, noOutbound, removed }));
    expect({ exited, noOutbound, removed }).toEqual({ exited: true, noOutbound: true, removed: true });
  }, 20_000);

  it("preserves a configured account-owned sibling through boot, key/custom changes and all-user repair", async () => {
    const target = await createBot(alice, `configuredApi:${alice.id}`);
    await send(alice, target, "configured-boot"); await reply(alice, target, "configured-boot");
    expect(saw("configured-source", "configured-boot")).toBe(true);
    await send(alice, target, "hold:configured-sibling");
    const preserved = async () => {
      expect(saw("abort", "hold:configured-sibling")).toBe(false);
      expect((await bot(alice, target.id)).busy).toBe(true);
      expect(await completions(alice, target)).toHaveLength(1);
    };
    await saveKey(alice, "configured-sibling-save"); await preserved();
    expect((await request("/api/user-keys", alice, "DELETE", { providerId: "opencodeZen" })).status).toBe(200);
    await preserved();
    const removed = await request("/api/instances", alice);
    const { instances } = z.object({ instances: z.array(z.object({ instanceId: z.string() })) }).parse(await removed.json());
    expect(instances.map(row => row.instanceId)).not.toContain(`opencodeZenApi:${alice.id}`);
    const added = await request("/api/custom-providers", alice, "POST", {
      name: "Configured sibling custom", baseUrl: "https://opencode.ai/zen/v1", format: "openai",
      models: ["deepseek-v4-flash-free"], apiKey: "owned-synthetic-sibling-custom",
    });
    expect(added.status).toBe(201);
    const custom = z.object({ id: z.string() }).parse(await added.json());
    await preserved();
    expect((await request(`/api/custom-providers/${custom.id}`, alice, "DELETE")).status).toBe(200);
    await preserved();
    expect((await request("/api/engines/doctor/repair", operator, "POST")).status).toBe(200);
    await preserved();
    expect((await request(`/api/bots/${target.id}/interrupt`, alice, "POST")).status).toBe(200);
    await until(() => saw("abort", "hold:configured-sibling"), "configured sibling Stop still reaches its controller");
    await idle(alice, target);
    expect(await completions(alice, target)).toHaveLength(2);
    await send(alice, target, "configured-after-repair"); await reply(alice, target, "configured-after-repair", 3);
    await saveKey(alice, "alice-after-sibling-test");
  });

  it("tolerates saved config collisions at boot and rejects new collisions before changing data or retiring explicit engines", async () => {
    const target = await createBot(operator);
    await send(operator, target, "hold:configured-key-collision");
    expect(saw("configured-source", "hold:configured-key-collision")).toBe(true);
    const configBefore = readFileSync(join(data, "config.json"), "utf8");
    const vaultBefore = readFileSync(join(data, "user-keys.json"), "utf8");
    const rejected = await request("/api/user-keys", operator, "PUT", { providerId: "opencodeZen", apiKey: "owned-synthetic-conflicting-key" });
    expect(rejected.status).toBe(409);
    expect(z.object({ error: z.string() }).parse(await rejected.json()).error).toContain("deployment configuration");
    expect(readFileSync(join(data, "config.json"), "utf8")).toBe(configBefore);
    expect(readFileSync(join(data, "user-keys.json"), "utf8")).toBe(vaultBefore);
    expect(saw("abort", "hold:configured-key-collision")).toBe(false);
    expect((await bot(operator, target.id)).busy).toBe(true);
    expect(await completions(operator, target)).toHaveLength(0);

    const customTarget = await createBot(alice, `custom-configured-collisionApi:${alice.id}`);
    await send(alice, customTarget, "hold:configured-custom-collision");
    expect(saw("configured-source", "hold:configured-custom-collision")).toBe(true);
    const metadataPath = join(data, "user-custom-providers.json");
    const metadataBefore = existsSync(metadataPath) ? readFileSync(metadataPath, "utf8") : null;
    const customRejected = await request("/api/custom-providers", alice, "POST", {
      name: "Configured collision", baseUrl: "https://opencode.ai/zen/v1", format: "openai",
      models: ["deepseek-v4-flash-free"], apiKey: "owned-synthetic-conflicting-custom-key",
    });
    expect(customRejected.status).toBe(409);
    expect(z.object({ error: z.string() }).parse(await customRejected.json()).error).toContain("deployment configuration");
    expect(existsSync(metadataPath) ? readFileSync(metadataPath, "utf8") : null).toBe(metadataBefore);
    expect(readFileSync(join(data, "user-keys.json"), "utf8")).toBe(vaultBefore);
    expect(saw("abort", "hold:configured-custom-collision")).toBe(false);
    expect((await bot(alice, customTarget.id)).busy).toBe(true);
    expect(await completions(alice, customTarget)).toHaveLength(0);

    // Deleting the old colliding vault record and repairing all users must
    // leave the already-running explicit adapters and their controllers alive.
    expect((await request("/api/user-keys", operator, "DELETE", { providerId: "opencodeZen" })).status).toBe(200);
    const flags = z.object({ providers: z.array(z.object({ configKey: z.string(), configured: z.boolean() })) }).parse(await (await request("/api/user-keys", operator)).json());
    expect(flags.providers.find(provider => provider.configKey === "opencodeZen")?.configured).toBe(false);
    expect((await request("/api/engines/doctor/repair", operator, "POST")).status).toBe(200);
    for (const [account, held, text] of [[operator, target, "hold:configured-key-collision"], [alice, customTarget, "hold:configured-custom-collision"]] as const) {
      expect(saw("abort", text)).toBe(false);
      expect((await bot(account, held.id)).busy).toBe(true);
      expect((await request(`/api/bots/${held.id}/interrupt`, account, "POST")).status).toBe(200);
      await until(() => saw("abort", text), "Stop reaches the preserved explicit controller");
      await idle(account, held);
      expect(await completions(account, held)).toHaveLength(1);
    }
    const other = await createBot(bob);
    await send(bob, other, "after-configured-conflict"); await reply(bob, other, "after-configured-conflict");
  });

  it("folds a saved user's boot-loaded reply once and releases the slot for another send", async () => {
    const target = await createBot(alice);
    await send(alice, target, "boot-one"); await reply(alice, target, "boot-one");
    await send(alice, target, "boot-two"); await reply(alice, target, "boot-two", 2);
  });
  it("routes Stop to the active provider and folds its interrupted completion promptly", async () => {
    const target = await createBot(bob);
    await send(bob, target, "hold:manual");
    expect((await request(`/api/bots/${target.id}/interrupt`, bob, "POST")).status).toBe(200);
    await until(() => saw("abort", "hold:manual"), "manual abort reached the provider");
    await idle(bob, target);
    expect(await completions(bob, target)).toHaveLength(1);
    await send(bob, target, "after-stop"); await reply(bob, target, "after-stop", 2);
  });
  it("attaches each replacement once after repeated user key reloads", async () => {
    await saveKey(alice, "alice-reload-one"); await saveKey(alice, "alice-reload-two");
    const target = await createBot(alice);
    await send(alice, target, "reload-reply"); await reply(alice, target, "reload-reply");
  });
  it("stops a replaced predecessor while another user's active controller survives", async () => {
    const own = await createBot(alice); const other = await createBot(bob);
    await send(alice, own, "hold:replace"); await send(bob, other, "hold:unrelated");
    await saveKey(alice, "alice-replaced");
    await until(() => saw("abort", "hold:replace"), "replacement aborted predecessor");
    await idle(alice, own);
    expect(saw("abort", "hold:unrelated")).toBe(false);
    expect((await bot(bob, other.id)).busy).toBe(true);
    expect((await request(`/api/bots/${other.id}/interrupt`, bob, "POST")).status).toBe(200);
    await idle(bob, other);
    await send(alice, own, "replacement-reply"); await reply(alice, own, "replacement-reply", 2);
  });
  it("removes a deleted key's live instance and stops its predecessor", async () => {
    const target = await createBot(alice);
    await send(alice, target, "hold:remove");
    expect((await request("/api/user-keys", alice, "DELETE", { providerId: "opencodeZen" })).status).toBe(200);
    await until(() => saw("abort", "hold:remove"), "removal aborted predecessor");
    await idle(alice, target);
    const response = await request("/api/instances", alice);
    const { instances } = z.object({ instances: z.array(z.object({ instanceId: z.string() })) }).parse(await response.json());
    expect(instances.map(row => row.instanceId)).not.toContain(`opencodeZenApi:${alice.id}`);
    await saveKey(alice, "alice-restored");
    await send(alice, target, "restored-reply"); await reply(alice, target, "restored-reply", 2);
  });

  it("attaches an added custom provider and removes it while preserving another owner's turn", async () => {
    const added = await request("/api/custom-providers", alice, "POST", {
      name: "Owned custom", baseUrl: "https://opencode.ai/zen/v1", format: "openai",
      models: ["deepseek-v4-flash-free"], apiKey: "owned-synthetic-custom",
    });
    expect(added.status).toBe(201);
    const provider = z.object({ id: z.string(), instanceId: z.string() }).parse(await added.json());
    const target = await createBot(alice, provider.instanceId);
    await send(alice, target, "custom-reply"); await reply(alice, target, "custom-reply");
    const other = await createBot(bob);
    await send(alice, target, "hold:custom-remove"); await send(bob, other, "hold:custom-unrelated");
    expect((await request(`/api/custom-providers/${provider.id}`, alice, "DELETE")).status).toBe(200);
    await until(() => saw("abort", "hold:custom-remove"), "custom removal aborted predecessor");
    await idle(alice, target);
    const response = await request("/api/instances", alice);
    const { instances } = z.object({ instances: z.array(z.object({ instanceId: z.string() })) }).parse(await response.json());
    expect(instances.map(row => row.instanceId)).not.toContain(provider.instanceId);
    expect((await bot(bob, other.id)).busy).toBe(true);
    expect(saw("abort", "hold:custom-unrelated")).toBe(false);
    expect((await request(`/api/bots/${other.id}/interrupt`, bob, "POST")).status).toBe(200);
    await idle(bob, other);
  });

  it("drains an explicit queued message onto the replacement once it is attached", async () => {
    const target = await createBot(alice);
    await send(alice, target, "hold:queued-replace");
    const queued = await request(`/api/bots/${target.id}/messages`, alice, "POST", { text: "queued-after-replace" });
    expect(queued.status).toBe(202);
    await saveKey(alice, "alice-queued-replacement");
    await until(() => saw("abort", "hold:queued-replace"), "queued predecessor stopped");
    await until(() => saw("start", "queued-after-replace"), "queued message reached replacement");
    await reply(alice, target, "queued-after-replace", 2);
    expect(transport().filter(row => row.action === "start" && row.text === "queued-after-replace")).toHaveLength(1);
  });

  it("settles global reload cleanup failures and recovers only after predecessor cleanup succeeds", async () => {
    const own = await createBot(alice); const other = await createBot(bob);
    await send(alice, own, "hold:global-cleanup-failure");
    await send(bob, other, "hold:global-cleanup-sibling");
    const failed = await request("/api/instances/ghost", operator, "PATCH", { cli: "" });
    expect(failed.status).toBe(500);
    expect(z.object({ error: z.string() }).parse(await failed.json()).error).toContain("cleanup failed");
    expect(saw("cleanup-fault", "hold:global-cleanup-failure")).toBe(true);
    await idle(alice, own); await idle(bob, other);
    expect(await completions(alice, own)).toHaveLength(1);
    expect(await completions(bob, other)).toHaveLength(1);
    const response = await request("/api/instances", alice);
    const { instances } = z.object({ instances: z.array(z.object({ instanceId: z.string(), snapshot: z.object({ state: z.string() }) })) }).parse(await response.json());
    expect(instances.find(row => row.instanceId === `opencodeZenApi:${alice.id}`)?.snapshot.state).toBe("unavailable");
    // A second settings retry disposes the quarantined old controller before
    // registering another instance. No provider action is automatically replayed.
    expect((await request("/api/instances/ghost", operator, "PATCH", { cli: "" })).status).toBe(200);
    await until(() => saw("abort", "hold:global-cleanup-failure"), "quarantined controller retired on retry");
    await send(alice, own, "after-global-recovery"); await reply(alice, own, "after-global-recovery", 2);
    expect(transport().filter(row => row.action === "start" && row.text === "hold:global-cleanup-failure")).toHaveLength(1);
    // A successful global rebuild must keep tracking dynamically registered
    // IDs so a later user-key deletion still retires/removes that instance.
    await send(alice, own, "hold:delete-after-global-reload");
    expect((await request("/api/user-keys", alice, "DELETE", { providerId: "opencodeZen" })).status).toBe(200);
    await until(() => saw("abort", "hold:delete-after-global-reload"), "post-rebuild deletion retired the managed controller");
    await idle(alice, own);
    expect(await completions(alice, own)).toHaveLength(3);
    const afterDelete = z.object({ instances: z.array(z.object({ instanceId: z.string() })) }).parse(await (await request("/api/instances", alice)).json());
    expect(afterDelete.instances.map(instance => instance.instanceId)).not.toContain(`opencodeZenApi:${alice.id}`);
    const configured = await createBot(alice, `configuredApi:${alice.id}`);
    await send(alice, configured, "configured-after-global-reload"); await reply(alice, configured, "configured-after-global-reload");
  });
});
