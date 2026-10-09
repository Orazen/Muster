import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const packageRoot = path.dirname(fileURLToPath(import.meta.url));
export const sourceLock = JSON.parse(fs.readFileSync(path.join(packageRoot, 'source-lock.json'), 'utf8'));

export function directory(value) {
  const root = path.resolve(value), s = fs.lstatSync(root);
  if (!s.isDirectory() || s.isSymbolicLink() || fs.realpathSync(root) !== root) throw Error(`Directory alias or wrong type: ${root}`);
  return root;
}

function identity(s) { return [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs, s.mode].join(':'); }
export function primitiveString(value) {
  try { return String.prototype.valueOf.call(value) === value; }
  catch { return false; }
}
export function readFile(root, relative, { singleLink = true } = {}) {
  if (!primitiveString(relative) || !relative || path.isAbsolute(relative) || relative.split('/').some(p => !p || p === '.' || p === '..')) throw Error('Invalid locked relative path');
  root = directory(root);
  const parts = relative.split('/');
  for (let i = 1; i < parts.length; i++) directory(path.join(root, ...parts.slice(0, i)));
  const name = path.join(root, relative), before = fs.lstatSync(name);
  if (!before.isFile() || before.isSymbolicLink() || (singleLink && before.nlink !== 1) || before.size > 32 * 1024 * 1024) throw Error(`Not a bounded regular file: ${name}`);
  const fd = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (identity(fs.fstatSync(fd)) !== identity(before)) throw Error('File changed before read');
    const bytes = fs.readFileSync(fd);
    if (identity(fs.fstatSync(fd)) !== identity(before) || identity(fs.lstatSync(name)) !== identity(before)) throw Error('File changed during read');
    return { bytes, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  } finally { fs.closeSync(fd); }
}

function rows(lock) {
  if (lock.schemaVersion !== 1 || !/^[a-f0-9]{40}$/.test(lock.source.commit) || !Array.isArray(lock.files) || lock.files.length === 0 || lock.files.length > 32) throw Error('Invalid source lock');
  const names = new Set();
  for (const f of lock.files) {
    if (!Number.isSafeInteger(f.bytes) || f.bytes < 0 || f.bytes > 32 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(f.sha256) || names.has(f.path)) throw Error('Invalid or duplicate locked file');
    names.add(f.path);
  }
  return lock.files;
}

export function verifyFiles(root, lock = sourceLock) {
  const checked = rows(lock).map(f => {
    const got = readFile(root, f.path);
    if (got.bytes.length !== f.bytes || got.sha256 !== f.sha256) throw Error(`Pinned source-build bytes differ: ${f.path}`);
    return f.path;
  });
  const pkg = JSON.parse(readFile(root, 'package.json').bytes);
  if (pkg.name !== 'oxlint-app' || pkg.version !== lock.source.appVersion || pkg.type !== 'module') throw Error('Source app identity differs');
  const native = readFile(root, 'dist/oxlint.linux-arm64-gnu.node').bytes;
  if (native.length < 64 || native.subarray(0, 4).toString('hex') !== '7f454c46' || native[4] !== 2 || native[5] !== 1 || native.readUInt16LE(18) !== 183) throw Error('Expected ELF64 ARM64 GNU native');
  return checked;
}

export function projectRoot(start = process.cwd()) {
  let current = directory(start);
  for (let i = 0; i < 12; i++) {
    const candidate = path.join(current, 'package.json');
    if (fs.existsSync(candidate)) {
      const p = JSON.parse(readFile(current, 'package.json').bytes);
      if (p.name === 'muster' && p.packageManager === 'pnpm@10.33.0' && p.scripts?.lint === 'oxlint .') return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = directory(parent);
  }
  throw Error('Run from a Muster project with the unchanged pnpm lint contract');
}

export function preparedRoot(root, lock = sourceLock) {
  return path.join(directory(root), '.omb-scratch', `oxlint-linux-arm64-${lock.source.commit}`);
}

function inventory(root) {
  const found = [];
  let entries = 0;
  function walk(rel = '') {
    for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      if (++entries > 64) throw Error('Prepared inventory exceeds the locked package bound');
      const name = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { directory(path.join(root, name)); walk(name); }
      else if (entry.isFile() && !entry.isSymbolicLink()) found.push(name);
      else throw Error('Unexpected prepared entry type');
    }
  }
  walk();
  return found.sort();
}

export function verifyPrepared(root, lock = sourceLock) {
  directory(root);
  const record = JSON.parse(readFile(root, 'READY.json').bytes);
  if (record.schemaVersion !== 1 || record.origin !== 'VERIFIED_IMPORT_NOT_A_NEW_BUILD' || record.sourceCommit !== lock.source.commit || record.target !== lock.build.target || record.sourceVersion !== lock.source.appVersion || JSON.stringify(record.files) !== JSON.stringify(lock.files)) throw Error('Prepared provenance differs');
  verifyFiles(root, lock);
  const license = readFile(root, 'LICENSE');
  if (license.sha256 !== lock.source.licenseSha256 || license.bytes.length !== lock.source.licenseBytes) throw Error('Upstream license differs');
  if (JSON.stringify(inventory(root)) !== JSON.stringify([...lock.files.map(f => f.path), 'READY.json', 'LICENSE'].sort())) throw Error('Unexpected prepared file');
  return record;
}

// No builds, installs, network, acquisition, code imports, or lifecycle scripts.
// This explicit operation admits only the exact already-reviewed source build.
export function importAcceptedBuild(from, root, lock = sourceLock) {
  from = directory(from); root = directory(root);
  verifyFiles(from, lock);
  const sourceLicenseRoot = directory(path.resolve(from, '../..'));
  const license = readFile(sourceLicenseRoot, 'LICENSE');
  if (license.sha256 !== lock.source.licenseSha256 || license.bytes.length !== lock.source.licenseBytes) throw Error('Pinned upstream license missing');
  const scratch = path.join(root, '.omb-scratch');
  if (!fs.existsSync(scratch)) fs.mkdirSync(scratch, { mode: 0o700 });
  directory(scratch);
  const target = preparedRoot(root, lock);
  // Atomic mkdir reserves a fresh output; never overwrite or delete an install.
  fs.mkdirSync(target, { mode: 0o700 });
  for (const f of rows(lock)) {
    const got = readFile(from, f.path);
    if (got.sha256 !== f.sha256 || got.bytes.length !== f.bytes) throw Error('Import input changed');
    fs.mkdirSync(path.dirname(path.join(target, f.path)), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(target, f.path), got.bytes, { flag: 'wx', mode: 0o644 });
  }
  fs.writeFileSync(path.join(target, 'LICENSE'), license.bytes, { flag: 'wx', mode: 0o644 });
  verifyFiles(from, lock); verifyFiles(target, lock);
  const afterLicense = readFile(sourceLicenseRoot, 'LICENSE');
  if (afterLicense.sha256 !== license.sha256) throw Error('Import license changed');
  const record = { schemaVersion: 1, origin: 'VERIFIED_IMPORT_NOT_A_NEW_BUILD', sourceCommit: lock.source.commit, sourceVersion: lock.source.appVersion, target: lock.build.target, files: lock.files };
  fs.writeFileSync(path.join(target, 'READY.json'), JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  verifyPrepared(target, lock);
  return target;
}

function directlyInvoked() {
  try { return fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; }
}
if (directlyInvoked()) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--from') throw Error('Usage: node tools/oxlint-linux-arm64/prepare.mjs --from <pinned-source>/apps/oxlint');
    const target = importAcceptedBuild(process.argv[3], projectRoot());
    console.log(`Verified source-build import prepared: ${target}`);
  } catch (error) { console.error(`Muster Oxlint preparation refused: ${error.message}. Failed owned output, if created, is retained.`); process.exitCode = 1; }
}
