// Local mitigations for GHSA-vfj7-8cjw-p6xm and GHSA-86w9-cpqp-85rv.
// Versions stay unchanged: npm/Dependabot still report the upstream advisories.
// Source preparation evaluates no dependency code and refuses unreviewed bytes.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve, sep } from "node:path";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const depthError = "Muster braces nesting exceeds the reviewed limit (100)";
const policy = [
  {
    package: "braces", version: "3.0.3", file: "lib/parse.js",
    originalSha256: "e572166565f15fa6ad9865ae49d678218e32aabfd1b3720f6d0d43d39800d310",
    patchedSha256: "38d9f0c3762d2fbc267488edb9da2a01c32ad62ab8af57299aea02dc4dd6146e",
    replacements: [["      stack.push(block);", `      if (stack.length >= 100) throw new SyntaxError('${depthError}');\n      stack.push(block);`, 2]],
  },
  {
    package: "braces", version: "3.0.3", file: "lib/compile.js",
    originalSha256: "dc98f22eee3d511785d92a00758d5f0d48efed5f5813bdecc2de430c529b5c9f",
    patchedSha256: "ccc779d1c36fc0f634d90f7f005245550b2b9b8de6264b7d39cbd12999497406",
    replacements: [
      ["  const walk = (node, parent = {}) => {", `  const walk = (node, parent = {}, depth = 0) => {\n    if (depth > 100) throw new SyntaxError('${depthError}');`, 1],
      ["walk(child, node)", "walk(child, node, depth + 1)", 1],
    ],
  },
  {
    package: "braces", version: "3.0.3", file: "lib/expand.js",
    originalSha256: "41ccc196ebfa7b7781a634e721eb744e4e7bcb54cba427a7e3d6806a1b9e58f7",
    patchedSha256: "0370999f2ce73ab4d3abc5f42dde90bd19bffe5027dc5871c4c77b3fde2a1680",
    replacements: [
      ["  const walk = (node, parent = {}) => {", `  const walk = (node, parent = {}, depth = 0) => {\n    if (depth > 100) throw new SyntaxError('${depthError}');`, 1],
      ["walk(child, node)", "walk(child, node, depth + 1)", 1],
    ],
  },
  {
    package: "braces", version: "3.0.3", file: "lib/stringify.js",
    originalSha256: "379f22d77bfa1478341ccd49c5e4267464aabcbba03558bab332aac23fc6f23a",
    patchedSha256: "181c363997e97a88a5986590a66a8f9c507fb60c34c6f8c4ef17970aef1c495c",
    replacements: [
      ["  const stringify = (node, parent = {}) => {", `  const stringify = (node, parent = {}, depth = 0) => {\n    if (depth > 100) throw new SyntaxError('${depthError}');`, 1],
      ["stringify(child)", "stringify(child, {}, depth + 1)", 1],
    ],
  },
  {
    package: "node-forge", version: "1.4.0", file: "lib/rsa.js",
    originalSha256: "fd4740238145ec26470eb3f06a627c72039538ce1307dbdce40521f94dfd0a50",
    patchedSha256: "c9b1e3799e230528b6d6815c1f6cd3c6058b9d45975264b55d995abb976589af",
    // The nested arity check is the upstream PR1152 fix at ceba34402e329f0365134f23fe19898756527d65.
    replacements: [["            obj.value.length !== 2) {", "            obj.value.length !== 2 ||\n            obj.value[0].value.length !==\n              (('parameters' in capture) ? 2 : 1)) {", 1]],
  },
];
export const DEPENDENCY_SECURITY_PATCHES = Object.freeze(policy.map((entry) => Object.freeze({ ...entry, replacements: Object.freeze(entry.replacements.map(Object.freeze)) })));

function readRegularFile(root, target) {
  assert(target.startsWith(`${join(root, "node_modules")}${sep}`), "Dependency target must remain in this companion's node_modules");
  let directory = dirname(target);
  while (true) {
    const stat = lstatSync(directory);
    assert(stat.isDirectory() && !stat.isSymbolicLink(), `Expected a regular dependency directory: ${directory}`);
    if (directory === root) break;
    directory = dirname(directory);
  }
  const stat = lstatSync(target);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, `Expected an unlinked regular dependency file: ${target}`);
  assert(stat.size <= 256 * 1024, `Unexpected dependency source size: ${target}`);
  return { bytes: readFileSync(target), mode: stat.mode };
}

/** Plan all known copies and verify each installed consumer's actual resolution
 * before any transaction writes a file. npm ci supplies the committed graph. */
export function planDependencySecurityPatches(root) {
  root = resolve(root);
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  assert(lock.lockfileVersion >= 2 && lock.packages, "A committed package graph is required");
  const files = [];
  const packages = [];
  const consumers = [];
  for (const name of ["braces", "node-forge"]) {
    const descriptors = DEPENDENCY_SECURITY_PATCHES.filter((entry) => entry.package === name);
    const copies = Object.keys(lock.packages).filter((path) => path === `node_modules/${name}` || path.endsWith(`/node_modules/${name}`));
    assert(copies.length > 0, `Missing reviewed ${name} dependency`);
    const packagePaths = new Set(copies.map((path) => resolve(root, path, "package.json")));
    for (const [path, entry] of Object.entries(lock.packages)) {
      if (!entry.dependencies?.[name]) continue;
      const consumer = resolve(root, path, "package.json");
      const actual = createRequire(consumer).resolve(`${name}/package.json`);
      assert(packagePaths.has(actual), `Unreviewed ${name} resolution from ${path}`);
      consumers.push({ package: name, consumer: path, resolved: actual });
    }
    for (const path of copies) {
      const packagePath = resolve(root, path, "package.json");
      const metadata = JSON.parse(readRegularFile(root, packagePath).bytes);
      assert.equal(metadata.name, name, "Unexpected dependency package");
      assert.equal(metadata.version, descriptors[0].version, `Unsupported ${name} version; review its mitigation`);
      assert.equal(lock.packages[path].version, metadata.version, `Lock/install version mismatch for ${name}`);
      for (const descriptor of descriptors) {
        const target = resolve(root, path, descriptor.file);
        const current = readRegularFile(root, target);
        const currentHash = sha256(current.bytes);
        assert([descriptor.originalSha256, descriptor.patchedSha256].includes(currentHash), `Unknown ${name} source: ${path}/${descriptor.file}; refusing to patch`);
        let bytes = current.bytes;
        if (currentHash !== descriptor.patchedSha256) {
          let source = bytes.toString("utf8");
          for (const [before, after, count] of descriptor.replacements) {
            assert.equal(source.split(before).length - 1, count, `Unexpected mitigation input in ${descriptor.file}`);
            source = source.split(before).join(after);
          }
          bytes = Buffer.from(source);
          assert.equal(sha256(bytes), descriptor.patchedSha256, `Unexpected mitigation output in ${descriptor.file}`);
        }
        files.push({ name: `${path}/${descriptor.file}`, target, currentHash, bytes, mode: current.mode, changed: currentHash !== descriptor.patchedSha256, patchedSha256: descriptor.patchedSha256 });
      }
    }
    packages.push({ name, version: descriptors[0].version, copies: copies.length });
  }
  return { files, packages, consumers };
}

export function verifyDependencySecurityPatches(root) {
  const plan = planDependencySecurityPatches(root);
  assert(plan.files.every((file) => !file.changed), "Dependency mitigations are missing; run prepare:toolchain before loading Expo/Metro");
  return { packages: plan.packages, consumers: plan.consumers.length, files: plan.files.length };
}
