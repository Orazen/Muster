// Real session continuity across owned server restarts. The Docker entrypoint
// is exercised directly; this does not prove a production volume is mounted.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { pairingServerEnvironment, waitForOwnedServer } from "../e2e/pairing-harness.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { seedConnectedGoogleRow } from "./testing/storage-gate.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const userSchema = z.object({ id: z.string() });
const sessionSchema = z.object({
  user: userSchema,
  session: z.object({ id: z.string(), userId: z.string(), expiresAt: z.string() }),
});
const botSchema = z.object({ id: z.string(), name: z.string() });
const storedBotsSchema = z.array(botSchema.extend({ ownerId: z.string().optional() }));

interface Identity {
  userId: string;
  sessionId: string;
  cookie: string;
  bot: z.infer<typeof botSchema>;
}

interface Fixture {
  root: string;
  data: string;
  url: string;
  networkLog: string;
  memoryFile: string;
  canary: string;
  email: string;
  password: string;
  start(secret?: string): Promise<void>;
  stop(): Promise<void>;
}

async function createFixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "muster-session-persistence-"));
  const data = join(root, "data");
  const home = join(root, "home");
  const companion = join(root, "companion");
  const ui = join(root, "ui");
  for (const directory of [data, home, companion, ui, join(data, "memory")]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  writeFileSync(join(ui, "index.html"), "<!doctype html><title>Owned session fixture</title>");
  writeFileSync(join(data, "config.json"), JSON.stringify({
    instances: { ghost: { driver: "not-a-real-driver", displayName: "Offline session fixture" } },
  }));
  const canary = randomBytes(24).toString("hex");
  const memoryFile = join(data, "memory", "session-canary.md");
  writeFileSync(memoryFile, canary, { mode: 0o600 });
  const networkLog = join(root, "outbound-attempts.txt");
  const preload = join(root, "block-outbound.mjs");
  writeFileSync(preload, `
import { Socket } from "node:net";
import { appendFileSync } from "node:fs";
const blocked = () => {
  appendFileSync(${JSON.stringify(networkLog)}, "blocked\\n");
  throw new Error("Outbound network disabled in session fixture");
};
globalThis.fetch = blocked;
Socket.prototype.connect = blocked;
`);
  let child: ChildProcess | undefined;
  let port: number;
  try {
    port = await freePortBlock([0, 1], 25000, 12000);
  } catch (error) {
    await removeTempDir(root);
    throw error;
  }
  const url = `http://127.0.0.1:${port}`;

  const stop = async () => {
    if (!child) return;
    const owned = child;
    const pid = owned.pid;
    const signalGroup = (signal: NodeJS.Signals) => {
      if (!pid) return;
      try {
        process.kill(-pid, signal);
      } catch (error) {
        const parsed = z.object({ code: z.string() }).safeParse(error);
        if (!parsed.success || parsed.data.code !== "ESRCH") throw error;
      }
    };
    // Detached here means a new owned process group, not an abandoned child.
    // Stop the shell AND its Node child before reusing the data/port pair.
    signalGroup("SIGTERM");
    const killTimer = setTimeout(() => signalGroup("SIGKILL"), 3_000);
    try {
      await waitForExit(owned, { graceMs: 4_000 });
      expect(owned.exitCode !== null || owned.signalCode !== null).toBe(true);
    } finally {
      clearTimeout(killTimer);
      // Also catch descendants if the entrypoint exited before forwarding.
      signalGroup("SIGKILL");
      child = undefined;
    }
  };

  return {
    root, data, url, networkLog, memoryFile, canary,
    email: `session-${randomBytes(10).toString("hex")}@example.test`,
    password: randomBytes(32).toString("base64url"),
    stop,
    async start(secret) {
      if (child) throw new Error("Stop the owned fixture before restarting it");
      const env = pairingServerEnvironment({
        home, dataDirectory: data, companionDirectory: companion, staticDir: ui,
        port, webhookPort: port + 1, secret: secret ?? "",
      });
      env.OMB_PUBLIC_HOST = `127.0.0.1:${port}`; // actual SELF_HOSTED gate, loopback listener
      env.OMB_ALLOW_SIGNUPS = "true";
      if (secret === undefined) delete env.BETTER_AUTH_SECRET;
      child = spawn("/bin/sh", [
        join(ROOT, "scripts/docker-entrypoint.sh"), process.execPath,
        "--import", preload, "--experimental-strip-types", join(ROOT, "server/index.ts"),
      ], { cwd: ROOT, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout?.on("data", () => {});
      child.stderr?.on("data", () => {});
      await waitForOwnedServer(child, url);
    },
  };
}

type FixtureRequestBody = { email: string; password: string; name?: string } | { name: string };

function request(fixture: Fixture, path: string, cookie?: string, body?: FixtureRequestBody): Promise<Response> {
  const headers = new Headers({ origin: fixture.url });
  if (cookie) headers.set("cookie", cookie);
  const init: RequestInit = { headers, redirect: "error", signal: AbortSignal.timeout(10_000) };
  if (body) {
    init.method = "POST";
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(body);
  }
  return fetch(`${fixture.url}${path}`, init);
}

function sessionCookie(response: Response): string {
  const cookie = response.headers.getSetCookie().find((value) => value.startsWith("better-auth.session_token="));
  if (!cookie) throw new Error("Owned login did not issue a session cookie");
  return cookie.split(";")[0];
}

async function sessionFor(fixture: Fixture, cookie: string) {
  const response = await request(fixture, "/api/auth/get-session?disableRefresh=true", cookie);
  expect(response.status).toBe(200);
  return sessionSchema.parse(await response.json());
}

async function establishIdentity(fixture: Fixture): Promise<Identity> {
  expect((await request(fixture, "/api/bots")).status).toBe(401);
  const signup = await request(fixture, "/api/auth/sign-up/email", undefined, {
    email: fixture.email, password: fixture.password, name: "Restart fixture",
  });
  expect(signup.status).toBe(200);
  const { user } = z.object({ user: userSchema }).parse(await signup.json());
  const cookie = sessionCookie(signup);
  const current = await sessionFor(fixture, cookie);
  expect(current.user.id).toBe(user.id);
  expect(current.session.userId).toBe(user.id);
  expect(Date.parse(current.session.expiresAt)).toBeGreaterThan(Date.now());
  // An existing hosted user: the storage-sovereignty gate is open (a local
  // fixture ignores the row).
  seedConnectedGoogleRow(fixture.data, user.id);
  const created = await request(fixture, "/api/bots", cookie, { name: `Persisted ${randomBytes(6).toString("hex")}` });
  expect(created.status).toBe(201);
  const { bot } = z.object({ bot: botSchema }).parse(await created.json());
  return { userId: user.id, sessionId: current.session.id, cookie, bot };
}

async function assertWorkspace(fixture: Fixture, identity: Identity, cookie: string) {
  const response = await request(fixture, "/api/bots", cookie);
  expect(response.status).toBe(200);
  const roster = z.object({ bots: z.array(botSchema) }).parse(await response.json());
  expect(roster.bots.find((bot) => bot.id === identity.bot.id)).toEqual(identity.bot);
  const stored = storedBotsSchema.parse(JSON.parse(readFileSync(join(fixture.data, "bots.json"), "utf8")));
  expect(stored.find((bot) => bot.id === identity.bot.id)?.ownerId).toBe(identity.userId);
  expect(readFileSync(fixture.memoryFile, "utf8")).toBe(fixture.canary);
}

async function assertRejected(fixture: Fixture, cookie: string) {
  const session = await request(fixture, "/api/auth/get-session?disableRefresh=true", cookie);
  expect(session.status).toBe(200);
  expect(await session.json()).toBeNull();
  expect((await request(fixture, "/api/bots", cookie)).status).toBe(401);
}

async function signInAgain(fixture: Fixture, identity: Identity) {
  const login = await request(fixture, "/api/auth/sign-in/email", undefined, {
    email: fixture.email, password: fixture.password,
  });
  expect(login.status).toBe(200);
  const cookie = sessionCookie(login);
  const current = await sessionFor(fixture, cookie);
  expect(current.user.id).toBe(identity.userId);
  expect(current.session.id).not.toBe(identity.sessionId);
  await assertWorkspace(fixture, identity, cookie);
}

describe.skipIf(process.platform === "win32")("session persistence through owned HTTP restarts", () => {
  let fixture: Fixture | undefined;
  beforeEach(async () => { fixture = await createFixture(); });
  afterEach(async () => {
    if (!fixture) return;
    try {
      await fixture.stop();
      expect(existsSync(fixture.networkLog)).toBe(false);
    } finally {
      await removeTempDir(fixture.root);
      fixture = undefined;
    }
  }, 15_000);

  const ownedFixture = () => {
    if (!fixture) throw new Error("Owned fixture is not initialized");
    return fixture;
  };

  it.each(["explicit", "generated"] as const)("retains the exact session and owned bot with an unchanged %s signing source", async (source) => {
    const owned = ownedFixture();
    const secret = source === "explicit" ? randomBytes(32).toString("hex") : undefined;
    await owned.start(secret);
    const identity = await establishIdentity(owned);
    await assertWorkspace(owned, identity, identity.cookie);
    // Prove the generated branch used the actual entrypoint's file, rather
    // than auth.ts's distinct desktop auth.secret fallback. Never print it.
    expect(existsSync(join(owned.data, ".better-auth-secret"))).toBe(source === "generated");
    expect(existsSync(join(owned.data, "auth.secret"))).toBe(false);
    await owned.stop();
    await owned.start(secret);
    const resumed = await sessionFor(owned, identity.cookie);
    expect(resumed.user.id).toBe(identity.userId);
    expect(resumed.session.id).toBe(identity.sessionId);
    expect(resumed.session.userId).toBe(identity.userId);
    await assertWorkspace(owned, identity, identity.cookie);
  }, 60_000);

  it("rejects an expired fixture session after restart while retaining the account and workspace", async () => {
    const owned = ownedFixture();
    const secret = randomBytes(32).toString("hex");
    await owned.start(secret);
    const identity = await establishIdentity(owned);
    await owned.stop();
    // Alter only this synthetic session while its server is stopped; no
    // clock mocking, production cookies, or real user records are involved.
    const db = new DatabaseSync(join(owned.data, "auth.db"));
    try {
      const changed = db.prepare('UPDATE "session" SET "expiresAt" = ? WHERE "id" = ? AND "userId" = ?')
        .run(new Date(Date.now() - 60_000).toISOString(), identity.sessionId, identity.userId);
      expect(Number(changed.changes)).toBe(1);
    } finally { db.close(); }
    await owned.start(secret);
    await assertRejected(owned, identity.cookie);
    await signInAgain(owned, identity);
  }, 60_000);

  it("rejects an old cookie after a signing-secret change without losing its account or bot", async () => {
    const owned = ownedFixture();
    await owned.start(randomBytes(32).toString("hex"));
    const identity = await establishIdentity(owned);
    await owned.stop();
    await owned.start(randomBytes(32).toString("hex"));
    await assertRejected(owned, identity.cookie);
    await signInAgain(owned, identity);
  }, 60_000);
});
