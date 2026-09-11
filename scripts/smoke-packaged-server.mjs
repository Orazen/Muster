// Run the server and native dependency outside the repo's node_modules tree.
// Default: standalone Node. For desktop gates pass the packaged executable,
// its exact Electron version and architecture; never silently test host Node.
import { execFile, spawn } from "node:child_process";
import { randomInt } from "node:crypto";
import { cpSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { observeOwnedPosixGroup } from "./owned-posix-processes.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({ options: {
  "server-dir": { type: "string", default: join(root, "dist-server") },
  runtime: { type: "string" },
  "electron-version": { type: "string" },
  arch: { type: "string", default: process.arch },
  platform: { type: "string", default: process.platform },
} });
if (Boolean(values.runtime) !== Boolean(values["electron-version"])) {
  throw new Error("Desktop smoke requires both --runtime and --electron-version");
}
const runtime = values.runtime ? resolve(values.runtime) : process.execPath;
const expectedElectron = values["electron-version"] ?? null;
const expectedArch = values.arch;
const expectedPlatform = values.platform;
const source = realpathSync(values["server-dir"]);
const fixture = mkdtempSync(join(tmpdir(), "muster-package-smoke-"));
const staging = join(fixture, "server");
const fixtureHome = join(fixture, "home");
const fixtureData = join(fixture, "data");
let child;
let probeChild;
let verifiedReport;
let executionError;
let output = "";
let childError;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const interruption = new AbortController();
const onInterrupt = () => interruption.abort();
const onParentMessage = (message) => { if (message === "muster-smoke-cancel") interruption.abort(); };
process.on("SIGINT", onInterrupt);
process.on("SIGTERM", onInterrupt);
process.on("message", onParentMessage);

async function freePortPair() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const port = randomInt(21000, 50000);
    const listeners = [];
    try {
      for (const candidate of [port, port + 1]) {
        const server = createServer();
        listeners.push(server);
        await new Promise((resolve, reject) => {
          server.once("error", reject);
          server.listen(candidate, "127.0.0.1", resolve);
        });
      }
      return port;
    } catch (error) {
      if (error.code !== "EADDRINUSE") throw error;
    } finally {
      await Promise.all(listeners.filter((server) => server.listening).map((server) => new Promise((resolve) => server.close(resolve))));
    }
  }
  throw new Error("No free owned port pair found");
}

function contained(file) {
  const path = relative(realpathSync(staging), realpathSync(file));
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function runProbe(probe, env) {
  interruption.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    // execFile does not forward detached to spawn. Use spawn directly so
    // cancellation can reap a resistant probe and its whole owned group.
    probeChild = spawn(runtime, [probe], {
      cwd: fixture, env, detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => finish(new Error("Native runtime probe timed out")), 30_000);
    const abort = () => finish(new Error("Native runtime probe interrupted"));
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      interruption.signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve({ stdout });
    }
    interruption.signal.addEventListener("abort", abort, { once: true });
    probeChild.stdout.on("data", (chunk) => {
      if (settled) return;
      stdout += chunk;
      if (stdout.length > 1_000_000) finish(new Error("Native probe stdout exceeded its limit"));
    });
    probeChild.stderr.on("data", (chunk) => {
      if (settled) return;
      stderr += chunk;
      if (stderr.length > 1_000_000) finish(new Error("Native probe stderr exceeded its limit"));
    });
    for (const stream of [probeChild.stdout, probeChild.stderr]) stream.once("error", finish);
    probeChild.once("error", finish);
    probeChild.once("close", (code, signal) => finish(code === 0 ? null : new Error(`Native runtime probe failed (${signal ?? code}):\n${stderr}`)));
  });
}

async function stopOwnedChild(child) {
  if (!child?.pid) return;
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  const groupAlive = () => {
    if (process.platform === "win32") return !exited();
    return observeOwnedPosixGroup(child.pid).liveMembers.length > 0;
  };
  if (process.platform === "win32" && !exited()) {
    // A Node/Electron child may own helper processes. Restrict taskkill to
    // this exact child tree, then await exit before removing fixture data.
    await promisify(execFile)("taskkill", ["/pid", String(child.pid), "/T", "/F"]).catch(() => {});
  } else if (process.platform !== "win32" && groupAlive()) {
    try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  }
  const deadline = Date.now() + 5_000;
  while ((!exited() || groupAlive()) && Date.now() < deadline) await delay(50);
  if (!exited() || groupAlive()) {
    if (process.platform === "win32") child.kill("SIGKILL");
    else if (groupAlive()) { try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; } }
    const forcedDeadline = Date.now() + 5_000;
    while ((!exited() || groupAlive()) && Date.now() < forcedDeadline) await delay(50);
  }
  if (!exited() || groupAlive()) throw new Error("Owned smoke process tree did not exit; fixture retained");
}

try {
  cpSync(source, staging, { recursive: true, dereference: true });
  for (const directory of [fixtureHome, fixtureData]) mkdirSync(directory, { recursive: true });
  writeFileSync(join(fixtureData, "config.json"), JSON.stringify({
    instances: { ghost: { driver: "not-a-real-driver", displayName: "Offline package fixture" } },
  }));
  const port = await freePortPair();
  // Preserve only the OS environment needed to execute the owned child.
  // No credentials, real user data, Node flags or alternate module paths.
  const childEnv = {
    HOME: fixtureHome, USERPROFILE: fixtureHome, OMB_USER_DATA: fixtureData,
    OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1),
    OMB_COMPANION_DIR: join(fixture, "companion"),
  };
  for (const key of ["PATH", "SystemRoot", "TMPDIR", "TEMP", "TMP", "LANG"]) {
    if (process.env[key]) childEnv[key] = process.env[key];
  }
  if (expectedElectron) childEnv.ELECTRON_RUN_AS_NODE = "1";

  const probe = join(staging, "package-runtime-probe.mjs");
  writeFileSync(probe, [
    'import { existsSync } from "node:fs";',
    'import { createRequire } from "node:module";',
    'import { SPAWNED_PROXIES } from "./proxy-paths.js";',
    'const require = createRequire(import.meta.url);',
    'const Database = require("./_native/better-sqlite3/lib/index.js");',
    'const db = new Database(":memory:");',
    'let value;',
    'try { db.exec("CREATE TABLE proof (value INTEGER)"); db.prepare("INSERT INTO proof VALUES (?)").run(17); value = db.prepare("SELECT value FROM proof").get().value; } finally { db.close(); }',
    'console.log(JSON.stringify({ electron: process.versions.electron ?? null, node: process.versions.node, abi: process.versions.modules, arch: process.arch, platform: process.platform, value, proxies: SPAWNED_PROXIES, missing: Object.values(SPAWNED_PROXIES).filter((path) => !existsSync(path)) }));',
  ].join("\n"));
  const { stdout } = await runProbe(probe, childEnv);
  const report = JSON.parse(stdout);
  if (report.electron !== expectedElectron || report.arch !== expectedArch || report.platform !== expectedPlatform) {
    throw new Error(`Wrong smoke runtime: ${JSON.stringify(report)}`);
  }
  if (report.value !== 17 || report.missing.length || Object.values(report.proxies).some((file) => !contained(file))) {
    throw new Error(`Packaged native/proxy check failed: ${JSON.stringify(report)}`);
  }
  const proxyCount = Object.keys(report.proxies).length;
  if (proxyCount !== 7) throw new Error(`Expected 7 spawned proxy paths, received ${proxyCount}`);

  interruption.signal.throwIfAborted();
  child = spawn(runtime, [join(staging, "index.js")], {
    cwd: fixture, env: childEnv, detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.on("error", (error) => { childError = error; });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output = (output + chunk).slice(-100_000); });
  let healthy = false;
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline && !interruption.signal.aborted && !childError && child.exitCode === null && child.signalCode === null) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.any([AbortSignal.timeout(1_000), interruption.signal]) });
      if (response.ok) {
        const health = await response.json();
        if (health.app !== "muster" || health.pid !== child.pid) throw new Error("Health port belongs to another process");
        healthy = true;
        break;
      }
    } catch (error) {
      if (error.message === "Health port belongs to another process") throw error;
    }
    await delay(200);
  }
  if (!healthy) throw new Error(`Packaged server failed its owned health check: ${childError?.message ?? child.exitCode}\n${output}`);
  verifiedReport = { passed: proxyCount + 2, checks: { ownedHttp: 1, proxyPaths: proxyCount, nativeDatabase: 1 }, runtime: { electron: report.electron, node: report.node, abi: report.abi, arch: report.arch, platform: report.platform } };
} catch (error) {
  executionError = error;
}
const cleanup = await Promise.allSettled([stopOwnedChild(child), stopOwnedChild(probeChild)]);
const cleanupErrors = cleanup.filter((result) => result.status === "rejected").map((result) => result.reason);
if (!cleanupErrors.length) {
  try { rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
  catch (error) { cleanupErrors.push(error); }
}
process.removeListener("SIGINT", onInterrupt);
process.removeListener("SIGTERM", onInterrupt);
process.removeListener("message", onParentMessage);
if (process.connected) process.disconnect();
if (cleanupErrors.length) throw new AggregateError([...(executionError ? [executionError] : []), ...cleanupErrors], "Packaged smoke failed to clean up its owned fixture");
if (executionError) throw executionError;
console.log(JSON.stringify(verifiedReport));
