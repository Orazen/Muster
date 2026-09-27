// Real route wiring for the onboarding server changes. All accounts, storage,
// ports and the fake CLI belong to this fixture; no provider is contacted.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
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
const planSchema = z.object({ id: z.string(), ownerId: z.string(), title: z.string() });
const planEnvelope = z.object({ plan: planSchema });
const intentsSchema = z.object({ version: z.literal(1), intents: z.record(z.string(), z.object({ planId: z.string(), acceptedAt: z.number() }).passthrough()) });
const modernIntent = "onboarding-owned-intent-001";
const legacyIntent = "onboarding-legacy-intent-001";

interface Account { id: string; cookie: string; botId: string }

describe.skipIf(process.platform === "win32")("onboarding server ownership and allowance boundaries", () => {
  let directory = "";
  let data = "";
  let url = "";
  let networkLog = "";
  let rpcLog = "";
  let byokRpcLog = "";
  let byokInstance = "";
  let preload = "";
  let env: NodeJS.ProcessEnv;
  const children: ChildProcess[] = [];
  const ports: number[] = [];
  let alice: Account;
  let bob: Account;
  let modernPlan: z.infer<typeof planSchema>;
  let legacyPlan: z.infer<typeof planSchema>;

  const request = (path: string, method = "GET", body?: JsonValue, account?: Account) => {
    const headers = new Headers({ origin: url, "content-type": "application/json" });
    if (account) headers.set("cookie", account.cookie);
    const init: RequestInit = { method, headers, redirect: "error", signal: AbortSignal.timeout(15_000) };
    if (body !== undefined) init.body = JSON.stringify(body);
    return fetch(`${url}${path}`, init);
  };

  const createPlan = (account: Account, intentId: string, extra: Record<string, JsonValue> = {}) =>
    request("/api/task-plans", "POST", { botId: account.botId, intentId, title: "Alice private plan marker", steps: ["Review fixture"], start: false, ...extra }, account);

  async function boot() {
    const child = spawn(process.execPath, ["--import", preload, "--experimental-strip-types", join(ROOT, "server/index.ts")], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", () => {});
    await waitForOwnedServer(child, url);
    return child;
  }

  async function signUp(name: string): Promise<Account> {
    const response = await request("/api/auth/sign-up/email", "POST", { name, email: `${name}-${randomBytes(8).toString("hex")}@example.test`, password: randomBytes(32).toString("base64url") });
    expect(response.status).toBe(200);
    const { user } = z.object({ user: z.object({ id: z.string() }) }).parse(await response.json());
    const session = response.headers.getSetCookie().find((header) => header.startsWith("better-auth.session_token="));
    if (!session) throw new Error("Owned signup did not return a session");
    const account = { id: user.id, cookie: session.split(";")[0], botId: "" };
    // Fixture-only existing consent, used by the current hosted storage gate.
    // Outbound traffic is blocked; this does not exercise Google consent.
    seedConnectedGoogleRow(data, account.id);
    const created = await request("/api/bots", "POST", {}, account);
    expect(created.status).toBe(201);
    account.botId = z.object({ bot: z.object({ id: z.string() }) }).parse(await created.json()).bot.id;
    return account;
  }

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "muster-onboarding-boundaries-"));
    data = join(directory, "data");
    const home = join(directory, "home"), companion = join(directory, "companion"), ui = join(directory, "ui");
    for (const path of [data, home, companion, ui]) mkdirSync(path, { recursive: true, mode: 0o700 });
    rpcLog = join(directory, "fake-rpc.json");
    byokRpcLog = join(directory, "fake-byok-rpc.json");
    networkLog = join(directory, "outbound.log");
    preload = join(directory, "block-outbound.mjs");
    writeFileSync(preload, `import { Socket } from "node:net";\nimport { appendFileSync } from "node:fs";\nconst blocked = () => { appendFileSync(${JSON.stringify(networkLog)}, "blocked\\n"); throw new Error("Owned boundary fixture refuses outbound traffic"); };\nglobalThis.fetch = blocked; Socket.prototype.connect = blocked;\n`);
    // Copy the existing fake into owned storage; never chmod a shared file.
    const fake = join(directory, "fake-acp-cli.ts");
    writeFileSync(fake, readFileSync(join(ROOT, "server/testing/fake-acp-cli.ts")), { mode: 0o700 });
    writeFileSync(join(data, "config.json"), JSON.stringify({
      instances: { fixture: { driver: "grokAgent", config: { cli: fake, fullAuto: true }, environment: { FAKE_ACP_MODE: "happy", FAKE_ACP_RPC_DUMP: rpcLog } } },
      usage: { allowance: { monthlyUsd: 10, turnReserveUsd: 1 } },
    }));
    const port = await freePortBlock([0, 1], 49000, 6000);
    ports.push(port, port + 1);
    url = `http://127.0.0.1:${port}`;
    env = pairingServerEnvironment({ home, dataDirectory: data, companionDirectory: companion, staticDir: ui, port, webhookPort: port + 1, secret: randomBytes(32).toString("hex") });
    Object.assign(env, { OMB_PUBLIC_HOST: `127.0.0.1:${port}`, OMB_ALLOW_SIGNUPS: "true" });
    const first = await boot();
    alice = await signUp("alice");
    bob = await signUp("bob");
    const selected = await request(`/api/bots/${alice.botId}`, "PATCH", { computer: "off", modelSelection: { instanceId: "fixture", model: "fake-acp-model" } }, alice);
    expect(selected.status).toBe(200);

    // A real positive dispatch control prevents an unavailable engine or an
    // earlier account gate from masquerading as allowance enforcement.
    const sent = await request(`/api/bots/${alice.botId}/messages`, "POST", { text: "Owned allowance positive control" }, alice);
    expect(sent.status).toBe(202);
    const deadline = Date.now() + 20_000;
    for (;;) {
      const response = await request("/api/bots", "GET", undefined, alice);
      expect(response.status).toBe(200);
      const bots = z.object({ bots: z.array(z.object({ id: z.string(), busy: z.boolean() })) }).parse(await response.json()).bots;
      const methods = existsSync(rpcLog) ? z.array(z.string()).parse(JSON.parse(readFileSync(rpcLog, "utf8"))) : [];
      if (methods.includes("session/prompt") && bots.find((bot) => bot.id === alice.botId)?.busy === false) break;
      if (Date.now() > deadline) throw new Error("The owned fake engine did not finish the positive dispatch control");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const modern = await createPlan(alice, modernIntent);
    expect(modern.status).toBe(201);
    modernPlan = planEnvelope.parse(await modern.json()).plan;
    const legacy = await createPlan(alice, legacyIntent);
    expect(legacy.status).toBe(201);
    legacyPlan = planEnvelope.parse(await legacy.json()).plan;
    await waitForExit(first, { signal: "SIGTERM" });
    expect(first.exitCode !== null || first.signalCode !== null).toBe(true);

    // Change only owned fixture state while its server is stopped. A prior
    // version-one intent lacks ownership fields; the plan retains its owner.
    const path = join(data, "task-delivery-intents.json");
    const disk = intentsSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    disk.intents[legacyIntent] = { planId: legacyPlan.id, acceptedAt: disk.intents[legacyIntent]!.acceptedAt };
    writeFileSync(path, JSON.stringify(disk));
    // An exact spent balance, independent of the fake provider's cost shape.
    const month = new Date().toISOString().slice(0, 7);
    writeFileSync(join(data, "usage-allowance-ledger.json"), JSON.stringify({ version: 1, months: { [month]: { local: { used: 10 }, [bob.id]: { used: 10 } } } }));
    byokInstance = `fixtureApi:${bob.id}`;
    // Exercise the actual account-scoped instance namespace with an offline
    // adapter. No key is saved and no paid provider API is called.
    writeFileSync(join(data, "config.json"), JSON.stringify({
      instances: {
        fixture: { driver: "grokAgent", config: { cli: fake, fullAuto: true }, environment: { FAKE_ACP_MODE: "happy", FAKE_ACP_RPC_DUMP: rpcLog } },
        [byokInstance]: { driver: "grokAgent", config: { cli: fake, fullAuto: true }, environment: { FAKE_ACP_MODE: "happy", FAKE_ACP_RPC_DUMP: byokRpcLog } },
        cloudFixture: { driver: "boxAgent" }, // No token: cannot provision or call Box.
      },
      usage: { allowance: { monthlyUsd: 10, turnReserveUsd: 1 } },
    }));
    rmSync(rpcLog, { force: true });
    await boot();
  }, 90_000);

  afterAll(async () => {
    await Promise.all(children.map((child) => waitForExit(child, { signal: "SIGTERM" })));
    const exited = children.every((child) => child.exitCode !== null || child.signalCode !== null);
    const closed = await Promise.all(ports.map((port) => new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.setTimeout(2_000);
      socket.once("connect", () => { socket.destroy(); resolve(false); });
      socket.once("timeout", () => { socket.destroy(); resolve(false); });
      socket.once("error", (error) => { socket.destroy(); resolve("code" in error && error.code === "ECONNREFUSED"); });
    })));
    const noOutbound = !networkLog || !existsSync(networkLog);
    if (directory && exited) await removeTempDir(directory);
    expect({ exited, noOutbound, closed: closed.every(Boolean) }).toEqual({ exited: true, noOutbound: true, closed: true });
  }, 20_000);

  it("reconciles an owner's retry after restart and ignores spoofed body ownership", async () => {
    const retried = await createPlan(alice, modernIntent, { ownerId: bob.id, intentOwnerId: bob.id });
    expect(retried.status).toBe(201);
    expect(planEnvelope.parse(await retried.json()).plan).toEqual(modernPlan);
    const response = await request("/api/task-plans", "GET", undefined, alice);
    expect(response.status).toBe(200);
    expect(z.object({ plans: z.array(planSchema) }).parse(await response.json()).plans).toHaveLength(2);
  });

  it("refuses another account's intent even when both owner fields are spoofed", async () => {
    const own = await createPlan(bob, "onboarding-bob-own-intent", { title: "Bob control" });
    expect(own.status).toBe(201);
    expect(planEnvelope.parse(await own.json()).plan.ownerId).toBe(bob.id);
    expect((await request(`/api/task-plans/${modernPlan.id}`, "GET", undefined, bob)).status).toBe(404);
    const collision = await createPlan(bob, modernIntent, { ownerId: alice.id, intentOwnerId: alice.id, context: { accountId: alice.id } });
    expect(collision.status).toBe(403);
    const text = await collision.text();
    expect(text).not.toContain(modernPlan.id);
    expect(text).not.toContain(modernPlan.title);
    const response = await request("/api/task-plans", "GET", undefined, bob);
    expect(z.object({ plans: z.array(planSchema) }).parse(await response.json()).plans).toHaveLength(1);
  });

  it("reconciles a pre-upgrade intent for its owner and refuses a foreign retry", async () => {
    const foreign = await createPlan(bob, legacyIntent, { ownerId: alice.id, intentOwnerId: alice.id });
    expect(foreign.status).toBe(403);
    expect(await foreign.text()).not.toContain(legacyPlan.id);
    const own = await createPlan(alice, legacyIntent);
    expect(own.status).toBe(201);
    expect(planEnvelope.parse(await own.json()).plan).toEqual(legacyPlan);
  });

  it("returns 402 for a spent allowance before invoking the shared engine", async () => {
    const refused = await request(`/api/bots/${alice.botId}/messages`, "POST", { text: "Spent allowance attempt" }, alice);
    expect(refused.status).toBe(402);
    expect(z.object({ error: z.string() }).parse(await refused.json()).error).toContain("Monthly usage allowance reached");
    const methods = existsSync(rpcLog) ? z.array(z.string()).parse(JSON.parse(readFileSync(rpcLog, "utf8"))) : [];
    expect(methods).not.toContain("session/prompt");
  });

  it("lets an account-owned BYOK namespace use its engine without consuming the shared allowance", async () => {
    const selected = await request(`/api/bots/${bob.botId}`, "PATCH", { computer: "off", modelSelection: { instanceId: byokInstance, model: "fake-acp-model" } }, bob);
    expect(selected.status).toBe(200);
    const ledgerBefore = readFileSync(join(data, "usage-allowance-ledger.json"), "utf8");
    const sent = await request(`/api/bots/${bob.botId}/messages`, "POST", { text: "Owned BYOK exemption control" }, bob);
    expect(sent.status).toBe(202);
    const deadline = Date.now() + 20_000;
    for (;;) {
      const response = await request("/api/bots", "GET", undefined, bob);
      const bots = z.object({ bots: z.array(z.object({ id: z.string(), busy: z.boolean() })) }).parse(await response.json()).bots;
      const methods = existsSync(byokRpcLog) ? z.array(z.string()).parse(JSON.parse(readFileSync(byokRpcLog, "utf8"))) : [];
      if (methods.includes("session/prompt") && bots.find((bot) => bot.id === bob.botId)?.busy === false) break;
      if (Date.now() > deadline) throw new Error("The account-scoped fake engine did not finish its prompt");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(readFileSync(join(data, "usage-allowance-ledger.json"), "utf8")).toBe(ledgerBefore);
  });

  it("meters the resolved cloud engine even when the bot's saved selection is BYOK", async () => {
    const selected = await request(`/api/bots/${bob.botId}`, "PATCH", { computer: "off", modelSelection: { instanceId: byokInstance, model: "fake-acp-model" } }, bob);
    expect(selected.status).toBe(200);
    const created = await request("/api/routines", "POST", { botId: bob.botId, name: "Owned cloud override", prompt: "Refuse before cloud work", runOn: "cloud", enabled: false, schedule: { type: "once", at: Date.now() + 86_400_000 } }, bob);
    expect(created.status).toBe(201);
    const routine = z.object({ routine: z.object({ id: z.string() }) }).parse(await created.json()).routine;
    const queued = await request(`/api/routines/${routine.id}/run`, "POST", {}, bob);
    expect(queued.status).toBe(201);
    const runId = z.object({ run: z.object({ id: z.string() }) }).parse(await queued.json()).run.id;
    const deadline = Date.now() + 10_000;
    for (;;) {
      const response = await request("/api/routines", "GET", undefined, bob);
      expect(response.status).toBe(200);
      const runs = z.object({ runs: z.array(z.object({ id: z.string(), status: z.string(), error: z.string().optional() })) }).parse(await response.json()).runs;
      const run = runs.find((candidate) => candidate.id === runId);
      if (run?.status === "failed") {
        expect(run.error).toContain("Monthly usage allowance reached");
        break;
      }
      if (Date.now() > deadline) throw new Error("Cloud override did not fail at the allowance gate");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(existsSync(networkLog)).toBe(false);
  });

  it("returns 503 for a corrupt allowance ledger and sends no prompt to the available engine", async () => {
    const current = children[children.length - 1]!;
    await waitForExit(current, { signal: "SIGTERM" });
    expect(current.exitCode !== null || current.signalCode !== null).toBe(true);
    writeFileSync(join(data, "usage-allowance-ledger.json"), "{broken");
    await boot();
    for (let attempt = 0; attempt < 2; attempt++) {
      const refused = await request(`/api/bots/${alice.botId}/messages`, "POST", { text: `Blocked allowance attempt ${attempt}` }, alice);
      expect(refused.status).toBe(503);
      expect(z.object({ error: z.string() }).parse(await refused.json()).error).toContain("saved ledger");
    }
    const methods = existsSync(rpcLog) ? z.array(z.string()).parse(JSON.parse(readFileSync(rpcLog, "utf8"))) : [];
    expect(methods).not.toContain("session/prompt");
    expect(readFileSync(join(data, "usage-allowance-ledger.json"), "utf8")).toBe("{broken");
  });
});
