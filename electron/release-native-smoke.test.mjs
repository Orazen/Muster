import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseReleaseNativeArguments, resolveReleaseNativeSmoke, runReleaseNativeSmoke, runSmokeProcess, SmokeProcessError } from "../scripts/release-native-smoke.mjs";

let scratch;
beforeEach(() => { scratch = mkdtempSync(join(tmpdir(), "muster-release-native-")); });
afterEach(() => { rmSync(scratch, { recursive: true, force: true }); });

function put(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function fixture(platform = "darwin", arch = "arm64") {
  const projectDir = join(scratch, "project with spaces");
  const packageDir = join(projectDir, "release");
  const appDir = platform === "darwin" ? join(packageDir, arch === "arm64" ? "mac-arm64" : "mac", "Muster.app")
    : join(packageDir, platform === "win32" ? "win-unpacked" : "linux-unpacked");
  const resourcesDir = platform === "darwin" ? join(appDir, "Contents", "Resources") : join(appDir, "resources");
  const runtime = platform === "darwin" ? join(appDir, "Contents", "MacOS", "Muster")
    : join(appDir, platform === "win32" ? "Muster.exe" : "muster");
  put(runtime, "inert packaged runtime fixture");
  chmodSync(runtime, 0o755);
  put(join(resourcesDir, "server", "index.js"), "// inert packaged server fixture\n");
  put(join(resourcesDir, "ui", "index.html"), "<!doctype html><title>Muster fixture</title>");
  const helperPath = join(projectDir, "scripts", "smoke-packaged-server.mjs");
  put(helperPath, "// inert helper fixture\n");
  put(join(projectDir, "package.json"), JSON.stringify({ name: "muster", devDependencies: { electron: "^99.0.0" } }));
  const electronPackage = join(projectDir, "node_modules", "electron", "package.json");
  put(electronPackage, JSON.stringify({ name: "electron", version: "43.4.0" }));
  return { projectDir, packageDir, appDir, resourcesDir, runtime, helperPath, electronPackage, options: { platform, arch } };
}

describe("release native target selection", () => {
  it.each([
    ["darwin", "arm64"], ["darwin", "x64"], ["win32", "x64"], ["linux", "x64"],
  ])("selects the exact %s/%s package and installed Electron version", (platform, arch) => {
    const owned = fixture(platform, arch);
    expect(resolveReleaseNativeSmoke(owned.options, { projectDir: owned.projectDir })).toEqual({
      platform, arch, packageDir: owned.packageDir, appDir: owned.appDir,
      runtime: owned.runtime, resourcesDir: owned.resourcesDir,
      serverDir: join(owned.resourcesDir, "server"), uiDir: join(owned.resourcesDir, "ui"),
      helperPath: owned.helperPath, electronVersion: "43.4.0",
    });
  });

  it("chooses each exact Mac target when both architectures are present", () => {
    const arm = fixture();
    const intel = fixture("darwin", "x64");
    expect(resolveReleaseNativeSmoke(arm.options, { projectDir: arm.projectDir }).runtime).toBe(arm.runtime);
    expect(resolveReleaseNativeSmoke(intel.options, { projectDir: intel.projectDir }).runtime).toBe(intel.runtime);
  });

  it("does not substitute an Intel package when the requested arm64 package is absent", () => {
    const owned = fixture("darwin", "x64");
    expect(() => resolveReleaseNativeSmoke({ platform: "darwin", arch: "arm64" }, { projectDir: owned.projectDir })).toThrow();
  });

  it("accepts an explicit absolute package output directory", () => {
    const owned = fixture();
    const otherProject = join(scratch, "metadata project");
    put(join(otherProject, "package.json"), "{}");
    put(join(otherProject, "node_modules", "electron", "package.json"), JSON.stringify({ name: "electron", version: "43.4.0" }));
    put(join(otherProject, "scripts", "smoke-packaged-server.mjs"), "// fixture\n");
    expect(resolveReleaseNativeSmoke({ ...owned.options, packageDir: owned.packageDir }, { projectDir: otherProject }).runtime).toBe(owned.runtime);
  });

  it.each([
    { platform: "win32", arch: "arm64" }, { platform: "linux", arch: "arm64" },
    { platform: "darwin", arch: "universal" }, { platform: "freebsd", arch: "x64" },
    { platform: "darwin" },
  ])("rejects an unsupported or incomplete target %j", (options) => {
    expect(() => resolveReleaseNativeSmoke(options, { projectDir: scratch })).toThrow(/configured release target/);
  });

  it.each(["^43.4.0", "43", "43.4.0\n"])("refuses non-exact installed Electron metadata %j", (version) => {
    const owned = fixture();
    put(owned.electronPackage, JSON.stringify({ name: "electron", version }));
    expect(() => resolveReleaseNativeSmoke(owned.options, { projectDir: owned.projectDir })).toThrow(/exact version/);
  });

  it.each(["server/index.js", "ui/index.html"])("requires packaged %s before invoking the helper", async (file) => {
    const owned = fixture();
    rmSync(join(owned.resourcesDir, file));
    let called = false;
    await expect(runReleaseNativeSmoke(owned.options, { projectDir: owned.projectDir, run: async () => { called = true; } })).rejects.toThrow();
    expect(called).toBe(false);
  });

  it("rejects resources redirected outside the selected app", () => {
    const owned = fixture();
    const outside = join(scratch, "outside resources");
    mkdirSync(outside);
    rmSync(owned.resourcesDir, { recursive: true });
    symlinkSync(outside, owned.resourcesDir, "junction");
    expect(() => resolveReleaseNativeSmoke(owned.options, { projectDir: owned.projectDir })).toThrow(/escapes/);
  });

  it("rejects an architecture directory aliased to another package", () => {
    const arm = fixture();
    const intel = fixture("darwin", "x64");
    rmSync(arm.appDir, { recursive: true });
    symlinkSync(intel.appDir, arm.appDir, "junction");
    expect(() => resolveReleaseNativeSmoke(arm.options, { projectDir: arm.projectDir })).toThrow(/ambiguous symlink/);
  });

  it.each([
    ["--platform", "darwin", "--arch", "arm64", "--arch", "x64"],
    ["--platform", "darwin", "--arch", "arm64", "--runtime", "node"],
    ["--platform", "darwin", "--arch", "arm64", "unexpected"],
  ])("rejects ambiguous or unsupported CLI arguments %j", (...args) => {
    expect(() => parseReleaseNativeArguments(args)).toThrow();
  });
});

describe("release native smoke delegation", () => {
  it("passes exact paths as separate argv values and excludes inherited runtime overrides", async () => {
    const owned = fixture("win32", "x64");
    const calls = [];
    await runReleaseNativeSmoke(owned.options, {
      projectDir: owned.projectDir,
      env: { PATH: "owned executable path", SystemRoot: "owned system", NODE_OPTIONS: "--inspect", NODE_PATH: "wrong modules", GH_TOKEN: "not used" },
      run: async (...args) => { calls.push(args); },
    });
    expect(calls).toEqual([[
      process.execPath,
      [owned.helperPath, "--runtime", owned.runtime, "--electron-version", "43.4.0", "--arch", "x64", "--platform", "win32", "--server-dir", join(owned.resourcesDir, "server")],
      { cwd: owned.projectDir, env: { PATH: "owned executable path", SystemRoot: "owned system" } },
    ]]);
  });

  it("propagates the helper's runtime mismatch failure without a fallback invocation", async () => {
    const owned = fixture();
    const failure = new SmokeProcessError(2);
    let calls = 0;
    await expect(runReleaseNativeSmoke(owned.options, { projectDir: owned.projectDir, run: async () => { calls++; throw failure; } })).rejects.toBe(failure);
    expect(calls).toBe(1);
  });
});

function processFixture() {
  const child = new EventEmitter();
  const signals = new EventEmitter();
  const messages = [];
  const kills = [];
  child.connected = true;
  child.send = (message, callback) => { messages.push(message); callback(null); };
  child.kill = (signal) => { kills.push(signal); return true; };
  const calls = [];
  const spawnChild = (...args) => { calls.push(args); return child; };
  return { child, signals, messages, kills, calls, spawnChild };
}

describe("owned smoke process lifecycle", () => {
  it("waits for close, not just exit, and propagates a nonzero status", async () => {
    const fake = processFixture();
    const pending = runSmokeProcess("node", ["owned helper"], {}, fake);
    let settled = false;
    pending.catch(() => { settled = true; });
    fake.child.emit("exit", 42);
    await Promise.resolve();
    expect(settled).toBe(false);
    fake.child.emit("close", 42, null);
    await expect(pending).rejects.toMatchObject({ exitCode: 42 });
    expect(fake.signals.listenerCount("SIGINT")).toBe(0);
    expect(fake.signals.listenerCount("SIGTERM")).toBe(0);
    expect(fake.calls[0][2]).toEqual({ stdio: ["inherit", "inherit", "inherit", "ipc"] });
  });

  it.each([["SIGINT", 130], ["SIGTERM", 143]])("relays %s by private IPC and awaits helper cleanup", async (signal, exitCode) => {
    const fake = processFixture();
    const pending = runSmokeProcess("node", [], {}, { ...fake, hostPlatform: "win32" });
    let settled = false;
    pending.catch(() => { settled = true; });
    fake.signals.emit(signal);
    expect(fake.messages).toEqual(["muster-smoke-cancel"]);
    expect(fake.kills).toEqual([]);
    await Promise.resolve();
    expect(settled).toBe(false);
    fake.child.emit("close", 0, null);
    await expect(pending).rejects.toMatchObject({ exitCode });
  });

  it("reports unavailable Windows IPC without force-killing the helper", async () => {
    const fake = processFixture();
    fake.child.connected = false;
    const pending = runSmokeProcess("node", [], {}, { ...fake, hostPlatform: "win32" });
    fake.signals.emit("SIGINT");
    expect(fake.kills).toEqual([]);
    fake.child.emit("close", 0, null);
    await expect(pending).rejects.toThrow(/IPC cancellation failed/);
  });

  it("uses a POSIX signal fallback only when IPC is unavailable", async () => {
    const fake = processFixture();
    fake.child.connected = false;
    const pending = runSmokeProcess("node", [], {}, { ...fake, hostPlatform: "linux" });
    fake.signals.emit("SIGTERM");
    expect(fake.kills).toEqual(["SIGTERM"]);
    fake.child.emit("close", 1, null);
    await expect(pending).rejects.toMatchObject({ exitCode: 143 });
  });

  it("waits for actual owned child IPC cleanup before rejecting cancellation", async () => {
    const helper = join(scratch, "owned ipc helper.mjs");
    const marker = join(scratch, "cleanup.txt");
    put(helper, `import { writeFileSync } from 'node:fs';
process.on('message', async message => {
  if (message !== 'muster-smoke-cancel') return;
  await new Promise(resolve => setTimeout(resolve, 20));
  writeFileSync(${JSON.stringify(marker)}, 'cleanup finished');
  process.disconnect();
});
process.send('ready');
`);
    const signals = new EventEmitter();
    let ownedChild;
    let ready;
    let failStart;
    const started = new Promise((resolveReady, rejectReady) => { ready = resolveReady; failStart = rejectReady; });
    const startupTimer = setTimeout(() => failStart(new Error("Owned IPC helper did not become ready")), 5_000);
    const spawnChild = (...args) => {
      ownedChild = spawn(...args);
      ownedChild.once("message", (message) => { if (message === "ready") ready(); });
      ownedChild.once("error", failStart);
      ownedChild.once("close", () => failStart(new Error("Owned IPC helper exited before readiness")));
      return ownedChild;
    };
    const pending = runSmokeProcess(process.execPath, [helper], { cwd: scratch, env: {} }, { spawnChild, signals });
    // Startup failures are asserted through started and still await teardown.
    pending.catch(() => {});
    try {
      await started;
      signals.emit("SIGINT");
      await expect(pending).rejects.toMatchObject({ exitCode: 130 });
      expect(readFileSync(marker, "utf8")).toBe("cleanup finished");
      expect(ownedChild.exitCode).toBe(0);
    } finally {
      clearTimeout(startupTimer);
      if (ownedChild?.exitCode === null && ownedChild.signalCode === null) {
        const closed = new Promise((resolveClose) => ownedChild.once("close", resolveClose));
        ownedChild.kill();
        await closed;
      }
    }
  });
});
