// Actual index registration, signed BetterAuth cookies and current SQLite
// rows in an owned hosted fixture. No accounts, backups or services outside
// this temporary child are touched; its outbound transports are denied.
import { spawn, type ChildProcess } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { pairingServerEnvironment, waitForOwnedServer } from "../e2e/pairing-harness.ts";
import { freePortBlock } from "./testing/ports.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { VISIBLE_DRIVE_ROUTE_PREFIX } from "./drive-visible-routes.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const resultSchema = z.record(z.string(), z.unknown());
describe.skipIf(process.platform === "win32")("visible Drive registration in the actual hosted server", () => {
  let child: ChildProcess;
  let directory: string;
  let dataDir: string;
  let origin: string;
  let db: DatabaseSync;
  let networkLog: string;
  const secret = randomBytes(32).toString("hex");
  const cookie = (user: string) => {
    const token = `${user}-owned-session-token`;
    const signed = encodeURIComponent(`${token}.${createHmac("sha256", secret).update(token).digest("base64")}`);
    return `better-auth.session_token=${signed}`;
  };
  const request = <T>(path: string, user = "alice", value?: T, suppliedCookie = cookie(user)) => fetch(`${origin}${path}`, {
    method: value === undefined ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
    headers: { origin, cookie: suppliedCookie, "content-type": "application/json" },
    body: value === undefined ? undefined : JSON.stringify(value),
  });
  const own = <T>(action: string, user = "alice", value?: T) => request(`${VISIBLE_DRIVE_ROUTE_PREFIX}/${action}`, user, value);
  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "muster-visible-registration-"));
    dataDir = join(directory, "data");
    for (const name of [dataDir, join(directory, "home"), join(directory, "companion"), join(directory, "ui")]) mkdirSync(name, { recursive: true });
    writeFileSync(join(directory, "ui", "index.html"), "<!doctype html><title>Owned visible Drive fixture</title>");
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ instances: { ghost: { driver: "not-a-real-driver", displayName: "Offline fixture" } } }));
    networkLog = join(directory, "outbound-attempts.txt");
    const preload = join(directory, "deny-outbound.mjs");
    writeFileSync(preload, `
import { Socket } from "node:net";
import * as dns from "node:dns";
import * as dgram from "node:dgram";
import { syncBuiltinESMExports } from "node:module";
import { appendFileSync } from "node:fs";
const deny = () => { appendFileSync(${JSON.stringify(networkLog)}, "outbound-attempt\\n"); throw new Error("Owned fixture refuses outbound transport"); };
globalThis.fetch = deny;
Socket.prototype.connect = deny;
// Node's listener path calls lookup even for an explicit numeric loopback
// bind. Resolve only those literal addresses in memory, with no DNS lookup.
dns.default.lookup = (host, options, callback) => {
  if (host !== "127.0.0.1" && host !== "::1") return deny();
  const done = typeof options === "function" ? options : callback;
  const family = host === "::1" ? 6 : 4;
  queueMicrotask(() => options?.all ? done(null, [{ address: host, family }]) : done(null, host, family));
};
dns.default.resolve = deny;
dgram.default.createSocket = deny;
syncBuiltinESMExports();
`);
    const port = await freePortBlock([0, 1], 32_000, 7000);
    origin = `http://127.0.0.1:${port}`;
    const env = pairingServerEnvironment({ home: join(directory, "home"), dataDirectory: dataDir,
      companionDirectory: join(directory, "companion"), staticDir: join(directory, "ui"), port, webhookPort: port + 1, secret });
    env.OMB_PUBLIC_HOST = `127.0.0.1:${port}`;
    env.GOOGLE_CLIENT_ID = "synthetic-visible-registration-client";
    env.GOOGLE_CLIENT_SECRET = "synthetic-visible-registration-secret";
    env.TELEGRAM_CHANNEL_BOT_ID = "";
    child = spawn(process.execPath, ["--import", preload, "--experimental-strip-types", join(ROOT, "server/index.ts")],
      { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.on("data", () => undefined);
    child.stderr?.on("data", () => undefined);
    await waitForOwnedServer(child, origin);
    db = new DatabaseSync(join(dataDir, "auth.db"));
    db.exec("PRAGMA foreign_keys=ON");
    for (const [ordinal, user] of ["alice", "bob"].entries()) {
      const createdAt = new Date(Date.now() - (2 - ordinal) * 86_400_000).toISOString();
      const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
      db.prepare('INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,?,?,?)')
        .run(user, `Owned ${user}`, `${user}@owned.example.test`, 1, createdAt, createdAt);
      db.prepare('INSERT INTO organization(id,name,slug,createdAt) VALUES(?,?,?,?)').run(`${user}-org`, user, user, createdAt);
      db.prepare('INSERT INTO member(id,organizationId,userId,role,createdAt) VALUES(?,?,?,?,?)').run(`${user}-member`, `${user}-org`, user, "owner", createdAt);
      db.prepare('INSERT INTO session(id,userId,token,expiresAt,createdAt,updatedAt,activeOrganizationId) VALUES(?,?,?,?,?,?,?)')
        .run(`${user}-session`, user, `${user}-owned-session-token`, expiresAt, createdAt, createdAt, `${user}-org`);
    }
  }, 40_000);
  afterAll(async () => {
    db?.close();
    await waitForExit(child, { signal: "SIGTERM", graceMs: 5000 });
    if (directory) await removeTempDir(directory);
  });
  it("requires a signed live session, including on the dedicated optional family", async () => {
    expect((await request(`${VISIBLE_DRIVE_ROUTE_PREFIX}/status`, "alice", undefined, "")).status).toBe(401);
    expect((await request(`${VISIBLE_DRIVE_ROUTE_PREFIX}/status`, "alice", undefined, "better-auth.session_token=invalid.signature")).status).toBe(401);
    const response = await own("status");
    expect(response.status).toBe(200);
    expect(resultSchema.parse(await response.json()).connected).toBe(false);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'drive_visible_%'").all()).toEqual([]);
  });
  it("captures explicit actual account preferences independently without opening whole-install backup routes", async () => {
    expect((await own("settings", "alice", { values: { theme: "dark" } })).status).toBe(200);
    expect(resultSchema.parse(await (await own("status")).json()).settingsCaptured).toBe(true);
    expect(resultSchema.parse(await (await own("status", "bob")).json()).settingsCaptured).toBe(false);
    const captures = db.prepare("SELECT userId,workspaceId FROM drive_visible_settings").all();
    expect(captures).toEqual([{ userId: "alice", workspaceId: "alice-org" }]);
    for (const path of ["/api/workspace/export", "/api/workspace/export/v2", "/api/vault/status"]) {
      const response = await request(path);
      const unavailable = resultSchema.parse(await response.json());
      expect(response.status, JSON.stringify({ path, unavailable })).toBe(403);
      expect(unavailable.code).toBe("WORKSPACE_BACKUP_UNAVAILABLE");
    }
  });
  it("dedicated visible consent is registered before the wall and uses the configured redirect/scope", async () => {
    const response = await own("consent", "alice", {});
    expect(response.status).toBe(200);
    const body = z.object({ authorizationUrl: z.string(), state: z.string() }).parse(await response.json());
    const authorization = new URL(body.authorizationUrl);
    expect(authorization.searchParams.get("redirect_uri")).toBe(`${origin}${VISIBLE_DRIVE_ROUTE_PREFIX}/callback`);
    expect(authorization.searchParams.get("scope")).toBe("openid https://www.googleapis.com/auth/drive.file");
    expect((await own("cancel", "alice", { state: body.state })).status).toBe(200);
    expect(db.prepare("SELECT * FROM drive_visible_oauth_states").all()).toEqual([]);
  });
  it("real ISO expiry, membership removal and deletion override previous signed cookies", async () => {
    db.prepare("UPDATE session SET expiresAt=? WHERE userId='bob'").run("2020-01-01T00:00:00.000Z");
    expect((await own("status", "bob")).status).toBe(401);
    // BetterAuth deletes an expired session during its actual signed lookup;
    // re-create only this owned synthetic row for the separate next probe.
    db.prepare('INSERT INTO session(id,userId,token,expiresAt,createdAt,updatedAt,activeOrganizationId) VALUES(?,?,?,?,?,?,?)')
      .run("bob-session", "bob", "bob-owned-session-token", new Date(Date.now() + 86_400_000).toISOString(),
        new Date().toISOString(), new Date().toISOString(), "bob-org");
    expect((await own("status", "bob")).status).toBe(200);
    db.exec("DELETE FROM member WHERE userId='bob'");
    expect((await own("status", "bob")).status).toBe(401);
    db.prepare("INSERT INTO member(id,organizationId,userId,role,createdAt) VALUES(?,?,?,?,?)")
      .run("bob-member", "bob-org", "bob", "owner", new Date().toISOString());
    db.exec("UPDATE session SET token='rotated-owned-token' WHERE userId='bob'");
    expect((await own("status", "bob")).status).toBe(401);
    db.exec("DELETE FROM session WHERE userId='bob'");
    expect((await own("status", "bob")).status).toBe(401);
  });
  it("neither inspection/apply gaps nor unsigned visible requests cause outbound transport", async () => {
    expect((await own("projection")).status).toBe(409);
    expect((await own("restore/apply", "alice", {})).status).toBe(404);
    expect(existsSync(networkLog) ? readFileSync(networkLog, "utf8") : "").toBe("");
    expect(child.exitCode).toBeNull();
  });
});
