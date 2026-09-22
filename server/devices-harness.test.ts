// The cross-tenant pin for the S0 device route (threat-model rule 1: any new
// /api route touching records MUST ship with a visibility predicate AND a
// harness case). Real hosted server, two real signed-up accounts with
// distinct browsers, owned files, all child outbound traffic refused.
//
// The predicate itself lives in two places and both are pinned here: the
// handler reads identity from the SESSION (never from query or body), and
// the view drops foreign rows server-side (devices.test.ts). This harness
// proves the wire agrees — account B never sees account A's device, and a
// cookie-less read gets 401 rather than a roster.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { pairingServerEnvironment, waitForOwnedServer } from "../e2e/pairing-harness.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { deviceIdFor } from "./devices.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const UA_A =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const UA_B =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

const deviceWire = z.object({
  devices: z.array(
    z
      .object({
        id: z.string(),
        name: z.string(),
        platform: z.string(),
        lastSeenAt: z.number(),
        keyEnvelopeStatus: z.string(),
      })
      .passthrough(),
  ),
});

interface Account {
  id: string;
  cookie: string;
}

describe.skipIf(process.platform === "win32")("device inventory over real HTTP", () => {
  let directory = "";
  let base = "";
  let port = 0;
  let child: ChildProcess | undefined;
  const children: ChildProcess[] = [];
  const ports: number[] = [];
  let alice: Account;
  let bob: Account;

  const request = (path: string, method = "GET", account?: Account, userAgent?: string) => {
    const headers = new Headers({ origin: base, "content-type": "application/json" });
    if (account) headers.set("cookie", account.cookie);
    if (userAgent) headers.set("user-agent", userAgent);
    const init: RequestInit = { method, headers, redirect: "error", signal: AbortSignal.timeout(10_000) };
    return fetch(`${base}${path}`, init);
  };

  async function signUp(name: string, userAgent: string): Promise<Account> {
    const response = await fetch(`${base}/api/auth/sign-up/email`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: { origin: base, "content-type": "application/json", "user-agent": userAgent },
      body: JSON.stringify({
        name,
        email: `${name}-${randomBytes(10).toString("hex")}@example.test`,
        password: randomBytes(32).toString("base64url"),
      }),
    });
    expect(response.status).toBe(200);
    const { user } = z.object({ user: z.object({ id: z.string() }) }).parse(await response.json());
    const header = response.headers.getSetCookie().find((value) => value.startsWith("better-auth.session_token="));
    if (!header) throw new Error("Owned signup did not return a session");
    return { id: user.id, cookie: header.split(";")[0] };
  }

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "muster-devices-harness-"));
    mkdirSync(join(directory, "ui"));
    writeFileSync(join(directory, "ui", "index.html"), "<!doctype html><title>Owned devices fixture</title>");
    const data = join(directory, "data");
    const home = join(directory, "home");
    const companionDirectory = join(directory, "companion");
    for (const path of [data, home, companionDirectory]) mkdirSync(path, { recursive: true, mode: 0o700 });
    // The house fixture: a non-empty map of an unknown driver. This matters
    // beyond tidiness — an EMPTY instances map boots config.ts's DEFAULT_FLEET,
    // whose opencodeGo ACP child fetches its model catalog (opencode.ai) at
    // module load, tripping the owned no-outbound guarantee. The ghost is
    // recorded as a shadow entry (unknownDriver) and never created.
    writeFileSync(
      join(data, "config.json"),
      JSON.stringify({ profile: { name: "Owned devices fixture" }, instances: { ghost: { driver: "not-a-real-driver", displayName: "Offline devices fixture" } } }),
      { mode: 0o600 },
    );
    port = await freePortBlock([0, 1], 29000, 10000);
    ports.push(port, port + 1);
    base = `http://127.0.0.1:${port}`;
    const networkLog = join(directory, "outbound.log");
    const preload = join(directory, "block-outbound.mjs");
    writeFileSync(
      preload,
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
        `  write("outbound fetch " + url + " STACK " + String(new Error().stack).split("\\n").join(" | "));`,
        `  throw new Error("Owned fixture refuses non-loopback fetch: " + url);`,
        `};`,
        `const realConnect = Socket.prototype.connect;`,
        `Socket.prototype.connect = function (...args) {`,
        `  const first = args[0];`,
        `  const host = typeof first === "object" && first !== null ? String(first.host ?? "127.0.0.1") : typeof first === "number" ? String(args[1] ?? "127.0.0.1") : null;`,
        `  const port = typeof first === "object" && first !== null ? first.port : first;`,
        `  if (host === null || LOOPBACK(host)) return realConnect.apply(this, args);`,
        `  write("outbound connect " + String(host) + ":" + String(port));`,
        `  throw new Error("Owned fixture refuses non-loopback connect: " + String(host));`,
        `};`,
        ``,
      ].join("\n"),
    );
    const env = pairingServerEnvironment({
      home,
      dataDirectory: data,
      companionDirectory,
      staticDir: join(directory, "ui"),
      port,
      webhookPort: port + 1,
      secret: randomBytes(32).toString("hex"),
    });
    Object.assign(env, { OMB_PUBLIC_HOST: `127.0.0.1:${port}`, OMB_ALLOW_SIGNUPS: "true" });
    child = spawn(
      process.execPath,
      ["--import", preload, "--experimental-strip-types", join(ROOT, "server/index.ts")],
      { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    children.push(child);
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", () => {});
    await waitForOwnedServer(child, base);
    alice = await signUp("alice", UA_A);
    bob = await signUp("bob", UA_B);
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
    console.info(JSON.stringify({ scope: "devices cleanup", pids: children.map((entry) => entry.pid), exited, ports, closedPorts, noOutbound, outboundLog: outboundLog.slice(0, 1600), rootRemoved }));
    expect({ exited, noOutbound, rootRemoved, closed: closedPorts.every(Boolean) }).toEqual({
      exited: true, noOutbound: true, rootRemoved: true, closed: true,
    });
  }, 20_000);

  it("lists only the signed-in account's own device, labelled from its browser", async () => {
    const response = await request("/api/devices", "GET", alice);
    expect(response.status).toBe(200);
    const { devices } = deviceWire.parse(await response.json());
    expect(devices).toHaveLength(1);
    const [device] = devices;
    expect(device!.id).toBe(deviceIdFor(alice.id, UA_A));
    expect(device!.platform).toBe("macos");
    expect(device!.name).toBe("Chrome on macOS");
    expect(device!.keyEnvelopeStatus).toBe("none");
    // the real session row's date survived coercion into a fresh epoch-ms stamp
    const now = Date.now();
    expect(device!.lastSeenAt).toBeGreaterThan(now - 10 * 60_000);
    expect(device!.lastSeenAt).toBeLessThanOrEqual(now + 60_000);
  });

  it("keeps the two accounts' devices apart", async () => {
    const aliceView = deviceWire.parse(await (await request("/api/devices", "GET", alice)).json()).devices;
    const bobView = deviceWire.parse(await (await request("/api/devices", "GET", bob)).json()).devices;
    expect(bobView).toHaveLength(1);
    expect(bobView[0]!.platform).toBe("ios");
    expect(bobView[0]!.id).toBe(deviceIdFor(bob.id, UA_B));
    const aliceIds = aliceView.map((device) => device.id);
    expect(aliceIds).not.toContain(bobView[0]!.id);
    expect(bobView.map((device) => device.id)).not.toContain(deviceIdFor(alice.id, UA_A));
  });

  it("refuses a cookie-less read instead of rostering anyone", async () => {
    const response = await request("/api/devices", "GET");
    expect(response.status).toBe(401);
  });
});
