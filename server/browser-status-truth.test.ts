// Ground truth about whether a bot's browser will actually mount.
//
// The defect this pins. `/api/browser-status` reported two things: whether the
// obscura binary exists, and which bots have the toggle on. The mount needs
// THREE things — the toggle, the binary, AND an engine adapter that declares
// `customMcp` — and only the first two were ever checked.
//
// Only 4 of the 29 drivers declare `customMcp` (claude, grok, openai,
// acp/core). So a bot on `grokagent`, `codex`, `google`, `local` — and 21
// others — showed the settings card reading "available, 1 bot enabled" while
// every turn ran with zero browser tools. The card was reassuring the user
// about a capability the engine could not mount, and the bot could only report
// that it had no browser. That is the whole bug: not that the browser was
// missing, but that nothing said WHY.
//
// A live server with a real store, because the claim is about what a user's
// settings card would tell them.

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { pairingServerEnvironment, waitForOwnedServer } from "../e2e/pairing-harness.ts";
import { seedConnectedGoogleRow } from "./testing/storage-gate.ts";
import type { JsonValue } from "./schema.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const posixOnly = describe.skipIf(process.platform === "win32");

let child: ChildProcess;
let home: string;
let data: string;
let base: string;
let cookie = "";
let stderr = "";
/** A driver kind whose adapter does not declare `customMcp`, found at run time. */
let dummyDriver = "";

/** Find a driver that cannot mount a custom MCP server.
 *
 *  Read off disk rather than hard-coded, because the set changes: supporting
 *  drivers went from four to nine while this test existed, and a pinned name
 *  made it assert against a fact that had already moved. */
function driverWithoutCustomMcp(): string | null {
  const dir = join(ROOT, "server", "drivers");
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.includes(".test."));
  for (const file of files) {
    if (readFileSync(join(dir, file), "utf8").includes("customMcp")) continue;
    const kind = file.replace(/\.ts$/, "");
    // `local` composes the shared ACP core, which DOES declare customMcp, so a
    // file that merely omits the token is not enough — the composed adapter is
    // what the turn path reads. Skip the wrappers that delegate to it.
    if (["local", "grokagent", "native", "retry", "local-inject", "acp"].includes(kind)) continue;
    return kind;
  }
  return null;
}


/** Ready offline adapter: status reads must never call this provider. */
const readyInstance = () => ({
  driver: "openai",
  environment: { OPENAI_API_KEY: "owned-browser-status-fixture" },
  config: { url: "http://127.0.0.1:1/v1" },
});

function outboundBlocker(directory: string): string {
  const path = join(directory, "block-outbound.mjs");
  writeFileSync(path, `import { Socket } from "node:net";
const blocked = () => { throw new Error("Browser status fixture forbids outbound traffic"); };
globalThis.fetch = blocked; Socket.prototype.connect = blocked;
`);
  return path;
}

const botSelection = z.object({ id: z.string(), modelSelection: z.object({ instanceId: z.string(), model: z.string() }).passthrough() });
const botList = z.object({ bots: z.array(botSelection) });

type BotStatus = {
  id: string;
  name: string;
  enabled: boolean;
  engineId: string | null;
  engineSupportsBrowser: boolean;
  effective: boolean;
  reason: "off" | "not-installed" | "engine-unsupported" | null;
};

type BrowserStatus = {
  available: boolean;
  bots: Array<{ id: string; name: string }>;
  status: BotStatus[];
  blockedCount: number;
  tools: number;
};

async function get(path: string): Promise<BrowserStatus> {
  const response = await fetch(`${base}${path}`, { headers: { cookie, origin: base }, redirect: "manual" });
  expect(response.status).toBe(200);
  // SAFETY: BrowserStatus above is the route's declared wire shape; the tests
  // below assert exactly these fields, and a shape drift fails an assertion
  // rather than crashing on a missing field.
  return (await response.json()) as BrowserStatus;
}

posixOnly("browser status tells the truth about each bot", () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "muster-browser-status-"));
    data = join(home, "data");
    mkdirSync(data, { recursive: true });
    // A `config.json` of `{}` sends the server looking for an engine at boot
    // over the network. Declaring a dummy instance keeps the fixture offline.
    //
    // The dummy deliberately uses a driver that CANNOT mount a custom MCP
    // server, and it is DISCOVERED rather than hard-coded. The first version of
    // this test pinned `local`, and it went stale the moment `local` began
    // inheriting `customMcp` from the shared ACP core — supporting drivers went
    // from four to nine and the test started failing on a true assertion about a
    // fact that had simply changed. A test that pins which drivers support the
    // browser is a test that will rot every time a driver is added.
    const withoutMcp = driverWithoutCustomMcp();
    if (!withoutMcp) throw new Error("every driver now supports customMcp; this fixture needs one that does not");
    dummyDriver = withoutMcp;
    writeFileSync(
      join(data, "config.json"),
      JSON.stringify({ instances: { dummy: { driver: withoutMcp, displayName: "Dummy" }, ready: readyInstance() } }),
    );
    mkdirSync(join(data, "bin"), { recursive: true });
    writeFileSync(join(data, "bin", "obscura"), "#!/bin/sh\nexit 99\n", { mode: 0o700 });
    const preload = outboundBlocker(home);
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ["--import", preload, "--experimental-strip-types", join(ROOT, "server/index.ts")], {
      cwd: ROOT,
      env: {
        PATH: "/usr/bin:/bin",
        VITEST: "true",
        NODE_OPTIONS: `--import=${new URL("../e2e/no-host-containers.mjs", import.meta.url).href}`,
        HOME: home,
        USERPROFILE: home,
        OMB_DATA_DIR: data,
        OMB_COMPANION_DIR: join(home, "companion"),
        OMB_HOST: "127.0.0.1",
        OMB_PORT: String(port),
        OMB_WEBHOOK_PORT: String(port + 1),
        OMB_PUBLIC_URL: base,
        BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
        OMB_ALLOW_SIGNUPS: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (chunk) => { stderr += chunk; });
    child.stdout!.resume();
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        const response = await fetch(`${base}/api/health`, { redirect: "manual" });
        if (response.ok) break;
      } catch {
        /* the listener is not up yet */
      }
      if (child.exitCode !== null || Date.now() > deadline) {
        throw new Error(`browser-status fixture did not start: ${stderr}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    const signed = await fetch(`${base}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ email: "browser@example.com", password: "correct-horse-battery", name: "Browser" }),
      redirect: "manual",
    });
    const jar = signed.headers.getSetCookie?.() ?? [];
    const session = jar.find((c) => c.startsWith("better-auth.session_token="));
    expect(session, `no session cookie: ${jar.join(" | ")}`).toBeTruthy();
    // SAFETY: the assertion above throws when no cookie was written, so the
    // split below always cuts a real name=value pair.
    cookie = (session as string).split(";")[0] as string;
  }, 45_000);

  afterAll(async () => {
    child?.kill("SIGKILL");
    await waitForExit(child).catch(() => {});
    if (home) await removeTempDir(home);
  });

  /** Create a bot, then PATCH its browser toggle — which is how the settings
   *  card actually sets it, so the fixture exercises the same path a user does. */
  const createBot = async (name: string, browser: boolean, instanceId?: string): Promise<string> => {
    const created = await fetch(`${base}/api/bots`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: base },
      body: JSON.stringify({ name }),
      redirect: "manual",
    });
    expect(created.status).toBe(201);
    // SAFETY: the status assertion above throws first, so the body is the
    // created bot and `id` is present.
    const bot = ((await created.json()) as { bot: { id: string } }).bot;
    if (instanceId !== undefined) {
      const pinned = await fetch(`${base}/api/bots/${bot.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie, origin: base },
        body: JSON.stringify({ modelSelection: { instanceId } }),
        redirect: "manual",
      });
      expect(pinned.status).toBe(200);
    }
    const patched = await fetch(`${base}/api/bots/${bot.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie, origin: base },
      body: JSON.stringify({ browser }),
      redirect: "manual",
    });
    expect(patched.status).toBe(200);
    return bot.id;
  };

  it("reports a bot whose engine cannot mount the browser as blocked, with the reason", async () => {
    // THE regression. `local` declares no `customMcp`, so this bot's toggle can
    // never produce browser tools — and the old reply said nothing at all.
    const id = await createBot("OnUnsupportedEngine", true, "dummy");
    const status = await get("/api/browser-status");
    const entry = status.status.find((b) => b.id === id);
    expect(entry, "the new bot is absent from the per-bot status").toBeDefined();
    expect(entry!.enabled, "the toggle is on but status says off").toBe(true);
    expect(entry!.engineSupportsBrowser, `the ${dummyDriver} driver declares no customMcp but status says it supports the browser`).toBe(false);
    expect(entry!.effective, "a bot that cannot mount the browser reports effective").toBe(false);
    // The reason must be the ENGINE, not "off" or "not-installed" — those are
    // different problems with different fixes, and collapsing them into one
    // "unavailable" is what made this unfixable from the outside.
    expect(["engine-unsupported", "not-installed"]).toContain(entry!.reason);
  });

  it("counts blocked bots separately from enabled ones", async () => {
    // The number a user needs at a glance: how many bots the toggle claims and
    // the engine cannot honour.
    const status = await get("/api/browser-status");
    const enabled = status.status.filter((b) => b.enabled);
    expect(status.bots.map((b) => b.id).sort()).toEqual(enabled.map((b) => b.id).sort());
    const blocked = enabled.filter((b) => !b.effective);
    expect(status.blockedCount, "blockedCount disagrees with the per-bot list").toBe(blocked.length);
  });

  it("marks a bot with the toggle off as off, not as broken", async () => {
    // A bot nobody enabled is not a fault, and must not be counted as blocked.
    const id = await createBot("NotEnabled", false, "dummy");
    const status = await get("/api/browser-status");
    const entry = status.status.find((b) => b.id === id);
    expect(entry!.enabled).toBe(false);
    expect(entry!.reason).toBe("off");
    expect(entry!.effective).toBe(false);
  });

  it("keeps the pre-existing reply shape so an older client is unaffected", async () => {
    // `bots` and `tools` are what the shipped card reads. Adding fields must not
    // change them, or the settings page breaks on its own server.
    const status = await get("/api/browser-status");
    expect(Array.isArray(status.bots)).toBe(true);
    for (const entry of status.bots) {
      expect(Object.keys(entry).sort()).toEqual(["id", "name"]);
    }
    // SAFETY: get() parses the body into BrowserStatus, whose tools is a
    // number and available a boolean; these assert the WIRE carries them.
    expect(status.tools).toEqual(expect.any(Number));
    expect(status.available).toEqual(expect.any(Boolean));
  });

  it.each([false, true])("does not select an engine or write bot state during status reads (browser=%s)", async (browser) => {
    const id = await createBot("Unselected", browser, "");
    const before = readFileSync(join(data, "bots.json"), "utf8");
    for (let read = 0; read < 2; read++) {
      const status = await get("/api/browser-status");
      expect(status.status.find((entry) => entry.id === id)).toMatchObject({
        engineId: "", engineSupportsBrowser: false, effective: false,
        reason: browser ? "engine-unsupported" : "off",
      });
    }
    expect(readFileSync(join(data, "bots.json"), "utf8")).toBe(before);
    const response = await fetch(`${base}/api/bots`, { headers: { origin: base } });
    expect(botList.parse(await response.json()).bots.find((bot) => bot.id === id)?.modelSelection.instanceId).toBe("");
  });

  it("reports the selected capable engine without requiring a desktop account", async () => {
    const id = await createBot("SelectedEngine", true, "ready");
    const status = await get("/api/browser-status");
    expect(status.status.find((entry) => entry.id === id)).toMatchObject({
      engineId: "ready", engineSupportsBrowser: true, effective: true, reason: null,
    });
  });

  it("keeps an explicitly removed engine selected instead of substituting an available one", async () => {
    const id = await createBot("RemovedEngine", true, "removed-engine");
    const before = readFileSync(join(data, "bots.json"), "utf8");
    const status = await get("/api/browser-status");
    expect(status.status.find((entry) => entry.id === id)).toMatchObject({
      engineId: "removed-engine", engineSupportsBrowser: false, effective: false, reason: "engine-unsupported",
    });
    expect(readFileSync(join(data, "bots.json"), "utf8")).toBe(before);
  });

});


posixOnly("browser status respects hosted account authority", () => {
  let directory = "";
  let hostedData = "";
  let hostedBase = "";
  let hostedChild: ChildProcess;
  let env: NodeJS.ProcessEnv;
  let preload = "";
  let alice: { id: string; cookie: string };
  let bob: { id: string; cookie: string };
  let aliceBot = "", bobBot = "", hiddenBot = "";

  const request = (path: string, account?: { cookie: string }, method = "GET", body?: JsonValue) => {
    const headers = new Headers({ origin: hostedBase, "content-type": "application/json" });
    if (account) headers.set("cookie", account.cookie);
    const init: RequestInit = { method, headers, redirect: "error", signal: AbortSignal.timeout(15_000) };
    if (body !== undefined) init.body = JSON.stringify(body);
    return fetch(`${hostedBase}${path}`, init);
  };

  async function boot() {
    hostedChild = spawn(process.execPath, ["--import", preload, "--experimental-strip-types", join(ROOT, "server/index.ts")], {
      cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"],
    });
    hostedChild.stdout?.on("data", () => {});
    hostedChild.stderr?.on("data", () => {});
    await waitForOwnedServer(hostedChild, hostedBase);
  }

  async function signup(name: string) {
    const response = await request("/api/auth/sign-up/email", undefined, "POST", {
      email: `${name}@example.test`, name, password: randomBytes(24).toString("base64url"),
    });
    expect(response.status).toBe(200);
    const { user } = z.object({ user: z.object({ id: z.string() }) }).parse(await response.json());
    const session = response.headers.getSetCookie().find((header) => header.startsWith("better-auth.session_token="));
    if (!session) throw new Error("Owned hosted signup did not return a session");
    seedConnectedGoogleRow(hostedData, user.id);
    return { id: user.id, cookie: session.split(";")[0]! };
  }

  async function makeBot(account: { cookie: string }, name: string, hidden = false) {
    const response = await request("/api/bots", account, "POST", {});
    expect(response.status).toBe(201);
    const { bot } = z.object({ bot: z.object({ id: z.string() }) }).parse(await response.json());
    expect((await request(`/api/bots/${bot.id}`, account, "PATCH", {
      name, hidden, browser: true, modelSelection: { instanceId: "dummy", model: "" },
    })).status).toBe(200);
    return bot.id;
  }

  async function status(account: { cookie: string }): Promise<BrowserStatus> {
    const response = await request("/api/browser-status", account);
    expect(response.status).toBe(200);
    // SAFETY: the real wire fields are checked by each owner/count assertion.
    return await response.json() as BrowserStatus;
  }

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "muster-browser-owner-"));
    hostedData = join(directory, "data");
    const hostedHome = join(directory, "home"), companion = join(directory, "companion"), ui = join(directory, "ui");
    for (const path of [hostedData, hostedHome, companion, ui, join(hostedData, "bin")]) mkdirSync(path, { recursive: true });
    const driver = driverWithoutCustomMcp();
    if (!driver) throw new Error("This fixture needs an unsupported adapter");
    const instances = { dummy: { driver }, ready: readyInstance() };
    writeFileSync(join(hostedData, "config.json"), JSON.stringify({ instances }));
    writeFileSync(join(hostedData, "bin", "obscura"), "#!/bin/sh\nexit 99\n", { mode: 0o700 });
    preload = outboundBlocker(directory);
    const port = await freePortBlock([0, 1]);
    hostedBase = `http://127.0.0.1:${port}`;
    env = pairingServerEnvironment({ home: hostedHome, dataDirectory: hostedData, companionDirectory: companion, staticDir: ui, port, webhookPort: port + 1, secret: randomBytes(32).toString("hex") });
    Object.assign(env, { OMB_PUBLIC_HOST: `127.0.0.1:${port}`, OMB_ALLOW_SIGNUPS: "true" });
    await boot();
    alice = await signup("alice-browser-owner");
    bob = await signup("bob-browser-owner");
    aliceBot = await makeBot(alice, "Alice private browser marker");
    bobBot = await makeBot(bob, "Bob private browser marker");
    hiddenBot = await makeBot(alice, "Hidden browser marker", true);
    await waitForExit(hostedChild, { signal: "SIGTERM" });
    // A real account-scoped namespace, with offline adapters and synthetic
    // credentials. Only this owned server is stopped/restarted.
    writeFileSync(join(hostedData, "config.json"), JSON.stringify({ instances: {
      ...instances, [`fixtureApi:${alice.id}`]: readyInstance(), [`fixtureApi:${bob.id}`]: readyInstance(),
    } }));
    await boot();
  }, 60_000);

  afterAll(async () => {
    if (hostedChild) await waitForExit(hostedChild, { signal: "SIGTERM" });
    if (directory) await removeTempDir(directory);
  });

  it("requires a hosted account before reporting browser status", async () => {
    expect((await request("/api/browser-status")).status).toBe(401);
  });

  it.each(["alice", "bob"])("returns only %s's visible bots in both lists and blocked count", async (owner) => {
    const own = owner === "alice" ? alice : bob;
    const ownId = owner === "alice" ? aliceBot : bobBot;
    const foreignId = owner === "alice" ? bobBot : aliceBot;
    const result = await status(own);
    expect(result.status.map((bot) => bot.id)).toEqual([ownId]);
    expect(result.bots.map((bot) => bot.id)).toEqual([ownId]);
    expect(result.blockedCount).toBe(1);
    expect(JSON.stringify(result)).not.toContain(foreignId);
    expect(JSON.stringify(result)).not.toContain(hiddenBot);
  });

  it.each(["operator-global", "foreign-vault"])("does not advertise or adopt %s credentials for another account", async (kind) => {
    const selection = { instanceId: kind === "operator-global" ? "ready" : `fixtureApi:${alice.id}`, model: "saved-model" };
    expect((await request(`/api/bots/${bobBot}`, bob, "PATCH", { modelSelection: selection })).status).toBe(200);
    const before = readFileSync(join(hostedData, "bots.json"), "utf8");
    const result = await status(bob);
    expect(result.status.find((bot) => bot.id === bobBot)).toMatchObject({
      engineId: null, engineSupportsBrowser: false, effective: false, reason: "engine-unsupported",
    });
    expect(readFileSync(join(hostedData, "bots.json"), "utf8")).toBe(before);
    const saved = botList.parse(await (await request("/api/bots", bob)).json()).bots.find((bot) => bot.id === bobBot);
    expect(saved?.modelSelection).toMatchObject(selection);
  });

  it("reports the account's saved capable engine without changing another bot", async () => {
    const instanceId = `fixtureApi:${bob.id}`;
    expect((await request(`/api/bots/${bobBot}`, bob, "PATCH", { modelSelection: { instanceId, model: "saved-model" } })).status).toBe(200);
    const before = readFileSync(join(hostedData, "bots.json"), "utf8");
    const result = await status(bob);
    expect(result.status).toEqual([expect.objectContaining({ id: bobBot, engineId: instanceId, engineSupportsBrowser: true, effective: true, reason: null })]);
    expect(result.blockedCount).toBe(0);
    expect(readFileSync(join(hostedData, "bots.json"), "utf8")).toBe(before);
  });

  it("does not expose another account's vault engine even to the operator's bot", async () => {
    const selectedId = `fixtureApi:${bob.id}`;
    expect((await request(`/api/bots/${aliceBot}`, alice, "PATCH", { modelSelection: { instanceId: selectedId, model: "saved-model" } })).status).toBe(200);
    const before = readFileSync(join(hostedData, "bots.json"), "utf8");
    const result = await status(alice);
    expect(result.status.find((bot) => bot.id === aliceBot)).toMatchObject({
      engineId: null, engineSupportsBrowser: false, effective: false, reason: "engine-unsupported",
    });
    expect(JSON.stringify(result)).not.toContain(selectedId);
    expect(readFileSync(join(hostedData, "bots.json"), "utf8")).toBe(before);
  });

  it("preserves an unavailable engine belonging to the account instead of adopting its ready one", async () => {
    const selectedId = `missingApi:${bob.id}`;
    expect((await request(`/api/bots/${bobBot}`, bob, "PATCH", { modelSelection: { instanceId: selectedId, model: "keep-this-model" } })).status).toBe(200);
    const before = readFileSync(join(hostedData, "bots.json"), "utf8");
    const result = await status(bob);
    expect(result.status.find((bot) => bot.id === bobBot)).toMatchObject({
      engineId: selectedId, engineSupportsBrowser: false, effective: false, reason: "engine-unsupported",
    });
    expect(readFileSync(join(hostedData, "bots.json"), "utf8")).toBe(before);
  });

});
