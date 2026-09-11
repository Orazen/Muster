// CUA computer-use wiring for the Electron main process.
//
// Two modes, per cua-driver's EMBEDDING.md:
//  - "embedded" (packaged app): spawn our own private daemon via
//    EmbeddedCuaDriverHost so TCC grants attribute to Muster and the
//    driver inherits them. Permission requests happen only after the user
//    explicitly enables computer access for this app session.
//  - "standalone" (dev): attach to an already-installed CuaDriver.app daemon
//    (its own TCC identity, typically already granted on a dev machine).
//
// Agents never talk to the daemon socket directly — they spawn the official
// stdio MCP proxy: `cua-driver mcp [--embedded --socket <path>]`. The proxy
// executes nothing; the host-owned daemon does.
//
// The resulting connection descriptor is written to
// <userData>/cua-connection.json for the harness server to hand to drivers.

import { app, ipcMain } from "electron";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createCuaRuntime, registerCuaRuntimeIpc } from "./cua-runtime.mjs";

const require = createRequire(import.meta.url);
const { createCuaConnectionStore } = require("./cua-connection.cjs");

const INSTALLED_DRIVER = "/Applications/CuaDriver.app/Contents/MacOS/cua-driver";
const STANDALONE_SOCKET = path.join(
  app.getPath("home"),
  "Library/Caches/cua-driver/cua-driver.sock",
);
const CUA_ENV = { CUA_DRIVER_RS_TELEMETRY_ENABLED: "0" };
process.env.CUA_DRIVER_RS_TELEMETRY_ENABLED ??= "0";

const connectionStore = createCuaConnectionStore({
  getUserData: () => app.getPath("userData"),
});

export function resolveDriverBinary() {
  if (process.env.CUA_DRIVER_PATH) return process.env.CUA_DRIVER_PATH;
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, "cua-driver");
    if (fs.existsSync(bundled)) return bundled;
  }
  if (fs.existsSync(INSTALLED_DRIVER)) return INSTALLED_DRIVER;
  return null;
}

function socketAlive(sockPath) {
  return new Promise((resolve) => {
    if (!fs.existsSync(sockPath)) return resolve(false);
    const s = net.createConnection(sockPath);
    let settled = false;
    const timer = setTimeout(() => done(false), 1500);
    timer.unref();
    const done = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      s.destroy();
      resolve(ok);
    };
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

async function loadEmbeddedSdk() {
  if (!app.isPackaged) {
    const [embedded, permissions] = await Promise.all([
      import("@trycua/cua-driver/embedded"),
      import("@trycua/cua-driver/electron"),
    ]);
    return { ...embedded, ...permissions };
  }
  process.env.MUSTER_CUA_SDK_LIBRARY = path.join(
    process.resourcesPath,
    "cua-sdk",
    "native",
    "libcua_driver_sdk.dylib",
  );
  return import(pathToFileURL(path.join(process.resourcesPath, "cua-sdk", "cua-sdk.mjs")).href);
}

const runtime = createCuaRuntime({
  connectionStore, resolveDriverBinary, loadEmbeddedSdk,
  wantEmbedded: () => app.isPackaged || process.env.MUSTER_CUA_EMBEDDED === "1",
  standaloneSocket: STANDALONE_SOCKET, socketAlive,
});

export const initializeCua = () => runtime.initialize();
export const startCua = () => runtime.start();
export const stopCua = () => runtime.stop();
export const getCuaConnection = () => runtime.get();

export function cuaPermissionsStatus() {
  const binary = resolveDriverBinary();
  if (!binary) return { available: false };
  const out = spawnSync(binary, ["permissions", "status", "--json"], {
    encoding: "utf8",
    timeout: 5000,
    env: { ...process.env, ...CUA_ENV },
  });
  try {
    return { available: true, ...JSON.parse(out.stdout) };
  } catch {
    return { available: true, raw: out.stdout?.trim() };
  }
}

export function registerCuaIpc(authorizeSender, onChanged) {
  registerCuaRuntimeIpc({ ipcMain, runtime, permissionsStatus: cuaPermissionsStatus, authorizeSender, onChanged });
}
