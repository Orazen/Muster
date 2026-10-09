#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { constants } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sourceLock, projectRoot, preparedRoot, verifyPrepared, readFile, primitiveString } from '../prepare.mjs';

export function runtimeRoute(runtime, lock = sourceLock) {
  if (runtime.platform !== 'linux' || runtime.arch !== 'arm64' || !runtime.glibc) return 'official';
  if (runtime.nodeMajor !== lock.runtime.nodeMajor || runtime.nodeAbi !== lock.runtime.nodeAbi || runtime.glibc !== lock.runtime.glibcVersion) throw Error('Prepared ARM64 GNU build requires Node24/ABI137 and measured glibc2.36; this runtime is not accepted');
  return 'source';
}

export function rejectOverrides(env) {
  for (const [key, value] of Object.entries(env)) if (value && (key.startsWith('NAPI_RS_') || ['NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'DEBUG', 'CONFORMANCE', 'VP_VERSION', 'MUSTER_OXLINT_BUILD_DIR'].includes(key))) throw Error(`Ambient source-build override prohibited: ${key}`);
}

const PNPM_SHIM_TEMPLATE = "#!/bin/sh\nbasedir=$(dirname \"$(echo \"$0\" | sed -e 's,\\\\,/,g')\")\n\ncase `uname` in\n    *CYGWIN*|*MINGW*|*MSYS*)\n        if command -v cygpath > /dev/null 2>&1; then\n            basedir=`cygpath -w \"$basedir\"`\n        fi\n    ;;\nesac\n\nif [ -z \"$NODE_PATH\" ]; then\n  export NODE_PATH=\"__MUSTER_PROJECT_ROOT__/node_modules/.pnpm/@muster+oxlint-linux-arm64@file+tools+oxlint-linux-arm64/node_modules/@muster/oxlint-linux-arm64/node_modules:__MUSTER_PROJECT_ROOT__/node_modules/.pnpm/@muster+oxlint-linux-arm64@file+tools+oxlint-linux-arm64/node_modules:__MUSTER_PROJECT_ROOT__/node_modules/.pnpm/node_modules\"\nelse\n  export NODE_PATH=\"__MUSTER_PROJECT_ROOT__/node_modules/.pnpm/@muster+oxlint-linux-arm64@file+tools+oxlint-linux-arm64/node_modules/@muster/oxlint-linux-arm64/node_modules:__MUSTER_PROJECT_ROOT__/node_modules/.pnpm/@muster+oxlint-linux-arm64@file+tools+oxlint-linux-arm64/node_modules:__MUSTER_PROJECT_ROOT__/node_modules/.pnpm/node_modules:$NODE_PATH\"\nfi\nif [ -x \"$basedir/node\" ]; then\n  exec \"$basedir/node\"  \"$basedir/../.pnpm/@muster+oxlint-linux-arm64@file+tools+oxlint-linux-arm64/node_modules/@muster/oxlint-linux-arm64/bin/oxlint.mjs\" \"$@\"\nelse\n  exec node  \"$basedir/../.pnpm/@muster+oxlint-linux-arm64@file+tools+oxlint-linux-arm64/node_modules/@muster/oxlint-linux-arm64/bin/oxlint.mjs\" \"$@\"\nfi\n";
export function clearPnpmNodePath(root) {
  const env = process.env;
  if (!env.NODE_PATH) return;
  const installedModules = path.join(root, 'node_modules/.pnpm/@muster+oxlint-linux-arm64@file+tools+oxlint-linux-arm64/node_modules');
  const installedPackage = path.join(installedModules, '@muster/oxlint-linux-arm64');
  const expectedBin = path.join(installedPackage, 'bin/oxlint.mjs');
  const currentBin = fileURLToPath(import.meta.url);
  if (currentBin !== expectedBin || fs.realpathSync(currentBin) !== currentBin) throw Error('NODE_PATH requires the exact installed pnpm package');
  const exact = [path.join(installedPackage, 'node_modules'), installedModules, path.join(root, 'node_modules/.pnpm/node_modules')].join(path.delimiter);
  if (env.NODE_PATH !== exact) throw Error('NODE_PATH differs from the exact pnpm-generated local path list');
  const shim = readFile(root, 'node_modules/.bin/oxlint', { singleLink: false });
  const directShim = PNPM_SHIM_TEMPLATE.replaceAll('__MUSTER_PROJECT_ROOT__', root);
  const aliasShim = directShim.replaceAll('$basedir/../.pnpm/@muster+oxlint-linux-arm64@file+tools+oxlint-linux-arm64/node_modules/@muster/oxlint-linux-arm64/bin/oxlint.mjs', '$basedir/../oxlint/bin/oxlint.mjs');
  const text = shim.bytes.toString();
  if (shim.bytes.length > 16384 || ![directShim, aliasShim].includes(text)) throw Error('Installed bin is not the exact pinned pnpm shim');
  if (text === aliasShim && fs.realpathSync(path.join(root, 'node_modules/oxlint')) !== installedPackage) throw Error('Installed pnpm bin alias differs from the exact package');
  delete env.NODE_PATH;
  Module._initPaths();
  if (Module.globalPaths.some(value => exact.split(path.delimiter).includes(value))) throw Error('pnpm NODE_PATH was not removed before source loading');
}

export function nativeLintExport(exports) {
  try { Function.prototype.toString.call(Object.getOwnPropertyDescriptor(exports, 'lint')?.value); return true; }
  catch { return false; }
}

export function officialCli(require = createRequire(import.meta.url), version = sourceLock.runtime.officialDelegationVersion) {
  const name = require.resolve('upstream-oxlint/package.json');
  const root = fs.realpathSync(path.dirname(name));
  const pkg = JSON.parse(readFile(root, 'package.json', { singleLink: false }).bytes);
  if (pkg.name !== 'oxlint' || pkg.version !== version || pkg.bin?.oxlint !== 'bin/oxlint') throw Error('Official pinned delegation identity differs');
  const cli = path.join(root, 'bin/oxlint');
  readFile(root, 'bin/oxlint', { singleLink: false });
  return cli;
}

export function delegate(args, cli, execute = spawnSync, sendSignal = signal => process.kill(process.pid, signal)) {
  const child = execute(process.execPath, [cli, ...args], { stdio: 'inherit', env: process.env });
  if (child.error) throw child.error;
  if (child.signal) {
    if (!constants.signals[child.signal]) throw Error('Unknown official child signal');
    sendSignal(child.signal);
    return 128 + constants.signals[child.signal];
  }
  if (!Number.isInteger(child.status)) throw Error('Official Oxlint did not return an exit status');
  return child.status;
}

export async function runSource(args, root) {
  clearPnpmNodePath(root);
  rejectOverrides(process.env);
  const artifact = preparedRoot(root), native = path.join(artifact, 'dist/oxlint.linux-arm64-gnu.node');
  verifyPrepared(artifact);
  const originalNative = Module._extensions['.node'], originalLoad = Module._load;
  let successfulLoads = 0;
  Module._extensions['.node'] = function (module, filename) {
    if (filename !== native || fs.realpathSync(filename) !== native || successfulLoads !== 0) throw Error('Only the exact pinned local GNU native may load');
    const pinned = sourceLock.files.find(f => f.path === 'dist/oxlint.linux-arm64-gnu.node');
    if (readFile(artifact, pinned.path).sha256 !== pinned.sha256) throw Error('Native changed before load');
    const result = originalNative.call(this, module, filename);
    if (!nativeLintExport(module.exports)) throw Error('Native lint export missing');
    successfulLoads++;
    return result;
  };
  Module._load = function (request, ...rest) {
    if (primitiveString(request) && /wasi|\.wasm(?:$|[?#])/i.test(request)) throw Error('WASI fallback prohibited');
    return originalLoad.call(this, request, ...rest);
  };
  try {
    const cli = path.join(artifact, 'dist/cli.js');
    process.argv = [process.execPath, cli, ...args];
    await import(pathToFileURL(cli).href);
    if (successfulLoads !== 1 || !process.report.getReport().sharedObjects.includes(native)) throw Error('Actual pinned native load was not proved');
    verifyPrepared(artifact);
  } finally { Module._extensions['.node'] = originalNative; Module._load = originalLoad; }
}

export async function main(args = process.argv.slice(2)) {
  const route = runtimeRoute({ platform: process.platform, arch: process.arch, nodeMajor: Number(process.versions.node.split('.')[0]), nodeAbi: process.versions.modules, glibc: process.report.getReport().header.glibcVersionRuntime });
  if (route === 'official') { process.exitCode = delegate(args, officialCli()); return; }
  await runSource(args, projectRoot());
}

let invoked = false;
try { invoked = fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { /* Module imported by focused tests. */ }
if (invoked) main().catch(error => { console.error(`Muster source Oxlint refused: ${error.message}. Run explicit preparation; no native fallback was used.`); process.exitCode = 1; });
