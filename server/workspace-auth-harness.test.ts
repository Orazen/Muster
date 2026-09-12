// Exercise the real shared-host backup guard with two accounts, and keep
// local export/restore and unpaired Vault behavior. Every file is owned;
// the child preload refuses outbound connections, including provider calls.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { pairingServerEnvironment, waitForOwnedServer } from "../e2e/pairing-harness.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const UNAVAILABLE = {
  code: "WORKSPACE_BACKUP_UNAVAILABLE",
  error: "Workspace backups are available on local desktop installs only for now.",
};
const WORKSPACE_ROUTES = [
  { method: "POST", path: "/api/workspace/export" },
  { method: "POST", path: "/api/workspace/restore" },
  { method: "GET", path: "/api/workspace/drive/url" },
  { method: "POST", path: "/api/workspace/drive/connect" },
  { method: "POST", path: "/api/workspace/drive/push" },
  { method: "POST", path: "/api/workspace/drive/pull" },
  { method: "POST", path: "/api/workspace/google/push" },
  { method: "POST", path: "/api/workspace/google/pull" },
  { method: "POST", path: "/api/workspace/telegram/connect" },
  { method: "POST", path: "/api/workspace/telegram/disconnect" },
  { method: "POST", path: "/api/workspace/telegram/push" },
  { method: "POST", path: "/api/workspace/telegram/pull" },
];
const VAULT_ROUTES = [
  { method: "GET", path: "/api/vault/status" },
  { method: "GET", path: "/api/vault/files" },
  { method: "POST", path: "/api/vault/backup" },
  { method: "POST", path: "/api/vault/drive-sync" },
  { method: "POST", path: "/api/vault/takeout" },
  { method: "POST", path: "/api/vault/restore" },
];
const VAULT_FAMILY_PATHS = ["/api/vault", "/api/vault/", "/api/vault/future/transport", "/api/vault/status/"];
const botSchema = z.object({ id: z.string(), name: z.string() });
const rosterSchema = z.object({ bots: z.array(botSchema), groups: z.array(z.unknown()) });
interface OwnedServer { url: string; dataDirectory: string; networkLog: string; vaultDirectory: string; inputFile: string; outputDirectory: string }
interface Account { cookie: string; id: string; botId: string; botName: string }

describe.skipIf(process.platform === "win32")("workspace backup account boundary over HTTP", () => {
  let rootDirectory: string;
  let shared: OwnedServer;
  let local: OwnedServer;
  let primary: Account;
  let secondary: Account;
  let sharedConfig: string;
  const memoryCanary = randomBytes(24).toString("hex");
  const children: ChildProcess[] = [];
  const ports: number[] = [];
  const servers: OwnedServer[] = [];
  const vaultState = (server: OwnedServer) => ({
    marker: readFileSync(join(server.vaultDirectory, "private-fixture.txt"), "utf8"),
    configExists: existsSync(join(server.vaultDirectory, "config.json")),
    indexExists: existsSync(join(server.vaultDirectory, "index.db")),
    input: readFileSync(server.inputFile, "utf8"),
    outputExists: existsSync(server.outputDirectory),
  });

  const portIsClosed = (port: number): Promise<boolean> => new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(2_000);
    socket.once("connect", () => { socket.destroy(); resolve(false); });
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
    socket.once("error", (error) => { socket.destroy(); resolve("code" in error && error.code === "ECONNREFUSED"); });
  });

  const request = (server: OwnedServer, path: string, method = "GET", body?: string, cookie?: string) => {
    const headers = new Headers({ origin: server.url });
    if (body !== undefined) headers.set("content-type", "application/json");
    if (cookie) headers.set("cookie", cookie);
    const init: RequestInit = { method, headers, redirect: "error", signal: AbortSignal.timeout(10_000) };
    if (body !== undefined && method !== "GET" && method !== "HEAD") init.body = body;
    return fetch(`${server.url}${path}`, init);
  };
  const roster = async (server: OwnedServer, cookie?: string) => {
    const response = await request(server, "/api/bots", "GET", undefined, cookie);
    expect(response.status).toBe(200);
    return rosterSchema.parse(await response.json());
  };

  const boot = async (kind: "shared" | "local", port: number): Promise<OwnedServer> => {
    const directory = join(rootDirectory, kind);
    const dataDirectory = join(directory, "data");
    const home = join(directory, "home");
    const companionDirectory = join(directory, "companion");
    const vaultDirectory = join(directory, "vault");
    const inputFile = join(directory, "owned-input.txt");
    const outputDirectory = join(directory, "restore-output");
    for (const path of [dataDirectory, home, companionDirectory, vaultDirectory]) mkdirSync(path, { recursive: true, mode: 0o700 });
    writeFileSync(inputFile, memoryCanary, { mode: 0o600 });
    // Keep the real Vaultgram integration unpaired: no native index binding
    // or provider is needed to verify routing and preserve local validation.
    writeFileSync(join(vaultDirectory, "private-fixture.txt"), memoryCanary, { mode: 0o600 });
    writeFileSync(join(dataDirectory, "config.json"), JSON.stringify({
      instances: { ghost: { driver: "not-a-real-driver", displayName: "Offline backup fixture" } },
      telegramSync: { botToken: `1234567890:${randomBytes(30).toString("base64url")}`, chatId: 123456, chatLabel: "Fixture only", lastFileId: "fixture-file" },
    }));
    mkdirSync(join(dataDirectory, "memory"), { mode: 0o700 });
    writeFileSync(join(dataDirectory, "memory", "canary.md"), memoryCanary);
    const networkLog = join(directory, "outbound-attempts.txt");
    const preload = join(directory, "block-outbound.mjs");
    writeFileSync(preload, `
import { Socket } from "node:net";
import { appendFileSync } from "node:fs";
const blocked = () => {
  appendFileSync(${JSON.stringify(networkLog)}, "blocked\\n");
  throw new Error("Outbound network disabled in workspace fixture");
};
globalThis.fetch = blocked;
Socket.prototype.connect = blocked;
`);
    const env = pairingServerEnvironment({
      home, dataDirectory, companionDirectory, staticDir: join(rootDirectory, "ui"), port, webhookPort: port + 1,
      secret: randomBytes(32).toString("hex"),
    });
    env.VAULTGRAM_HOME = vaultDirectory;
    if (kind === "shared") {
      // Explicit public-host configuration makes SELF_HOSTED true while the
      // owned listener itself remains confined to loopback.
      env.OMB_PUBLIC_HOST = `127.0.0.1:${port}`;
      env.OMB_ALLOW_SIGNUPS = "true";
    }
    const child = spawn(process.execPath, ["--import", preload, "--experimental-strip-types", join(ROOT, "server/index.ts")], {
      cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", () => {});
    const url = `http://127.0.0.1:${port}`;
    await waitForOwnedServer(child, url);
    const server = { url, dataDirectory, networkLog, vaultDirectory, inputFile, outputDirectory };
    servers.push(server);
    return server;
  };

  const signUp = async (label: string): Promise<Account> => {
    const response = await request(shared, "/api/auth/sign-up/email", "POST", JSON.stringify({
      name: `Backup ${label}`, email: `${label}-${randomBytes(10).toString("hex")}@example.test`,
      password: randomBytes(32).toString("base64url"),
    }));
    expect(response.status).toBe(200);
    const { user } = z.object({ user: z.object({ id: z.string() }) }).parse(await response.json());
    const cookieHeader = response.headers.getSetCookie().find((value) => value.startsWith("better-auth.session_token="));
    if (!cookieHeader) throw new Error("Fixture sign-up returned no session cookie");
    const cookie = cookieHeader.split(";")[0];
    const created = await request(shared, "/api/bots", "POST", JSON.stringify({ name: `Owned by ${label}` }), cookie);
    expect(created.status).toBe(201);
    const { bot } = z.object({ bot: botSchema }).parse(await created.json());
    return { cookie, id: user.id, botId: bot.id, botName: bot.name };
  };

  beforeAll(async () => {
    rootDirectory = mkdtempSync(join(tmpdir(), "muster-workspace-auth-"));
    mkdirSync(join(rootDirectory, "ui"));
    writeFileSync(join(rootDirectory, "ui", "index.html"), "<!doctype html><title>Workspace fixture</title>");
    const port = await freePortBlock([0, 1, 2, 3], 24000, 10000);
    ports.push(port, port + 1, port + 2, port + 3);
    shared = await boot("shared", port);
    local = await boot("local", port + 2);
    primary = await signUp("primary");
    secondary = await signUp("secondary");
    // Confirm the HTTP server really distinguishes these roles, rather than
    // accidentally testing two sessions on a loopback-trusted deployment.
    expect((await request(shared, "/api/instances", "GET", undefined, primary.cookie)).status).toBe(200);
    expect((await request(shared, "/api/instances", "GET", undefined, secondary.cookie)).status).toBe(404);
    sharedConfig = readFileSync(join(shared.dataDirectory, "config.json"), "utf8");
  }, 60_000);

  afterAll(async () => {
    await Promise.all(children.map((child) => waitForExit(child, { signal: "SIGTERM" })));
    const exited = children.every((child) => child.exitCode !== null || child.signalCode !== null);
    const closedPorts = await Promise.all(ports.map(portIsClosed));
    const noOutbound = servers.every((server) => !existsSync(server.networkLog));
    if (rootDirectory && exited) await removeTempDir(rootDirectory);
    const rootRemoved = !rootDirectory || !existsSync(rootDirectory);
    console.info(JSON.stringify({ scope: "workspace and Vault fixture cleanup", children: children.length, exited, ports: ports.length, closedPorts, noOutbound, rootRemoved }));
    expect(exited).toBe(true);
    expect(closedPorts.every(Boolean)).toBe(true);
    expect(noOutbound).toBe(true);
    expect(rootRemoved).toBe(true);
  });

  it("keeps each synthetic account's normal roster isolated", async () => {
    const first = await roster(shared, primary.cookie);
    const second = await roster(shared, secondary.cookie);
    expect(first.bots.some((bot) => bot.id === primary.botId)).toBe(true);
    expect(first.bots.some((bot) => bot.id === secondary.botId)).toBe(false);
    expect(second.bots.some((bot) => bot.id === secondary.botId)).toBe(true);
    expect(second.bots.some((bot) => bot.id === primary.botId)).toBe(false);
    expect(primary.id).not.toBe(secondary.id);
  });

  for (const role of ["primary", "secondary"]) {
    it.each(VAULT_ROUTES)(`denies ${role} $method $path before parsing its body`, async ({ method, path }) => {
      const account = role === "primary" ? primary : secondary;
      const response = await request(shared, path, method, method === "POST" ? "{invalid-json" : undefined, account.cookie);
      expect({ status: response.status, body: await response.json() }).toEqual({ status: 403, body: UNAVAILABLE });
    });
    for (const method of ["GET", "POST"]) {
      it.each(VAULT_FAMILY_PATHS)(`denies ${role} ${method} the whole Vault route family: %s`, async (path) => {
        const account = role === "primary" ? primary : secondary;
        const response = await request(shared, path, method, method === "POST" ? "{invalid-json" : undefined, account.cookie);
        expect({ status: response.status, body: await response.json() }).toEqual({ status: 403, body: UNAVAILABLE });
      });
    }
    it(`does not treat a similar prefix as the Vault family for ${role}`, async () => {
      const account = role === "primary" ? primary : secondary;
      const response = await request(shared, "/api/vault-other/status", "GET", undefined, account.cookie);
      expect(response.status).toBe(404);
    });
    it.each(WORKSPACE_ROUTES)(`denies ${role} $method $path before parsing its body`, async ({ method, path }) => {
      const account = role === "primary" ? primary : secondary;
      const response = await request(shared, path, method, method === "POST" ? "{invalid-json" : undefined, account.cookie);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual(UNAVAILABLE);
    });

    it.each(["/api/workspace", "/api/workspace/", "/api/workspace/future/transport"])(`denies ${role} the whole workspace route family: %s`, async (path) => {
      const account = role === "primary" ? primary : secondary;
      const response = await request(shared, path, "POST", "{invalid-json", account.cookie);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual(UNAVAILABLE);
    });
  }

  it("still requires a hosted session before exposing workspace availability", async () => {
    const response = await request(shared, "/api/workspace/export", "POST", "{invalid-json");
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized: sign in required" });
  });

  it.each([...VAULT_ROUTES, ...VAULT_FAMILY_PATHS.map((path) => ({ method: "POST", path }))])(
    "requires a hosted session before $method $path availability", async ({ method, path }) => {
      const response = await request(shared, path, method, method === "POST" ? "{invalid-json" : undefined);
      expect({ status: response.status, body: await response.json() })
        .toEqual({ status: 401, body: { error: "unauthorized: sign in required" } });
    },
  );

  it("denies well-formed Vault operations without reading or changing owned data or connections", async () => {
    const before = vaultState(shared);
    const beforePrimary = await roster(shared, primary.cookie);
    const beforeSecondary = await roster(shared, secondary.cookie);
    const operations = [
      { path: "/api/vault/backup", body: { localPath: shared.inputFile, vaultPath: "fixture-new.txt" } },
      { path: "/api/vault/drive-sync", body: { clientId: "fixture-client", clientSecret: "fixture-secret", refreshToken: "fixture-refresh" } },
      { path: "/api/vault/takeout", body: { dirPath: shared.vaultDirectory } },
      { path: "/api/vault/restore", body: { vaultPath: "fixture-only.txt", outDir: shared.outputDirectory } },
    ];
    for (const account of [primary, secondary]) for (const operation of operations) {
      const response = await request(shared, operation.path, "POST", JSON.stringify(operation.body), account.cookie);
      expect({ status: response.status, body: await response.json() }).toEqual({ status: 403, body: UNAVAILABLE });
    }
    expect(vaultState(shared)).toEqual(before);
    expect(await roster(shared, primary.cookie)).toEqual(beforePrimary);
    expect(await roster(shared, secondary.cookie)).toEqual(beforeSecondary);
    expect(readFileSync(join(shared.dataDirectory, "config.json"), "utf8")).toBe(sharedConfig);
    expect(readFileSync(join(shared.dataDirectory, "memory", "canary.md"), "utf8")).toBe(memoryCanary);
    expect(existsSync(shared.networkLog)).toBe(false);
  });

  for (const role of ["primary", "secondary"]) {
    it(`limits the ${role} hosted briefing to its bots and omits installation Vault metadata`, async () => {
      const account = role === "primary" ? primary : secondary;
      const other = role === "primary" ? secondary : primary;
      const before = vaultState(shared);
      const response = await request(shared, "/api/briefing", "GET", undefined, account.cookie);
      expect(response.status).toBe(200);
      const { briefing } = z.object({ briefing: z.string() }).parse(await response.json());
      expect({ ownBot: briefing.includes(account.botName), otherBot: briefing.includes(other.botName), vault: briefing.includes("Vault") })
        .toEqual({ ownBot: true, otherBot: false, vault: false });
      expect(vaultState(shared)).toEqual(before);
      expect(existsSync(shared.networkLog)).toBe(false);
    });
  }

  it("keeps the local unpaired briefing's roster and Vault guidance", async () => {
    const before = vaultState(local);
    const response = await request(local, "/api/briefing");
    expect(response.status).toBe(200);
    const { briefing } = z.object({ briefing: z.string() }).parse(await response.json());
    expect(briefing).toContain("Daily brief — ");
    expect(briefing).toContain("Vault is empty — nothing is backed up yet.");
    expect(vaultState(local)).toEqual(before);
    expect(existsSync(local.networkLog)).toBe(false);
  });

  it("requires a hosted session before exposing the briefing", async () => {
    const response = await request(shared, "/api/briefing");
    expect({ status: response.status, body: await response.json() })
      .toEqual({ status: 401, body: { error: "unauthorized: sign in required" } });
  });

  it("preserves actual local unpaired Vault status and file listing", async () => {
    const before = vaultState(local);
    const status = await request(local, "/api/vault/status");
    expect({ status: status.status, body: await status.json() }).toEqual({
      status: 200, body: { paired: false, unlocked: false, fileCount: 0, lastSnapshot: null },
    });
    const files = await request(local, "/api/vault/files");
    expect({ status: files.status, body: await files.json() }).toEqual({ status: 200, body: { files: [] } });
    expect(vaultState(local)).toEqual(before);
  });

  it.each([
    { path: "/api/vault/backup", status: 400, error: "localPath and vaultPath are required" },
    { path: "/api/vault/takeout", status: 400, error: "dirPath is required" },
    { path: "/api/vault/restore", status: 400, error: "vaultPath is required" },
    { path: "/api/vault/drive-sync", status: 500, error: "Vaultgram is not paired" },
  ])("preserves local $path validation without invoking a provider", async ({ path, status, error }) => {
    const response = await request(local, path, "POST", "{}");
    expect({ status: response.status, body: await response.json() }).toEqual({ status, body: { error } });
    expect(existsSync(local.networkLog)).toBe(false);
  });

  it.each(["/api/workspace/drive/push", "/api/workspace/drive/pull"])("preserves local installation Drive validation: %s", async (path) => {
    const response = await request(local, path, "POST", JSON.stringify({ passphrase: "short" }));
    expect({ status: response.status, body: await response.json() })
      .toEqual({ status: 400, body: { error: "passphrase must be at least 8 characters" } });
    expect(existsSync(local.networkLog)).toBe(false);
  });

  it("rejects well-formed request bodies without changing either account, memory or configuration", async () => {
    const beforePrimary = await roster(shared, primary.cookie);
    const beforeSecondary = await roster(shared, secondary.cookie);
    const config = z.object({ telegramSync: z.object({ botToken: z.string() }) }).parse(JSON.parse(sharedConfig));
    for (const account of [primary, secondary]) {
      for (const path of ["/api/workspace/restore", "/api/workspace/telegram/connect", "/api/workspace/telegram/disconnect", "/api/workspace/telegram/push"]) {
        const response = await request(shared, path, "POST", JSON.stringify({
          passphrase: "fixture-passphrase", payload: "malformed-fixture-bundle", botToken: config.telegramSync.botToken,
        }), account.cookie);
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual(UNAVAILABLE);
      }
    }
    expect(await roster(shared, primary.cookie)).toEqual(beforePrimary);
    expect(await roster(shared, secondary.cookie)).toEqual(beforeSecondary);
    expect(readFileSync(join(shared.dataDirectory, "config.json"), "utf8")).toBe(sharedConfig);
    expect(readFileSync(join(shared.dataDirectory, "memory", "canary.md"), "utf8")).toBe(memoryCanary);
    expect(existsSync(shared.networkLog)).toBe(false);
  });

  it("preserves local export and same-install restore with actual restored memory", async () => {
    const before = await roster(local);
    const exported = await request(local, "/api/workspace/export", "POST", JSON.stringify({ passphrase: "fixture-passphrase" }));
    expect(exported.status).toBe(200);
    const { payload } = z.object({ payload: z.string().startsWith("muster-workspace-bundle:1:") }).parse(await exported.json());
    const memoryFile = join(local.dataDirectory, "memory", "canary.md");
    rmSync(memoryFile);
    const restored = await request(local, "/api/workspace/restore", "POST", JSON.stringify({ passphrase: "fixture-passphrase", payload }));
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({ restored: { memoryFilesRestored: 1, skippedExisting: before.bots.length } });
    expect(readFileSync(memoryFile, "utf8")).toBe(memoryCanary);
    expect(await roster(local)).toEqual(before);
    expect(existsSync(local.networkLog)).toBe(false);
  });

  it("keeps local validation errors distinct from the hosted availability guard", async () => {
    const response = await request(local, "/api/workspace/export", "POST", JSON.stringify({ passphrase: "short" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "passphrase must be at least 8 characters" });
  });
});
