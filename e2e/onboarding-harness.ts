/** Owned local runtime for manual onboarding browser checks. No provider keys
 * are inherited. A loopback proxy can fail one request before forwarding it. */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, request as httpRequest, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { pairingServerEnvironment, waitForOwnedServer } from "./pairing-harness.ts";
import { freePortBlock } from "../server/testing/ports.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export type OnboardingOperation = "roster" | "create" | "patch" | "send" | "gate";
type Fault = { operation: OnboardingOperation; status: number; error: string; delayMs?: number; expireCookie?: boolean };
type RequestRecord = { operation: OnboardingOperation; status: number; injected: boolean; source: "browser" | "control" };

function operationFor(method: string, path: string): OnboardingOperation | null {
  if (path === "/api/bots") return method === "GET" ? "roster" : method === "POST" ? "create" : null;
  if (method === "PATCH" && /^\/api\/bots\/[\w-]+$/.test(path)) return "patch";
  if (method === "POST" && /^\/api\/bots\/[\w-]+\/messages$/.test(path)) return "send";
  return method === "PUT" && path === "/api/me/onboarding" ? "gate" : null;
}

export async function startOnboardingHarness() {
  const rootDirectory = await mkdtemp(join(tmpdir(), "muster-onboarding-audit-"));
  const port = await freePortBlock([0, 1, 2], 37000, 1500);
  const serverUrl = `http://127.0.0.1:${port}`;
  const proxyPort = port + 2;
  const host = `muster-onboarding-${randomBytes(5).toString("hex")}.localhost:${proxyPort}`;
  const url = `http://${host}`;
  const loopbackProxyUrl = `http://127.0.0.1:${proxyPort}`;
  const home = join(rootDirectory, "home");
  const dataDirectory = join(rootDirectory, "data");
  const companionDirectory = join(rootDirectory, "companion");
  for (const directory of [home, dataDirectory, companionDirectory]) await mkdir(directory, { mode: 0o700 });
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const cli = join(rootDirectory, "fake-acp");
  await writeFile(cli, `#!/bin/sh\nexec ${quote(process.execPath)} --experimental-strip-types ${quote(join(ROOT, "server/testing/fake-acp-cli.ts"))} "$@"\n`, { mode: 0o700 });
  await writeFile(join(dataDirectory, "config.json"), JSON.stringify({ instances: {
    gemini: { driver: "geminiAgent", displayName: "Onboarding fixture", environment: { FAKE_ACP_MODE: "happy" },
      config: { cli, fullAuto: false, workspace: home } },
  } }), { mode: 0o600 });
  // Expired trial exercises the real Free tier rather than inventing a cap.
  await writeFile(join(dataDirectory, "license.json"), JSON.stringify({ firstLaunchAt: "2020-01-01T00:00:00.000Z", license: null }), { mode: 0o600 });
  const env = pairingServerEnvironment({ home, dataDirectory, companionDirectory, staticDir: join(ROOT, "dist"), port, webhookPort: port + 1, secret: randomBytes(32).toString("hex") });
  Object.assign(env, { OMB_PUBLIC_URL: url, OMB_PUBLIC_HOST: host, OMB_ALLOW_SIGNUPS: "true", GOOGLE_CLIENT_ID: randomBytes(24).toString("hex"), GOOGLE_CLIENT_SECRET: randomBytes(32).toString("hex") });
  let fault: Fault | null = null;
  const records: RequestRecord[] = [];
  const pendingResponses = new Set<ServerResponse>();
  const proxy = createServer((req, res) => {
    const path = new URL(req.url ?? "/", url).pathname;
    const operation = operationFor(req.method ?? "GET", path);
    const source = req.headers["x-muster-audit-control"] === "1" ? "control" : "browser";
    const chosen = source === "browser" && operation && fault?.operation === operation ? fault : null;
    if (chosen) {
      fault = null;
      pendingResponses.add(res);
      const timer = setTimeout(() => {
        pendingResponses.delete(res);
        if (res.destroyed) return;
        // Only this fixture's dedicated hostname is affected.
        const cookies = chosen.expireCookie
          ? (req.headers.cookie ?? "").split(";").map((part) => part.trim().split("=")[0])
            .filter((name) => name.includes("better-auth"))
            .map((name) => `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`)
          : [];
        const headers = { "content-type": "application/json", "set-cookie": cookies };
        records.push({ operation: chosen.operation, status: chosen.status, injected: true, source });
        res.writeHead(chosen.status, headers).end(JSON.stringify({ error: chosen.error }));
      }, chosen.delayMs ?? 0);
      res.once("close", () => { clearTimeout(timer); pendingResponses.delete(res); });
      req.resume();
      return;
    }
    const upstream = httpRequest(`${serverUrl}${req.url ?? "/"}`, { method: req.method, headers: { ...req.headers, host } }, (reply) => {
      if (operation) records.push({ operation, status: reply.statusCode ?? 502, injected: false, source });
      res.writeHead(reply.statusCode ?? 502, reply.headers);
      reply.pipe(res);
    });
    upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    res.once("close", () => upstream.destroy());
    req.pipe(upstream);
  });
  const child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "server/index.ts")], { cwd: ROOT, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let closed = false;
  const closing = new Promise<void>((done) => child.once("close", () => { closed = true; done(); }));
  child.stdout?.on("data", () => {});
  child.stderr?.on("data", () => {});
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    for (const response of pendingResponses) response.destroy();
    proxy.closeAllConnections();
    if (proxy.listening) await new Promise<void>((done) => proxy.close(() => done()));
    const signal = (value: NodeJS.Signals) => {
      if (closed || !child.pid) return;
      try { process.kill(-child.pid, value); } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
      }
    };
    const waitClosed = async (ms: number) => {
      if (closed) return true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([closing.then(() => true), new Promise<boolean>((done) => {
          timer = setTimeout(() => done(false), ms);
        })]);
      } finally { if (timer) clearTimeout(timer); }
    };
    signal("SIGTERM");
    if (!(await waitClosed(3000))) {
      signal("SIGKILL");
      if (!(await waitClosed(2000))) throw new Error(`Owned onboarding server ${child.pid} did not close`);
    }
    await rm(rootDirectory, { recursive: true, force: true });
    stopped = true;
  };
  try {
    await waitForOwnedServer(child, serverUrl);
    await new Promise<void>((done, reject) => { proxy.once("error", reject); proxy.listen(proxyPort, "127.0.0.1", done); });
    const email = `onboarding-${randomBytes(8).toString("hex")}@example.test`;
    const password = randomBytes(32).toString("base64url");
    const signup = await fetch(`${loopbackProxyUrl}/api/auth/sign-up/email`, { method: "POST", headers: { host, origin: url, "content-type": "application/json" }, body: JSON.stringify({ email, password, name: "Onboarding Audit Owner" }) });
    if (!signup.ok) throw new Error(`fixture signup failed (${signup.status}): ${await signup.text()}`);
    const cookie = signup.headers.getSetCookie().map((item) => item.split(";")[0]).join("; ");
    await signup.arrayBuffer();
    const api = async (path: string, init: RequestInit = {}) => {
      if (!path.startsWith("/api/")) throw new Error("fixture API path required");
      const response = await fetch(`${loopbackProxyUrl}${path}`, { ...init, headers: { host, origin: url, cookie, "content-type": "application/json", ...init.headers, "x-muster-audit-control": "1" } });
      const body: unknown = await response.json();
      return { status: response.status, body };
    };
    return { url, serverUrl, email, password, rootDirectory, pid: child.pid, api, stop,
      failNext: (next: Fault) => { fault = next; },
      clearFault: () => { fault = null; },
      records: () => records.slice(),
      resetRecords: () => { records.length = 0; },
    };
  } catch (error) { await stop(); throw error; }
}

/** CLI: inspect counts/state or arm a fault from stdin while CUA operates the
 * real browser. Never accepts code or forwards requests outside this fixture. */
if (process.argv.includes("--onboarding-audit")) {
  const harness = await startOnboardingHarness();
  console.log(JSON.stringify({ url: harness.url, email: harness.email, password: harness.password, root: harness.rootDirectory, pid: harness.pid }));
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    if (line === "stop") break;
    if (line === "records") console.log(JSON.stringify(harness.records()));
    else if (line === "reset") harness.resetRecords();
    else if (line === "clear") harness.clearFault();
    else if (line === "roster") console.log(JSON.stringify(await harness.api("/api/bots")));
    else {
      try {
        const command = JSON.parse(line);
        if (command.fault) harness.failNext(command.fault);
        else if (command.api) console.log(JSON.stringify(await harness.api(command.api, command.init)));
      } catch (error) { console.log(error instanceof Error ? error.message : String(error)); }
    }
  }
  lines.close();
  process.stdin.pause();
  await harness.stop();
  console.log("Owned onboarding fixture, proxy and data removed");
}
