// The host-operation boundary (platform audit F1) over real HTTP, with two
// disposable hosted accounts, an INERT probe binary on the server's PATH and
// the deployment's real config.json.
//
// The three routes under test answer questions about the machine the server
// runs on: where its CLIs are, does a given binary run here, and what is in
// the operator's global instance map. A signed-in member is not the operator,
// so none of the three may be reachable for them — not merely hidden in the
// UI. Each case therefore asserts BOTH the refusal and the absence of the
// side effect it would have caused: no host path in the reply, no probe
// marker on disk, and a byte-identical config.json.
//
// The other half of the contract is that the guard must not cost anyone
// anything legitimate: the operator keeps all three routes, a LOCAL
// single-user install keeps all three (no session, no second user), and a
// member's own BYOK key still registers an engine they alone can see.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { pairingServerEnvironment, waitForOwnedServer } from "../e2e/pairing-harness.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import type { JsonValue } from "./schema.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
/** On PATH so `?name=` resolves it; spawned to see whether a probe ran. */
const PROBE_NAME = "muster-inert-probe";
const NO_RESOURCE = { error: "no such resource" };
const OPERATOR_ONLY = { error: "only the deployment operator can change configuration" };

interface Account { id: string; cookie: string }
/** `probeDir` leads this server's PATH, `probePath` is the inert binary in it
 * and `marker` is the file it appends to — per server, so a hosted probe and
 * a local probe can never be mistaken for each other. */
interface OwnedServer { url: string; data: string; networkLog: string; probePath: string; marker: string; configPath: string; port: number }

const instances = z.object({ instances: z.array(z.object({ instanceId: z.string(), cli: z.string().optional() })) });

describe.skipIf(process.platform === "win32")("host operations belong to the operator, over real HTTP", () => {
  let directory: string;
  let hosted: OwnedServer;
  let local: OwnedServer;
  let operator: Account;
  let member: Account;
  const children: ChildProcess[] = [];
  const servers: OwnedServer[] = [];
  const ports: number[] = [];

  const request = (server: OwnedServer, path: string, method = "GET", body?: JsonValue, account?: Account) => {
    const headers = new Headers({ origin: server.url, "content-type": "application/json" });
    if (account) headers.set("cookie", account.cookie);
    const init: RequestInit = { method, headers, redirect: "error", signal: AbortSignal.timeout(15_000) };
    if (body !== undefined) init.body = JSON.stringify(body);
    return fetch(`${server.url}${path}`, init);
  };
  const json = async (response: Response) => z.record(z.string(), z.unknown()).parse(await response.json());
  const ran = (server: OwnedServer) => existsSync(server.marker);
  const configBytes = (server: OwnedServer) => readFileSync(server.configPath, "utf8");

  async function boot(kind: "hosted" | "local", port: number): Promise<OwnedServer> {
    const root = join(directory, kind);
    const data = join(root, "data");
    const home = join(root, "home");
    const companionDirectory = join(root, "companion");
    for (const path of [data, home, companionDirectory]) mkdirSync(path, { recursive: true, mode: 0o700 });
    const configPath = join(data, "config.json");
    // `ghost` is the operator's global instance. A member patching it is the
    // exact global-mutation case F1 describes.
    writeFileSync(configPath, JSON.stringify({ profile: { name: `${kind} operator profile` }, instances: { ghost: { driver: "not-a-real-driver", displayName: `${kind} ghost` } } }));
    // Lapsed trial, no license: this fixture runs on the FREE tier.
    writeFileSync(join(data, "license.json"), JSON.stringify({ firstLaunchAt: new Date(Date.now() - 30 * 86_400_000).toISOString(), license: null }));
    const networkLog = join(root, "outbound.log");
    const preload = join(root, "block-outbound.mjs");
    writeFileSync(preload, `import { Socket } from "node:net";\nimport { appendFileSync } from "node:fs";\nconst blocked = () => { appendFileSync(${JSON.stringify(networkLog)}, "blocked\\n"); throw new Error("Owned fixture refuses outbound traffic"); };\nglobalThis.fetch = blocked; Socket.prototype.connect = blocked;\n`);
    // The probe appends to `marker` and prints a version line: inert apart
    // from proving it ran, which is what separates "refused" from "refused
    // after doing it anyway".
    const probeDir = join(root, "hostbin");
    const marker = join(root, "probe-ran");
    mkdirSync(probeDir, { recursive: true });
    const probePath = join(probeDir, PROBE_NAME);
    writeFileSync(probePath, `#!/bin/sh\nprintf 'probe\\n' >> ${JSON.stringify(marker)}\necho "9.9.9-inert"\n`);
    chmodSync(probePath, 0o755);
    const env = pairingServerEnvironment({ home, dataDirectory: data, companionDirectory, staticDir: join(directory, "ui"), port, webhookPort: port + 1, secret: randomBytes(32).toString("hex") });
    // The probe dir leads PATH so discovery finds it by bare name.
    env.PATH = [probeDir, ...(env.PATH ?? "").split(delimiter)].filter(Boolean).join(delimiter);
    if (kind === "hosted") Object.assign(env, { OMB_PUBLIC_HOST: `127.0.0.1:${port}`, OMB_ALLOW_SIGNUPS: "true", GOOGLE_CLIENT_ID: randomBytes(24).toString("hex"), GOOGLE_CLIENT_SECRET: randomBytes(24).toString("hex") });
    const child = spawn(process.execPath, ["--import", preload, "--experimental-strip-types", join(ROOT, "server/index.ts")], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", () => {});
    const server: OwnedServer = { url: `http://127.0.0.1:${port}`, data, networkLog, probePath, marker, configPath, port };
    servers.push(server);
    await waitForOwnedServer(child, server.url);
    return server;
  }

  async function signUp(name: string): Promise<Account> {
    const response = await request(hosted, "/api/auth/sign-up/email", "POST", { name, email: `${name}-${randomBytes(10).toString("hex")}@example.test`, password: randomBytes(32).toString("base64url") });
    expect(response.status).toBe(200);
    const { user } = z.object({ user: z.object({ id: z.string() }) }).parse(await response.json());
    const header = response.headers.getSetCookie().find((value) => value.startsWith("better-auth.session_token="));
    if (!header) throw new Error("Owned signup did not return a session");
    return { id: user.id, cookie: header.split(";")[0] };
  }

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "muster-host-operator-guard-"));
    mkdirSync(join(directory, "ui"), { recursive: true });
    writeFileSync(join(directory, "ui", "index.html"), "<!doctype html><title>Owned host guard fixture</title>");
    const port = await freePortBlock([0, 1, 2, 3], 28200, 8000);
    ports.push(port, port + 1, port + 2, port + 3);
    hosted = await boot("hosted", port);
    local = await boot("local", port + 2);
    operator = await signUp("operator");
    member = await signUp("member");
  }, 90_000);

  afterAll(async () => {
    await Promise.all(children.map((child) => waitForExit(child, { signal: "SIGTERM" })));
    const exited = children.every((child) => child.exitCode !== null || child.signalCode !== null);
    const closedPorts = await Promise.all(ports.map((port) => new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.setTimeout(2_000);
      socket.once("connect", () => { socket.destroy(); resolve(false); });
      socket.once("timeout", () => { socket.destroy(); resolve(false); });
      socket.once("error", (error) => { socket.destroy(); resolve("code" in error && error.code === "ECONNREFUSED"); });
    })));
    const noOutbound = servers.every((server) => !existsSync(server.networkLog));
    if (directory && exited) await removeTempDir(directory);
    const rootRemoved = !directory || !existsSync(directory);
    console.info(JSON.stringify({ scope: "host operator guard cleanup", pids: children.map((child) => child.pid), exited, ports, closedPorts, noOutbound, rootRemoved }));
    expect({ exited, noOutbound, rootRemoved, closed: closedPorts.every(Boolean) }).toEqual({ exited: true, noOutbound: true, rootRemoved: true, closed: true });
  }, 20_000);

  it("proves the operator's host is real before asserting the member cannot see it", async () => {
    // A guard that denies because a fixture is empty proves nothing. These
    // three operator calls establish that discovery finds a real file, the
    // probe really spawns it, and the config really holds `ghost`.
    const found = await request(hosted, `/api/cli-candidates?name=${PROBE_NAME}`, "GET", undefined, operator);
    expect(found.status).toBe(200);
    expect(z.object({ candidates: z.array(z.string()) }).parse(await found.json()).candidates).toContain(hosted.probePath);

    const probed = await request(hosted, "/api/cli-test", "POST", { cli: hosted.probePath }, operator);
    expect(probed.status).toBe(200);
    expect(await json(probed)).toMatchObject({ ok: true, version: "9.9.9-inert" });
    expect(ran(hosted)).toBe(true);

    const patched = await request(hosted, "/api/instances/ghost", "PATCH", { cli: "/opt/ghost/operator-only" }, operator);
    expect(patched.status).toBe(200);
    expect(instances.parse(await patched.json()).instances.find((row) => row.instanceId === "ghost")?.cli).toBe("/opt/ghost/operator-only");
    // Reset so the "unchanged bytes" assertions below start from a known
    // operator-owned state rather than the fixture's original one.
    expect((await request(hosted, "/api/instances/ghost", "PATCH", { cli: "" }, operator)).status).toBe(200);
  });

  it("refuses CLI discovery for a member before any host path is disclosed", async () => {
    const response = await request(hosted, `/api/cli-candidates?name=${PROBE_NAME}`, "GET", undefined, member);
    expect(response.status).toBe(404);
    expect(await json(response)).toEqual(NO_RESOURCE);
    // The refusal must not smuggle the answer back: no probe path, no
    // directory fragment, and no candidate list at all.
    const raw = JSON.stringify(await request(hosted, `/api/cli-candidates?name=${PROBE_NAME}`, "GET", undefined, member).then((r) => r.json()));
    expect(raw).not.toContain(hosted.probePath);
    expect(raw).not.toContain(dirname(hosted.probePath));
    // Anonymous is not a member: it never gets past the session gate.
    expect((await request(hosted, `/api/cli-candidates?name=${PROBE_NAME}`)).status).toBe(401);
  });

  it("refuses the CLI probe for a member before the host spawns anything", async () => {
    // A fresh marker per case: a file left by the operator's probe above must
    // not be mistaken for this one having run.
    rmMarker(hosted);
    const response = await request(hosted, "/api/cli-test", "POST", { cli: hosted.probePath, driver: "claudeAgent" }, member);
    expect(response.status).toBe(404);
    expect(await json(response)).toEqual(NO_RESOURCE);
    // The side-effect assertion, not just the status.
    expect(ran(hosted)).toBe(false);
  });

  it("refuses the instance CLI override for a member before global config changes", async () => {
    const before = configBytes(hosted);
    const response = await request(hosted, "/api/instances/ghost", "PATCH", { cli: "/opt/ghost/member-smuggled" }, member);
    expect(response.status).toBe(403);
    expect(await json(response)).toEqual(OPERATOR_ONLY);
    expect(configBytes(hosted)).toBe(before);
    // Re-read through the API the operator uses: the override never landed in
    // the live registry either, not just on disk.
    const rows = instances.parse(await (await request(hosted, "/api/instances", "GET", undefined, operator)).json()).instances;
    expect(rows.find((row) => row.instanceId === "ghost")?.cli).toBeUndefined();
  });

  it("keeps a member's own BYOK usable while the operator's fleet stays theirs", async () => {
    const saved = await request(hosted, "/api/user-keys", "PUT", { providerId: "deepseek", apiKey: "sk-member-own-key" }, member);
    expect(saved.status).toBe(200);
    const own = instances.parse(await (await request(hosted, "/api/instances", "GET", undefined, member)).json()).instances;
    expect(own.map((row) => row.instanceId)).toContain(`deepseekApi:${member.id}`);
    expect(own.map((row) => row.instanceId)).not.toContain("ghost");
    // The operator's own fleet is unaffected by the member saving a key.
    const operatorRows = instances.parse(await (await request(hosted, "/api/instances", "GET", undefined, operator)).json()).instances;
    expect(operatorRows.map((row) => row.instanceId)).toContain("ghost");
    // And the pre-existing infra refusals this slice must not weaken.
    expect((await request(hosted, "/api/mcp-servers", "GET", undefined, member)).status).toBe(404);
    expect((await request(hosted, "/api/local-computer", "GET", undefined, member)).status).toBe(404);
    expect((await request(hosted, "/api/mcp-servers", "GET", undefined, operator)).status).toBe(200);
  });

  it("leaves a local single-user install fully able to manage its own host", async () => {
    // No session, no second user: the operator guard keys off the signed-in
    // identity, so a desktop install must lose nothing.
    expect(ran(local)).toBe(false);
    const found = await request(local, `/api/cli-candidates?name=${PROBE_NAME}`);
    expect(found.status).toBe(200);
    expect(z.object({ candidates: z.array(z.string()) }).parse(await found.json()).candidates).toContain(local.probePath);

    const probed = await request(local, "/api/cli-test", "POST", { cli: local.probePath });
    expect(probed.status).toBe(200);
    expect(await json(probed)).toMatchObject({ ok: true, version: "9.9.9-inert" });
    expect(ran(local)).toBe(true);

    const patched = await request(local, "/api/instances/ghost", "PATCH", { cli: "/opt/ghost/local-only" });
    expect(patched.status).toBe(200);
    expect(instances.parse(await patched.json()).instances.find((row) => row.instanceId === "ghost")?.cli).toBe("/opt/ghost/local-only");
  });

  /** Delete, never truncate: `ran()` is an existence check, and an emptied
   * marker would read as "the probe ran" to the very next assertion. */
  function rmMarker(server: OwnedServer) {
    rmSync(server.marker, { force: true });
    expect(ran(server)).toBe(false);
  }
});
