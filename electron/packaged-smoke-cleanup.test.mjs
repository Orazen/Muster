// Process-cleanup contracts only: the staged server and database below are
// deliberately fake. Actual native loading has a separate packaged smoke gate.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "../scripts/smoke-packaged-server.mjs");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await delay(25);
  }
  throw new Error("Owned smoke fixture did not reach the expected state");
}

function alive(pid, group = false) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  // Independent of the script's observer: assert exact fixture-marker IDs
  // against a fresh process table. Darwin kill(-pgid, 0) can return EPERM after
  // termination. A zombie is not live; this check does not claim PID absence.
  const output = execFileSync("/bin/ps", ["-axo", "pid=,pgid=,stat="], {
    encoding: "utf8", timeout: 2_000, maxBuffer: 1_000_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines = output.trim().split("\n");
  return lines.map((line) => {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 3 || !fields.slice(0, 2).every((value) => /^\d+$/.test(value))
        || !/^[A-Za-z?][A-Za-z0-9+<>=-]*$/.test(fields[2])) throw new Error(`Independent fixture process observation failed: ${JSON.stringify(line)}`);
    const [processId, processGroup] = fields.slice(0, 2).map(Number);
    if (![processId, processGroup].every(Number.isSafeInteger)) throw new Error("Independent fixture process IDs invalid");
    return (group ? processGroup : processId) === pid && fields[2][0] !== "Z";
  }).some(Boolean);
}

function forceStop(pid, group = false) {
  if (!alive(pid, group)) return;
  try { process.kill(group ? -pid : pid, "SIGKILL"); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
}

function readMarker(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { return null; }
}

function put(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

async function withFixture(mode, run) {
  const root = mkdtempSync(join(tmpdir(), "muster-smoke-cleanup-test-"));
  const source = join(root, "fake server with spaces");
  const temporary = join(root, "smoke temporary files");
  const marker = (name) => join(root, `${name}.json`);
  mkdirSync(temporary);
  put(join(source, "package.json"), JSON.stringify({ type: "module" }));
  put(join(source, "_native/better-sqlite3/package.json"), JSON.stringify({ type: "commonjs" }));
  put(join(source, "_native/better-sqlite3/lib/index.js"), [
    "// Fake database solely for reaching the process-cleanup code path.",
    "module.exports = class FakeDatabase {",
    "  exec() {}",
    "  prepare() { return { run() {}, get() { return { value: 17 }; } }; }",
    "  close() {}",
    "};",
  ].join("\n"));
  for (let index = 0; index < 7; index++) put(join(source, `proxy-${index}.js`), "// fake contained proxy\n");
  put(join(source, "proxy-paths.js"), [
    'import { writeFileSync } from "node:fs";',
    'import { dirname, join } from "node:path";',
    'import { fileURLToPath } from "node:url";',
    "const staging = dirname(fileURLToPath(import.meta.url));",
    "export const SPAWNED_PROXIES = Object.fromEntries(Array.from({ length: 7 }, (_, index) => [String(index), join(staging, `proxy-${index}.js`)]));",
    `writeFileSync(${JSON.stringify(marker("probe"))}, JSON.stringify({ pid: process.pid, staging }));`,
    ...(mode === "probe" ? [
      // execFile's abort callback rejects before a resistant probe exits.
      // Cleanup must await and escalate the process, not just its promise.
      'process.on("SIGTERM", () => {});',
      "setInterval(() => {}, 1000);", "await new Promise(() => {});",
    ] : []),
  ].join("\n"));

  const descendant = [
    'import { writeFileSync } from "node:fs";',
    'process.on("SIGTERM", () => {});',
    `writeFileSync(${JSON.stringify(marker("descendant"))}, JSON.stringify({ pid: process.pid }));`,
    "setInterval(() => {}, 1000);",
  ].join("\n");
  put(join(source, "descendant.mjs"), descendant);
  put(join(source, "index.js"), [
    'import { spawn } from "node:child_process";',
    'import { existsSync, writeFileSync } from "node:fs";',
    'import { createServer } from "node:http";',
    'import { fileURLToPath } from "node:url";',
    `writeFileSync(${JSON.stringify(marker("server"))}, JSON.stringify({ pid: process.pid }));`,
    ...(mode === "descendant" ? [
      'spawn(process.execPath, [fileURLToPath(new URL("./descendant.mjs", import.meta.url))], { stdio: "ignore" });',
      `while (!existsSync(${JSON.stringify(marker("descendant"))})) await new Promise((resolve) => setTimeout(resolve, 10));`,
      'createServer((_request, response) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ app: "muster", pid: process.pid })); }).listen(Number(process.env.OMB_PORT), "127.0.0.1");',
    ] : ["setInterval(() => {}, 1000);"]),
  ].join("\n"));

  const environment = { TMPDIR: temporary, TEMP: temporary, TMP: temporary };
  for (const key of ["PATH", "SystemRoot"]) if (process.env[key]) environment[key] = process.env[key];
  const wrongPlatform = process.platform === "darwin" ? "linux" : "darwin";
  const child = spawn(process.execPath, [script, "--server-dir", source,
    ...(mode === "wrong-platform" ? ["--platform", wrongPlatform] : []),
  ], {
    env: environment, detached: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stdout = "";
  let stderr = "";
  let result;
  child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-50_000); });
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-50_000); });
  child.once("error", (error) => { result = { error }; });
  child.once("close", (code, signal) => { result = { code, signal }; });
  const finished = async () => {
    await until(() => result, 18_000);
    return { ...result, stdout, stderr };
  };
  try {
    await run({ child, marker, temporary, source, finished });
  } finally {
    // Emergency teardown remains independent of the script under test.
    // Only PIDs recorded by this fixture and its detached launcher are used.
    for (const pid of [readMarker(marker("server"))?.pid, child.pid]) {
      forceStop(pid, true);
    }
    for (const name of ["probe", "server", "descendant"]) {
      const pid = readMarker(marker(name))?.pid;
      forceStop(pid);
    }
    await until(() => result, 3_000);
    await until(() => ["probe", "server", "descendant"].every((name) => !alive(readMarker(marker(name))?.pid))
      && !alive(child.pid, true) && !alive(readMarker(marker("server"))?.pid, true), 3_000);
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

// Windows process-tree termination uses taskkill, not POSIX process groups.
// These cases intentionally make no Windows cleanup claim.
describe.skipIf(process.platform === "win32")("packaged smoke POSIX cleanup", () => {
  it("cleans an IPC-cancelled probe before closing its parent channel", async () => {
    await withFixture("probe", async ({ child, marker, temporary, finished }) => {
      const probe = await until(() => readMarker(marker("probe")));
      child.send("muster-smoke-cancel");
      const result = await finished();
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("Native runtime probe interrupted");
      expect(result.stdout).not.toContain('"passed":');
      expect(alive(probe.pid, true)).toBe(false);
      expect(readdirSync(temporary)).toEqual([]);
      expect(child.connected).toBe(false);
    });
  }, 25_000);
  it("rejects a wrong runtime platform before starting a server and cleans the probe", async () => {
    await withFixture("wrong-platform", async ({ marker, temporary, finished }) => {
      const result = await finished();
      expect(result.error).toBeUndefined();
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("Wrong smoke runtime");
      expect(existsSync(marker("server"))).toBe(false);
      expect(alive(readMarker(marker("probe"))?.pid)).toBe(false);
      expect(readdirSync(temporary)).toEqual([]);
    });
  });
  for (const phase of ["probe", "server"]) {
    it.each(["SIGINT", "SIGTERM"])(`cleans an interrupted ${phase} on %s`, async (signal) => {
      await withFixture(phase, async ({ child, marker, temporary, source, finished }) => {
        const active = await until(() => readMarker(marker(phase)));
        expect(alive(active.pid)).toBe(true);
        expect(child.kill(signal)).toBe(true);
        const result = await finished();
        expect(result.error, result.stderr).toBeUndefined();
        expect(result.code, result.stderr).not.toBe(0);
        expect(result.signal, result.stderr).toBeNull();
        expect(result.stdout).not.toContain('"passed":');
        try { await until(() => !alive(active.pid), 3_000); }
        catch (error) { throw new Error(`Interrupted ${phase} ${active.pid} cleanup observation failed: ${error.message}\n${result.stderr}`, { cause: error }); }
        expect(alive(active.pid, true)).toBe(false);
        expect(alive(child.pid, true)).toBe(false);
        expect(readdirSync(temporary)).toEqual([]);
        expect(existsSync(join(source, "index.js"))).toBe(true);
      });
    }, 25_000);
  }

  it("removes a SIGTERM-ignoring descendant after its server parent exits", async () => {
    await withFixture("descendant", async ({ marker, temporary, finished }) => {
      const server = await until(() => readMarker(marker("server")));
      const descendant = await until(() => readMarker(marker("descendant")));
      expect(alive(descendant.pid)).toBe(true);
      const result = await finished();
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ passed: 9 });
      expect(alive(server.pid)).toBe(false);
      expect(alive(descendant.pid)).toBe(false);
      expect(alive(server.pid, true)).toBe(false);
      expect(readdirSync(temporary)).toEqual([]);
    });
  }, 25_000);
});
