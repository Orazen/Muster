// Actual HTTP/session/store/SSE boundary. A retained authenticated stream must
// stop receiving data when its session dies, without signing out another
// session for that same account. No email, provider, or fabricated event path.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { pairingServerEnvironment, waitForOwnedServer } from "../e2e/pairing-harness.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const BOT_ID = "retainedssefixturebot0001";
const THREAD_ID = "retainedssefixturethread01";
const sessionSchema = z.object({
  user: z.object({ id: z.string() }),
  session: z.object({ id: z.string(), userId: z.string() }),
});
const botSchema = z.object({ id: z.string(), name: z.string() });
const rosterSchema = z.object({ bots: z.array(botSchema) });
const frameSchema = z.object({
  kind: z.string(), cursor: z.string().optional(), resumed: z.boolean().optional(),
  bot: botSchema.optional(),
});
interface Session {
  cookie: string;
  userId: string;
  sessionId: string;
}
type RequestBody = { email: string; password: string; name?: string } | { name: string } | { sessionId: string };

/** Retains only parsed hello and matching synthetic bot names; never logs a
 * cookie, raw auth response or transcript. Local abort cannot satisfy close. */
class OwnedStream {
  readonly names = new Set<string>();
  hello = false;
  closed = false;
  failed = false;
  locallyStopped = false;
  private buffer = "";
  private bytes = 0;
  private readonly controller = new AbortController();
  private finished = Promise.resolve();

  static async open(base: string, cookie: string): Promise<OwnedStream> {
    const stream = new OwnedStream();
    const handshake = setTimeout(() => { stream.failed = true; stream.controller.abort(); }, 10_000);
    let response: Response;
    try {
      response = await fetch(`${base}/api/events`, {
        headers: { cookie, accept: "text/event-stream" }, signal: stream.controller.signal, redirect: "error",
      });
    } finally { clearTimeout(handshake); }
    if (response.status !== 200 || !response.headers.get("content-type")?.startsWith("text/event-stream") || !response.body) {
      stream.stop();
      throw new Error("Owned event stream did not open with SSE200");
    }
    const reader = response.body.getReader(), decoder = new TextDecoder();
    stream.finished = (async () => {
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) { stream.closed = !stream.locallyStopped; return; }
          stream.bytes += chunk.value.byteLength;
          if (stream.bytes > 1024 * 1024) { stream.failed = true; throw new Error("Owned event stream exceeded its bound"); }
          stream.buffer += decoder.decode(chunk.value, { stream: true });
          let boundary = stream.buffer.indexOf("\n\n");
          while (boundary !== -1) {
            const block = stream.buffer.slice(0, boundary);
            stream.buffer = stream.buffer.slice(boundary + 2);
            const data = block.split("\n").filter(line => line.startsWith("data: ")).map(line => line.slice(6)).join("\n");
            if (data) {
              const frame = (() => {
                try { return frameSchema.parse(JSON.parse(data)); }
                catch { stream.failed = true; throw new Error("Owned event frame could not be parsed"); }
              })();
              if (frame.kind === "hello") stream.hello = frame.resumed === false && Boolean(frame.cursor);
              if (frame.kind === "bot" && frame.bot?.id === BOT_ID) stream.names.add(frame.bot.name);
            }
            boundary = stream.buffer.indexOf("\n\n");
          }
        }
      } catch {
        // The server may end gracefully or destroy the invalid stream. A
        // remote reader rejection is closure, not a locally simulated pass.
        if (!stream.locallyStopped) stream.closed = true;
      } finally { reader.releaseLock(); }
    })();
    return stream;
  }

  stop(): void {
    this.locallyStopped = true;
    this.controller.abort();
  }
  async settle(): Promise<void> { await this.finished; }
}

describe("retained account event streams follow actual session validity", () => {
  let child: ChildProcess | undefined;
  let root = "", data = "", base = "", blockedNetwork = "";
  let initialSession: Session | undefined;
  const streams: OwnedStream[] = [];
  const email = `retained-sse-${randomBytes(8).toString("hex")}@example.test`;
  const password = randomBytes(32).toString("base64url");

  function request(route: string, cookie = "", method = "GET", body?: RequestBody): Promise<Response> {
    const headers = new Headers({ origin: base });
    if (cookie) headers.set("cookie", cookie);
    const hasBody = method === "POST" || method === "PATCH";
    if (hasBody) headers.set("content-type", "application/json");
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(10_000), redirect: "error" };
    if (hasBody) init.body = JSON.stringify(body ?? {});
    return fetch(`${base}${route}`, init);
  }
  async function sessionFor(cookie: string): Promise<Session> {
    const response = await request("/api/auth/get-session?disableRefresh=true", cookie);
    expect(response.status).toBe(200);
    const current = sessionSchema.parse(await response.json());
    expect(current.user.id === current.session.userId).toBe(true);
    return { cookie, userId: current.user.id, sessionId: current.session.id };
  }
  async function authenticate(signup: boolean): Promise<Session> {
    const response = await request(signup ? "/api/auth/sign-up/email" : "/api/auth/sign-in/email", "", "POST", {
      email, password, name: "Owned SSE fixture",
    });
    expect(response.status).toBe(200);
    // No assertion contains a cookie value on failure.
    const cookie = response.headers.getSetCookie().find(value => value.startsWith("better-auth.session_token="))?.split(";")[0];
    if (!cookie) throw new Error("Synthetic authentication did not issue a cookie");
    await response.arrayBuffer();
    return sessionFor(cookie);
  }
  async function assertRejected(session: Session): Promise<void> {
    const response = await request("/api/auth/get-session?disableRefresh=true", session.cookie);
    expect(response.status).toBe(200);
    expect((await response.json()) === null).toBe(true);
    for (const route of ["/api/bots", "/api/events"]) {
      const denied = await request(route, session.cookie);
      expect(denied.status).toBe(401);
      await denied.arrayBuffer();
    }
  }
  async function rename(session: Session, name: string): Promise<void> {
    const response = await request(`/api/bots/${BOT_ID}`, session.cookie, "PATCH", { name });
    expect(response.status).toBe(200);
    const body = z.object({ bot: botSchema }).parse(await response.json());
    expect(body.bot.id).toBe(BOT_ID);
    expect(body.bot.name).toBe(name);
  }

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "muster-retained-sse-"));
    data = join(root, "data");
    const home = join(root, "home"), companion = join(root, "companion"), ui = join(root, "ui");
    for (const directory of [data, home, companion, ui]) mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(join(ui, "index.html"), "<!doctype html><title>Owned SSE fixture</title>");
    writeFileSync(join(data, "config.json"), JSON.stringify({
      instances: { ghost: { driver: "not-a-real-driver", displayName: "Offline SSE fixture" } },
    }));
    // Existing tenant-isolation fixture format: no account exists at boot,
    // so the legacy record remains ownerless. ownerVisible assigns it to the
    // actual first operator; both session assertions below verify that path.
    // This is not a claim about explicit ownerId migration or another tenant.
    const createdAt = Date.now();
    writeFileSync(join(data, "bots.json"), JSON.stringify([{
      id: BOT_ID, threadId: THREAD_ID, name: "Inert legacy fixture", title: "", description: "",
      notifications: true, unread: false, privacyShield: true, color: "orange", character: "star",
      modelSelection: { instanceId: "", model: "" }, resumeCursors: {}, createdAt,
      tasks: [{ threadId: THREAD_ID, title: "First task", createdAt, resumeCursors: {} }],
    }]));
    blockedNetwork = join(root, "blocked-network.txt");
    const preload = join(root, "offline.mjs");
    writeFileSync(preload, `
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import { Socket } from "node:net";
import dgram from "node:dgram";
import childProcess from "node:child_process";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const denied = () => {
  appendFileSync(${JSON.stringify(blockedNetwork)}, "blocked\\n");
  throw new Error("Network disabled in owned SSE fixture");
};
globalThis.fetch = denied;
Socket.prototype.connect = denied;
for (const key of ["lookup", "lookupService", "resolve", "resolve4", "resolve6", "resolveAny", "resolveCname", "resolveMx", "resolveNaptr", "resolveNs", "resolvePtr", "resolveSoa", "resolveSrv", "resolveTxt", "reverse"]) {
  dns[key] = denied; dnsPromises[key] = denied;
  if (key in dns.Resolver.prototype) dns.Resolver.prototype[key] = denied;
  if (key in dnsPromises.Resolver.prototype) dnsPromises.Resolver.prototype[key] = denied;
}
// Numeric loopback lookup is resolved in memory, never by the resolver.
dns.lookup = (host, options, callback) => {
  if (host !== "127.0.0.1") return denied();
  const done = typeof options === "function" ? options : callback;
  queueMicrotask(() => options?.all ? done(null, [{ address: host, family: 4 }]) : done(null, host, 4));
};
dnsPromises.lookup = async host => { if (host !== "127.0.0.1") return denied(); return { address: host, family: 4 }; };
dgram.createSocket = denied;
dgram.Socket.prototype.send = denied;
const unavailable = "/__muster_owned_sse_no_subprocess__";
for (const method of ["execFile", "execFileSync", "spawn", "spawnSync"]) {
  const original = childProcess[method];
  childProcess[method] = (...args) => original(unavailable, ...args.slice(1));
}
for (const method of ["exec", "execSync", "fork"]) childProcess[method] = () => { throw new Error("Subprocess disabled in owned SSE fixture"); };
syncBuiltinESMExports();
setTimeout(() => process.exit(124), 180_000).unref();
`);
    const port = await freePortBlock([0, 1], 27000, 10000);
    base = `http://127.0.0.1:${port}`;
    const env = pairingServerEnvironment({ home, dataDirectory: data, companionDirectory: companion, staticDir: ui,
      port, webhookPort: port + 1, secret: randomBytes(32).toString("hex") });
    env.OMB_PUBLIC_HOST = `127.0.0.1:${port}`;
    env.OMB_ALLOW_SIGNUPS = "true";
    child = spawn(process.execPath, ["--import", preload, "--experimental-strip-types", join(ROOT, "server/index.ts")], {
      cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", () => {});
    await waitForOwnedServer(child, base);
    expect((await request("/api/bots")).status).toBe(401);
    initialSession = await authenticate(true);
  }, 60_000);

  afterAll(async () => {
    for (const stream of streams) stream.stop();
    await waitForExit(child, { signal: "SIGTERM", graceMs: 3_000 });
    await Promise.all(streams.map(stream => stream.settle()));
    expect(!child || child.exitCode !== null || child.signalCode !== null).toBe(true);
    try { expect(existsSync(blockedNetwork), "the fixture must not attempt outbound network").toBe(false); }
    finally { if (root) await removeTempDir(root); }
  }, 15_000);

  for (const cause of ["logout", "revoke-session", "persisted-expiry"]) {
    it(`withholds the next real bot event after ${cause} without revoking the other session`, async () => {
      const a = initialSession ?? await authenticate(false);
      initialSession = undefined;
      const b = await authenticate(false);
      expect(a.userId === b.userId && a.sessionId !== b.sessionId && a.cookie !== b.cookie).toBe(true);
      for (const session of [a, b]) {
        const current = await sessionFor(session.cookie);
        expect(current.sessionId === session.sessionId).toBe(true);
        const config = await request("/api/config", session.cookie);
        expect(config.status).toBe(200);
        expect(z.object({ isOperator: z.boolean() }).parse(await config.json()).isOperator).toBe(true);
        const roster = await request("/api/bots", session.cookie);
        expect(roster.status).toBe(200);
        expect(rosterSchema.parse(await roster.json()).bots.map(bot => bot.id)).toEqual([BOT_ID]);
      }
      const streamA = await OwnedStream.open(base, a.cookie);
      streams.push(streamA);
      const streamB = await OwnedStream.open(base, b.cookie);
      streams.push(streamB);
      try {
        await expect.poll(() => streamA.hello && streamB.hello, { timeout: 5000 }).toBe(true);
        const before = `Synthetic before ${randomBytes(8).toString("hex")}`;
        const after = `Synthetic after ${randomBytes(8).toString("hex")}`;
        await rename(b, before);
        await expect.poll(() => streamA.names.has(before) && streamB.names.has(before), { timeout: 5000 }).toBe(true);
        if (cause === "logout") {
          const response = await request("/api/auth/sign-out", a.cookie, "POST");
          expect(response.status).toBe(200);
          expect(z.object({ success: z.boolean() }).parse(await response.json()).success).toBe(true);
        } else if (cause === "revoke-session") {
          const response = await request("/api/auth/revoke-session", b.cookie, "POST", { sessionId: a.sessionId });
          expect(response.status).toBe(200);
          expect(z.object({ status: z.boolean() }).parse(await response.json()).status).toBe(true);
        } else {
          // Alters one owned synthetic expiry row; no fake clock and no
          // claim of natural seven-day expiry. Do not query A's session
          // before emission: Better Auth could delete it on that read and
          // hide a writer that checks existence but ignores persisted expiry.
          const db = new DatabaseSync(join(data, "auth.db"));
          try {
            const changed = db.prepare('UPDATE "session" SET "expiresAt" = ? WHERE "id" = ? AND "userId" = ?')
              .run(new Date(Date.now() - 1000).toISOString(), a.sessionId, a.userId);
            expect(Number(changed.changes)).toBe(1);
          } finally { db.close(); }
        }
        if (cause !== "persisted-expiry") await assertRejected(a);
        expect((await sessionFor(b.cookie)).sessionId === b.sessionId).toBe(true);
        // Real authorized PATCH -> Store.patchBot -> store.onChange -> SSE.
        // A's stream is deliberately still held; no local abort before outcome.
        await rename(b, after);
        await expect.poll(() => streamB.names.has(after), { timeout: 5000 }).toBe(true);
        await expect.poll(() => streamA.closed || streamA.names.has(after), { timeout: 5000 }).toBe(true);
        expect(streamA.names.has(after), "revoked stream received new account data").toBe(false);
        expect(streamA.closed, "revoked stream must close at the writer boundary").toBe(true);
        expect(streamA.locallyStopped || streamB.locallyStopped || streamA.failed || streamB.failed).toBe(false);
        expect(streamB.closed).toBe(false);
        await assertRejected(a);
        expect((await sessionFor(b.cookie)).sessionId === b.sessionId).toBe(true);
      } finally { streamA.stop(); streamB.stop(); }
    }, 30_000);
  }
});
