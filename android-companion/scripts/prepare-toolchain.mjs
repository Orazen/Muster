#!/usr/bin/env node
// Expo 52's generated default-import wrapper is incompatible with tar 7's
// CommonJS namespace. Keep this explicit compatibility patch limited to two
// pinned files; a different upstream version requires source review first.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const companionRoot = fileURLToPath(new URL("..", import.meta.url));
const originalImport = 'const data = /*#__PURE__*/ _interopRequireDefault(require("tar"));';
const patchedImport = 'const data = { default: require("tar") };';
export const EXPO_TAR_PATCHES = Object.freeze([
  Object.freeze({
    name: "tar.js",
    originalSha256: "2f673a6bbba4ee208e478024c6ef4d73f727e7d9243356336bb69d80d53df7bb",
    patchedSha256: "b844cbba7fd98b1cd7e50b925a922ea712bbb1984985caca9f78f0d402514a37",
  }),
  Object.freeze({
    name: "npm.js",
    originalSha256: "2883a0ca6fc57ad9234539cbbabe4418f571bc3a42d4b92b8f751dbe8c1edf29",
    patchedSha256: "39bd0049f758d0c182a8e2efc284883e9176babfe29a343250f8979d411a89e6",
  }),
]);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function readRegularFile(path) {
  const stat = lstatSync(path);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, `Expected an unlinked regular toolchain file: ${path}`);
  assert(stat.size <= 256 * 1024, `Unexpected toolchain file size: ${path}`);
  return { bytes: readFileSync(path), mode: stat.mode };
}

function checkDirectories(root, target) {
  let current = dirname(target);
  while (true) {
    const stat = lstatSync(current);
    assert(stat.isDirectory() && !stat.isSymbolicLink(), `Expected an unlinked toolchain directory: ${current}`);
    if (current === root) return;
    const parent = dirname(current);
    assert.notEqual(parent, current, "Toolchain target must remain under its companion root");
    current = parent;
  }
}

/** Only reads package metadata and patches known local bytes. No dependency
 * code is evaluated, no install command runs, and no network is contacted. */
export function prepareToolchain(root = companionRoot) {
  root = resolve(root);
  const cliRoot = join(root, "node_modules", "@expo", "cli");
  const cliPackagePath = join(cliRoot, "package.json");
  checkDirectories(root, cliPackagePath);
  const cliPackage = JSON.parse(readRegularFile(cliPackagePath).bytes.toString("utf8"));
  assert.equal(cliPackage.name, "@expo/cli", "Unexpected Expo CLI package");
  assert.equal(cliPackage.version, "0.22.28", "Unsupported Expo CLI version; review the compatibility patch");

  // Validate both inputs and both dependency resolutions before replacing any
  // source file. Mixed original/patched states can resume an interrupted run.
  const files = EXPO_TAR_PATCHES.map((patch) => {
    const target = join(cliRoot, "build", "src", "utils", patch.name);
    checkDirectories(root, target);
    const tarPackagePath = createRequire(target).resolve("tar/package.json");
    checkDirectories(root, tarPackagePath);
    const tarPackage = JSON.parse(readRegularFile(tarPackagePath).bytes.toString("utf8"));
    assert.equal(tarPackage.name, "tar", "Unexpected tar package");
    assert.equal(tarPackage.version, "7.5.22", "Unsupported tar version; review the compatibility patch");
    const current = readRegularFile(target);
    const currentHash = sha256(current.bytes);
    assert([patch.originalSha256, patch.patchedSha256].includes(currentHash), `Unknown Expo CLI source: ${patch.name}; refusing to patch`);
    if (currentHash === patch.patchedSha256) return { ...patch, target, currentHash, bytes: current.bytes, mode: current.mode, changed: false };
    const source = current.bytes.toString("utf8");
    assert.equal(source.split(originalImport).length - 1, 1, `Unexpected tar import count in ${patch.name}`);
    const bytes = Buffer.from(source.replace(originalImport, patchedImport));
    assert.equal(sha256(bytes), patch.patchedSha256, `Unexpected patch output for ${patch.name}`);
    return { ...patch, target, currentHash, bytes, mode: current.mode, changed: true };
  });

  const staged = [];
  try {
    for (const file of files.filter((file) => file.changed)) {
      const temporary = `${file.target}.muster-${randomUUID()}.tmp`;
      staged.push({ temporary, file });
      writeFileSync(temporary, file.bytes, { flag: "wx", mode: file.mode });
    }
    for (const file of files) {
      assert.equal(sha256(readRegularFile(file.target).bytes), file.currentHash, `Expo CLI source changed during preparation: ${file.name}`);
    }
    for (const { temporary, file } of staged) renameSync(temporary, file.target);
    for (const file of files) assert.equal(sha256(readRegularFile(file.target).bytes), file.patchedSha256, `Could not verify prepared source: ${file.name}`);
  } finally {
    for (const { temporary } of staged) rmSync(temporary, { force: true });
  }
  return { status: staged.length ? "prepared" : "unchanged", expoCli: cliPackage.version, tar: "7.5.22", files: files.map(({ name, patchedSha256, changed }) => ({ name, sha256: patchedSha256, changed })) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    assert.equal(process.argv.length, 2, "Usage: node scripts/prepare-toolchain.mjs");
    console.log(JSON.stringify(prepareToolchain()));
  } catch (error) {
    console.error("Expo toolchain preparation failed:", error.message);
    process.exitCode = 1;
  }
}
