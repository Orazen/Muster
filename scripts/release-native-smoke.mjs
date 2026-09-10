// Select an exact desktop package, then let the existing isolated smoke
// prove its Electron runtime, native database, proxy paths, and owned server.
import { spawn } from "node:child_process";
import { accessSync, constants, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TARGETS = new Map([
  ["darwin-arm64", ["mac-arm64", "Muster.app"]],
  ["darwin-x64", ["mac", "Muster.app"]],
  ["win32-x64", ["win-unpacked"]],
  ["linux-x64", ["linux-unpacked"]],
]);

function contained(root, path) {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function checkedPath(root, path, kind) {
  if (!contained(resolve(root), resolve(path)) || !contained(realpathSync(root), realpathSync(path))) {
    throw new Error("Release package path escapes its expected directory");
  }
  if (lstatSync(path).isSymbolicLink()) throw new Error("Release package path must not be an ambiguous symlink");
  const stat = statSync(path);
  if (kind === "directory" ? !stat.isDirectory() : !stat.isFile()) throw new Error(`Expected packaged ${kind}`);
  return resolve(path);
}

export function parseReleaseNativeArguments(args) {
  const { values, tokens } = parseArgs({ args, tokens: true, options: {
    platform: { type: "string" }, arch: { type: "string" }, "package-dir": { type: "string" },
  } });
  const seen = new Set();
  for (const token of tokens) {
    if (token.kind !== "option") continue;
    if (seen.has(token.name)) throw new Error(`Duplicate --${token.name} option`);
    seen.add(token.name);
  }
  return { platform: values.platform, arch: values.arch, packageDir: values["package-dir"] };
}

export function resolveReleaseNativeSmoke({ platform, arch, packageDir }, { projectDir = ROOT } = {}) {
  const segments = TARGETS.get(`${platform}-${arch}`);
  if (!segments) throw new Error("Expected a configured release target: darwin arm64/x64, win32 x64, or linux x64");
  projectDir = resolve(projectDir);
  packageDir = resolve(packageDir ?? join(projectDir, "release"));
  if (!statSync(packageDir).isDirectory()) throw new Error("Package directory is not a directory");
  const appDir = checkedPath(packageDir, join(packageDir, ...segments), "directory");
  const resourcesDir = checkedPath(appDir, platform === "darwin" ? join(appDir, "Contents", "Resources") : join(appDir, "resources"), "directory");
  const runtime = checkedPath(appDir, platform === "darwin" ? join(appDir, "Contents", "MacOS", "Muster")
    : join(appDir, platform === "win32" ? "Muster.exe" : "muster"), "file");
  if (platform !== "win32") accessSync(runtime, constants.X_OK);
  const serverDir = checkedPath(resourcesDir, join(resourcesDir, "server"), "directory");
  const uiDir = checkedPath(resourcesDir, join(resourcesDir, "ui"), "directory");
  checkedPath(serverDir, join(serverDir, "index.js"), "file");
  checkedPath(uiDir, join(uiDir, "index.html"), "file");
  const helperPath = checkedPath(projectDir, join(projectDir, "scripts", "smoke-packaged-server.mjs"), "file");

  const require = createRequire(join(projectDir, "package.json"));
  const installedPath = require.resolve("electron/package.json");
  // Do not accidentally satisfy this requirement from a parent's install.
  checkedPath(realpathSync(join(projectDir, "node_modules")), realpathSync(installedPath), "file");
  let installed;
  try { installed = JSON.parse(readFileSync(installedPath, "utf8")); }
  catch { throw new Error("Unable to read installed Electron metadata"); }
  // Package metadata is a runtime JSON boundary, not the manifest range.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  if (installed?.name !== "electron" || typeof installed.version !== "string"
    || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(installed.version)
    || installed.version.trim() !== installed.version) throw new Error("Installed Electron must have an exact version");
  return { platform, arch, packageDir, appDir, resourcesDir, runtime, serverDir, uiDir, helperPath, electronVersion: installed.version };
}

export class SmokeProcessError extends Error {
  constructor(code, signal) {
    super(`Packaged runtime smoke failed (${signal ?? code ?? "unknown exit"})`);
    this.exitCode = signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : Number.isInteger(code) && code > 0 && code <= 255 ? code : 1;
  }
}

export function runSmokeProcess(executable, args, options, { spawnChild = spawn, signals = process, hostPlatform = process.platform } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawnChild(executable, args, { ...options, stdio: ["inherit", "inherit", "inherit", "ipc"] });
    let spawnError;
    let cancellationError;
    let interrupted;
    const forward = (signal) => {
      if (interrupted) return;
      interrupted = signal;
      const fallback = () => {
        if (hostPlatform === "win32") {
          cancellationError = new Error("Smoke IPC cancellation failed; graceful helper cleanup could not be requested");
        } else {
          try { child.kill(signal); }
          catch { cancellationError = new Error("Unable to forward cancellation to the owned smoke helper"); }
        }
      };
      if (!child.connected) { fallback(); return; }
      try { child.send("muster-smoke-cancel", (error) => { if (error) fallback(); }); }
      catch { fallback(); }
    };
    const onInt = () => forward("SIGINT");
    const onTerm = () => forward("SIGTERM");
    signals.on("SIGINT", onInt);
    signals.on("SIGTERM", onTerm);
    child.once("error", (error) => { spawnError = error; });
    child.once("close", (code, signal) => {
      signals.removeListener("SIGINT", onInt);
      signals.removeListener("SIGTERM", onTerm);
      if (spawnError) reject(spawnError);
      else if (cancellationError) reject(cancellationError);
      else if (code !== 0 || signal || interrupted) reject(new SmokeProcessError(code, signal ?? interrupted));
      else resolveRun();
    });
  });
}

export async function runReleaseNativeSmoke(options, { projectDir = ROOT, run = runSmokeProcess, env = process.env } = {}) {
  const target = resolveReleaseNativeSmoke(options, { projectDir });
  const childEnv = {};
  for (const key of ["PATH", "SystemRoot", "TMPDIR", "TEMP", "TMP", "LANG"]) {
    if (env[key]) childEnv[key] = env[key];
  }
  await run(process.execPath, [
    target.helperPath, "--runtime", target.runtime, "--electron-version", target.electronVersion,
    "--arch", target.arch, "--platform", target.platform, "--server-dir", target.serverDir,
  ], { cwd: resolve(projectDir), env: childEnv });
  return target;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await runReleaseNativeSmoke(parseReleaseNativeArguments(process.argv.slice(2)));
  } catch (error) {
    console.error(`[release-native-smoke] ${error instanceof Error ? error.message : "Smoke gate failed"}`);
    process.exitCode = error instanceof SmokeProcessError ? error.exitCode : 1;
  }
}
