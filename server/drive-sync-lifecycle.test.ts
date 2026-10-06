import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { request as httpRequest } from "node:http";
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { pairingServerEnvironment, waitForOwnedServer } from "../e2e/pairing-harness.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { syncChangeRows } from "./sync-journal.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const passphrase = "owned-drive-lifecycle-passphrase";
const syntheticRefreshToken = randomBytes(24).toString("hex");
const syntheticAccessToken = randomBytes(24).toString("hex");
const syntheticClientId = randomBytes(24).toString("hex");
const syntheticClientSecret = randomBytes(24).toString("hex");
const syntheticAccountToken = randomBytes(24).toString("hex");
const userId = `drive-lifecycle-${randomBytes(10).toString("hex")}`;
const userSession = randomBytes(24).toString("hex");
const lifecycleConfigSchema = z.object({
  driveSync: z.object({ refreshToken: z.string().optional(), accessToken: z.string().optional(), expiresAt: z.number().optional() }).optional(),
  driveSyncGeneration: z.number().optional(),
  providers: z.object({ xai: z.object({ apiKey: z.string().optional() }).optional() }).optional(),
  telegramSync: z.object({ botToken: z.string().optional(), chatId: z.number().optional(), chatLabel: z.string().optional() }).optional(),
});
const transportEventSchema = z.object({ operation: z.string() });
const remoteFilesSchema = z.record(z.string(), z.object({ id: z.string(), payload: z.string() }));
const rosterSchema = z.object({ bots: z.array(z.object({ id: z.string() })).min(1) }).passthrough();

interface DriveLifecycleFixture {
  directory: string;
  controlPath: string;
  filesPath: string;
  logPath: string;
  refreshToken: string;
  accessToken: string;
}

interface CancellableRequest {
  abort(): void;
  done: Promise<void>;
}

const preloadSource = String.raw`
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { Socket } from "node:net";
import { ProviderRegistry } from ${JSON.stringify(new URL("./harness/registry.ts", import.meta.url).href)};
import { DriveSyncInvalidatedError } from ${JSON.stringify(new URL("./drive-sync.ts", import.meta.url).href)};

const fixturePath = process.env.MUSTER_DRIVE_LIFECYCLE_FIXTURE;
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
const controlPath = fixture.controlPath;
const logPath = fixture.logPath;
const filesPath = fixture.filesPath;
const markerPath = (name) => fixture.directory + "/" + name + ".held";
const readControl = () => JSON.parse(readFileSync(controlPath, "utf8")).mode;
const loadProviders = ProviderRegistry.prototype.load;
ProviderRegistry.prototype.load = async function (configs) {
  await loadProviders.call(this, configs);
  if (readControl() === "provider-reload-lifecycle-error") throw new DriveSyncInvalidatedError("Owned provider reload lifecycle invalidation");
  if (readControl() === "provider-reload-error") throw new Error("Owned provider reload failure");
};
const readFiles = () => existsSync(filesPath) ? JSON.parse(readFileSync(filesPath, "utf8")) : {};
const writeFiles = (files) => writeFileSync(filesPath, JSON.stringify(files), { mode: 0o600 });
const log = (row) => appendFileSync(logPath, JSON.stringify(row) + "\n", { mode: 0o600 });
const noteAbort = (request, name) => {
  const mark = () => writeFileSync(markerPath(name + "-cancelled"), "cancelled", { mode: 0o600 });
  if (request.signal.aborted) mark();
  else request.signal.addEventListener("abort", mark, { once: true });
};
const held = async (mode, marker) => {
  if (readControl() !== mode) return;
  writeFileSync(markerPath(marker), "held", { mode: 0o600 });
  const deadline = Date.now() + 20_000;
  try {
    while (readControl() === mode) {
      if (Date.now() >= deadline) throw new Error("owned " + mode + " hold expired");
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  } finally {
    rmSync(markerPath(marker), { force: true });
  }
};

Socket.prototype.connect = function () {
  log({ operation: "blocked-network" });
  throw new Error("Outbound network is disabled in the owned Drive lifecycle fixture");
};

globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const mode = readControl();
  if (url.origin === "https://ascii.dev" && url.pathname === "/api/box/v1/boxes") {
    log({ operation: "config-verify" });
    await held("hold-config-verify", "config-verify");
    return new Response("{}", { status: 200 });
  }
  if (url.origin === "https://opencode.ai" && url.pathname === "/zen/go/v1/models") {
    log({ operation: "provider-reload" });
    await held("hold-provider-reload", "provider-reload");
    return Response.json({ data: [{ id: "minimax-m3" }] });
  }
  if (url.origin === "https://oauth2.googleapis.com" && url.pathname === "/token") {
    const body = new URLSearchParams(await request.text());
    const operation = body.get("grant_type") === "authorization_code" ? "exchange" : "refresh";
    log({ operation, grantType: body.get("grant_type") });
    noteAbort(request, operation);
    await held("hold-" + operation, operation);
    if (mode === "refresh-error" && operation === "refresh") return Response.json({ error: "synthetic refresh failure" }, { status: 503 });
    // Deliberately return even if the caller's signal was aborted. This models
    // a provider response already in flight and proves the server's post-await
    // generation check, not just transport cancellation.
    return Response.json({ access_token: fixture.accessToken, refresh_token: fixture.refreshToken, expires_in: 3600 });
  }
  if (url.origin !== "https://www.googleapis.com") {
    if (/revoke/i.test(request.url)) {
      log({ operation: "google-revoke" });
      return new Response(null, { status: 200 });
    }
    log({ operation: "blocked-network", url: request.url });
    throw new Error("Unexpected outbound request in the owned Drive lifecycle fixture");
  }

  const authorized = request.headers.get("authorization") === "Bearer " + fixture.accessToken;
  if (url.pathname === "/drive/v3/files" && request.method === "GET") {
    const query = url.searchParams.get("q") ?? "";
    const name = query.match(/name = '([^']+)'/)?.[1] ?? "";
    log({ operation: "list", name, authorized });
    noteAbort(request, name === "muster-manifest.json" ? "sync-list" : "list");
    if (mode === "hold-sync-list" && name === "muster-manifest.json") await held(mode, "sync-list");
    const file = Object.values(readFiles()).find((entry) => entry.name === name);
    const fields = url.searchParams.get("fields") ?? "";
    const row = file ? (fields.includes("modifiedTime")
      ? { id: file.id, modifiedTime: file.modifiedTime }
      : { id: file.id }) : null;
    return Response.json({ files: row ? [row] : [] });
  }

  if (url.pathname.startsWith("/upload/drive/v3/files") && (request.method === "POST" || request.method === "PATCH")) {
    log({ operation: "upload", authorized });
    noteAbort(request, "upload");
    await held("hold-upload", "upload");
    try {
      request.signal.throwIfAborted();
      const contentType = request.headers.get("content-type") ?? "";
      const boundary = contentType.match(/^multipart\/related; boundary=(.+)$/)?.[1];
      if (!boundary) throw new Error("Synthetic Drive expected the real multipart upload body");
      const parts = (await request.text()).split("--" + boundary);
      const metadataPart = parts.find((part) => part.includes("Content-Type: application/json"));
      const payloadPart = parts.find((part) => part.startsWith("\r\nContent-Type: application/octet-stream\r\n\r\n"));
      if (!metadataPart || !payloadPart) throw new Error("Synthetic Drive upload body is incomplete");
      const metadata = JSON.parse(metadataPart.slice(metadataPart.indexOf("\r\n\r\n") + 4).trim());
      const payload = payloadPart.slice("\r\nContent-Type: application/octet-stream\r\n\r\n".length, -2);
      const files = readFiles();
      const existingId = request.method === "PATCH" ? decodeURIComponent(url.pathname.split("/").at(-1) ?? "") : "";
      const id = existingId || "owned-" + randomBytes(8).toString("hex");
      files[metadata.name] = { id, name: metadata.name, payload, modifiedTime: new Date().toISOString() };
      writeFiles(files);
      const response = { id, ...(url.searchParams.get("fields")?.includes("name") ? { name: metadata.name } : {}) };
      writeFileSync(markerPath("upload-settled"), "settled", { mode: 0o600 });
      return Response.json(response);
    } catch (error) {
      writeFileSync(markerPath("upload-settled"), "settled", { mode: 0o600 });
      throw error;
    }
  }

  if (url.pathname.startsWith("/drive/v3/files/") && url.search === "?alt=media" && request.method === "GET") {
    log({ operation: "download", authorized });
    noteAbort(request, "download");
    await held("hold-download", "download");
    const id = decodeURIComponent(url.pathname.slice("/drive/v3/files/".length));
    const file = Object.values(readFiles()).find((entry) => entry.id === id);
    return file ? new Response(file.payload) : Response.json({ error: "not found" }, { status: 404 });
  }
  log({ operation: "blocked-network", url: request.url });
  throw new Error("Unexpected synthetic Drive request: " + request.method + " " + request.url);
};
`;

const implicitLifecycleSource = String.raw`
import { Socket } from "node:net";
import { saveConfig, disconnectDriveSync, DATA_DIR } from ${JSON.stringify(new URL("./config.ts", import.meta.url).href)};
import * as drive from ${JSON.stringify(new URL("./drive-sync.ts", import.meta.url).href)};
import { runNightlySnapshot, overrideSnapshotPassphraseStore } from ${JSON.stringify(new URL("./snapshot-runner.ts", import.meta.url).href)};
import { readSnapshotState } from ${JSON.stringify(new URL("./snapshot-state.ts", import.meta.url).href)};
import { readSyncState } from ${JSON.stringify(new URL("./sync-state.ts", import.meta.url).href)};

Socket.prototype.connect = function () { throw new Error("Outbound network is disabled in the owned implicit lifecycle fixture"); };
const scenario = process.argv[2];
const refreshToken = "owned-implicit-refresh";
const accessToken = "owned-implicit-access";
const events = [];
let invalidateBody = false;
let activeHelper = "";
let snapshotPayload = "";
const disconnect = () => disconnectDriveSync();
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  events.push({ path: url.pathname, method: request.method });
  if (url.origin === "https://oauth2.googleapis.com" && url.pathname === "/token") {
    return Response.json({ access_token: accessToken, refresh_token: refreshToken, expires_in: 3600 });
  }
  let response;
  if (url.pathname.startsWith("/upload/drive/v3/files")) {
    if (scenario === "nightly") {
      const body = await request.text();
      snapshotPayload = body.split("Content-Type: application/octet-stream\r\n\r\n")[1].split("\r\n--")[0];
      disconnect();
    }
    response = Response.json({ id: "owned-file", name: "muster-workspace-v2-1000-owned.enc" });
  } else if (url.searchParams.get("alt") === "media") {
    response = new Response(snapshotPayload || "owned download bytes");
  } else if (request.method === "DELETE") {
    response = new Response(null, { status: 204 });
  } else {
    const fields = url.searchParams.get("fields") ?? "";
    const files = fields.includes("createdTime") ? [] : fields.includes("modifiedTime")
      ? [{ id: "owned-file", modifiedTime: "owned-time" }] : [{ id: "owned-file" }];
    response = Response.json({ files });
  }
  for (const method of ["json", "text"]) {
    const read = response[method].bind(response);
    response[method] = async () => {
      const body = await read();
      const delayedMethod = scenario === "text-body" ? "text" : "json";
      const targetResponse = activeHelper !== "uploadBundle" || url.pathname.startsWith("/upload/drive/v3/files");
      if (invalidateBody && method === delayedMethod && targetResponse) {
        await Promise.resolve();
        disconnect();
      }
      return body;
    };
  }
  return response;
};
const configuredToken = async () => {
  saveConfig({ driveSync: { refreshToken } });
  return (await drive.refreshDriveToken(refreshToken)).accessToken;
};
const helpers = {
  uploadBundle: (token, guard) => drive.uploadBundle(token, "owned encrypted bytes", undefined, guard),
  findBundleFile: (token, guard) => drive.findBundleFile(token, undefined, guard),
  downloadBundle: (token, guard) => drive.downloadBundle(token, undefined, guard),
  statBundleFile: (token, guard) => drive.statBundleFile(token, undefined, guard),
  listSnapshots: (token, guard) => drive.listSnapshots(token, guard),
  uploadSnapshot: (token, guard) => drive.uploadSnapshot(token, "owned encrypted bytes", guard),
  downloadSnapshot: (token, guard) => drive.downloadSnapshot(token, "owned-file", guard),
  deleteSnapshot: (token, guard) => drive.deleteSnapshot(token, "owned-file", guard),
  downloadLatestSnapshot: (token, guard) => drive.downloadLatestSnapshot(token, guard),
};
const results = [];
if (scenario === "nightly") {
  saveConfig({ driveSync: { refreshToken } });
  overrideSnapshotPassphraseStore({ status: () => "available", get: async () => "owned-nightly-passphrase", getSync: () => "owned-nightly-passphrase", has: async () => true, set: async () => true, clear: async () => true });
  const run = await runNightlySnapshot();
  console.log(JSON.stringify({ run, health: readSnapshotState().health, sync: readSyncState("local"), operations: events.map((event) => event.method + " " + event.path), dataDir: DATA_DIR }));
} else if (scenario === "explicit") {
  const token = await configuredToken();
  disconnect();
  let guards = 0;
  await drive.uploadBundle(token, "owned independent account bytes", undefined, async () => { guards += 1; });
  console.log(JSON.stringify({ guards, requests: events.length }));
} else {
  const names = scenario === "json-body" ? ["uploadBundle", "findBundleFile", "statBundleFile", "listSnapshots", "uploadSnapshot"]
    : scenario === "text-body" ? ["downloadBundle", "downloadSnapshot"] : Object.keys(helpers);
  for (const name of names) {
    activeHelper = name;
    const token = await configuredToken();
    const before = events.length;
    invalidateBody = scenario.endsWith("-body");
    if (!invalidateBody) disconnect();
    try {
      await helpers[name](token);
      results.push({ name, invalidated: false, requests: events.length - before });
    } catch (error) {
      results.push({ name, invalidated: error instanceof drive.DriveSyncInvalidatedError, requests: events.length - before });
    }
    invalidateBody = false;
  }
  console.log(JSON.stringify({ results }));
}
`;

describe.skipIf(process.platform === "win32")("legacy per-install Drive disconnect lifecycle over a booted server", () => {
  let rootDirectory: string;
  let dataDirectory: string;
  let port: number;
  let url: string;
  let child: ChildProcess;
  let fixture: DriveLifecycleFixture;
  const localMemory = () => join(dataDirectory, "memory", "disconnect-canary.md");
  const configPath = () => join(dataDirectory, "config.json");
  const authPath = () => join(dataDirectory, "auth.db");

  async function request(path: string, method = "GET", body?: string): Promise<Response> {
    const init: RequestInit = {
      method,
      headers: { origin: url, "content-type": "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    };
    if (body !== undefined) init.body = body;
    return fetch(`${url}${path}`, init);
  }

  function setMode(mode: string): void {
    writeFileSync(fixture.controlPath, JSON.stringify({ mode }), { mode: 0o600 });
  }

  function clearMarker(name: string): void {
    rmSync(join(fixture.directory, `${name}.held`), { force: true });
  }

  async function waitForMarker(name: string): Promise<void> {
    const marker = join(fixture.directory, `${name}.held`);
    const deadline = Date.now() + 5_000;
    while (!existsSync(marker)) {
      if (Date.now() >= deadline) throw new Error(`Synthetic Google ${name} operation did not enter its hold`);
      await new Promise<void>((resolve) => setTimeout(resolve, 15));
    }
  }

  function config() {
    return lifecycleConfigSchema.parse(JSON.parse(readFileSync(configPath(), "utf8")));
  }

  function authSnapshot(): Record<string, unknown[]> {
    const db = new DatabaseSync(authPath());
    try {
      const tables = ["user", "session", "account", "drive_grants", "drive_visible_grants", "calendar_grants", "calendar_device_grants"];
      return Object.fromEntries(tables.map((table) => [table, db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()]));
    } finally {
      db.close();
    }
  }

  function journalSnapshot() {
    const db = new DatabaseSync(authPath());
    try {
      return syncChangeRows(db);
    } finally {
      db.close();
    }
  }

  async function postDisconnect(): Promise<Response> {
    return request("/api/workspace/drive/disconnect", "POST", "{}");
  }

  function startCancellableRequest(path: string, body: string): CancellableRequest {
    let outgoing: ReturnType<typeof httpRequest>;
    const done = new Promise<void>((resolve) => {
      outgoing = httpRequest(`${url}${path}`, {
        method: "POST",
        headers: { origin: url, "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      }, (incoming) => {
        incoming.resume();
        incoming.once("end", resolve);
        incoming.once("aborted", resolve);
      });
      outgoing.once("error", resolve);
      outgoing.end(body);
    });
    return { abort: () => outgoing.destroy(), done };
  }

  beforeAll(async () => {
    rootDirectory = mkdtempSync(join(tmpdir(), "muster-drive-disconnect-"));
    const home = join(rootDirectory, "home");
    dataDirectory = join(rootDirectory, "data");
    const companionDirectory = join(rootDirectory, "companion");
    const vaultDirectory = join(rootDirectory, "vault");
    const staticDirectory = join(rootDirectory, "ui");
    fixture = {
      directory: join(rootDirectory, "google"),
      controlPath: join(rootDirectory, "google", "control.json"),
      filesPath: join(rootDirectory, "google", "files.json"),
      logPath: join(rootDirectory, "google", "transport.jsonl"),
      refreshToken: syntheticRefreshToken,
      accessToken: syntheticAccessToken,
    };
    for (const path of [home, dataDirectory, companionDirectory, vaultDirectory, join(dataDirectory, "memory"), staticDirectory, fixture.directory]) {
      mkdirSync(path, { recursive: true, mode: 0o700 });
    }
    writeFileSync(join(staticDirectory, "index.html"), "<!doctype html><title>Owned Drive lifecycle</title>");
    writeFileSync(fixture.controlPath, JSON.stringify({ mode: "ok" }), { mode: 0o600 });
    writeFileSync(fixture.filesPath, "{}", { mode: 0o600 });
    writeFileSync(fixture.logPath, "", { mode: 0o600 });
    writeFileSync(join(rootDirectory, "drive-fetch-preload.mjs"), preloadSource, { mode: 0o600 });
    writeFileSync(configPath(), JSON.stringify({
      driveSync: { refreshToken: fixture.refreshToken, accessToken: fixture.accessToken, expiresAt: Date.now() + 60_000 },
      providers: { xai: { apiKey: randomBytes(24).toString("hex") } },
      telegramSync: { botToken: randomBytes(24).toString("hex"), chatId: 7, chatLabel: "retained chat" },
    }), { mode: 0o600 });
    writeFileSync(localMemory(), "legacy Drive lifecycle canary", { mode: 0o600 });
    mkdirSync(join(dataDirectory, "backups"), { recursive: true, mode: 0o700 });
    writeFileSync(join(dataDirectory, "backups", "retained-local.enc"), "owned retained backup bytes", { mode: 0o600 });

    port = await freePortBlock([0, 1], 34000, 10_000);
    url = `http://127.0.0.1:${port}`;
    const env = pairingServerEnvironment({
      home,
      dataDirectory,
      companionDirectory,
      staticDir: staticDirectory,
      port,
      webhookPort: port + 1,
      secret: randomBytes(32).toString("hex"),
    });
    env.MUSTER_DRIVE_LIFECYCLE_FIXTURE = join(rootDirectory, "google", "fixture.json");
    env.GOOGLE_CLIENT_ID = syntheticClientId;
    env.GOOGLE_CLIENT_SECRET = syntheticClientSecret;
    writeFileSync(env.MUSTER_DRIVE_LIFECYCLE_FIXTURE, JSON.stringify(fixture), { mode: 0o600 });
    env.VAULTGRAM_HOME = vaultDirectory;
    child = spawn(process.execPath, ["--import", join(rootDirectory, "drive-fetch-preload.mjs"), "--experimental-strip-types", join(ROOT, "server/index.ts")], {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", () => {});
    await waitForOwnedServer(child, url);
    seedGrantTables();
  }, 30_000);

  function seedGrantTables(): void {
    const db = new DatabaseSync(authPath());
    try {
      const now = new Date().toISOString();
      db.prepare('INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?)')
        .run(userId, "Lifecycle owner", `${userId}@example.test`, 1, now, now);
      db.prepare('INSERT INTO "session" (id,expiresAt,token,createdAt,updatedAt,userId) VALUES (?,?,?,?,?,?)')
        .run(`session-${userId}`, new Date(Date.now() + 60_000_000).toISOString(), userSession, now, now, userId);
      db.prepare('INSERT INTO account (id,accountId,providerId,userId,accessToken,refreshToken,scope,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(`account-${userId}`, `google-${userId}`, "google", userId, syntheticAccountToken, randomBytes(24).toString("hex"), "openid profile email", now, now);
      db.exec(`
        CREATE TABLE IF NOT EXISTS drive_grants (userId TEXT PRIMARY KEY, googleSub TEXT NOT NULL, accessToken TEXT NOT NULL, refreshToken TEXT NOT NULL, expiresAt INTEGER NOT NULL, scopes TEXT NOT NULL, generation INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS drive_visible_grants (userId TEXT PRIMARY KEY, googleSub TEXT NOT NULL, accessToken TEXT NOT NULL, refreshToken TEXT NOT NULL, expiresAt INTEGER NOT NULL, scopes TEXT NOT NULL, generation INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS calendar_grants (userId TEXT PRIMARY KEY, googleSub TEXT NOT NULL, accessToken TEXT NOT NULL, refreshToken TEXT NOT NULL, expiresAt INTEGER NOT NULL, scopes TEXT NOT NULL, generation INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS calendar_device_grants (id TEXT PRIMARY KEY, tokenHash TEXT NOT NULL UNIQUE, userId TEXT NOT NULL, calendarId TEXT NOT NULL, label TEXT NOT NULL, generation INTEGER NOT NULL, googleSub TEXT NOT NULL, expiresAt INTEGER NOT NULL);
      `);
      const scopes = JSON.stringify(["https://www.googleapis.com/auth/drive.appdata"]);
      db.prepare("INSERT INTO drive_grants VALUES (?, ?, ?, ?, ?, ?, ?)").run(userId, "grant-google-sub", "grant-access", "grant-refresh", Date.now() + 60_000, scopes, 3);
      db.prepare("INSERT INTO drive_visible_grants VALUES (?, ?, ?, ?, ?, ?, ?)").run(userId, "visible-google-sub", "visible-access", "visible-refresh", Date.now() + 60_000, JSON.stringify(["https://www.googleapis.com/auth/drive.file"]), 4);
      db.prepare("INSERT INTO calendar_grants VALUES (?, ?, ?, ?, ?, ?, ?)").run(userId, "calendar-google-sub", "calendar-access", "calendar-refresh", Date.now() + 60_000, JSON.stringify(["https://www.googleapis.com/auth/calendar.readonly"]), 5);
      db.prepare("INSERT INTO calendar_device_grants VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("device-grant", "device-token-hash", userId, "primary-calendar", "Retained device", 5, "calendar-google-sub", Date.now() + 60_000);
    } finally {
      db.close();
    }
  }

  afterAll(async () => {
    setMode("ok");
    if (child) await waitForExit(child, { signal: "SIGTERM" });
    const exited = !child || child.exitCode !== null || child.signalCode !== null;
    if (rootDirectory && exited) await removeTempDir(rootDirectory);
    expect({ exited, rootRemoved: !existsSync(rootDirectory) }).toEqual({ exited: true, rootRemoved: true });
  }, 20_000);

  it("disconnects only local appData credentials and fences stale/cancelled lifecycles", async () => {
    const initialGeneration = Number(config().driveSyncGeneration ?? 0);
    const originalAuth = authSnapshot();
    const backupPath = join(dataDirectory, "backups", "retained-local.enc");
    const initialPush = await request("/api/workspace/drive/push", "POST", JSON.stringify({ passphrase }));
    const initialPushBody = await initialPush.json();
    expect(initialPush.status, JSON.stringify(initialPushBody)).toBe(200);
    const remoteBackup = JSON.parse(readFileSync(fixture.filesPath, "utf8"))["muster-workspace.enc"];
    expect(remoteBackup?.payload).toContain("muster-workspace-bundle:1:");
    const remoteCountBeforeDisconnect = Object.keys(JSON.parse(readFileSync(fixture.filesPath, "utf8"))).length;

    // The route inherits the established local host/origin gate; it must not
    // clear machine credentials from a remote or cross-origin request.
    for (const badHeader of ["host", "origin"] as const) {
      const headers = { origin: url, "content-type": "application/json" };
      const rejectedHeaders = badHeader === "host"
        ? { ...headers, host: "unowned.invalid" }
        : { ...headers, origin: "https://unowned.invalid" };
      const denied = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const outgoing = httpRequest(`${url}/api/workspace/drive/disconnect`, { method: "POST", headers: rejectedHeaders }, (incoming) => {
          let body = "";
          incoming.setEncoding("utf8");
          incoming.on("data", (chunk) => { body += String(chunk); });
          incoming.once("end", () => resolve({ status: incoming.statusCode ?? 0, body }));
          incoming.once("error", reject);
        });
        outgoing.once("error", reject);
        outgoing.end("{}");
      });
      expect(denied.status).toBe(403);
      expect(config().driveSync).toBeDefined();
    }

    // A legacy OAuth exchange that returns after disconnect cannot resurrect
    // the old or newly exchanged credential pair.
    setMode("hold-exchange");
    const connecting = request("/api/workspace/drive/connect", "POST", JSON.stringify({ code: "owned-code", redirectUri: `${url}/sync` }));
    await waitForMarker("exchange");
    const staleExchangeDisconnect = await postDisconnect();
    expect(staleExchangeDisconnect.status).toBe(200);
    expect(await staleExchangeDisconnect.json()).toMatchObject({
      connected: false,
      localTokensRemoved: true,
      googleAuthorizationRevoked: false,
      backupFilesDeleted: false,
      message: expect.stringContaining("Google's remote authorization was not revoked"),
    });
    const afterExchangeDisconnectGeneration = Number(config().driveSyncGeneration);
    setMode("ok");
    const staleConnect = await connecting;
    expect(staleConnect.status).toBe(409);
    expect(config().driveSync).toBeUndefined();
    expect(Number(config().driveSyncGeneration)).toBe(afterExchangeDisconnectGeneration);
    const disconnectedLogLength = readFileSync(fixture.logPath, "utf8").length;
    const disconnectedPush = await request("/api/workspace/drive/push", "POST", JSON.stringify({ passphrase }));
    expect(disconnectedPush.status).toBe(400);
    expect(await disconnectedPush.json()).toEqual({ error: "Google Drive is not connected yet" });
    expect(readFileSync(fixture.logPath, "utf8").length).toBe(disconnectedLogLength);

    // A delayed /api/config patch must also be invalidated when disconnect
    // begins with no saved Drive tokens, not only when replacing old tokens.
    setMode("hold-config-verify");
    const delayedConfigFromDisconnected = request("/api/config", "PATCH", JSON.stringify({
      driveSync: { refreshToken: fixture.refreshToken },
      box: { token: randomBytes(24).toString("hex") },
    }));
    await waitForMarker("config-verify");
    const beforePendingConfigDisconnect = Number(config().driveSyncGeneration);
    expect((await postDisconnect()).status).toBe(200);
    expect(Number(config().driveSyncGeneration)).toBeGreaterThan(beforePendingConfigDisconnect);
    setMode("ok");
    expect((await delayedConfigFromDisconnected).status).toBe(409);
    expect(config().driveSync).toBeUndefined();

    // Repeated disconnect is a durable no-op. Local backups, remote appData,
    // sign-in, account Drive, visible Drive and Calendar state all survive.
    const tombstoneConfig = readFileSync(configPath(), "utf8");
    const repeated = await postDisconnect();
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toMatchObject({ localTokensRemoved: true, googleAuthorizationRevoked: false, backupFilesDeleted: false });
    expect(readFileSync(configPath(), "utf8")).toBe(tombstoneConfig);
    expect(authSnapshot()).toEqual(originalAuth);
    expect(readFileSync(backupPath, "utf8")).toBe("owned retained backup bytes");
    expect(Object.keys(JSON.parse(readFileSync(fixture.filesPath, "utf8")))).toHaveLength(remoteCountBeforeDisconnect);

    // A connect started from the disconnected state is also a pending
    // lifecycle. Disconnect must advance its tombstone even though there are
    // no credentials to delete yet.
    setMode("hold-exchange");
    const noCredentialExchange = request("/api/workspace/drive/connect", "POST", JSON.stringify({ code: "owned-code-with-no-current-credentials", redirectUri: `${url}/sync` }));
    await waitForMarker("exchange");
    const generationBeforePendingDisconnect = Number(config().driveSyncGeneration);
    expect(config().driveSync).toBeUndefined();
    expect((await postDisconnect()).status).toBe(200);
    const pendingDisconnectGeneration = Number(config().driveSyncGeneration);
    expect(pendingDisconnectGeneration).toBeGreaterThan(generationBeforePendingDisconnect);
    setMode("ok");
    expect((await noCredentialExchange).status).toBe(409);
    expect(config().driveSync).toBeUndefined();

    // Reconnect advances the durable generation before the OAuth exchange and
    // saves only the response for that still-current attempt.
    const reconnect = await request("/api/workspace/drive/connect", "POST", JSON.stringify({ code: "owned-reconnect", redirectUri: `${url}/sync` }));
    expect(reconnect.status).toBe(200);
    const reconnectedGeneration = Number(config().driveSyncGeneration);
    expect(reconnectedGeneration).toBeGreaterThan(pendingDisconnectGeneration);
    expect(config().driveSync).toMatchObject({ refreshToken: fixture.refreshToken, accessToken: fixture.accessToken });

    // Refresh errors are ordinary operation errors, never an implicit
    // disconnect; the configured local credentials remain available.
    setMode("refresh-error");
    const failedRefresh = await request("/api/workspace/drive/push", "POST", JSON.stringify({ passphrase }));
    expect(failedRefresh.status).toBe(502);
    expect(config().driveSync).toBeDefined();
    setMode("ok");

    // Client cancellation during token refresh is not a disconnect and must
    // stop before any subsequent Drive list or upload request.
    const refreshOffset = readFileSync(fixture.logPath, "utf8").length;
    setMode("hold-refresh");
    clearMarker("refresh-cancelled");
    const cancelledRefresh = startCancellableRequest("/api/workspace/drive/push", JSON.stringify({ passphrase }));
    await waitForMarker("refresh");
    cancelledRefresh.abort();
    await waitForMarker("refresh-cancelled");
    setMode("ok");
    await cancelledRefresh.done;
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    expect(config().driveSync).toBeDefined();
    const afterCancelledRefresh = readFileSync(fixture.logPath, "utf8").slice(refreshOffset).trim().split("\n").filter(Boolean).map((line) => transportEventSchema.parse(JSON.parse(line)));
    expect(afterCancelledRefresh.map((entry) => entry.operation)).toEqual(["refresh"]);

    // A held token refresh cannot proceed into a push after its lifecycle was
    // disconnected, even when the synthetic provider returns late.
    setMode("hold-refresh");
    const refreshingPush = request("/api/workspace/drive/push", "POST", JSON.stringify({ passphrase }));
    await waitForMarker("refresh");
    const beforeHeldRefresh = readFileSync(configPath(), "utf8");
    const refreshDisconnect = await postDisconnect();
    expect(refreshDisconnect.status).toBe(200);
    setMode("ok");
    const staleRefreshPush = await refreshingPush;
    expect(staleRefreshPush.status).toBe(409);
    expect(config().driveSync).toBeUndefined();
    expect(readFileSync(configPath(), "utf8")).not.toBe(beforeHeldRefresh);

    // An explicit config write creates a fresh generation, but cannot let the
    // earlier request finish on that new lifecycle or bypass the fence.
    const configuredAgain = await request("/api/config", "PATCH", JSON.stringify({ driveSync: { refreshToken: fixture.refreshToken } }));
    expect(configuredAgain.status).toBe(200);
    const configReconnectGeneration = Number(config().driveSyncGeneration);
    setMode("hold-refresh");
    const configHeldPush = request("/api/workspace/drive/push", "POST", JSON.stringify({ passphrase }));
    await waitForMarker("refresh");
    const configPatch = await request("/api/config", "PATCH", JSON.stringify({ driveSync: { accessToken: fixture.accessToken } }));
    expect(configPatch.status).toBe(200);
    expect(Number(config().driveSyncGeneration)).toBeGreaterThan(configReconnectGeneration);
    setMode("ok");
    expect((await configHeldPush).status).toBe(409);
    expect(config().driveSync).toBeDefined();

    // A /api/config request that began before disconnect may be waiting on
    // provider validation. Its late commit must compare the captured Drive
    // generation rather than silently reconnecting the removed credentials.
    setMode("hold-config-verify");
    const delayedConfigPatch = request("/api/config", "PATCH", JSON.stringify({
      driveSync: { refreshToken: fixture.refreshToken },
      box: { token: randomBytes(24).toString("hex") },
    }));
    await waitForMarker("config-verify");
    expect((await postDisconnect()).status).toBe(200);
    setMode("ok");
    expect((await delayedConfigPatch).status).toBe(409);
    expect(config().driveSync).toBeUndefined();

    // Uploads are guarded too: disconnect during a held push prevents the
    // server from reporting or stamping a stale copy.
    const beforeUploadFiles = JSON.stringify(JSON.parse(readFileSync(fixture.filesPath, "utf8")));
    const syncStateDirectory = join(dataDirectory, "sync-state");
    const stampPath = join(syncStateDirectory, "local.json");
    const beforeStamp = existsSync(stampPath) ? readFileSync(stampPath, "utf8") : null;
    const uploadReconnect = await request("/api/workspace/drive/connect", "POST", JSON.stringify({ code: "owned-reconnect-upload", redirectUri: `${url}/sync` }));
    expect(uploadReconnect.status).toBe(200);
    setMode("hold-upload");
    const uploading = request("/api/workspace/drive/push", "POST", JSON.stringify({ passphrase }));
    await waitForMarker("upload");
    expect((await postDisconnect()).status).toBe(200);
    setMode("ok");
    expect((await uploading).status).toBe(409);
    expect(JSON.stringify(JSON.parse(readFileSync(fixture.filesPath, "utf8")))).toBe(beforeUploadFiles);
    expect(existsSync(stampPath) ? readFileSync(stampPath, "utf8") : null).toBe(beforeStamp);

    // Reconnect and cancel a push after it reaches the held upload. No stale
    // local sync stamp or remote file copy is committed by the cancelled call.
    const uploadCancelReconnect = await request("/api/workspace/drive/connect", "POST", JSON.stringify({ code: "owned-reconnect-upload-cancel", redirectUri: `${url}/sync` }));
    expect(uploadCancelReconnect.status).toBe(200);
    const beforeCancelledUploadFiles = readFileSync(fixture.filesPath, "utf8");
    const beforeCancelledUploadStamp = existsSync(stampPath) ? readFileSync(stampPath, "utf8") : null;
    setMode("hold-upload");
    clearMarker("upload-cancelled");
    const cancelledUpload = startCancellableRequest("/api/workspace/drive/push", JSON.stringify({ passphrase }));
    await waitForMarker("upload");
    cancelledUpload.abort();
    await waitForMarker("upload-cancelled");
    setMode("ok");
    await cancelledUpload.done;
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    expect(config().driveSync).toBeDefined();
    expect(readFileSync(fixture.filesPath, "utf8")).toBe(beforeCancelledUploadFiles);
    expect(existsSync(stampPath) ? readFileSync(stampPath, "utf8") : null).toBe(beforeCancelledUploadStamp);

    // Pull returns an already-in-flight stale payload after disconnect. The
    // post-await epoch check must run before decrypt/restore mutates local data.
    const secondReconnect = await request("/api/workspace/drive/connect", "POST", JSON.stringify({ code: "owned-reconnect-2", redirectUri: `${url}/sync` }));
    expect(secondReconnect.status).toBe(200);
    rmSync(localMemory(), { force: true });
    setMode("hold-download");
    const pulling = request("/api/workspace/drive/pull", "POST", JSON.stringify({ passphrase }));
    await waitForMarker("download");
    expect((await postDisconnect()).status).toBe(200);
    setMode("ok");
    expect((await pulling).status).toBe(409);
    expect(existsSync(localMemory())).toBe(false);

    // The synchronous workspace restore is the commit boundary. Hold the
    // subsequent real provider reload, disconnect after the bytes are already
    // local, then fail reload with a lifecycle error. The committed success
    // must survive an error that would otherwise map to 409.
    const committedPullReconnect = await request("/api/workspace/drive/connect", "POST", JSON.stringify({ code: "owned-reconnect-commit-boundary", redirectUri: `${url}/sync` }));
    expect(committedPullReconnect.status).toBe(200);
    setMode("hold-provider-reload");
    const committedPull = request("/api/workspace/drive/pull", "POST", JSON.stringify({ passphrase }));
    await waitForMarker("provider-reload");
    expect(readFileSync(localMemory(), "utf8")).toBe("legacy Drive lifecycle canary");
    expect((await postDisconnect()).status).toBe(200);
    setMode("provider-reload-lifecycle-error");
    const committedPullResponse = await committedPull;
    expect(committedPullResponse.status).toBe(200);
    expect(await committedPullResponse.json()).toMatchObject({ restored: { memoryFilesRestored: 1 }, reloadError: "Owned provider reload lifecycle invalidation" });
    expect(readFileSync(localMemory(), "utf8")).toBe("legacy Drive lifecycle canary");
    setMode("ok");

    // An ordinary reload failure would previously map to 400 after restore.
    // Prove the same boundary retains the restored bytes and reports the
    // reload problem without changing the committed operation's status.
    const failedReloadReconnect = await request("/api/workspace/drive/connect", "POST", JSON.stringify({ code: "owned-reconnect-reload-failure", redirectUri: `${url}/sync` }));
    expect(failedReloadReconnect.status).toBe(200);
    rmSync(localMemory(), { force: true });
    setMode("hold-provider-reload");
    const failedReloadPull = request("/api/workspace/drive/pull", "POST", JSON.stringify({ passphrase }));
    await waitForMarker("provider-reload");
    expect(readFileSync(localMemory(), "utf8")).toBe("legacy Drive lifecycle canary");
    setMode("provider-reload-error");
    const failedReloadResponse = await failedReloadPull;
    expect(failedReloadResponse.status).toBe(200);
    expect(await failedReloadResponse.json()).toMatchObject({ restored: { memoryFilesRestored: 1 }, reloadError: "Owned provider reload failure" });
    expect(readFileSync(localMemory(), "utf8")).toBe("legacy Drive lifecycle canary");
    expect(config().driveSync).toBeDefined();
    setMode("ok");

    // Cancellation is not disconnect: aborting a pending pull prevents local
    // restore, while the local credential remains configured for retry.
    const thirdReconnect = await request("/api/workspace/drive/connect", "POST", JSON.stringify({ code: "owned-reconnect-3", redirectUri: `${url}/sync` }));
    expect(thirdReconnect.status).toBe(200);
    rmSync(localMemory(), { force: true });
    setMode("hold-download");
    clearMarker("download-cancelled");
    const cancelledPull = startCancellableRequest("/api/workspace/drive/pull", JSON.stringify({ passphrase }));
    await waitForMarker("download");
    cancelledPull.abort();
    await waitForMarker("download-cancelled");
    setMode("ok");
    await cancelledPull.done;
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    expect(config().driveSync).toBeDefined();
    expect(existsSync(localMemory())).toBe(false);

    // Cancellation during the engine-backed manual sync has the same fence:
    // it may not continue applying or publishing after the client leaves.
    setMode("hold-sync-list");
    clearMarker("sync-list-cancelled");
    const cancelledSync = startCancellableRequest("/api/workspace/drive/sync", JSON.stringify({ passphrase }));
    await waitForMarker("sync-list");
    cancelledSync.abort();
    await waitForMarker("sync-list-cancelled");
    setMode("ok");
    await cancelledSync.done;
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    expect(config().driveSync).toBeDefined();

    // Queue a real memory write through the server producer and start at
    // attempt 11 so the old generic drainer behavior would dead-letter it.
    const rosterResponse = await request("/api/bots");
    expect(rosterResponse.status).toBe(200);
    const firstBotId = rosterSchema.parse(await rosterResponse.json()).bots[0]!.id;
    const queuedMemory = await request(`/api/bots/${firstBotId}/memory`, "PUT", JSON.stringify({ text: "queued lifecycle upload" }));
    expect(queuedMemory.status).toBe(200);
    const queuedObjectId = `memory:${firstBotId}`;
    const queueDb = new DatabaseSync(authPath());
    let queuedBeforeInvalidation;
    try {
      queueDb.prepare("UPDATE sync_journal SET attempts = 11, nextAttemptAt = ? WHERE objectId = ?").run(Date.now() - 1, queuedObjectId);
      queuedBeforeInvalidation = syncChangeRows(queueDb).find((row) => row.objectId === queuedObjectId);
    } finally {
      queueDb.close();
    }
    expect(queuedBeforeInvalidation).toMatchObject({ objectId: queuedObjectId, state: "pending", attempts: 11 });
    setMode("hold-upload");
    const queuedSync = request("/api/workspace/drive/sync", "POST", JSON.stringify({ passphrase }));
    await waitForMarker("upload");
    expect((await postDisconnect()).status).toBe(200);
    setMode("ok");
    expect((await queuedSync).status).toBe(409);
    expect(journalSnapshot().find((row) => row.objectId === queuedObjectId)).toEqual(queuedBeforeInvalidation);
    expect(journalSnapshot().find((row) => row.objectId === queuedObjectId)).toMatchObject({ state: "pending", attempts: 11 });

    const queuedReconnect = await request("/api/workspace/drive/connect", "POST", JSON.stringify({ code: "owned-reconnect-queued-cancel", redirectUri: `${url}/sync` }));
    expect(queuedReconnect.status).toBe(200);
    setMode("hold-upload");
    clearMarker("upload-cancelled");
    clearMarker("upload-settled");
    const cancelledQueuedSync = startCancellableRequest("/api/workspace/drive/sync", JSON.stringify({ passphrase }));
    await waitForMarker("upload");
    cancelledQueuedSync.abort();
    await waitForMarker("upload-cancelled");
    setMode("ok");
    await waitForMarker("upload-settled");
    await cancelledQueuedSync.done;
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    expect(journalSnapshot().find((row) => row.objectId === queuedObjectId)).toEqual(queuedBeforeInvalidation);

    // The sync pass captures a single lifecycle for its entire run, including
    // token refresh and remote manifest reads. It cannot continue after a
    // disconnect that lands while its Drive request is held.
    const syncDisconnectReconnect = await request("/api/workspace/drive/connect", "POST", JSON.stringify({ code: "owned-reconnect-sync-disconnect", redirectUri: `${url}/sync` }));
    expect(syncDisconnectReconnect.status).toBe(200);
    setMode("hold-sync-list");
    const syncing = request("/api/workspace/drive/sync", "POST", JSON.stringify({ passphrase }));
    await waitForMarker("sync-list");
    expect((await postDisconnect()).status).toBe(200);
    setMode("ok");
    expect((await syncing).status).toBe(409);
    expect(config().driveSync).toBeUndefined();
    expect(journalSnapshot().find((row) => row.objectId === queuedObjectId)).toEqual(queuedBeforeInvalidation);

    // A client-cancelled OAuth exchange also leaves the pre-existing
    // connection alone; it is not translated into disconnect.
    const fourthReconnect = await request("/api/workspace/drive/connect", "POST", JSON.stringify({ code: "owned-reconnect-4", redirectUri: `${url}/sync` }));
    expect(fourthReconnect.status).toBe(200);
    setMode("hold-exchange");
    clearMarker("exchange-cancelled");
    const canceledExchange = startCancellableRequest("/api/workspace/drive/connect", JSON.stringify({ code: "cancelled-code", redirectUri: `${url}/sync` }));
    await waitForMarker("exchange");
    canceledExchange.abort();
    await waitForMarker("exchange-cancelled");
    setMode("ok");
    await canceledExchange.done;
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    expect(config().driveSync).toBeDefined();
    expect(authSnapshot()).toEqual(originalAuth);

    // The unchanged v2 caller passes no guard after configured-token refresh.
    // Disconnect must reach that upload's signal before its held fetch ends.
    const beforeImplicitUpload = readFileSync(fixture.filesPath, "utf8");
    const beforeImplicitStamp = existsSync(stampPath) ? readFileSync(stampPath, "utf8") : null;
    setMode("hold-upload");
    clearMarker("upload-cancelled");
    const implicitUpload = request("/api/workspace/v2/drive/push", "POST", JSON.stringify({ passphrase }));
    let implicitResponse: Response;
    try {
      await waitForMarker("upload");
      expect((await postDisconnect()).status).toBe(200);
      await waitForMarker("upload-cancelled");
    } finally {
      setMode("ok");
      implicitResponse = await implicitUpload;
    }
    expect(implicitResponse.status).toBe(502);
    expect(readFileSync(fixture.filesPath, "utf8")).toBe(beforeImplicitUpload);
    expect(existsSync(stampPath) ? readFileSync(stampPath, "utf8") : null).toBe(beforeImplicitStamp);

    const finalDisconnect = await postDisconnect();
    expect(finalDisconnect.status).toBe(200);
    expect(config().driveSync).toBeUndefined();
    expect(config().providers).toBeDefined();
    expect(config().telegramSync).toBeDefined();
    expect(authSnapshot()).toEqual(originalAuth);
    expect(readFileSync(backupPath, "utf8")).toBe("owned retained backup bytes");
    const finalRemoteFiles = remoteFilesSchema.parse(JSON.parse(readFileSync(fixture.filesPath, "utf8")));
    expect(finalRemoteFiles["muster-workspace.enc"]?.payload).toBe(remoteBackup.payload);
    const transportLog = readFileSync(fixture.logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => transportEventSchema.parse(JSON.parse(line)));
    expect(transportLog.filter((entry) => entry.operation === "google-revoke")).toEqual([]);
    expect(initialGeneration).toBe(0);
    expect(reconnectedGeneration).toBeGreaterThan(afterExchangeDisconnectGeneration);
  }, 30_000);

  async function runImplicitScenario<T>(scenario: string, schema: z.ZodType<T>): Promise<T> {
    const directory = mkdtempSync(join(rootDirectory, "implicit-"));
    const dataDirectory = join(directory, "data");
    mkdirSync(dataDirectory, { mode: 0o700 });
    const script = join(directory, "implicit-lifecycle.mjs");
    writeFileSync(script, implicitLifecycleSource, { mode: 0o600 });
    const helper = spawn(process.execPath, ["--experimental-strip-types", script, scenario], {
      cwd: ROOT,
      env: {
        HOME: directory,
        USERPROFILE: directory,
        OMB_DATA_DIR: dataDirectory,
        OMB_HOST: "127.0.0.1",
        GOOGLE_CLIENT_ID: randomBytes(24).toString("hex"),
        GOOGLE_CLIENT_SECRET: randomBytes(24).toString("hex"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let errors = "";
    helper.stdout?.on("data", (chunk) => { output += String(chunk); });
    helper.stderr?.on("data", (chunk) => { errors += String(chunk); });
    try {
      await waitForExit(helper, { graceMs: 10_000 });
      expect(helper.exitCode, errors).toBe(0);
      return schema.parse(JSON.parse(output.trim()));
    } finally {
      if (helper.exitCode === null && helper.signalCode === null) await waitForExit(helper, { signal: "SIGTERM" });
      await removeTempDir(directory);
      expect({ exited: helper.exitCode !== null || helper.signalCode !== null, removed: !existsSync(directory) }).toEqual({ exited: true, removed: true });
    }
  }

  const implicitResultsSchema = z.object({ results: z.array(z.object({ name: z.string(), invalidated: z.boolean(), requests: z.number() })) });
  it("fences all default helpers before a request after configured-token disconnect", async () => {
    const { results } = await runImplicitScenario("stale", implicitResultsSchema);
    expect(results).toHaveLength(9);
    expect(results.every((result) => result.invalidated && result.requests === 0), JSON.stringify(results)).toBe(true);
  });

  it.each([
    { scenario: "json-body", count: 5 },
    { scenario: "text-body", count: 2 },
  ])("fences configured default helpers after delayed $scenario reads", async ({ scenario, count }) => {
    const { results } = await runImplicitScenario(scenario, implicitResultsSchema);
    expect(results).toHaveLength(count);
    expect(results.every((result) => result.invalidated), JSON.stringify(results)).toBe(true);
    expect(results.map((result) => result.requests)).toEqual(scenario === "json-body" ? [2, 1, 1, 1, 1] : [2, 1]);
  });

  it("keeps an invalidated real nightly snapshot from marking health or stamping success", async () => {
    const stampSchema = z.object({ at: z.number(), channel: z.enum(["google-drive", "google-account", "telegram"]) }).nullable();
    const result = await runImplicitScenario("nightly", z.object({
      run: z.object({ status: z.enum(["ok", "skipped", "failed"]), error: z.string().optional() }),
      health: z.object({ snapshotId: z.string(), name: z.string(), verifiedAt: z.number() }).nullable(),
      sync: z.object({ lastPush: stampSchema, lastPull: stampSchema }),
      operations: z.array(z.string()),
    }));
    expect(result).toMatchObject({
      run: { status: "failed", error: expect.stringContaining("connection changed") },
      health: null,
      sync: { lastPush: null, lastPull: null },
      operations: ["POST /token", "POST /upload/drive/v3/files"],
    });
  });

  it("retains independent explicit guards when an installation token lifecycle was disconnected", async () => {
    const result = await runImplicitScenario("explicit", z.object({ guards: z.number(), requests: z.number() }));
    expect(result.guards).toBeGreaterThan(0);
    expect(result.requests).toBe(3);
  });
});
