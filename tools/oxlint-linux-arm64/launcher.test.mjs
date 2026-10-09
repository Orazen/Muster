import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Module from 'node:module';
import { pathToFileURL } from 'node:url';
import { runtimeRoute, rejectOverrides, officialCli, delegate, runSource, nativeLintExport } from './bin/oxlint.mjs';

const accepted = { platform: 'linux', arch: 'arm64', glibc: '2.36', nodeMajor: 24, nodeAbi: '137' };
test('exact accepted GNU ARM64 runtime uses the source route', () => assert.equal(runtimeRoute(accepted), 'source'));
for (const [label, change] of Object.entries({ Darwin: { platform: 'darwin' }, Windows: { platform: 'win32' }, LinuxX64: { arch: 'x64' }, musl: { glibc: undefined } })) test(`${label} preserves official delegation`, () => assert.equal(runtimeRoute({ ...accepted, ...change }), 'official'));
for (const [label, change] of Object.entries({ oldNode: { nodeMajor: 22 }, wrongABI: { nodeAbi: '138' }, unprovedGlibc: { glibc: '2.37' } })) test(`${label} refuses instead of invoking an unproved native`, () => assert.throws(() => runtimeRoute({ ...accepted, ...change }), /runtime is not accepted/));

for (const key of ['NAPI_RS_NATIVE_LIBRARY_PATH', 'NAPI_RS_FORCE_WASI', 'NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'DEBUG', 'CONFORMANCE', 'VP_VERSION', 'MUSTER_OXLINT_BUILD_DIR']) test(`${key} cannot change source-load selection`, () => assert.throws(() => rejectOverrides({ [key]: 'injected' }), /override prohibited/));
test('ordinary environment and empty overrides remain accepted', () => rejectOverrides({ PATH: '/usr/bin', LANG: 'en', NAPI_RS_FORCE_WASI: '' }));
test('native lint export requires an own callable value, not a spoofed brand or accessor', () => {
  assert.equal(nativeLintExport({ lint() {} }), true);
  assert.equal(nativeLintExport({ lint: () => true }), true);
  for (const value of [null, {}, { lint: { [Symbol.toStringTag]: 'Function', toString() { return 'function lint() {}'; } } }, { lint: 'function lint() {}' }, Object.create({ lint() {} }), { get lint() { throw Error('must not execute getter'); } }]) assert.equal(nativeLintExport(value), false);
});

function officialFixture(t, { version = '1.86.0', bin = 'bin/oxlint' } = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'muster-official-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'bin'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'oxlint', version, bin: { oxlint: bin } }));
  fs.writeFileSync(path.join(root, 'bin/oxlint'), '#!/usr/bin/env node\nimport "../dist/cli.js";\n');
  return { root, require: { resolve(name) { assert.equal(name, 'upstream-oxlint/package.json'); return path.join(root, 'package.json'); } } };
}
test('official route resolves only the exact aliased official package', t => {
  const f = officialFixture(t); assert.equal(officialCli(f.require), path.join(f.root, 'bin/oxlint'));
});
test('official package-manager hardlinks are allowed on delegation', t => {
  const f = officialFixture(t); fs.linkSync(path.join(f.root, 'bin/oxlint'), path.join(f.root, 'extra-link'));
  assert.equal(officialCli(f.require), path.join(f.root, 'bin/oxlint'));
});
test('wrong official version refuses', t => assert.throws(() => officialCli(officialFixture(t, { version: '1.87.0' }).require), /delegation identity differs/));
test('wrong official bin mapping refuses', t => assert.throws(() => officialCli(officialFixture(t, { bin: '../other' }).require), /delegation identity differs/));
test('missing official executable refuses', t => {
  const f = officialFixture(t); fs.unlinkSync(path.join(f.root, 'bin/oxlint')); assert.throws(() => officialCli(f.require), /ENOENT/);
});
test('official executable symlink refuses', t => {
  const f = officialFixture(t); fs.renameSync(path.join(f.root, 'bin/oxlint'), path.join(f.root, 'bin/real')); fs.symlinkSync('real', path.join(f.root, 'bin/oxlint'));
  assert.throws(() => officialCli(f.require), /Not a bounded regular file/);
});

for (const status of [0, 1, 2]) test(`delegation preserves exit ${status}, arguments, cwd and environment`, () => {
  const before = process.cwd(), args = ['.', '--format', 'json'];
  const result = delegate(args, '/owned/official/bin/oxlint', (program, argv, options) => {
    assert.equal(program, process.execPath); assert.deepEqual(argv, ['/owned/official/bin/oxlint', ...args]);
    assert.equal(options.stdio, 'inherit'); assert.equal(options.env, process.env); assert.equal(process.cwd(), before);
    return { status, signal: null };
  });
  assert.equal(result, status);
});
test('spawn error is not reported as success', () => assert.throws(() => delegate([], '/missing', () => ({ error: Error('ENOENT') })), /ENOENT/));
test('official termination signal is propagated', () => {
  const signals = []; assert.equal(delegate([], '/owned', () => ({ status: null, signal: 'SIGTERM' }), s => signals.push(s)), 143); assert.deepEqual(signals, ['SIGTERM']);
});
test('unknown signal or missing exit status refuses', () => {
  assert.throws(() => delegate([], '/owned', () => ({ signal: 'UNKNOWN' })), /Unknown official child signal/);
  assert.throws(() => delegate([], '/owned', () => ({ status: null, signal: null })), /did not return an exit status/);
});
test('missing source preparation refuses before any module or native load', async t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'muster-source-missing-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await assert.rejects(runSource(['.'], root), /ENOENT/);
});
test('package bin maps the existing command and installs have no lifecycle surprise', () => {
  const p = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url)));
  assert.deepEqual(p.bin, { oxlint: 'bin/oxlint.mjs' }); assert.equal(p.dependencies['upstream-oxlint'], 'npm:oxlint@1.86.0');
  assert.equal(p.private, true); assert.equal(p.scripts.prepare, undefined); assert.equal(p.scripts.postinstall, undefined); assert.equal(p.scripts.install, undefined);
});

// Literal pinned pnpm10.33 shim witness; fixture shell is never executed.
const pnpmShimWitness = "#!/bin/sh\nbasedir=$(dirname \"$(echo \"$0\" | sed -e 's,\\\\,/,g')\")\n\ncase `uname` in\n    *CYGWIN*|*MINGW*|*MSYS*)\n        if command -v cygpath > /dev/null 2>&1; then\n            basedir=`cygpath -w \"$basedir\"`\n        fi\n    ;;\nesac\n\nif [ -z \"$NODE_PATH\" ]; then\n  export NODE_PATH=\"__MUSTER_PROJECT_ROOT__/node_modules/.pnpm/@muster+oxlint-linux-arm64@file+tools+oxlint-linux-arm64/node_modules/@muster/oxlint-linux-arm64/node_modules:__MUSTER_PROJECT_ROOT__/node_modules/.pnpm/@muster+oxlint-linux-arm64@file+tools+oxlint-linux-arm64/node_modules:__MUSTER_PROJECT_ROOT__/node_modules/.pnpm/node_modules\"\nelse\n  export NODE_PATH=\"__MUSTER_PROJECT_ROOT__/node_modules/.pnpm/@muster+oxlint-linux-arm64@file+tools+oxlint-linux-arm64/node_modules/@muster/oxlint-linux-arm64/node_modules:__MUSTER_PROJECT_ROOT__/node_modules/.pnpm/@muster+oxlint-linux-arm64@file+tools+oxlint-linux-arm64/node_modules:__MUSTER_PROJECT_ROOT__/node_modules/.pnpm/node_modules:$NODE_PATH\"\nfi\nif [ -x \"$basedir/node\" ]; then\n  exec \"$basedir/node\"  \"$basedir/../.pnpm/@muster+oxlint-linux-arm64@file+tools+oxlint-linux-arm64/node_modules/@muster/oxlint-linux-arm64/bin/oxlint.mjs\" \"$@\"\nelse\n  exec node  \"$basedir/../.pnpm/@muster+oxlint-linux-arm64@file+tools+oxlint-linux-arm64/node_modules/@muster/oxlint-linux-arm64/bin/oxlint.mjs\" \"$@\"\nfi\n";
async function installedFixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'muster-nodepath-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const modules = path.join(root, 'node_modules/.pnpm/@muster+oxlint-linux-arm64@file+tools+oxlint-linux-arm64/node_modules');
  const pkg = path.join(modules, '@muster/oxlint-linux-arm64');
  fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
  for (const name of ['bin/oxlint.mjs', 'prepare.mjs', 'source-lock.json']) fs.copyFileSync(new URL(name, import.meta.url), path.join(pkg, name));
  const shim = path.join(root, 'node_modules/.bin/oxlint');
  fs.mkdirSync(path.dirname(shim), { recursive: true });
  fs.writeFileSync(shim, pnpmShimWitness.replaceAll('__MUSTER_PROJECT_ROOT__', root));
  fs.symlinkSync(path.relative(path.join(root, 'node_modules'), pkg), path.join(root, 'node_modules/oxlint'));
  const bin = path.join(pkg, 'bin/oxlint.mjs');
  const loaded = await import(pathToFileURL(bin).href);
  return { root, bin, shim, loaded, nodePath: [path.join(pkg, 'node_modules'), modules, path.join(root, 'node_modules/.pnpm/node_modules')].join(path.delimiter) };
}
function withNodePath(t, value) {
  const old = process.env.NODE_PATH;
  t.after(() => { if (old === undefined) delete process.env.NODE_PATH; else process.env.NODE_PATH = old; Module._initPaths(); });
  process.env.NODE_PATH = value;
  Module._initPaths();
}
test('exact pnpm shim clears real process NODE_PATH and Module global paths before missing-artifact refusal', async t => {
  const f = await installedFixture(t);
  withNodePath(t, f.nodePath);
  for (const value of f.nodePath.split(path.delimiter)) assert.ok(Module.globalPaths.includes(value));
  await assert.rejects(f.loaded.runSource(['.'], f.root), /ENOENT/);
  assert.equal(process.env.NODE_PATH, undefined);
  for (const value of f.nodePath.split(path.delimiter)) assert.ok(!Module.globalPaths.includes(value));
});
for (const kind of ['prepend', 'append', 'reorder', 'duplicate', 'trailing-empty', 'missing', 'different-root', 'nonlocal']) test(`pnpm NODE_PATH ${kind} refuses before deleting the actual environment`, async t => {
  const f = await installedFixture(t), paths = f.nodePath.split(path.delimiter);
  const values = { prepend: '/injected:' + f.nodePath, append: f.nodePath + ':/injected', reorder: [...paths].reverse().join(path.delimiter), duplicate: f.nodePath + ':' + paths[0], 'trailing-empty': f.nodePath + ':', missing: paths.slice(1).join(path.delimiter), 'different-root': f.nodePath.replaceAll(f.root, '/unowned'), nonlocal: '/unowned' };
  withNodePath(t, values[kind]);
  assert.throws(() => f.loaded.clearPnpmNodePath(f.root), /differs from the exact/);
  assert.equal(process.env.NODE_PATH, values[kind]);
});
for (const kind of ['extra-command', 'missing', 'symlink', 'oversized']) test(`pnpm shim ${kind} refuses with NODE_PATH retained`, async t => {
  const f = await installedFixture(t);
  if (kind === 'extra-command') fs.appendFileSync(f.shim, 'echo injected\n');
  if (kind === 'missing') fs.unlinkSync(f.shim);
  if (kind === 'symlink') { fs.renameSync(f.shim, f.shim + '.real'); fs.symlinkSync('oxlint.real', f.shim); }
  if (kind === 'oversized') fs.writeFileSync(f.shim, 'x'.repeat(16385));
  withNodePath(t, f.nodePath);
  assert.throws(() => f.loaded.clearPnpmNodePath(f.root), /pnpm shim|ENOENT|bounded regular file/);
  assert.equal(process.env.NODE_PATH, f.nodePath);
});
test('source-tree invocation cannot claim an installed pnpm NODE_PATH exemption', async t => {
  const f = await installedFixture(t);
  withNodePath(t, f.nodePath);
  const { clearPnpmNodePath } = await import('./bin/oxlint.mjs');
  assert.throws(() => clearPnpmNodePath(f.root), /exact installed pnpm package/);
});
test('valid pnpm exemption still refuses every other source override before artifact lookup', async t => {
  const f = await installedFixture(t);
  withNodePath(t, f.nodePath);
  f.loaded.clearPnpmNodePath(f.root);
  for (const key of ['NAPI_RS_NATIVE_LIBRARY_PATH', 'NAPI_RS_FORCE_WASI', 'NODE_OPTIONS', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'DEBUG', 'CONFORMANCE', 'VP_VERSION', 'MUSTER_OXLINT_BUILD_DIR']) assert.throws(() => f.loaded.rejectOverrides({ [key]: 'injected' }), /override prohibited/);
  process.env.MUSTER_OXLINT_BUILD_DIR = '/injected';
  try { await assert.rejects(f.loaded.runSource(['.'], f.root), /override prohibited: MUSTER_OXLINT_BUILD_DIR/); }
  finally { delete process.env.MUSTER_OXLINT_BUILD_DIR; }
});

function useAliasShim(f) {
  fs.writeFileSync(f.shim, fs.readFileSync(f.shim, 'utf8').replaceAll('$basedir/../.pnpm/@muster+oxlint-linux-arm64@file+tools+oxlint-linux-arm64/node_modules/@muster/oxlint-linux-arm64/bin/oxlint.mjs', '$basedir/../oxlint/bin/oxlint.mjs'));
}
test('fresh pnpm alias-form shim clears real NODE_PATH only for the exact installed target', async t => {
  const f = await installedFixture(t);
  useAliasShim(f); withNodePath(t, f.nodePath);
  await assert.rejects(f.loaded.runSource(['.'], f.root), /ENOENT/);
  assert.equal(process.env.NODE_PATH, undefined);
  for (const value of f.nodePath.split(path.delimiter)) assert.ok(!Module.globalPaths.includes(value));
});
for (const kind of ['missing', 'wrong-target']) test(`pnpm alias-form ${kind} refuses before clearing NODE_PATH`, async t => {
  const f = await installedFixture(t), alias = path.join(f.root, 'node_modules/oxlint');
  useAliasShim(f); fs.unlinkSync(alias);
  if (kind === 'wrong-target') fs.symlinkSync('.', alias);
  withNodePath(t, f.nodePath);
  assert.throws(() => f.loaded.clearPnpmNodePath(f.root), /ENOENT|alias differs/);
  assert.equal(process.env.NODE_PATH, f.nodePath);
});
