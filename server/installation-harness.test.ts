// The cross-tenant pin for the installation routes (threat-model rule 1: any
// new /api route touching records MUST ship with a visibility predicate AND a
// harness case). Real hosted server, two real signed-up accounts, all child
// outbound traffic refused — the same shape as devices-harness.test.ts, plus
// the case that motivates a REGISTRY instead of a view: a full server
// RESTART, after which a revoked installation stays revoked and the surviving
// one keeps its stable id.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { pairingServerEnvironment, waitForOwnedServer } from "../e2e/pairing-harness.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const ROOT = join(new URL("../", import.meta.url).pathname);

const installationWire = z.object({
  id: z.string(),
  label: z.string(),
  platform: z.string(),
  capabilities: z.array(z.string()),
  createdAt: z.number(),
  lastSeenAt: z.number(),
  revokedAt: z.number().nullable(),
});

interface Account { cookie: string }

describe("installation authority over real HTTP", () => {
  let directory = "";
  let base = "";
  let port = 0;
  let child: ChildProcess | undefined;
  let env: Record<string, string>;
  const children: ChildProcess[] = [];
  const ports: number[] = [];
  let alice: Account;
  let bob: Account;

  const request = (path: string, method = "GET", account?: Account, body?: Record<string, string>) => {
    const headers = new Headers({ origin: base, "content-type": "application/json" });
    if (account) headers.set("cookie", account.cookie);
    const init: RequestInit = {
      method,
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      body: body === undefined ? undefined : JSON.stringify(body),
    };
    return fetch(`${base}${path}`, init);
  };

  async function signUp(name: string): Promise<Account> {
    const response = await fetch(`${base}/api/auth/sign-up/email`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({
        name,
        email: `${name}-${randomBytes(10).toString("hex")}@example.test`,
        password: randomBytes(32).toString("base64url"),
      }),
    });
    expect(response.status).toBe(200);
    const header = response.headers.getSetCookie().find((value) => value.startsWith("better-auth.session_token="));
    if (!header) throw new Error("Owned signup did not return a session");
    return { cookie: header.split(";")[0]! };
  }

  async function boot(): Promise<void> {
    child = spawn(
      process.execPath,
      ["--import", join(directory, "block-outbound.mjs"), "--experimental-strip-types", join(ROOT, "server/index.ts")],
      { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    children.push(child);
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", () => {});
    await waitForOwnedServer(child, base);
  }

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "muster-installation-harness-"));
    mkdirSync(join(directory, "ui"));
    writeFileSync(join(directory, "ui", "index.html"), "<!doctype html><title>Owned installations fixture</title>");
    const data = join(directory, "data");
    const home = join(directory, "home");
    const companionDirectory = join(directory, "companion");
    for (const path of [data, home, companionDirectory]) mkdirSync(path, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(data, "config.json"),
      JSON.stringify({ profile: { name: "Owned installations fixture" }, instances: { ghost: { driver: "not-a-real-driver", displayName: "Offline fixture" } } }),
      { mode: 0o600 },
    );
    port = await freePortBlock([0, 1], 29000, 10000);
    ports.push(port, port + 1);
    base = `http://127.0.0.1:${port}`;
    const networkLog = join(directory, "outbound.log");
    writeFileSync(
      join(directory, "block-outbound.mjs"),
      [
        `import { Socket } from "node:net";`,
        `import { appendFileSync } from "node:fs";`,
        `const path = ${JSON.stringify(networkLog)};`,
        `const write = (line) => { try { appendFileSync(path, line + "\\n"); } catch {} };`,
        `const LOOPBACK = (host) => !host || host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";`,
        `const realFetch = globalThis.fetch.bind(globalThis);`,
        `globalThis.fetch = (input, init) => {`,
        `  const url = String(typeof input === "string" || input instanceof globalThis.URL ? input : input?.url ?? "");`,
        `  if (LOOPBACK(url.replace(/^https?:\\/\\//u, "").split(/[/:?#]/u)[0])) return realFetch(input, init);`,
        `  write("outbound fetch " + url);`,
        `  throw new Error("Owned fixture refuses non-loopback fetch: " + url);`,
        `};`,
        `const realConnect = Socket.prototype.connect;`,
        `Socket.prototype.connect = function (...args) {`,
        `  const first = args[0];`,
        `  const host = typeof first === "object" && first !== null ? String(first.host ?? "127.0.0.1") : typeof first === "number" ? String(args[1] ?? "127.0.0.1") : null;`,
        `  if (host === null || LOOPBACK(host)) return realConnect.apply(this, args);`,
        `  write("outbound connect " + String(host));`,
        `  throw new Error("Owned fixture refuses non-loopback connect: " + String(host));`,
        `};`,
        ``,
      ].join("\n"),
    );
    env = pairingServerEnvironment({
      home,
      dataDirectory: data,
      companionDirectory,
      staticDir: join(directory, "ui"),
      port,
      webhookPort: port + 1,
      secret: randomBytes(32).toString("hex"),
    });
    Object.assign(env, { OMB_PUBLIC_HOST: `127.0.0.1:${port}`, OMB_ALLOW_SIGNUPS: "true" });
    await boot();
    alice = await signUp("alice");
    bob = await signUp("bob");
  }, 60_000);

  afterAll(async () => {
    await Promise.all(children.map((entry) => waitForExit(entry, { signal: "SIGTERM" })));
    const exited = children.every((entry) => entry.exitCode !== null || entry.signalCode !== null);
    const closedPorts = await Promise.all(
      ports.map(
        (value) =>
          new Promise<boolean>((resolve) => {
            const socket = createConnection({ host: "127.0.0.1", port: value });
            socket.setTimeout(2_000);
            socket.once("connect", () => { socket.destroy(); resolve(false); });
            socket.once("timeout", () => { socket.destroy(); resolve(false); });
            socket.once("error", (error) => { socket.destroy(); resolve("code" in error && error.code === "ECONNREFUSED"); });
          }),
      ),
    );
    const logPath = join(directory, "outbound.log");
    const outboundLog = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
    const noOutbound = outboundLog === "";
    if (directory && exited) await removeTempDir(directory);
    const rootRemoved = !directory || !existsSync(directory);
    expect({ exited, noOutbound, rootRemoved, closed: closedPorts.every(Boolean) }).toEqual({
      exited: true, noOutbound: true, rootRemoved: true, closed: true,
    });
  }, 20_000);

  afterEach(async () => {
    // Restart between cases: every case must hold over a fresh boot, not
    // only inside the process that created the rows.
    await waitForExit(children.pop()!, { signal: "SIGTERM" });
    await boot();
  }, 30_000);

  it("registers for the signed-in account and answers a stable id on re-register", async () => {
    const first = await request("/api/installations/register", "POST", alice, {
      clientKey: "desk-mac-alpha", label: "Study Mac", platform: "macos",
    });
    expect(first.status).toBe(201);
    const created = z.object({
      installation: installationWire,
      credential: z.string(),
      reactivated: z.literal(false),
    }).parse(await first.json());
    expect(created.credential).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    const again = await request("/api/installations/register", "POST", alice, {
      clientKey: "desk-mac-alpha", label: "Study Mac", platform: "macos",
    });
    expect(again.status).toBe(200);
    const reattached = z.object({
      installation: installationWire,
      credential: z.string(),
      reactivated: z.literal(true),
    }).parse(await again.json());
    expect(reattached.installation.id).toBe(created.installation.id);
    // The old credential is dead the moment a new one is minted.
    expect(reattached.credential).not.toBe(created.credential);
  });

  it("keeps accounts apart: bob sees and touches none of alice's installations", async () => {
    const created = z.object({ installation: installationWire }).parse(
      await (await request("/api/installations/register", "POST", alice, {
        clientKey: "alice-box", label: "Alice only", platform: "macos",
      })).json(),
    );
    const bobList = z.object({ installations: z.array(installationWire) }).parse(
      await (await request("/api/installations", "GET", bob)).json(),
    );
    expect(bobList.installations).toHaveLength(0);
    expect((await request("/api/installations/revoke", "POST", bob, { id: created.installation.id })).status).toBe(404);
    expect((await request("/api/installations/rotate", "POST", bob, { id: created.installation.id })).status).toBe(404);
    const aliceList = z.object({ installations: z.array(installationWire) }).parse(
      await (await request("/api/installations", "GET", alice)).json(),
    );
    expect(aliceList.installations.map((row) => row.id)).toContain(created.installation.id);
    expect((await request("/api/installations", "GET")).status).toBe(401);
  });

  it("revokes durably: no resurrect over a restart, and a re-register is a new id", async () => {
    const created = z.object({ installation: installationWire, credential: z.string() }).parse(
      await (await request("/api/installations/register", "POST", alice, {
        clientKey: "to-revoke", label: "Commuter laptop", platform: "windows",
      })).json(),
    );
    expect((await request("/api/installations/revoke", "POST", alice, { id: created.installation.id })).status).toBe(200);
    const after = z.object({ installations: z.array(installationWire) }).parse(
      await (await request("/api/installations", "GET", alice)).json(),
    );
    const row = after.installations.find((entry) => entry.id === created.installation.id);
    expect(row?.revokedAt).toBeTypeOf("number");
    // This afterEach restarts the server; the NEXT case's first assertion
    // re-checks the same registry from a fresh process.
    const survivor = z.object({ installations: z.array(installationWire) }).parse(
      await (await request("/api/installations", "GET", alice)).json(),
    ).installations;
    const reRegistered = await request("/api/installations/register", "POST", alice, {
      clientKey: "to-revoke", label: "Commuter laptop", platform: "windows",
    });
    expect(reRegistered.status).toBe(201); // NEW installation, not the revoked row
    const fresh = z.object({ installation: installationWire }).parse(await reRegistered.json());
    expect(fresh.installation.id).not.toBe(created.installation.id);
    expect(survivor.find((entry) => entry.id === created.installation.id)?.revokedAt).toBeTypeOf("number");
  });

  it("rejects malformed registration instead of minting a row", async () => {
    const tooShort = await request("/api/installations/register", "POST", alice, {
      clientKey: "abc", label: "", platform: "toaster",
    });
    expect(tooShort.status).toBe(400);
    const anonymous = await request("/api/installations/register", "POST", undefined, {
      clientKey: "ghost-machine-1", label: "Ghost", platform: "linux",
    });
    expect(anonymous.status).toBe(401);
  });
});
