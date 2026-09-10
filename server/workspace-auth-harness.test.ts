// Exercise the real shared-host guard with two accounts, and keep local
// export/restore working. Every server and file belongs to this fixture;
// the child preload refuses outbound connections, including provider calls.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
const botSchema = z.object({ id: z.string(), name: z.string() });
const rosterSchema = z.object({ bots: z.array(botSchema), groups: z.array(z.unknown()) });
interface OwnedServer { url: string; dataDirectory: string; networkLog: string }
interface Account { cookie: string; id: string; botId: string }

describe.skipIf(process.platform === "win32")("workspace backup account boundary over HTTP", () => {
  let rootDirectory: string;
  let shared: OwnedServer;
  let local: OwnedServer;
  let primary: Account;
  let secondary: Account;
  let sharedConfig: string;
  const memoryCanary = randomBytes(24).toString("hex");
  const children: ChildProcess[] = [];

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
    for (const path of [dataDirectory, home, companionDirectory]) mkdirSync(path, { recursive: true, mode: 0o700 });
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
    return { url, dataDirectory, networkLog };
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
    return { cookie, id: user.id, botId: bot.id };
  };

  beforeAll(async () => {
    rootDirectory = mkdtempSync(join(tmpdir(), "muster-workspace-auth-"));
    mkdirSync(join(rootDirectory, "ui"));
    writeFileSync(join(rootDirectory, "ui", "index.html"), "<!doctype html><title>Workspace fixture</title>");
    const port = await freePortBlock([0, 1, 2, 3], 24000, 10000);
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
    for (const child of children) expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    if (rootDirectory) await removeTempDir(rootDirectory);
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
