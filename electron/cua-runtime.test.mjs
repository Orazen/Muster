import fs from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCuaRuntime, registerCuaRuntimeIpc } from "./cua-runtime.mjs";

const require = createRequire(import.meta.url);
const { createCuaConnectionStore } = require("./cua-connection.cjs");
const fixtures = [];
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(platform = "darwin", runtimeOptions = {}) {
  const directory = fs.mkdtempSync(path.join(tmpdir(), "muster-cua-session-"));
  const counts = { resolve: 0, sdk: 0, permissions: 0, socket: 0, constructed: 0, starts: 0, stops: 0, destroyed: 0 };
  const control = {
    binary: "/owned-fixture/cua-driver", embedded: true,
    permissions: { accessibility: true, screenRecording: true },
    failWrite: () => false,
    loadSdk: async (sdk) => sdk,
    start: async () => ({ socketPath: "/owned-fixture/private.sock" }),
    stop: async () => {},
    alive: async () => true,
  };
  const persisted = [];
  const diskStore = createCuaConnectionStore({
    getUserData: () => directory,
    fileSystem: {
      ...fs,
      renameSync(from, to) {
        const next = JSON.parse(fs.readFileSync(from, "utf8"));
        if (control.failWrite(next)) throw new Error("owned descriptor replacement failed");
        fs.renameSync(from, to);
      },
    },
  });
  const sdk = {
    requestMacOSPermissions() { counts.permissions++; return control.permissions; },
    hasRequiredMacOSPermissions: (status) => status.accessibility && status.screenRecording,
    EmbeddedCuaDriverHost: class {
      constructor(binary, bundle) {
        expect(binary).toBe(control.binary); expect(bundle).toBe("com.muster.app"); counts.constructed++;
      }
      start() { counts.starts++; return control.start(); }
      stop() { counts.stops++; return control.stop(); }
      uniffiDestroy() { counts.destroyed++; }
    },
  };
  const runtime = createCuaRuntime({
    platform,
    connectionStore: { persist(next) { const result = diskStore.persist(next); persisted.push(result); return result; } },
    resolveDriverBinary() { counts.resolve++; return control.binary; },
    loadEmbeddedSdk() { counts.sdk++; return control.loadSdk(sdk); },
    wantEmbedded: () => control.embedded,
    standaloneSocket: "/owned-fixture/standalone.sock",
    socketAlive(socket) { expect(socket).toBe("/owned-fixture/standalone.sock"); counts.socket++; return control.alive(); },
    ...runtimeOptions,
  });
  const result = { runtime, control, counts, persisted, diskStore, directory,
    disk: () => JSON.parse(fs.readFileSync(path.join(directory, "cua-connection.json"), "utf8")),
  };
  fixtures.push(result);
  return result;
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    try { await f.runtime.stop(); } catch { /* Failure fixtures deliberately reject invalidation/cleanup. */ }
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

describe("session computer access runtime", () => {
  it("atomically replaces stale access with off without consulting the driver", () => {
    const f = fixture();
    f.diskStore.persist({ mode: "embedded", mcpCommand: "stale-driver", mcpArgs: ["mcp"] });
    expect(f.runtime.initialize()).toEqual({ mode: "unavailable", reason: "computer-access-off" });
    expect(f.disk()).toEqual(f.runtime.get());
    expect(Object.values(f.counts)).toEqual(Array(8).fill(0));
    expect(fs.readdirSync(f.directory)).toEqual(["cua-connection.json"]);
  });
  it("throws if stale access cannot be invalidated and never permits enable afterward", async () => {
    const f = fixture(); const previous = { mode: "standalone", mcpCommand: "stale-driver", mcpArgs: ["mcp"] };
    f.diskStore.persist(previous); f.control.failWrite = () => true;
    expect(() => f.runtime.initialize()).toThrow("owned descriptor replacement failed");
    expect(f.disk()).toEqual(previous);
    expect(f.runtime.get()).toEqual({ mode: "unavailable", reason: "computer-access-off" });
    await expect(f.runtime.start()).rejects.toThrow("Initialize computer access");
    expect(f.counts.resolve).toBe(0);
    expect(fs.readdirSync(f.directory)).toEqual(["cua-connection.json"]);
  });
  it.each(["linux", "win32", "other"])("does not consult native services on %s", async (platform) => {
    const f = fixture(platform); f.runtime.initialize();
    expect(await f.runtime.start()).toEqual({ mode: "unavailable", reason: "unsupported-platform" });
    expect(Object.values(f.counts)).toEqual(Array(8).fill(0));
    expect(f.disk()).toEqual(f.runtime.get());
  });
  it("single-flights concurrent enables and reuses the successful connection", async () => {
    const f = fixture(); f.runtime.initialize(); const ready = deferred(); f.control.start = () => ready.promise;
    const first = f.runtime.start(); const second = f.runtime.start(); expect(first).toBe(second);
    await Promise.resolve(); expect(f.counts.permissions).toBe(1); expect(f.counts.starts).toBe(1);
    expect(f.disk().reason).toBe("computer-access-off");
    ready.resolve({ socketPath: "/owned-fixture/ready.sock" });
    const connection = await first;
    expect(connection).toMatchObject({ mode: "embedded", socketPath: "/owned-fixture/ready.sock", mcpArgs: ["mcp", "--embedded", "--socket", "/owned-fixture/ready.sock"] });
    expect(f.disk()).toEqual(connection);
    expect(await f.runtime.start()).toBe(connection);
    expect(f.counts).toMatchObject({ resolve: 1, sdk: 1, permissions: 1, constructed: 1, starts: 1 });
  });
  it("can retry a missing driver without requesting any permissions on the failed attempt", async () => {
    const f = fixture(); f.runtime.initialize(); f.control.binary = null;
    expect((await f.runtime.start()).reason).toBe("cua-driver binary not found");
    expect(f.counts.permissions).toBe(0);
    f.control.binary = "/owned-fixture/cua-driver";
    expect((await f.runtime.start()).mode).toBe("embedded");
  });
  it("keeps denied permissions unavailable and allows an explicit retry", async () => {
    const f = fixture(); f.runtime.initialize(); f.control.permissions.screenRecording = false;
    expect((await f.runtime.start()).reason).toContain("Screen Recording required");
    expect(f.counts.starts).toBe(0); expect(f.disk().mode).toBe("unavailable");
    f.control.permissions.screenRecording = true;
    expect((await f.runtime.start()).mode).toBe("embedded");
    expect(f.counts.permissions).toBe(2);
  });
  it("stops and destroys a partial host before a retry can create another", async () => {
    const f = fixture(); f.runtime.initialize(); const cleanup = deferred();
    f.control.start = async () => { throw new Error("daemon did not become ready"); };
    f.control.stop = () => cleanup.promise;
    const failed = f.runtime.start(); await Promise.resolve(); await Promise.resolve();
    expect(f.runtime.start()).toBe(failed); expect(f.counts.constructed).toBe(1);
    cleanup.resolve(); expect((await failed).reason).toContain("daemon did not become ready");
    expect(f.counts).toMatchObject({ stops: 1, destroyed: 1 });
    f.control.start = async () => ({ socketPath: "/owned-fixture/retry.sock" });
    f.control.stop = async () => {};
    expect((await f.runtime.start()).mode).toBe("embedded"); expect(f.counts.constructed).toBe(2);
  });
  it("blocks further enables when partial host cleanup could not be confirmed", async () => {
    const f = fixture(); f.runtime.initialize();
    f.control.start = async () => { throw new Error("partial startup failed"); };
    f.control.stop = async () => { throw new Error("stop failed"); };
    const failed = await f.runtime.start();
    expect(failed.reason).toContain("restart Muster before enabling computer access again");
    expect(f.counts).toMatchObject({ constructed: 1, stops: 1, destroyed: 1 });
    expect(await f.runtime.start()).toBe(failed);
    expect(f.counts).toMatchObject({ constructed: 1, permissions: 1 });
  });
  it("cleans a started daemon when ready-descriptor publication fails, then permits retry", async () => {
    const f = fixture(); f.runtime.initialize(); f.control.failWrite = (next) => next.mode === "embedded";
    expect((await f.runtime.start()).reason).toContain("owned descriptor replacement failed");
    expect(f.disk().mode).toBe("unavailable"); expect(f.counts).toMatchObject({ stops: 1, destroyed: 1 });
    f.control.failWrite = () => false;
    expect((await f.runtime.start()).mode).toBe("embedded");
  });
  it("rejects a failed error-descriptor write while preserving off capability and releasing the host", async () => {
    const f = fixture(); f.runtime.initialize(); f.control.failWrite = () => true;
    await expect(f.runtime.start()).rejects.toThrow("owned descriptor replacement failed");
    expect(f.runtime.get().mode).toBe("unavailable"); expect(f.disk().reason).toBe("computer-access-off");
    expect(f.counts).toMatchObject({ stops: 1, destroyed: 1 });
  });
  it("quitting during SDK load prevents later permission and daemon calls", async () => {
    const f = fixture(); f.runtime.initialize(); const loading = deferred();
    f.control.loadSdk = async (sdk) => { await loading.promise; return sdk; };
    const start = f.runtime.start(); const stop = f.runtime.stop();
    expect(f.disk().reason).toBe("desktop-host-stopped");
    loading.resolve(); expect((await start).mode).toBe("unavailable"); await stop;
    expect(f.counts).toMatchObject({ permissions: 0, starts: 0 });
    expect((await f.runtime.start()).reason).toBe("desktop-host-stopped");
    expect(f.counts.resolve).toBe(1);
  });
  it("quitting during host startup releases the late host without publishing usable access", async () => {
    const f = fixture(); f.runtime.initialize(); const ready = deferred(); f.control.start = () => ready.promise;
    const start = f.runtime.start(); await Promise.resolve();
    const stop = f.runtime.stop(); expect(f.runtime.stop()).toBe(stop);
    expect(f.disk().reason).toBe("desktop-host-stopped");
    ready.resolve({ socketPath: "/owned-fixture/late.sock" }); await start; await stop;
    expect(f.counts).toMatchObject({ constructed: 1, stops: 1, destroyed: 1 });
    expect(f.persisted.every((entry) => entry.mode === "unavailable")).toBe(true);
    expect(f.disk().reason).toBe("desktop-host-stopped");
  });
  it("invalidates before awaiting host shutdown and destroys even if stop fails", async () => {
    const f = fixture(); f.runtime.initialize(); await f.runtime.start(); const ending = deferred();
    f.control.stop = () => ending.promise;
    const stopped = f.runtime.stop(); expect(f.disk().reason).toBe("desktop-host-stopped");
    expect(f.runtime.get().mode).toBe("unavailable");
    ending.reject(new Error("stop rejected")); await expect(stopped).rejects.toThrow("stop rejected");
    expect(f.counts.destroyed).toBe(1);
    expect((await f.runtime.start()).mode).toBe("unavailable");
  });
  it("still destroys the host when shutdown cannot invalidate the descriptor", async () => {
    const f = fixture(); f.runtime.initialize(); await f.runtime.start(); f.control.failWrite = () => true;
    await expect(f.runtime.stop()).rejects.toThrow("owned descriptor replacement failed");
    expect(f.runtime.get().reason).toBe("desktop-host-stopped");
    expect(f.counts).toMatchObject({ stops: 1, destroyed: 1 });
  });
  it("attaches to standalone only after enable and never stops another app's daemon", async () => {
    const f = fixture(); f.control.embedded = false; f.runtime.initialize();
    expect(f.counts.socket).toBe(0);
    expect((await f.runtime.start()).mode).toBe("standalone"); await f.runtime.start();
    await f.runtime.stop();
    expect(f.counts).toMatchObject({ socket: 1, sdk: 0, permissions: 0, constructed: 0, stops: 0 });
    expect(f.disk().reason).toBe("desktop-host-stopped");
  });
  it("does not publish a standalone result arriving after shutdown", async () => {
    const f = fixture(); f.control.embedded = false; f.runtime.initialize();
    const socket = deferred(); f.control.alive = () => socket.promise;
    const start = f.runtime.start(); const stop = f.runtime.stop(); socket.resolve(true);
    await start; await stop;
    expect(f.disk().reason).toBe("desktop-host-stopped");
    expect(f.persisted.every((entry) => entry.mode === "unavailable")).toBe(true);
  });
});

describe("desktop permission probe overriding a stale SDK preflight", () => {
  it("starts the embedded host when fresh evidence proves both permissions the preflight denies", async () => {
    const f = fixture("darwin", {
      requestDesktopPermissions: async () => ({ accessibility: true, screenRecording: true }),
    });
    f.runtime.initialize();
    // macOS 15+: the Screen Recording preflight caches per-process and stays
    // denied for the whole session after the user grants, so this read never flips.
    f.control.permissions = { accessibility: false, screenRecording: false };
    const connection = await f.runtime.start();
    expect(connection.mode).toBe("embedded");
    expect(f.disk()).toEqual(connection);
    expect(f.counts).toMatchObject({ permissions: 2, starts: 1 });
  });
  it("keeps the exact legacy message when the fresh evidence also proves nothing", async () => {
    const f = fixture("darwin", {
      requestDesktopPermissions: async () => ({ accessibility: false, screenRecording: false }),
    });
    f.runtime.initialize();
    f.control.permissions = { accessibility: false, screenRecording: false };
    const connection = await f.runtime.start();
    expect(connection).toEqual({
      mode: "unavailable",
      reason: "embedded host failed: Accessibility and Screen Recording required; grant access in System Settings, then try again",
    });
    expect(f.counts.starts).toBe(0);
  });
  it("names only the permission neither source has proven", async () => {
    const f = fixture("darwin", {
      requestDesktopPermissions: async () => ({ accessibility: true, screenRecording: false }),
    });
    f.runtime.initialize();
    f.control.permissions = { accessibility: false, screenRecording: false };
    expect((await f.runtime.start()).reason).toBe(
      "embedded host failed: Screen Recording required; grant access in System Settings, then try again",
    );
  });
  it("fails byte-identically to the legacy path when no probe is injected", async () => {
    const f = fixture();
    f.runtime.initialize();
    f.control.permissions = { accessibility: false, screenRecording: false };
    const connection = await f.runtime.start();
    expect(connection.reason).toBe(
      "embedded host failed: Accessibility and Screen Recording required; grant access in System Settings, then try again",
    );
    expect(f.counts).toMatchObject({ permissions: 1, starts: 0 });
  });
  it("never consults an injected probe when the preflight already reports both", async () => {
    let probeCalls = 0;
    const f = fixture("darwin", {
      requestDesktopPermissions: async () => { probeCalls++; return { accessibility: false, screenRecording: false }; },
    });
    f.runtime.initialize();
    expect((await f.runtime.start()).mode).toBe("embedded");
    expect(probeCalls).toBe(0);
    expect(f.counts.permissions).toBe(1);
  });
  it("lets a retry succeed after the user grants without quitting the session", async () => {
    let granted = false;
    const f = fixture("darwin", {
      requestDesktopPermissions: async () => (granted
        ? { accessibility: true, screenRecording: true }
        : { accessibility: false, screenRecording: false }),
    });
    f.runtime.initialize();
    f.control.permissions = { accessibility: false, screenRecording: false }; // stale all session — only the probe can see the grant
    expect((await f.runtime.start()).reason).toBe(
      "embedded host failed: Accessibility and Screen Recording required; grant access in System Settings, then try again",
    );
    granted = true;
    const connection = await f.runtime.start();
    expect(connection.mode).toBe("embedded");
    expect(f.counts).toMatchObject({ permissions: 4, constructed: 1, starts: 1 });
  });
});

describe("computer access IPC authorization", () => {
  it.each(["resolved", "rejected"])("notifies current windows after %s activation without sending a state payload", async (outcome) => {
    const handlers = new Map(), completed = deferred(), notifications = [];
    registerCuaRuntimeIpc({
      ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
      runtime: { start: () => completed.promise }, permissionsStatus: () => ({}),
      authorizeSender: () => true, onChanged: (...args) => notifications.push(args),
    });
    const result = handlers.get("cua:enable")({});
    expect(notifications).toEqual([]);
    if (outcome === "resolved") {
      completed.resolve({ mode: "embedded" });
      await expect(result).resolves.toEqual({ mode: "embedded" });
    } else {
      completed.reject(new Error("activation failed"));
      await expect(result).rejects.toThrow("activation failed");
    }
    expect(notifications).toEqual([[]]);
  });
  it("a closed notification target cannot turn successful activation into an error", async () => {
    const handlers = new Map();
    registerCuaRuntimeIpc({
      ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
      runtime: { start: async () => ({ mode: "standalone" }) }, permissionsStatus: () => ({}),
      authorizeSender: () => true, onChanged: () => { throw new Error("window destroyed"); },
    });
    await expect(handlers.get("cua:enable")({})).resolves.toEqual({ mode: "standalone" });
  });
  it("only starts from an authorized current main frame and preserves read-only handlers", async () => {
    const f = fixture(); f.runtime.initialize(); const handlers = new Map();
    const mainFrame = {}, subframe = {}, otherFrame = {}, currentWindow = {}, oldWindow = {};
    let permissionReads = 0;
    registerCuaRuntimeIpc({
      ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, runtime: f.runtime,
      permissionsStatus: () => { permissionReads++; return { available: true }; },
      authorizeSender: (event) => event.sender === currentWindow && event.senderFrame === mainFrame,
    });
    for (const event of [{ sender: currentWindow, senderFrame: subframe }, { sender: oldWindow, senderFrame: mainFrame }, { sender: oldWindow, senderFrame: otherFrame }]) {
      expect(() => handlers.get("cua:enable")(event)).toThrow("current app window");
    }
    expect(f.counts.resolve).toBe(0);
    expect(handlers.get("cua:connection")()).toEqual({ mode: "unavailable", reason: "computer-access-off" });
    expect(handlers.get("cua:permissions")()).toEqual({ available: true }); expect(permissionReads).toBe(1);
    expect((await handlers.get("cua:enable")({ sender: currentWindow, senderFrame: mainFrame })).mode).toBe("embedded");
  });
  it("fails closed without a sender authorizer", () => {
    const f = fixture(); f.runtime.initialize(); const handlers = new Map();
    registerCuaRuntimeIpc({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, runtime: f.runtime, permissionsStatus: () => ({ available: false }) });
    expect(() => handlers.get("cua:enable")({})).toThrow("current app window");
    expect(f.counts.resolve).toBe(0);
  });
});
