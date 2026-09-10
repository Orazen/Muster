// The standalone server uses the build machine's Node ABI. Only the copy
// inside an Electron package may be rebuilt for Electron's different ABI.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { cpSync, existsSync, lstatSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";

const require = createRequire(import.meta.url);
const execute = promisify(execFile);
const ELECTRON_HEADERS = "https://electronjs.org/headers";
const NODE_GYP_VERSION = "12.4.0";
const ARCHES = new Map([[1, "x64"], [3, "arm64"]]);
const ExactVersion = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/);
const AbsolutePath = z.string().refine(isAbsolute);
const NativePackage = z.object({ name: z.literal("better-sqlite3"), version: z.string().min(1) });

function inside(parent, child) {
  const path = relative(parent, child);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function absolutePath(value, label) {
  const parsed = AbsolutePath.safeParse(value);
  if (!parsed.success) throw new Error(`${label} must be an absolute path`);
  return resolve(parsed.data);
}

function directory(path, label) {
  if (!existsSync(path) || !lstatSync(path).isDirectory()) throw new Error(`Missing ${label} directory: ${path}`);
}

function file(path, label) {
  if (!existsSync(path) || !lstatSync(path).isFile()) throw new Error(`Missing ${label} file: ${path}`);
}

// Resolve a future target through its nearest existing ancestor as well as
// lexically: a staged server/_native symlink must not redirect deletion.
function canonicalLocation(path) {
  try {
    lstatSync(path);
    return realpathSync(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(canonicalLocation(parent), basename(path));
  }
}

export function resolveElectronNativeTarget(context, { hostPlatform = process.platform } = {}) {
  const parsedVersion = ExactVersion.safeParse(context?.packager?.config?.electronVersion);
  if (!parsedVersion.success) {
    throw new Error("An exact resolved Electron version is required");
  }
  const version = parsedVersion.data;
  const platform = context.electronPlatformName;
  if (!["darwin", "win32", "linux"].includes(platform) || platform !== hostPlatform) {
    throw new Error(`Unsupported native build platform: ${platform} on ${hostPlatform}`);
  }
  const arch = ARCHES.get(context.arch);
  if (!arch) throw new Error(`Unsupported Electron architecture: ${context.arch}`);
  const projectDir = absolutePath(context.packager.projectDir, "Project directory");
  const appOutDir = absolutePath(context.appOutDir, "App output directory");
  directory(projectDir, "project");
  directory(appOutDir, "app output");
  let resources;
  try {
    resources = context.packager.getResourcesDir(appOutDir);
  } catch (error) {
    throw new Error("Packaged resources resolver failed", { cause: error });
  }
  const resourcesDir = absolutePath(resources, "Resources directory");
  directory(resourcesDir, "packaged resources");
  if (!inside(appOutDir, resourcesDir) || !inside(realpathSync(appOutDir), realpathSync(resourcesDir))) {
    throw new Error("Packaged resources must stay inside the app output directory");
  }
  const sourceDir = join(projectDir, "dist-server", "_native", "better-sqlite3");
  const targetDir = join(resourcesDir, "server", "_native", "better-sqlite3");
  directory(sourceDir, "source native dependency");
  const source = realpathSync(sourceDir);
  const target = canonicalLocation(targetDir);
  if (!inside(realpathSync(projectDir), source)
    || !inside(realpathSync(resourcesDir), target)
    || source === target || inside(source, target) || inside(target, source)) {
    throw new Error("Native source and packaged target must be separate, contained paths");
  }
  return { version, platform, arch, resourcesDir, sourceDir, targetDir };
}

function validateSource(sourceDir) {
  // bundle-server already dereferences dependencies. Reject any residual
  // links rather than following a dependency outside this prepared tree.
  const inspect = (path) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`Native dependency contains a symlink: ${path}`);
    if (stat.isDirectory()) for (const name of readdirSync(path)) inspect(join(path, name));
  };
  inspect(sourceDir);
  for (const name of ["package.json", "binding.gyp", "lib/index.js", "node_modules/bindings/bindings.js", "node_modules/file-uri-to-path/index.js"]) {
    file(join(sourceDir, name), `native dependency ${name}`);
  }
  for (const name of ["src", "deps"]) directory(join(sourceDir, name), `native dependency ${name}`);
  const pkg = NativePackage.safeParse(JSON.parse(readFileSync(join(sourceDir, "package.json"), "utf8")));
  if (!pkg.success) {
    throw new Error("Invalid better-sqlite3 package metadata");
  }
}

function removeHostOutputs(path) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.name === "build" || entry.name === "prebuilds" || entry.name.endsWith(".node")) {
      rmSync(child, { recursive: true, force: true });
    } else if (entry.isDirectory()) removeHostOutputs(child);
  }
}

export async function prepareElectronNative(context, {
  run = execute,
  nodeGypPath,
  headersDir,
  hostPlatform = process.platform,
} = {}) {
  const target = resolveElectronNativeTarget(context, { hostPlatform });
  validateSource(target.sourceDir);
  file(join(target.resourcesDir, "server", "index.js"), "packaged server entry point");
  if (nodeGypPath === undefined) {
    if (require("node-gyp/package.json").version !== NODE_GYP_VERSION) throw new Error(`node-gyp ${NODE_GYP_VERSION} is required`);
    nodeGypPath = require.resolve("node-gyp/bin/node-gyp.js");
  }
  nodeGypPath = absolutePath(nodeGypPath, "node-gyp executable");
  file(nodeGypPath, "node-gyp executable");
  if (headersDir !== undefined) {
    headersDir = absolutePath(headersDir, "Electron headers directory");
    file(join(headersDir, "include", "node", "config.gypi"), "Electron header configuration");
  }

  // Recopy the full dependency, including helpers that electron-builder may
  // prune beneath node_modules. Never overwrite or rebuild dist-server.
  rmSync(target.targetDir, { recursive: true, force: true });
  cpSync(target.sourceDir, target.targetDir, { recursive: true, dereference: true });
  removeHostOutputs(target.targetDir);
  const args = [nodeGypPath, "rebuild", "--release", `--target=${target.version}`, `--arch=${target.arch}`, `--dist-url=${ELECTRON_HEADERS}`, "--jobs=2"];
  if (headersDir !== undefined) args.push(`--nodedir=${headersDir}`);
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !/^npm_(?:config_|package_config_node_gyp_)/i.test(key)));
  // node-gyp applies these two environment prefixes after argv, allowing
  // inherited target/header/directory options to override explicit flags.
  Object.assign(env, { ELECTRON_RUN_AS_NODE: "1", npm_config_runtime: "electron", npm_config_target: target.version, npm_config_arch: target.arch });
  console.log(`[afterPack] rebuilding better-sqlite3 for Electron ${target.version} ${target.platform}-${target.arch}`);
  try {
    const output = await run(process.execPath, args, { cwd: target.targetDir, env, timeout: 600_000, maxBuffer: 16 * 1024 * 1024 });
    if (output?.stdout) process.stdout.write(output.stdout);
    if (output?.stderr) process.stderr.write(output.stderr);
  } catch (error) {
    if (error.stdout) process.stdout.write(error.stdout);
    if (error.stderr) process.stderr.write(error.stderr);
    throw new Error(`Electron native rebuild failed for ${target.platform}-${target.arch}: ${error.message}`, { cause: error });
  }
  const binaryPath = join(target.targetDir, "build", "Release", "better_sqlite3.node");
  file(binaryPath, "rebuilt native addon");
  if (lstatSync(binaryPath).size === 0 || !inside(realpathSync(target.targetDir), realpathSync(binaryPath))) {
    throw new Error("Native rebuild produced an empty or uncontained addon");
  }
  return { ...target, binaryPath };
}
