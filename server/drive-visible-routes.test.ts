import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { exportJWK, generateKeyPair, SignJWT, type JSONWebKeySet } from "jose";
import { handleVisibleDriveRoute, readLiveVisibleAccount, VISIBLE_DRIVE_ROUTE_PREFIX,
  type VisibleDriveRouteContext, type VisibleRouteSession } from "./drive-visible-routes.ts";
import { createVisibleRuntimeProtector } from "./drive-visible-runtime-key.ts";
import { createVisibleConsentState, consumeVisibleConsentState, getVisibleGrant, saveVisibleGrant,
  VISIBLE_FILE_SCOPE } from "./drive-visible-grants.ts";
import { FOLDER_MIME, parseVisibleFiles, type DriveFileRef } from "./drive-visible.ts";
import type { BotRecord } from "./store.ts";

const NOW = Date.parse("2026-10-05T12:00:00Z");
const SECRET = "synthetic-visible-routes-deployment-secret";
const protector = createVisibleRuntimeProtector(SECRET);
const session = (userId: string): VisibleRouteSession => ({ userId, sessionId: `${userId}-session`, sessionToken: `${userId}-token` });
const bot = (userId: string): BotRecord => ({ id: `${userId}-bot`, ownerId: userId, threadId: `${userId}-thread`,
  name: userId, title: userId, description: `${userId} persona`, notifications: false, color: "green", unread: false,
  createdAt: 1, resumeCursors: {}, modelSelection: { instanceId: "offline", model: "test" } });
const md5 = (bytes: Buffer) => createHash("md5").update(bytes).digest("hex");
const checkedJson = z.record(z.string(), z.unknown());
const wireFile = z.object({ name: z.string(), mimeType: z.string(), parents: z.array(z.string()) });

describe("optional visible Drive routes over owned real HTTP", () => {
  let db: DatabaseSync;
  let server: Server;
  let origin: string;
  let directory: string;
  let ctx: Omit<VisibleDriveRouteContext, "session">;
  let calls: { url: string; method: string; authorization: string | null }[];
  let files: Map<string, { ref: DriveFileRef; bytes: Buffer }>;
  let tokenHook: (() => Promise<Response>) | undefined;
  let readHook: ((url: string) => void) | undefined;
  let sessionHook: ((user: string) => Promise<VisibleRouteSession | null>) | undefined;
  let verifyHook: (() => Promise<string>) | undefined;
  let jwks: JSONWebKeySet;
  let clock: number;
  const start = async (user = "alice") => {
    const response = await post("consent", {}, user);
    expect(response.status).toBe(200);
    return z.object({ state: z.string(), authorizationUrl: z.string() }).parse(await response.json());
  };
  const get = (action: string, user = "alice", init: RequestInit = {}) => fetch(`${origin}${VISIBLE_DRIVE_ROUTE_PREFIX}/${action}`,
    { ...init, headers: { "x-owned-account": user, ...Object.fromEntries(new Headers(init.headers)) }, signal: init.signal ?? AbortSignal.timeout(10_000) });
  const post = <T>(action: string, value: T, user = "alice", extra: Record<string, string> = {}) => get(action, user,
    { method: "POST", headers: { origin: ctx.publicBaseUrl, "content-type": "application/json", ...extra }, body: JSON.stringify(value) });
  const connect = (user = "alice", remainingMs = 3_600_000) => {
    const attempt = createVisibleConsentState(db, session(user), protector, clock);
    expect(consumeVisibleConsentState(db, { ...session(user), state: attempt.state }, protector, clock)).not.toBeNull();
    return saveVisibleGrant(db, { userId: user, googleSub: `google-${user}`, accessToken: `access-${user}`,
      refreshToken: `refresh-${user}`, expiresAt: clock + remainingMs, scopes: ["openid", VISIBLE_FILE_SCOPE],
      expectedGeneration: attempt.generation }, protector, clock);
  };
  const outbound: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const authorization = new Headers(init?.headers).get("authorization");
    calls.push({ url: url.toString(), method, authorization });
    readHook?.(url.toString());
    if (url.toString() === "https://oauth2.googleapis.com/token") {
      if (tokenHook) return tokenHook();
      return Response.json({ access_token: "access-alice", refresh_token: "refresh-alice", expires_in: 3600,
        token_type: "Bearer", id_token: "test-verified-alice", scope: `openid ${VISIBLE_FILE_SCOPE}` });
    }
    if (url.origin !== "https://www.googleapis.com") throw new Error("No outbound fixture endpoint");
    if (url.pathname === "/oauth2/v3/certs") return Response.json(jwks);
    if (url.pathname === "/drive/v3/files/root") return Response.json({ id: "opaque-root" });
    if (url.pathname === "/drive/v3/files" && method === "GET") {
      const query = url.searchParams.get("q") ?? "";
      const parent = /'([^']+)' in parents/.exec(query)?.[1];
      const name = /name = '([^']+)'/.exec(query)?.[1];
      return Response.json({ files: [...files.values()].filter(file => file.ref.name === name && file.ref.parents.includes(parent ?? "")).map(file => file.ref) });
    }
    if (url.pathname === "/drive/v3/files" && method === "POST") {
      const metadata = wireFile.parse(JSON.parse(String(init?.body)));
      const ref = { id: `folder-${files.size}`, ...metadata };
      files.set(ref.id, { ref, bytes: Buffer.alloc(0) }); return Response.json(ref);
    }
    if (url.pathname === "/upload/drive/v3/files" && method === "POST") {
      const bytes = Buffer.from(z.instanceof(ArrayBuffer).parse(init?.body));
      const boundary = /boundary=([^;]+)/.exec(new Headers(init?.headers).get("content-type") ?? "")?.[1];
      if (!boundary) throw new Error("Missing multipart boundary");
      const metaStart = bytes.indexOf("\r\n\r\n") + 4;
      const metaEnd = bytes.indexOf(`\r\n--${boundary}`, metaStart);
      const metadata = wireFile.parse(JSON.parse(bytes.subarray(metaStart, metaEnd).toString("utf8")));
      const mediaStart = bytes.indexOf("\r\n\r\n", metaEnd + 2) + 4;
      const mediaEnd = bytes.lastIndexOf(`\r\n--${boundary}--`);
      const media = Buffer.from(bytes.subarray(mediaStart, mediaEnd));
      const ref = { id: `copy-${files.size}`, ...metadata, md5Checksum: md5(media) };
      files.set(ref.id, { ref, bytes: media }); return Response.json(ref);
    }
    const id = url.pathname.split("/").at(-1) ?? "";
    const found = files.get(id);
    if (!found) return Response.json({}, { status: 404 });
    if (url.searchParams.get("alt") === "media") return new Response(new Uint8Array(found.bytes));
    return Response.json({ ...found.ref, size: String(found.bytes.byteLength), capabilities: { canDownload: true } });
  };
  beforeEach(async () => {
    clock = NOW; calls = []; files = new Map(); tokenHook = undefined; readHook = undefined; sessionHook = undefined; verifyHook = undefined; jwks = { keys: [] };
    directory = mkdtempSync(join(tmpdir(), "muster-visible-route-"));
    db = new DatabaseSync(":memory:");
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE user(id TEXT PRIMARY KEY); CREATE TABLE organization(id TEXT PRIMARY KEY);
      CREATE TABLE session(id TEXT PRIMARY KEY,userId TEXT,token TEXT,expiresAt,activeOrganizationId TEXT);
      CREATE TABLE member(id TEXT PRIMARY KEY,userId TEXT,organizationId TEXT,createdAt TEXT);
      INSERT INTO user VALUES('alice'),('bob'); INSERT INTO organization VALUES('alice-org'),('bob-org');
      INSERT INTO session VALUES('alice-session','alice','alice-token','2026-10-06T12:00:00.000Z','alice-org'),
        ('bob-session','bob','bob-token','2026-10-06T12:00:00.000Z','bob-org');
      INSERT INTO member VALUES('m1','alice','alice-org','2026-01-01'),('m2','bob','bob-org','2026-01-01');`);
    ctx = { db: () => db, operator: () => "alice", deploymentSecret: () => SECRET, publicBaseUrl: "",
      google: { clientId: "synthetic-client", clientSecret: "synthetic-client-secret" }, now: () => clock,
      appVersion: "test", fetch: outbound, verifyIdToken: () => verifyHook ? verifyHook() : Promise.resolve("google-alice"),
      source: () => ({ dataDir: directory, store: { bots: [bot("alice"), bot("bob")], groups: [],
        snapshotThread: thread => ({ status: "ready", source: "sqlite", activeLeafId: null,
          messages: [{ id: `${thread}-message`, parentId: null, text: `${thread} durable body`, role: "user", kind: "text", at: 1 }] }) },
        plans: { listPlans: () => [] } }) };
    server = createServer((req, res) => {
      const user = z.string().catch("").parse(req.headers["x-owned-account"]);
      void handleVisibleDriveRoute(req, res, req.method ?? "GET", new URL(req.url!, "http://127.0.0.1").pathname,
        { ...ctx, session: () => sessionHook ? sessionHook(user) : Promise.resolve(["alice", "bob"].includes(user) ? session(user) : null) })
        .then(handled => { if (!handled) { res.writeHead(404); res.end(); } });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${z.object({ port: z.number() }).parse(server.address()).port}`;
    ctx.publicBaseUrl = origin;
  });
  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    db.close(); rmSync(directory, { recursive: true, force: true });
  });

  it("requires actual sessions on loopback and advertises without creating grant/settings tables", async () => {
    expect((await get("status", "missing")).status).toBe(401);
    expect(await (await get("status")).json()).toEqual({ available: true, connected: false, scope: "account-owned", restoreApply: "unsupported", settingsCaptured: false });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'drive_visible_%'").all()).toEqual([]);
    expect(calls).toEqual([]);
  });
  it("legacy or partially initialized grant schemas remain untouched by status and projection reads", async () => {
    connect();
    db.exec("DROP TABLE drive_visible_oauth_states; CREATE TABLE drive_visible_oauth_states(stateHash TEXT PRIMARY KEY)");
    const before = db.prepare("SELECT * FROM sqlite_master ORDER BY name").all();
    expect(checkedJson.parse(await (await get("status")).json()).connected).toBe(false);
    expect((await get("projection")).status).toBe(409);
    expect(db.prepare("SELECT * FROM sqlite_master ORDER BY name").all()).toEqual(before);
    expect(db.prepare("SELECT userId FROM drive_visible_grants").get()?.userId).toBe("alice");
  });
  it("unrelated callback or cancellation state does not create a grant schema", async () => {
    const state = "a".repeat(43);
    expect((await get(`callback?state=${state}&code=owned-code`)).status).toBe(400);
    expect(checkedJson.parse(await (await post("cancel", { state })).json()).cancelled).toBe(false);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'drive_visible_%'").all()).toEqual([]);
    expect(calls).toEqual([]);
  });
  it.each([
    ["expired ISO", "UPDATE session SET expiresAt='2020-01-01T00:00:00.000Z' WHERE userId='alice'"],
    ["invalid expiry", "UPDATE session SET expiresAt='invalid' WHERE userId='alice'"],
    ["expired epoch", `UPDATE session SET expiresAt=${NOW - 1} WHERE userId='alice'`],
    ["deleted", "DELETE FROM session WHERE userId='alice'"],
    ["token rotated", "UPDATE session SET token='rotated' WHERE userId='alice'"],
    ["membership removed", "DELETE FROM member WHERE userId='alice'"],
    ["user removed", "DELETE FROM user WHERE id='alice'"],
  ])("refuses cached signed identity when the current %s row is unavailable", async (_label, statement) => {
    db.exec(statement);
    expect((await post("consent", {})).status).toBe(401);
    expect(calls).toEqual([]);
  });
  it("accepts a live epoch only after exact user/session/token and current membership checks", () => {
    db.prepare("UPDATE session SET expiresAt=? WHERE userId='alice'").run(NOW + 1000);
    expect(readLiveVisibleAccount(db, session("alice"), "alice", NOW)?.workspaceId).toBe("alice-org");
    expect(readLiveVisibleAccount(db, { ...session("alice"), userId: "bob" }, "alice", NOW)).toBeNull();
  });
  it.each(["missing", "foreign", "null"])("requires the configured POST Origin (%s)", async kind => {
    const headers = new Headers({ "content-type": "application/json" });
    if (kind !== "missing") headers.set("origin", kind === "null" ? "null" : "https://elsewhere.example");
    const response = await get("consent", "alice", { method: "POST", headers, body: "{}" });
    expect(response.status).toBe(403); expect(calls).toEqual([]);
  });
  it("pins the dedicated redirect to configured origin rather than Host or forwarded headers", async () => {
    ctx.publicBaseUrl = "https://configured.example";
    const response = await post("consent", {}, "alice", { "x-forwarded-host": "attacker.example", "x-forwarded-proto": "http" });
    const answer = checkedJson.parse(await response.json());
    const authorization = new URL(z.string().parse(answer.authorizationUrl));
    expect(authorization.searchParams.get("redirect_uri")).toBe(`https://configured.example${VISIBLE_DRIVE_ROUTE_PREFIX}/callback`);
    expect(authorization.searchParams.get("scope")).toBe(`openid ${VISIBLE_FILE_SCOPE}`);
    expect(JSON.stringify(answer)).not.toMatch(/codeVerifier|client-secret|access-alice/);
  });
  it.each(["key", "provider", "configuration"])("fails closed without %s and sends no provider request", async kind => {
    if (kind === "key") ctx.deploymentSecret = () => "";
    if (kind === "provider") ctx.google = null;
    if (kind === "configuration") ctx.publicBaseUrl = "http://remote.example";
    expect((await post("consent", {})).status).toBe(503); expect(calls).toEqual([]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'drive_visible_%'").all()).toEqual([]);
  });
  it.each([
    ["wrong account", "bob", ""], ["duplicate state", "alice", "&state=extra"], ["duplicate code", "alice", "&code=extra"],
  ])("refuses %s callback without burning the correct account state", async (_label, user, extra) => {
    const attempt = await start();
    expect((await get(`callback?state=${attempt.state}&code=owned-code${extra}`, user)).status).toBe(400);
    expect(calls).toEqual([]);
    expect((await get(`callback?state=${attempt.state}&code=owned-code`)).status).toBe(200);
    expect((await get(`callback?state=${attempt.state}&code=owned-code`)).status).toBe(400);
    expect(getVisibleGrant(db, "alice", protector)?.googleSub).toBe("google-alice");
  });
  it("completed consent stores encrypted tokens and disconnect is local and account-specific", async () => {
    connect("bob");
    const attempt = await start();
    expect((await get(`callback?state=${attempt.state}&code=owned-code`)).status).toBe(200);
    const row = db.prepare("SELECT * FROM drive_visible_grants WHERE userId='alice'").get();
    expect(JSON.stringify(row)).not.toMatch(/access-alice|refresh-alice/);
    expect((await post("disconnect", {})).status).toBe(200);
    expect(getVisibleGrant(db, "alice", protector)).toBeNull();
    expect(getVisibleGrant(db, "bob", protector)?.googleSub).toBe("google-bob");
    expect(calls).toHaveLength(1);
  });
  it("declining replacement preserves the previous usable grant", async () => {
    const prior = connect(); const attempt = await start();
    expect((await get(`callback?state=${attempt.state}&error=access_denied`)).status).toBe(400);
    expect(getVisibleGrant(db, "alice", protector)).toEqual(prior); expect(calls).toEqual([]);
  });
  it("uses real signed OIDC verification and guarded official JWKS reads for the dedicated nonce", async () => {
    ctx.verifyIdToken = undefined;
    const attempt = await start();
    const nonce = z.object({ nonce: z.string() }).parse(db.prepare("SELECT nonce FROM drive_visible_oauth_states").get()).nonce;
    const keys = await generateKeyPair("RS256");
    jwks = { keys: [{ ...await exportJWK(keys.publicKey), kid: "owned-key", alg: "RS256", use: "sig" }] };
    const token = await new SignJWT({ nonce }).setProtectedHeader({ alg: "RS256", kid: "owned-key" })
      .setIssuer("https://accounts.google.com").setAudience("synthetic-client").setSubject("google-alice")
      .setIssuedAt().setExpirationTime("1h").sign(keys.privateKey);
    tokenHook = () => Promise.resolve(Response.json({ access_token: "access-alice", refresh_token: "refresh-alice", expires_in: 3600,
      token_type: "Bearer", id_token: token, scope: `openid ${VISIBLE_FILE_SCOPE}` }));
    expect((await get(`callback?state=${attempt.state}&code=owned-code`)).status).toBe(200);
    expect(calls.map(call => new URL(call.url).pathname)).toEqual(["/token", "/oauth2/v3/certs"]);
    expect(getVisibleGrant(db, "alice", protector)?.googleSub).toBe("google-alice");
    expect(calls.every(call => call.authorization === null)).toBe(true);
  });
  it("a verified different Google subject cannot overwrite the existing account grant", async () => {
    const prior = connect(); const attempt = await start();
    verifyHook = () => Promise.resolve("google-bob");
    expect((await get(`callback?state=${attempt.state}&code=owned-code`)).status).toBe(502);
    expect(getVisibleGrant(db, "alice", protector)).toEqual(prior);
  });
  it("provider body streaming is rechecked before identity verification or saving", async () => {
    const prior = connect(); const attempt = await start();
    const bytes = Buffer.from(JSON.stringify({ access_token: "late", refresh_token: "late-refresh", expires_in: 3600,
      token_type: "Bearer", id_token: "verified", scope: VISIBLE_FILE_SCOPE }));
    let pulls = 0;
    tokenHook = () => Promise.resolve(new Response(new ReadableStream({ pull(controller) {
      if (pulls++ === 0) { controller.enqueue(bytes); db.exec("DELETE FROM member WHERE userId='alice'"); }
      else controller.close();
    } })));
    expect((await get(`callback?state=${attempt.state}&code=owned-code`)).status).toBe(502);
    expect(getVisibleGrant(db, "alice", protector)).toEqual(prior);
  });
  it("cancellation while a consumed exchange awaits cannot save or replace the previous grant", async () => {
    const prior = connect(); const attempt = await start();
    let release!: (response: Response) => void; let entered!: () => void;
    const called = new Promise<void>(resolve => { entered = resolve; });
    tokenHook = () => { entered(); return new Promise(resolve => { release = resolve; }); };
    const pending = get(`callback?state=${attempt.state}&code=owned-code`);
    await called;
    expect((await post("cancel", { state: attempt.state })).status).toBe(200);
    release(Response.json({ access_token: "replacement", refresh_token: "replacement-refresh", expires_in: 3600,
      token_type: "Bearer", id_token: "verified", scope: VISIBLE_FILE_SCOPE }));
    expect((await pending).status).toBe(502);
    expect(getVisibleGrant(db, "alice", protector)).toEqual(prior);
    expect(db.prepare("SELECT * FROM drive_visible_oauth_states").all()).toEqual([]);
  });
  it("a newer consent wins over an older consumed exchange, and its state survives older cleanup", async () => {
    const prior = connect(); const old = await start();
    let release!: () => void; let entered!: () => void;
    const called = new Promise<void>(resolve => { entered = resolve; });
    verifyHook = () => { entered(); return new Promise(resolve => { release = () => resolve("google-alice"); }); };
    const pending = get(`callback?state=${old.state}&code=owned-code`);
    await called;
    const newer = await start(); release();
    expect((await pending).status).toBe(409);
    expect(getVisibleGrant(db, "alice", protector)).toEqual(prior);
    expect(consumeVisibleConsentState(db, { ...session("alice"), state: newer.state }, protector, clock)).not.toBeNull();
  });
  it.each(["delete", "expiry", "member", "rotate", "async-invalid"])("rechecks %s after provider fetch before body/identity/save", async kind => {
    const prior = connect(); const attempt = await start();
    readHook = url => {
      if (!url.includes("oauth2.googleapis.com")) return;
      if (kind === "delete") db.exec("DELETE FROM session WHERE userId='alice'");
      if (kind === "expiry") clock += 2 * 86_400_000;
      if (kind === "member") db.exec("DELETE FROM member WHERE userId='alice'");
      if (kind === "rotate") db.exec("UPDATE session SET token='changed' WHERE userId='alice'");
      if (kind === "async-invalid") sessionHook = () => Promise.resolve(null);
    };
    expect((await get(`callback?state=${attempt.state}&code=owned-code`)).status).toBe(502);
    expect(getVisibleGrant(db, "alice", protector)).toEqual(prior);
    expect(calls).toHaveLength(1);
  });
  it("settings capture is explicit, account-bound and required for the real five-file projection", async () => {
    connect(); connect("bob");
    expect((await get("projection")).status).toBe(503);
    expect((await post("settings", { values: { theme: "dark", density: "compact", discarded: "not-persisted" } })).status).toBe(200);
    const answer = checkedJson.parse(await (await get("projection")).json());
    expect(parseVisibleFiles(z.record(z.string(), z.string()).parse(answer.files)).ok).toBe(true);
    expect(JSON.stringify(answer)).toContain("alice-thread durable body");
    expect(JSON.stringify(answer)).not.toContain("bob-thread durable body");
    expect((await get("projection", "bob")).status).toBe(503);
    expect(db.prepare("SELECT * FROM drive_visible_settings").all()).toHaveLength(1);
    expect(calls).toEqual([]);
  });
  it("refresh preserves exact account custody and then serves the real projection", async () => {
    const prior = connect("alice", 1000);
    await post("settings", { values: { theme: "dark" } });
    expect((await get("projection")).status).toBe(200);
    const refreshed = getVisibleGrant(db, "alice", protector);
    expect(refreshed?.generation).toBe(prior.generation);
    expect(refreshed?.googleSub).toBe(prior.googleSub);
    expect(refreshed?.expiresAt).toBeGreaterThan(prior.expiresAt);
    expect(calls.map(call => new URL(call.url).pathname)).toEqual(["/token"]);
  });
  it("revocation during refresh token response prevents a new credential save and all later requests", async () => {
    connect("alice", 1000);
    readHook = url => { if (url.includes("oauth2.googleapis.com")) db.exec("DELETE FROM drive_visible_grants WHERE userId='alice'"); };
    expect((await get("projection")).status).toBe(409);
    expect(db.prepare("SELECT * FROM drive_visible_grants").all()).toEqual([]);
    expect(calls).toHaveLength(1);
  });
  it("malformed backup/restore inputs cannot trigger token refresh or transport", async () => {
    connect("alice", 1000);
    expect((await post("backup", { passphrase: "short" })).status).toBe(400);
    expect((await post("restore/inspect", { fileId: "../foreign", passphrase: "owned-passphrase" })).status).toBe(400);
    expect(calls).toEqual([]);
  });
  it("rejects forged workspace, credentials and unbounded/invalid captures before settings mutation", async () => {
    expect((await post("settings", { values: {}, workspaceId: "bob-org" })).status).toBe(400);
    expect((await post("settings", { values: { accessToken: "private" } })).status).toBe(400);
    expect((await post("settings", { values: { theme: "x".repeat(4001) } })).status).toBe(400);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='drive_visible_settings'").all()).toEqual([]);
    expect(calls).toEqual([]);
  });
  it("creates an immutable encrypted copy, verifies the download and returns only inert restore inspection", async () => {
    connect(); await post("settings", { values: { theme: "dark" } });
    const response = await post("backup", { passphrase: "owned-account-passphrase" });
    const answer = checkedJson.parse(await response.json());
    expect(response.status, JSON.stringify({ answer, calls })).toBe(200);
    expect(answer.status).toBe("verified"); expect(answer.apply).toBe("unsupported");
    expect([...files.values()].filter(file => file.ref.mimeType === FOLDER_MIME)).toHaveLength(2);
    const ciphertext = files.get(z.string().parse(answer.fileId))!.bytes;
    expect(ciphertext.toString()).not.toContain("alice-thread durable body");
    const before = db.prepare("SELECT * FROM drive_visible_grants").all();
    const inspected = await post("restore/inspect", { fileId: answer.fileId, passphrase: "owned-account-passphrase" });
    expect(inspected.status).toBe(200);
    const restored = checkedJson.parse(await inspected.json());
    expect(restored.apply).toBe("unsupported");
    expect(JSON.stringify(restored)).toContain("alice-thread durable body");
    expect(db.prepare("SELECT * FROM drive_visible_grants").all()).toEqual(before);
    const again = await post("backup", { passphrase: "owned-account-passphrase" });
    expect(checkedJson.parse(await again.json()).created).toBe(false);
    expect(calls.some(call => ["PATCH", "DELETE"].includes(call.method))).toBe(false);
    connect("bob");
    expect((await post("restore/inspect", { fileId: answer.fileId, passphrase: "owned-account-passphrase" }, "bob")).status).toBe(422);
  });
  it("revocation between metadata and media prevents further outbound requests", async () => {
    connect();
    files.set("copy", { ref: { id: "copy", name: "copy.enc", mimeType: "application/octet-stream", parents: ["backups"], md5Checksum: md5(Buffer.from("data")) }, bytes: Buffer.from("data") });
    readHook = url => { if (url.includes("/files/copy")) db.exec("DELETE FROM drive_visible_grants WHERE userId='alice'"); };
    expect((await post("restore/inspect", { fileId: "copy", passphrase: "owned-passphrase" })).status).toBe(409);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).not.toContain("alt=media");
  });
  it("async signed-session revalidation stops media even when cached synchronous rows still look valid", async () => {
    connect();
    files.set("copy", { ref: { id: "copy", name: "copy.enc", mimeType: "application/octet-stream", parents: ["backups"], md5Checksum: md5(Buffer.from("data")) }, bytes: Buffer.from("data") });
    readHook = () => { sessionHook = () => Promise.resolve(null); };
    expect((await post("restore/inspect", { fileId: "copy", passphrase: "owned-passphrase" })).status).toBe(409);
    expect(calls).toHaveLength(1);
  });
  it("unknown/apply/HEAD routes have no mutation and body inputs stay bounded", async () => {
    expect((await post("restore/apply", {})).status).toBe(404);
    expect((await get("callback?state=anything&code=anything", "alice", { method: "HEAD" })).status).toBe(405);
    expect((await get("consent", "alice", { method: "POST", headers: { origin }, body: "{}" })).status).toBe(415);
    expect((await post("consent", { value: "x".repeat(32768) })).status).toBe(413);
    expect(calls).toEqual([]);
  });
  it("request cancellation after token exchange begins consumes only its attempt and preserves the prior grant", async () => {
    const prior = connect(); const attempt = await start();
    let entered!: () => void; const called = new Promise<void>(resolve => { entered = resolve; });
    let release!: (response: Response) => void;
    tokenHook = () => { entered(); return new Promise(resolve => { release = resolve; }); };
    const stop = new AbortController();
    const pending = get(`callback?state=${attempt.state}&code=owned-code`, "alice", { signal: stop.signal }).catch(() => null);
    await called; stop.abort(); await pending;
    await vi.waitFor(() => expect(db.prepare("SELECT * FROM drive_visible_oauth_states").all()).toEqual([]));
    release(Response.json({ access_token: "late", refresh_token: "late", expires_in: 3600, token_type: "Bearer", id_token: "late", scope: VISIBLE_FILE_SCOPE }));
    expect(getVisibleGrant(db, "alice", protector)).toEqual(prior);
  });
});
