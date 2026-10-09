import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { sourceLock, readFile, projectRoot, preparedRoot, verifyFiles, verifyPrepared, importAcceptedBuild, primitiveString } from './prepare.mjs';

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
test('primitive string validation rejects boxed and spoofed brands without invoking coercion', () => {
  assert.equal(primitiveString('dist/cli.js'), true);
  const values = [null, undefined, true, 3, new String('dist/cli.js'), { [Symbol.toStringTag]: 'String' }, { toString() { throw Error('must not coerce'); }, [Symbol.toPrimitive]() { throw Error('must not coerce'); } }];
  for (const value of values) assert.equal(primitiveString(value), false);
});
function fixture(t) {
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'muster-oxlint-test-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const from = path.join(temp, 'upstream/apps/oxlint'), root = path.join(temp, 'muster');
  fs.mkdirSync(path.join(from, 'dist'), { recursive: true }); fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'muster', packageManager: 'pnpm@10.33.0', scripts: { lint: 'oxlint .' } }));
  const native = Buffer.alloc(64); native.write('ELF', 1); native[0] = 127; native[4] = 2; native[5] = 1; native.writeUInt16LE(183, 18);
  const files = { 'package.json': Buffer.from(JSON.stringify({ name: 'oxlint-app', version: '1.87.0', type: 'module' })), 'dist/cli.js': Buffer.from('export {};\n'), 'dist/oxlint.linux-arm64-gnu.node': native };
  for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(from, name), bytes);
  const license = Buffer.from('Synthetic license fixture; not upstream provenance.\n');
  fs.writeFileSync(path.join(temp, 'upstream/LICENSE'), license);
  const lock = structuredClone(sourceLock);
  lock.files = Object.entries(files).map(([name, bytes]) => ({ path: name, bytes: bytes.length, sha256: hash(bytes) }));
  lock.source.licenseBytes = license.length; lock.source.licenseSha256 = hash(license);
  function replace(name, bytes) { fs.writeFileSync(path.join(from, name), bytes); const row = lock.files.find(row => row.path === name); row.bytes = bytes.length; row.sha256 = hash(bytes); }
  return { temp, from, root, lock, native, replace };
}

test('explicit import verifies synthetic bytes and writes truthful completion last', t => {
  const f = fixture(t), target = importAcceptedBuild(f.from, f.root, f.lock);
  assert.equal(target, preparedRoot(f.root, f.lock));
  const record = verifyPrepared(target, f.lock);
  assert.equal(record.origin, 'VERIFIED_IMPORT_NOT_A_NEW_BUILD');
  assert.deepEqual(record.files, f.lock.files);
  for (const row of f.lock.files) assert.equal(readFile(target, row.path).sha256, readFile(f.from, row.path).sha256);
  assert.equal(fs.readFileSync(path.join(target, 'LICENSE'), 'utf8'), fs.readFileSync(path.join(f.temp, 'upstream/LICENSE'), 'utf8'));
});

for (const name of ['dist/cli.js', 'dist/oxlint.linux-arm64-gnu.node']) {
  test(`missing ${name} refuses before output reservation`, t => {
    const f = fixture(t); fs.unlinkSync(path.join(f.from, name));
    assert.throws(() => importAcceptedBuild(f.from, f.root, f.lock));
    assert.equal(fs.existsSync(preparedRoot(f.root, f.lock)), false);
  });
  test(`tampered ${name} cannot be imported`, t => {
    const f = fixture(t); fs.appendFileSync(path.join(f.from, name), 'changed');
    assert.throws(() => importAcceptedBuild(f.from, f.root, f.lock), /Pinned source-build bytes differ/);
  });
}

test('wrong app version refuses even with a matching synthetic file hash', t => {
  const f = fixture(t); f.replace('package.json', Buffer.from(JSON.stringify({ name: 'oxlint-app', type: 'module', version: '1.86.0' })));
  assert.throws(() => verifyFiles(f.from, f.lock), /Source app identity differs/);
});
for (const field of ['machine', 'class', 'endianness', 'magic']) test(`wrong ELF ${field} refuses despite matching file hash`, t => {
  const f = fixture(t), native = Buffer.from(f.native);
  if (field === 'machine') native.writeUInt16LE(62, 18);
  if (field === 'class') native[4] = 1;
  if (field === 'endianness') native[5] = 2;
  if (field === 'magic') native[0] = 0;
  f.replace('dist/oxlint.linux-arm64-gnu.node', native);
  assert.throws(() => verifyFiles(f.from, f.lock), /Expected ELF64 ARM64 GNU native/);
});

test('file symlink refuses', t => {
  const f = fixture(t), name = path.join(f.from, 'dist/cli.js');
  fs.renameSync(name, name + '.old'); fs.symlinkSync('cli.js.old', name);
  assert.throws(() => verifyFiles(f.from, f.lock), /Not a bounded regular file/);
});
test('parent symlink refuses', t => {
  const f = fixture(t); fs.renameSync(path.join(f.from, 'dist'), path.join(f.from, 'dist-old')); fs.symlinkSync('dist-old', path.join(f.from, 'dist'));
  assert.throws(() => verifyFiles(f.from, f.lock), /Directory alias or wrong type/);
});
test('root alias refuses', t => {
  const f = fixture(t), alias = path.join(f.temp, 'alias'); fs.symlinkSync(f.from, alias);
  assert.throws(() => verifyFiles(alias, f.lock), /Directory alias or wrong type/);
});
test('multiply linked source refuses', t => {
  const f = fixture(t); fs.linkSync(path.join(f.from, 'dist/cli.js'), path.join(f.temp, 'extra-link'));
  assert.throws(() => verifyFiles(f.from, f.lock), /Not a bounded regular file/);
});
for (const name of ['../outside', '/absolute', 'dist/../cli.js', 'dist//cli.js']) test(`invalid lock path ${name} refuses`, t => {
  const f = fixture(t); f.lock.files[0].path = name;
  assert.throws(() => verifyFiles(f.from, f.lock), /Invalid locked relative path/);
});
test('duplicate lock path refuses', t => {
  const f = fixture(t); f.lock.files.push({ ...f.lock.files[0] });
  assert.throws(() => verifyFiles(f.from, f.lock), /Invalid or duplicate/);
});
test('non-integer lock size refuses', t => {
  const f = fixture(t); f.lock.files[0].bytes = true;
  assert.throws(() => verifyFiles(f.from, f.lock), /Invalid or duplicate/);
});
test('non-primitive locked paths fail at the actual read boundary', t => {
  const f = fixture(t);
  for (const value of [new String('dist/cli.js'), { [Symbol.toStringTag]: 'String' }, 0, null]) assert.throws(() => readFile(f.from, value), /Invalid locked relative path/);
});
test('an existing prepared output is preserved', t => {
  const f = fixture(t), target = importAcceptedBuild(f.from, f.root, f.lock), before = fs.readFileSync(path.join(target, 'READY.json'));
  assert.throws(() => importAcceptedBuild(f.from, f.root, f.lock), /EEXIST/);
  assert.deepEqual(fs.readFileSync(path.join(target, 'READY.json')), before);
  verifyPrepared(target, f.lock);
});
test('partial import without READY is not admitted', t => {
  const f = fixture(t), target = importAcceptedBuild(f.from, f.root, f.lock); fs.unlinkSync(path.join(target, 'READY.json'));
  assert.throws(() => verifyPrepared(target, f.lock), /ENOENT/);
});
test('a changed completion provenance refuses', t => {
  const f = fixture(t), target = importAcceptedBuild(f.from, f.root, f.lock), record = verifyPrepared(target, f.lock);
  record.origin = 'BUILT_AND_TESTED'; fs.writeFileSync(path.join(target, 'READY.json'), JSON.stringify(record));
  assert.throws(() => verifyPrepared(target, f.lock), /Prepared provenance differs/);
});
test('changed prepared native refuses without fallback', t => {
  const f = fixture(t), target = importAcceptedBuild(f.from, f.root, f.lock); fs.appendFileSync(path.join(target, 'dist/oxlint.linux-arm64-gnu.node'), 'tamper');
  assert.throws(() => verifyPrepared(target, f.lock), /Pinned source-build bytes differ/);
});
test('unknown prepared file refuses', t => {
  const f = fixture(t), target = importAcceptedBuild(f.from, f.root, f.lock); fs.writeFileSync(path.join(target, 'unknown'), 'extra');
  assert.throws(() => verifyPrepared(target, f.lock), /Unexpected prepared file/);
});
test('unknown prepared symlink refuses', t => {
  const f = fixture(t), target = importAcceptedBuild(f.from, f.root, f.lock); fs.symlinkSync('package.json', path.join(target, 'alias'));
  assert.throws(() => verifyPrepared(target, f.lock), /Unexpected prepared entry type/);
});
test('altered upstream notice refuses', t => {
  const f = fixture(t); fs.appendFileSync(path.join(f.temp, 'upstream/LICENSE'), 'different');
  assert.throws(() => importAcceptedBuild(f.from, f.root, f.lock), /Pinned upstream license missing/);
});
test('project root preserves the existing lint and package-manager contract', t => {
  const f = fixture(t); fs.mkdirSync(path.join(f.root, 'nested')); assert.equal(projectRoot(path.join(f.root, 'nested')), f.root);
  fs.writeFileSync(path.join(f.root, 'package.json'), JSON.stringify({ name: 'muster', packageManager: 'pnpm@10.33.0', scripts: { lint: 'true' } }));
  assert.throws(() => projectRoot(f.root), /unchanged pnpm lint contract/);
});
