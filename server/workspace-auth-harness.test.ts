// Exercise the real shared-host backup guard with two accounts, and keep
// local export/restore and unpaired Vault behavior. Every file is owned;
// the child preload refuses outbound connections, including provider calls.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";
import { request as httpRequest } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { pairingServerEnvironment, waitForOwnedServer } from "../e2e/pairing-harness.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { createWorkspaceDriveFixture, type DriveFixtureMode } from "./testing/workspace-drive-fixture.ts";
import { createDriveState, saveDriveGrant, DRIVE_APPDATA_SCOPE } from "./drive-grants.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const UNAVAILABLE = {
  code: "WORKSPACE_BACKUP_UNAVAILABLE",
  error: "Workspace backups are available on local desktop installs only for now.",
};
const ACCOUNT_DRIVE_UNAVAILABLE = {
  code: "ACCOUNT_DRIVE_UNAVAILABLE",
  error: "Account-linked Google Drive backup is unavailable. Use a Drive connection configured on this computer.",
};
const ACCOUNT_DRIVE_ROUTES = [
  { method: "GET", path: "/api/workspace/google/connect" },
  { method: "GET", path: "/api/workspace/google/callback?code=owned-unused-code&state=owned-unused-state" },
  { method: "POST", path: "/api/workspace/google/push" },
  { method: "POST", path: "/api/workspace/google/pull" },
];
const capability = (hosted: boolean, ready = false) => ({
  capabilityVersion: 1, workspaceBackupAvailable: !hosted,
  unavailableReason: hosted ? UNAVAILABLE.error : null, drive: false,
  installationDrive: { configured: ready, operationsAvailable: ready },
  accountDrive: { available: false, connected: false },
});

type DriveConfiguration = "ready" | "missing-token" | "blank-token" | "missing-id" | "blank-id" | "missing-secret" | "blank-secret" | "padded-client";
interface LocalDriveServer {
  url: string;
  port: number;
  dataDirectory: string;
  memoryFile: string;
  transport: ReturnType<typeof createWorkspaceDriveFixture>;
}

describe.skipIf(process.platform === "win32")("configured local Drive over actual workspace routes", () => {
  let rootDirectory: string;
  let basePort: number;
  const children: ChildProcess[] = [];
  const servers: LocalDriveServer[] = [];
  const memoryCanary = randomBytes(24).toString("hex");
  const passphrase = "owned-workspace-passphrase";
  let local: LocalDriveServer;

  async function boot(configuration: DriveConfiguration): Promise<LocalDriveServer> {
    const directory = join(rootDirectory, configuration);
    const dataDirectory = join(directory, "data");
    const home = join(directory, "home");
    const companionDirectory = join(directory, "companion");
    const vaultDirectory = join(directory, "vault");
    for (const path of [dataDirectory, home, companionDirectory, vaultDirectory, join(dataDirectory, "memory")]) mkdirSync(path, { recursive: true, mode: 0o700 });
    const transport = createWorkspaceDriveFixture(join(directory, "google"));
    const refreshToken = configuration === "missing-token" ? "" : configuration === "blank-token" ? "  " : transport.refreshToken;
    writeFileSync(join(dataDirectory, "config.json"), JSON.stringify({
      instances: { ghost: { driver: "not-a-real-driver", displayName: "Offline backup fixture" } },
      driveSync: { refreshToken },
    }), { mode: 0o600 });
    const memoryFile = join(dataDirectory, "memory", "canary.md");
    writeFileSync(memoryFile, memoryCanary, { mode: 0o600 });
    const port = basePort + servers.length * 2;
    const env = pairingServerEnvironment({ home, dataDirectory, companionDirectory, staticDir: join(rootDirectory, "ui"), port, webhookPort: port + 1, secret: randomBytes(32).toString("hex") });
    Object.assign(env, transport.env);
    env.VAULTGRAM_HOME = vaultDirectory;
    if (configuration === "missing-id") delete env.GOOGLE_CLIENT_ID;
    if (configuration === "blank-id") env.GOOGLE_CLIENT_ID = " \t ";
    if (configuration === "missing-secret") delete env.GOOGLE_CLIENT_SECRET;
    if (configuration === "blank-secret") env.GOOGLE_CLIENT_SECRET = " \t ";
    if (configuration === "padded-client") {
      env.GOOGLE_CLIENT_ID = ` ${transport.env.GOOGLE_CLIENT_ID} `;
      env.GOOGLE_CLIENT_SECRET = ` ${transport.env.GOOGLE_CLIENT_SECRET} `;
    }
    const child = spawn(process.execPath, ["--import", transport.preloadPath, "--experimental-strip-types", join(ROOT, "server/index.ts")], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", () => {});
    const server = { url: `http://127.0.0.1:${port}`, port, dataDirectory, memoryFile, transport };
    // Retain the cleanup identity even if startup fails.
    servers.push(server);
    await waitForOwnedServer(child, server.url);
    seedGoogleAccount(dataDirectory);
    return server;
  }

  const request = (server: LocalDriveServer, path: string, method = "GET", body?: string) => {
    const init: RequestInit = { method, headers: { origin: server.url, "content-type": "application/json" }, redirect: "error", signal: AbortSignal.timeout(10_000) };
    if (method !== "GET" && method !== "HEAD" && body !== undefined) init.body = body;
    return fetch(`${server.url}${path}`, init);
  };
  const send = (operation: "push" | "pull", phrase = passphrase) => request(local, `/api/workspace/drive/${operation}`, "POST", JSON.stringify({ passphrase: phrase }));
  const state = () => ({
    account: accountState(local.dataDirectory),
    config: readFileSync(join(local.dataDirectory, "config.json"), "utf8"),
    memory: existsSync(local.memoryFile) ? readFileSync(local.memoryFile, "utf8") : null,
  });
  const operationsSince = (offset: number) => local.transport.entries().slice(offset).map((entry) => entry.operation);
  const waitForDownload = async () => {
    const deadline = Date.now() + 5_000;
    while (!existsSync(local.transport.heldDownloadPath)) {
      if (Date.now() >= deadline) throw new Error("Owned Drive download did not enter its hold");
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
  };

  beforeAll(async () => {
    rootDirectory = mkdtempSync(join(tmpdir(), "muster-workspace-drive-"));
    mkdirSync(join(rootDirectory, "ui"));
    writeFileSync(join(rootDirectory, "ui", "index.html"), "<!doctype html><title>Owned Drive fixture</title>");
    basePort = await freePortBlock(Array.from({ length: 16 }, (_, i) => i), 34000, 10000);
    local = await boot("ready");
  }, 30_000);

  afterAll(async () => {
    for (const server of servers) server.transport.setMode("ok");
    await Promise.all(children.map((child) => waitForExit(child, { signal: "SIGTERM" })));
    const exited = children.every((child) => child.exitCode !== null || child.signalCode !== null);
    const closedPorts = await Promise.all(servers.flatMap((server) => [server.port, server.port + 1]).map((port) => new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.setTimeout(2_000);
      socket.once("connect", () => { socket.destroy(); resolve(false); });
      socket.once("timeout", () => { socket.destroy(); resolve(false); });
      socket.once("error", (error) => { socket.destroy(); resolve("code" in error && error.code === "ECONNREFUSED"); });
    })));
    const noOutbound = servers.every((server) => !existsSync(server.transport.networkLog));
    const noCredentialMismatch = servers.every((server) => server.transport.entries().every((entry) => entry.credentialsMatch));
    const operations = servers.map((server) => server.transport.entries().map((entry) => entry.operation));
    if (rootDirectory && exited) await removeTempDir(rootDirectory);
    const rootRemoved = !rootDirectory || !existsSync(rootDirectory);
    console.info(JSON.stringify({ scope: "workspace synthetic Google cleanup", pids: children.map((child) => child.pid), children: children.length, exited, ports: closedPorts.length, closedPorts, noOutbound, noCredentialMismatch, operations, rootRemoved }));
    expect({ exited, noOutbound, noCredentialMismatch, rootRemoved }).toEqual({ exited: true, noOutbound: true, noCredentialMismatch: true, rootRemoved: true });
    expect(closedPorts.every(Boolean)).toBe(true);
  }, 20_000);

  it("advertises only the configured installation transport without a logged-in account", async () => {
    const before = state();
    const response = await request(local, "/api/workspace/google/status");
    expect({ status: response.status, body: await response.json() }).toEqual({ status: 200, body: capability(false, true) });
    expect(state()).toEqual(before);
    expect(local.transport.entries()).toEqual([]);
  });

  it.each(ACCOUNT_DRIVE_ROUTES)("does not substitute installation credentials for configured-local account $method $path", async ({ method, path }) => {
    const before = state();
    const offset = local.transport.entries().length;
    // Callback parameters only look like input; with no session they never
    // reach the signed-intent check, the consent exchange or any transport.
    const response = await request(local, path, method, method === "POST" ? JSON.stringify({ passphrase, payload: "owned-unused-payload" }) : undefined);
    expect({ status: response.status, body: await response.json() }).toEqual({ status: 501, body: ACCOUNT_DRIVE_UNAVAILABLE });
    expect(state()).toEqual(before);
    expect(operationsSince(offset)).toEqual([]);
    expect(existsSync(local.transport.networkLog)).toBe(false);
  });

  it.each<DriveConfiguration>(["missing-token", "blank-token", "missing-id", "blank-id", "missing-secret", "blank-secret"])("does not advertise partial configuration: %s", async (configuration) => {
    const server = await boot(configuration);
    const before = accountState(server.dataDirectory);
    const response = await request(server, "/api/workspace/google/status");
    expect({ status: response.status, body: await response.json() }).toEqual({ status: 200, body: capability(false) });
    expect(accountState(server.dataDirectory)).toEqual(before);
    expect(server.transport.entries()).toEqual([]);
    if (configuration !== "blank-token") {
      const pushed = await request(server, "/api/workspace/drive/push", "POST", JSON.stringify({ passphrase }));
      expect({ status: pushed.status, body: await pushed.json() }).toEqual(configuration === "missing-token"
        ? { status: 400, body: { error: "Google Drive is not connected yet" } }
        : { status: 502, body: { error: "Google OAuth is not configured on this deployment" } });
      expect(server.transport.entries()).toEqual([]);
    }
  }, 30_000);

  it("uses trimmed complete client credentials for both readiness and actual refresh", async () => {
    const server = await boot("padded-client");
    const status = await request(server, "/api/workspace/google/status");
    expect(await status.json()).toEqual(capability(false, true));
    const pushed = await request(server, "/api/workspace/drive/push", "POST", JSON.stringify({ passphrase }));
    expect(pushed.status).toBe(200);
    expect(server.transport.entries().map((entry) => entry.operation)).toEqual(["refresh", "list", "upload"]);
    expect(server.transport.entries().every((entry) => entry.credentialsMatch)).toBe(true);
  }, 30_000);

  it("pushes encrypted bytes and restores missing memory with only the installation token", async () => {
    const before = state();
    const offset = local.transport.entries().length;
    const pushStarted = Date.now();
    const pushed = await send("push");
    expect(pushed.status).toBe(200);
    expect(await pushed.json()).toMatchObject({ uploaded: "owned-workspace-file", counts: { memoryFiles: 1 } });
    const pushedState = state();
    const pushStamp = JSON.parse(pushedState.account.stamps.find((stamp) => stamp.name === "local.json")!.contents);
    const previousStamp = JSON.parse(before.account.stamps.find((stamp) => stamp.name === "local.json")!.contents);
    expect(pushStamp.lastPush.at).toBeGreaterThanOrEqual(pushStarted);
    expect(pushStamp.lastPush.at).toBeLessThanOrEqual(Date.now());
    expect(pushStamp.lastPull).toEqual(previousStamp.lastPull);
    expect(pushedState).toEqual({ ...before, account: { ...before.account, stamps: pushedState.account.stamps } });
    expect(pushedState.account.stamps.filter((stamp) => stamp.name !== "local.json")).toEqual(before.account.stamps.filter((stamp) => stamp.name !== "local.json"));
    const payload = readFileSync(local.transport.payloadPath, "utf8");
    expect(payload.startsWith("muster-workspace-bundle:1:")).toBe(true);
    expect(payload.includes(memoryCanary)).toBe(false);
    rmSync(local.memoryFile);
    const pullStarted = Date.now();
    const pulled = await send("pull");
    expect(pulled.status).toBe(200);
    expect(await pulled.json()).toMatchObject({ restored: { memoryFilesRestored: 1 } });
    const after = state();
    const afterLocalState = after.account.stamps.find((stamp) => stamp.name === "local.json")!;
    expect(after.account.accounts).toEqual(before.account.accounts);
    expect(after.account.verification).toEqual(before.account.verification);
    expect(after.config).toEqual(before.config);
    expect(after.memory).toEqual(before.memory);
    expect(after.account.stamps.filter((stamp) => stamp.name !== "local.json")).toEqual(before.account.stamps.filter((stamp) => stamp.name !== "local.json"));
    const pullStamp = JSON.parse(afterLocalState.contents);
    expect(pullStamp.lastPush).toEqual(pushStamp.lastPush);
    expect(pullStamp.lastPull.at).toBeGreaterThanOrEqual(pullStarted);
    expect(pullStamp.lastPull.at).toBeLessThanOrEqual(Date.now());
    expect(pullStamp).toMatchObject({
      lastPull: expect.objectContaining({ channel: "google-drive" }),
      lastPush: expect.objectContaining({ at: expect.any(Number), channel: "google-drive" }),
    });
    expect(operationsSince(offset)).toEqual(["refresh", "list", "upload", "refresh", "list", "download"]);
    expect(local.transport.entries().every((entry) => entry.credentialsMatch)).toBe(true);
  });

  it("preserves newer local memory during a successful pull and updates the same Drive file on push", async () => {
    const before = accountState(local.dataDirectory);
    writeFileSync(local.memoryFile, "owned newer local edit");
    try {
      const pulled = await send("pull");
      expect(pulled.status).toBe(200);
      expect(await pulled.json()).toMatchObject({ restored: { memoryFilesRestored: 0 } });
      expect(readFileSync(local.memoryFile, "utf8")).toBe("owned newer local edit");
      const pushed = await send("push");
      expect(pushed.status).toBe(200);
      expect(await pushed.json()).toMatchObject({ uploaded: "owned-workspace-file" });
      const after = accountState(local.dataDirectory);
      const afterLocalState = after.stamps.find((stamp) => stamp.name === "local.json")!;
      expect(after.accounts).toEqual(before.accounts);
      expect(after.verification).toEqual(before.verification);
      expect(after.stamps.filter((stamp) => stamp.name !== "local.json")).toEqual(before.stamps.filter((stamp) => stamp.name !== "local.json"));
      expect(JSON.parse(afterLocalState.contents)).toMatchObject({
        lastPull: expect.objectContaining({ channel: "google-drive" }),
        lastPush: expect.objectContaining({ at: expect.any(Number), channel: "google-drive" }),
      });
    } finally { writeFileSync(local.memoryFile, memoryCanary); }
    // Restore the actual encrypted fixture bytes used by later failure tests.
    expect((await send("push")).status).toBe(200);
  });

  it.each<{ mode: DriveFixtureMode; operation: "push" | "pull"; status: number; error: string; operations: string[] }>([
    { mode: "refresh-error", operation: "push", status: 502, error: "could not refresh the Drive token — reconnect Google Drive in Settings", operations: ["refresh"] },
    { mode: "list-error", operation: "push", status: 502, error: "Drive list failed: HTTP 503", operations: ["refresh", "list"] },
    { mode: "upload-error", operation: "push", status: 502, error: "Drive upload failed: HTTP 503", operations: ["refresh", "list", "upload"] },
    { mode: "download-error", operation: "pull", status: 400, error: "Drive download failed: HTTP 503", operations: ["refresh", "list", "download"] },
  ])("keeps data and account tokens/stamps unchanged on $mode", async ({ mode, operation, status, error, operations }) => {
    const before = state();
    const payload = readFileSync(local.transport.payloadPath, "utf8");
    const offset = local.transport.entries().length;
    local.transport.setMode(mode);
    try {
      const response = await send(operation);
      expect({ status: response.status, body: await response.json() }).toEqual({ status, body: { error } });
      expect(state()).toEqual(before);
      expect(readFileSync(local.transport.payloadPath, "utf8")).toBe(payload);
      expect(operationsSince(offset)).toEqual(operations);
    } finally { local.transport.setMode("ok"); }
  });

  it.each(["corrupt", "wrong-passphrase"])("does not restore or stamp a %s download", async (failure) => {
    rmSync(local.memoryFile);
    const before = state();
    if (failure === "corrupt") local.transport.setMode("corrupt-download");
    try {
      const response = await send("pull", failure === "wrong-passphrase" ? "wrong-fixture-passphrase" : passphrase);
      expect(response.status).toBe(400);
      expect(z.object({ error: z.string().min(1) }).safeParse(await response.json()).success).toBe(true);
      expect(state()).toEqual(before);
    } finally { local.transport.setMode("ok"); writeFileSync(local.memoryFile, memoryCanary); }
  });

  it("reports an actual local restore filesystem failure without a stamp or account mutation", async () => {
    const before = accountState(local.dataDirectory);
    const memoryDirectory = join(local.dataDirectory, "memory");
    const savedDirectory = join(local.dataDirectory, "owned-memory-before-failure");
    renameSync(memoryDirectory, savedDirectory);
    writeFileSync(memoryDirectory, "owned filesystem blocker");
    try {
      const response = await send("pull");
      expect(response.status).toBe(400);
      expect(z.object({ error: z.string().includes("EEXIST") }).safeParse(await response.json()).success).toBe(true);
      expect(readFileSync(memoryDirectory, "utf8")).toBe("owned filesystem blocker");
      expect(accountState(local.dataDirectory)).toEqual(before);
    } finally { rmSync(memoryDirectory); renameSync(savedDirectory, memoryDirectory); }
  });

  it.each(["host", "origin"])("keeps the local %s request guard before the configured Drive transport", async (header) => {
    const offset = local.transport.entries().length;
    const headers = new Headers({ origin: local.url, "content-type": "application/json" });
    headers.set(header, header === "host" ? "unowned.invalid" : "https://unowned.invalid");
    // Node's fetch rewrites Host from the URL. HTTP's request API preserves
    // this explicit wire header, so the guard sees the attempted host.
    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = httpRequest(`${local.url}/api/workspace/drive/push`, { method: "POST", headers: Object.fromEntries(headers), signal: AbortSignal.timeout(5_000) }, (incoming) => {
        let body = "";
        incoming.setEncoding("utf8");
        incoming.on("data", (chunk) => { body += String(chunk); });
        incoming.once("end", () => resolve({ status: incoming.statusCode ?? 0, body }));
        incoming.once("error", reject);
      });
      request.once("error", reject);
      request.end(JSON.stringify({ passphrase }));
    });
    expect({ status: response.status, body: JSON.parse(response.body) }).toEqual({ status: 403, body: { error: header === "host" ? "forbidden: host not allowed" : "forbidden: cross-origin request" } });
    expect(operationsSince(offset)).toEqual([]);
  });

  it("rejects a changed installation connection after held download without restoring or changing account stamps", async () => {
    rmSync(local.memoryFile);
    const before = accountState(local.dataDirectory);
    local.transport.setMode("hold-download");
    const pending = send("pull");
    try {
      await waitForDownload();
      const changed = await request(local, "/api/config", "PATCH", JSON.stringify({ driveSync: { refreshToken: randomBytes(24).toString("hex") } }));
      expect(changed.status).toBe(200);
      local.transport.setMode("ok");
      const response = await pending;
      expect({ status: response.status, body: await response.json() }).toEqual({ status: 409, body: { error: "Google Drive connection changed during download — check the connection and try again." } });
      expect(existsSync(local.memoryFile)).toBe(false);
      expect(accountState(local.dataDirectory)).toEqual(before);
    } finally {
      local.transport.setMode("ok");
      await pending.catch(() => undefined);
      expect((await request(local, "/api/config", "PATCH", JSON.stringify({ driveSync: { refreshToken: local.transport.refreshToken } }))).status).toBe(200);
      writeFileSync(local.memoryFile, memoryCanary);
    }
  });
});

function seedGoogleAccount(dataDirectory: string, userId = randomBytes(16).toString("hex")): void {
  const db = new DatabaseSync(join(dataDirectory, "auth.db"));
  try {
    const now = new Date().toISOString();
    db.prepare('INSERT OR IGNORE INTO "user" (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?)')
      .run(userId, "Owned backup account", `${userId}@example.test`, 0, now, now);
    db.prepare('INSERT INTO account (id,accountId,providerId,userId,accessToken,refreshToken,scope,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(randomBytes(16).toString("hex"), randomBytes(16).toString("hex"), "google", userId,
        randomBytes(24).toString("hex"), randomBytes(24).toString("hex"), "https://www.googleapis.com/auth/drive.appdata", now, now);
  } finally { db.close(); }
  mkdirSync(join(dataDirectory, "sync-state"), { recursive: true, mode: 0o700 });
  // An existing stamp must neither make capability claims nor be rewritten.
  writeFileSync(join(dataDirectory, "sync-state", "local.json"), JSON.stringify({ lastPush: { at: 123, channel: "google-drive" }, lastPull: null }), { mode: 0o600 });
  writeFileSync(join(dataDirectory, "sync-state", `${userId}.json`), JSON.stringify({ lastPush: null, lastPull: { at: 456, channel: "google-drive" } }), { mode: 0o600 });
}

function accountState(dataDirectory: string) {
  const db = new DatabaseSync(join(dataDirectory, "auth.db"));
  try {
    return {
      accounts: db.prepare("SELECT * FROM account ORDER BY id").all(),
      verification: db.prepare("SELECT * FROM verification ORDER BY id").all(),
      stamps: readdirSync(join(dataDirectory, "sync-state")).sort().map((name) => ({
        name, contents: readFileSync(join(dataDirectory, "sync-state", name), "utf8"),
      })),
    };
  } finally { db.close(); }
}
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
  // Held deliberately WITHOUT an own Drive grant: the capability/status and
  // connect tests assert that a hosted account which has only Google login
  // tokens still reports its Drive as not connected.
  let probePrimary: Account;
  let probeSecondary: Account;
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
      driveSync: kind === "shared" ? { refreshToken: randomBytes(24).toString("hex") } : undefined,
    }));
    mkdirSync(join(dataDirectory, "memory"), { mode: 0o700 });
    writeFileSync(join(dataDirectory, "memory", "canary.md"), memoryCanary);
    const networkLog = join(directory, "outbound-attempts.txt");
    const preload = join(directory, "block-outbound.mjs");
    // The assertions only ever check existence, but the CONTENT now names
    // the attempted target and caller frame — so the next no-outbound
    // failure diagnoses its culprit instead of merely proving one existed.
    writeFileSync(preload, `
import { Socket } from "node:net";
import { appendFileSync } from "node:fs";
const blocked = (first) => {
  const where = String(first?.url ?? first?.host ?? first ?? "?").slice(0, 200);
  const at = String(new Error().stack).split("\\n")[1]?.trim().slice(0, 200) ?? "?";
  appendFileSync(${JSON.stringify(networkLog)}, "blocked " + where + " at " + at + "\\n");
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
    // Loop200: this suite's config deliberately carries a Telegram bot token,
    // which also starts the Telegram CHAT loop (server/index.ts) — a
    // different subsystem that polls getUpdates every 3 seconds. Its first
    // tick then races the suite's no-outbound assertion: on a quiet machine
    // the fixtures exit first and the assertion passes, on a loaded one they
    // live past the tick and a network call this suite never asked for
    // appears. The backup transport under test is unaffected by this flag;
    // only the unsolicited chat poll is switched off, so "no outbound" means
    // the same thing on a fast machine and a slow one.
    env.TELEGRAM_CHANNEL_BOT_ID = "";
    if (kind === "shared") {
      // Explicit public-host configuration makes SELF_HOSTED true while the
      // owned listener itself remains confined to loopback.
      env.OMB_PUBLIC_HOST = `127.0.0.1:${port}`;
      env.OMB_ALLOW_SIGNUPS = "true";
      env.GOOGLE_CLIENT_ID = randomBytes(24).toString("hex");
      env.GOOGLE_CLIENT_SECRET = randomBytes(24).toString("hex");
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

  /** A hosted account may only do durable work once it holds its OWN Drive
   * grant (storage gate, decision 14). This suite is about the backup account
   * boundary, not the gate, and its child process blocks outbound so a real
   * PKCE consent round-trip is impossible here — so the grant is written
   * directly. It used to lean on the deployment-wide telegramSync fixture
   * instead, which is exactly the hole that got closed: a shared channel
   * opened another account's gate. */
  const grantOwnDrive = (userId: string) => {
    const db = new DatabaseSync(join(shared.dataDirectory, "auth.db"));
    try {
      const pending = createDriveState(db, { userId, sessionId: "workspace-auth-fixture" });
      saveDriveGrant(db, {
        userId,
        googleSub: `sub-${userId}`,
        expectedGeneration: pending.generation,
        accessToken: `access-${randomBytes(16).toString("hex")}`,
        refreshToken: `refresh-${randomBytes(16).toString("hex")}`,
        expiresAt: Date.now() + 300_000,
        scopes: [DRIVE_APPDATA_SCOPE],
      });
    } finally {
      db.close();
    }
  };

  const signUp = async (label: string, options: { grantDrive?: boolean; createBot?: boolean } = {}): Promise<Account> => {
    const response = await request(shared, "/api/auth/sign-up/email", "POST", JSON.stringify({
      name: `Backup ${label}`, email: `${label}-${randomBytes(10).toString("hex")}@example.test`,
      password: randomBytes(32).toString("base64url"),
    }));
    expect(response.status).toBe(200);
    const { user } = z.object({ user: z.object({ id: z.string() }) }).parse(await response.json());
    const cookieHeader = response.headers.getSetCookie().find((value) => value.startsWith("better-auth.session_token="));
    if (!cookieHeader) throw new Error("Fixture sign-up returned no session cookie");
    const cookie = cookieHeader.split(";")[0];
    if (options.grantDrive !== false) grantOwnDrive(user.id);
    if (options.createBot === false) return { cookie, id: user.id, botId: "", botName: "" };
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
    // No Drive grant and no bot: these exist only so the capability, status
    // and connect tests can observe an account that has Google login tokens
    // but has never given explicit Drive consent.
    probePrimary = await signUp("probe-primary", { grantDrive: false, createBot: false });
    probeSecondary = await signUp("probe-secondary", { grantDrive: false, createBot: false });
    seedGoogleAccount(shared.dataDirectory, primary.id);
    seedGoogleAccount(shared.dataDirectory, secondary.id);
    seedGoogleAccount(local.dataDirectory);
    // Confirm the HTTP server really distinguishes these roles, rather than
    // accidentally testing two sessions on a loopback-trusted deployment.
    // /api/instances proves it: primary sees the operator fleet; secondary
    // gets 200 but ONLY their own per-user engines (never the fleet). A
    // secondary with no vault keys/custom providers sees an empty list.
    expect((await request(shared, "/api/instances", "GET", undefined, primary.cookie)).status).toBe(200);
    const secondaryFleet = z
      .object({ instances: z.array(z.unknown()) })
      .parse(await (await request(shared, "/api/instances", "GET", undefined, secondary.cookie)).json());
    expect(secondaryFleet.instances).toHaveLength(0);
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

  for (const role of ["primary", "secondary"]) {
    it(`returns the exact read-only hosted capability to ${role}`, async () => {
      const before = accountState(shared.dataDirectory);
      const response = await request(shared, "/api/workspace/google/status", "GET", undefined, (role === "primary" ? probePrimary : probeSecondary).cookie);
      // Storage sovereignty (decision 14): a hosted session can connect its
      // OWN Drive, so the capability advertises accountDrive available. This
      // fixture seeds login tokens only; they are not explicit Drive consent.
      // The installation transports stay unavailable behind the wall.
      expect({ status: response.status, body: await response.json() }).toEqual({
        status: 200,
        body: { ...capability(true), accountDrive: { available: true, connected: false } },
      });
      expect(accountState(shared.dataDirectory)).toEqual(before);
      expect(readFileSync(join(shared.dataDirectory, "config.json"), "utf8")).toBe(sharedConfig);
      expect(readFileSync(join(shared.dataDirectory, "memory", "canary.md"), "utf8")).toBe(memoryCanary);
      expect(existsSync(shared.networkLog)).toBe(false);
    });
    it(`tells ${role} whether it administers the deployment, so People can be hidden`, async () => {
      // The 403 on /api/people is permanent for a non-operator, so the UI
      // hides the section rather than opening one that can only error. That
      // needs the server to say which case the reader is, per request.
      // `primary` is signed up first in this harness, which makes it the
      // deployment operator by creation order; `secondary` is not. The
      // probe accounts are later signups, so they are non-operators too.
      const expected = new Map<Account, boolean>([[primary, true], [secondary, false], [probePrimary, false], [probeSecondary, false]]);
      const account = role === "primary" ? probePrimary : probeSecondary;
      const response = await request(shared, "/api/config", "GET", undefined, account.cookie);
      expect(response.status).toBe(200);
      const { isOperator } = z.object({ isOperator: z.boolean() }).parse(await response.json());
      expect(isOperator).toBe(expected.get(account));
    });
    it("tells the deployment operator the same thing as its own role claims", async () => {
      // The operator must not be locked out of its own People list by the
      // same gate that hides it from everyone else.
      const { isOperator } = z.object({ isOperator: z.boolean() })
        .parse(await (await request(shared, "/api/config", "GET", undefined, primary.cookie)).json());
      expect(isOperator).toBe(true);
      expect((await request(shared, "/api/people", "GET", undefined, primary.cookie)).status).toBe(200);
      // and the account the gate exists for is refused both ways
      expect((await request(shared, "/api/people", "GET", undefined, secondary.cookie)).status).toBe(403);
    });
    it(`offers ${role} the hosted Drive connect without touching any token state`, async () => {
      const before = accountState(shared.dataDirectory);
      const response = await request(shared, "/api/workspace/google/connect", "GET", undefined, (role === "primary" ? probePrimary : probeSecondary).cookie);
      expect(response.status).toBe(200);
      const { url } = z.object({ url: z.string() }).parse(await response.json());
      expect(url).toContain("accounts.google.com");
      expect(url).toContain("drive.appdata");
      expect(accountState(shared.dataDirectory)).toEqual(before);
      expect(existsSync(shared.networkLog)).toBe(false);
    });
    it.each([
      { method: "GET", path: "/api/workspace/google/callback?code=owned-unused-code&state=owned-unused-state" },
    ])(`answers ${role} $method $path with a redirect that carries no state change`, async ({ method, path }) => {
      // The state is not one this server signed, so the callback refuses the
      // exchange and answers with a redirect — fetch in `error` redirect mode
      // is the proof a redirect was served, and the seeded token rows must be
      // byte-identical afterwards. The outbound block guarantees no real
      // Google call is even attempted.
      const before = accountState(shared.dataDirectory);
      await expect(fetch(`${shared.url}${path}`, {
        method, redirect: "error", signal: AbortSignal.timeout(10_000),
        headers: { origin: shared.url, cookie: (role === "primary" ? primary : secondary).cookie },
      })).rejects.toThrow();
      expect(accountState(shared.dataDirectory)).toEqual(before);
      expect(existsSync(shared.networkLog)).toBe(false);
    });
    it.each(ACCOUNT_DRIVE_ROUTES.filter((r) => r.path.startsWith("/api/workspace/google/push") || r.path.startsWith("/api/workspace/google/pull")))(
      `still denies ${role} account transport $method $path`, async ({ method, path }) => {
        const before = accountState(shared.dataDirectory);
        const response = await request(shared, path, method, method === "POST" ? '{"passphrase":"fixture-passphrase"}' : undefined, (role === "primary" ? primary : secondary).cookie);
        expect({ status: response.status, body: await response.json() }).toEqual({ status: 403, body: UNAVAILABLE });
        expect(accountState(shared.dataDirectory)).toEqual(before);
        expect(existsSync(shared.networkLog)).toBe(false);
      });
  }

  it.each([{ method: "GET", path: "/api/workspace/google/status" }, ...ACCOUNT_DRIVE_ROUTES])("requires hosted authentication for $method $path", async ({ method, path }) => {
    const response = await request(shared, path, method, method === "POST" ? "{invalid-json" : undefined);
    expect({ status: response.status, body: await response.json() }).toEqual({ status: 401, body: { error: "unauthorized: sign in required" } });
  });

  it.each([
    { method: "POST", path: "/api/workspace/google/status" },
    { method: "PUT", path: "/api/workspace/google/status" },
    { method: "GET", path: "/api/workspace/google/status/" },
    { method: "GET", path: "/api/workspace/google/status-extra" },
  ])("does not widen the exact capability exception to $method $path", async ({ method, path }) => {
    const response = await request(shared, path, method, method !== "GET" ? "{invalid-json" : undefined, primary.cookie);
    expect({ status: response.status, body: await response.json() }).toEqual({ status: 403, body: UNAVAILABLE });
    expect((await request(local, path, method, method !== "GET" ? "{invalid-json" : undefined)).status).toBe(404);
  });

  it("reports local file backup without treating an account Google token as an installation connection", async () => {
    const before = accountState(local.dataDirectory);
    const response = await request(local, "/api/workspace/google/status");
    expect({ status: response.status, body: await response.json() }).toEqual({ status: 200, body: capability(false) });
    expect(accountState(local.dataDirectory)).toEqual(before);
    expect(existsSync(local.networkLog)).toBe(false);
  });

  for (const body of ["{invalid-json", '{"passphrase":"fixture-passphrase","payload":"owned-unused-payload"}']) {
    it.each(ACCOUNT_DRIVE_ROUTES)(`contains local account $method $path before ${body.startsWith("{invalid") ? "invalid" : "valid"} input and session handling`, async ({ method, path }) => {
      const before = accountState(local.dataDirectory);
      const config = readFileSync(join(local.dataDirectory, "config.json"), "utf8");
      const response = await request(local, path, method, method === "POST" ? body : undefined);
      expect({ status: response.status, body: await response.json() }).toEqual({ status: 501, body: ACCOUNT_DRIVE_UNAVAILABLE });
      expect(accountState(local.dataDirectory)).toEqual(before);
      expect(readFileSync(join(local.dataDirectory, "config.json"), "utf8")).toBe(config);
      expect(readFileSync(join(local.dataDirectory, "memory", "canary.md"), "utf8")).toBe(memoryCanary);
      expect(existsSync(local.networkLog)).toBe(false);
    });
  }
});
