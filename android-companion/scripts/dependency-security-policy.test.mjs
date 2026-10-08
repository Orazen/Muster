import assert from "node:assert/strict";
import { constants, createHash, generateKeyPairSync, privateEncrypt, sign as nodeSign } from "node:crypto";
import { chmodSync, cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { DEPENDENCY_SECURITY_PATCHES, IMMUTABLE_DEPENDENCY_FORKS, planDependencySecurityPatches, verifyDependencySecurityPatches } from "./dependency-security-policy.mjs";
import { EXPO_TAR_PATCHES, prepareToolchain } from "./prepare-toolchain.mjs";

const companionRoot = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(new URL("../package.json", import.meta.url));
const yamlPackagePaths = [
  "node_modules/@istanbuljs/load-nyc-config/node_modules/js-yaml",
  "node_modules/cosmiconfig/node_modules/js-yaml",
];
const scratch = mkdtempSync(join(companionRoot, ".dependency-security-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const originalSource = (patch) => {
  const path = patch.package === "js-yaml"
    ? join(companionRoot, yamlPackagePaths[0], patch.file)
    : require.resolve(`${patch.package}/${patch.file}`);
  let source = readFileSync(path, "utf8");
  if (sha256(source) === patch.patchedSha256) {
    for (const [before, after] of [...patch.replacements].reverse()) source = source.split(after).join(before);
  }
  assert.equal(sha256(source), patch.originalSha256);
  return source;
};
function fixture(name, { originals = false } = {}) {
  const root = join(scratch, name);
  const packages = { "": { devDependencies: Object.fromEntries(IMMUTABLE_DEPENDENCY_FORKS.map(({ name, relativePath }) => [name, `file:${relativePath}`])) } };
  const installedLock = JSON.parse(readFileSync(join(companionRoot, "package-lock.json")));
  mkdirSync(join(root, "vendor"), { recursive: true });
  cpSync(join(companionRoot, "vendor/dependency-forks"), join(root, "vendor/dependency-forks"), { recursive: true });
  for (const name of ["braces", "node-forge"]) {
    const target = join(root, "node_modules", name);
    cpSync(dirname(require.resolve(`${name}/package.json`)), target, { recursive: true });
    packages[`node_modules/${name}`] = { ...installedLock.packages[`node_modules/${name}`] };
  }
  const argparseTarget = join(root, "node_modules/argparse");
  cpSync(dirname(require.resolve("argparse/package.json")), argparseTarget, { recursive: true });
  packages["node_modules/argparse"] = { version: require("argparse/package.json").version };
  for (const [index, yamlPath] of yamlPackagePaths.entries()) {
    const yamlRoot = join(root, yamlPath);
    const yamlPackageRoot = join(companionRoot, yamlPackagePaths[0]);
    mkdirSync(dirname(yamlRoot), { recursive: true });
    cpSync(yamlPackageRoot, yamlRoot, { recursive: true });
    packages[yamlPath] = { version: "3.15.2", dependencies: { argparse: "^1.0.7", esprima: "^4.0.0" } };
    const consumerPath = index === 0 ? "node_modules/@istanbuljs/load-nyc-config" : "node_modules/cosmiconfig";
    const consumerName = index === 0 ? "@istanbuljs/load-nyc-config" : "cosmiconfig";
    const consumerRoot = join(root, consumerPath);
    mkdirSync(consumerRoot, { recursive: true });
    writeFileSync(join(consumerRoot, "package.json"), JSON.stringify({ name: consumerName, version: index === 0 ? "1.1.0" : "5.2.1", dependencies: { "js-yaml": "^3.15.2" } }));
    packages[consumerPath] = { version: index === 0 ? "1.1.0" : "5.2.1", dependencies: { "js-yaml": "^3.15.2" } };
  }
  for (const patch of DEPENDENCY_SECURITY_PATCHES) {
    const targets = patch.package === "js-yaml"
      ? yamlPackagePaths.map((yamlPath) => join(root, yamlPath, patch.file))
      : [join(root, "node_modules", patch.package, patch.file)];
    if (originals || patch.package === "js-yaml") for (const target of targets) writeFileSync(target, originalSource(patch));
  }
  for (const name of ["@expo/cli", "tar"]) mkdirSync(join(root, "node_modules", name), { recursive: true });
  writeFileSync(join(root, "node_modules/@expo/cli/package.json"), JSON.stringify({ name: "@expo/cli", version: "0.22.28" }));
  writeFileSync(join(root, "node_modules/tar/package.json"), JSON.stringify({ name: "tar", version: "7.5.22" }));
  mkdirSync(join(root, "node_modules/@expo/cli/build/src/utils"), { recursive: true });
  for (const patch of EXPO_TAR_PATCHES) {
    const path = join(require.resolve("@expo/cli/package.json"), "..", "build/src/utils", patch.name);
    const source = readFileSync(path, "utf8").replace('const data = { default: require("tar") };', 'const data = /*#__PURE__*/ _interopRequireDefault(require("tar"));');
    assert.equal(sha256(source), patch.originalSha256);
    writeFileSync(join(root, "node_modules/@expo/cli/build/src/utils", patch.name), source);
  }
  packages["node_modules/caller"] = { version: "1.0.0", dependencies: { braces: "^3.0.3", "node-forge": "^1.3.3" } };
  mkdirSync(join(root, "node_modules/caller"));
  writeFileSync(join(root, "node_modules/caller/package.json"), JSON.stringify({ name: "caller", ...packages["node_modules/caller"] }));
  writeFileSync(join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages }));
  return root;
}
const deepPattern = (open, close, depth) => open.repeat(depth) + "a,b" + close.repeat(depth);
function deepAst(depth) {
  const ast = { type: "root", nodes: [] };
  let node = ast;
  for (let index = 0; index < depth; index++) {
    const child = { type: "brace", nodes: [], commas: 1, parent: node };
    node.nodes.push(child);
    node = child;
  }
  node.nodes.push({ type: "text", value: "leaf" });
  return ast;
}
function rsaFixture(forge) {
  // Ephemeral synthetic low-exponent key; no account key material is stored.
  const key = generateKeyPairSync("rsa", { modulusLength: 1024, publicExponent: 3,
    publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  const privateKey = forge.pki.privateKeyFromPem(key.privateKey);
  const publicKey = forge.pki.publicKeyFromPem(key.publicKey);
  const digest = forge.md.sha256.create().update("owned RSA regression");
  const asn1 = forge.asn1;
  const der = (children) => asn1.toDer(asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, children),
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, digest.digest().getBytes()),
  ])).getBytes();
  const oid = () => asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer(forge.pki.oids.sha256).getBytes());
  const nil = (value = "") => asn1.create(asn1.Class.UNIVERSAL, asn1.Type.NULL, false, value);
  const garbage = () => asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, "nested garbage");
  const signDer = (value) => {
    const body = Buffer.from(value, "binary");
    const encoded = Buffer.concat([Buffer.from([0, 1]), Buffer.alloc(128 - body.length - 3, 0xff), Buffer.from([0]), body]);
    return privateEncrypt({ key: key.privateKey, padding: constants.RSA_NO_PADDING }, encoded).toString("binary");
  };
  const nativeSign = () => nodeSign("sha256", Buffer.from("owned RSA regression"), key.privateKey).toString("binary");
  return { privateKey, publicKey, digest, der, oid, nil, garbage, signDer, nativeSign };
}

test("all installed consumers/copies have reviewed mitigated bytes", () => {
  const result = verifyDependencySecurityPatches(companionRoot);
  assert.equal(result.files, 7);
  assert.equal(result.packages.length, 3);
  assert(result.consumers >= 6);
});

test("original vulnerable nested RSA structure is accepted before the mitigation", () => {
  const root = fixture("rsa-original", { originals: true });
  const forge = createRequire(join(root, "package.json"))("node-forge");
  const f = rsaFixture(forge);
  assert.equal(f.publicKey.verify(f.digest.digest().getBytes(), f.signDer(f.der([f.oid(), f.nil(), f.garbage()]))), true);
});

test("mitigated RSA rejects nested garbage with and without NULL and preserves normal signatures", () => {
  const forge = require("node-forge");
  const f = rsaFixture(forge);
  const digest = f.digest.digest().getBytes();
  assert.equal(f.publicKey.verify(digest, f.privateKey.sign(f.digest)), true);
  assert.equal(f.publicKey.verify(digest, f.signDer(f.der([f.oid(), f.nil()]))), true);
  assert.equal(f.publicKey.verify(digest, f.signDer(f.der([f.oid()]))), true);
  for (const children of [[f.oid(), f.nil(), f.garbage()], [f.oid(), f.garbage()]]) {
    assert.throws(() => f.publicKey.verify(digest, f.signDer(f.der(children))), /valid RSASSA-PKCS1-v1_5 DigestInfo/);
  }
  assert.equal(f.publicKey.verify(forge.md.sha256.create().update("different").digest().getBytes(), f.privateKey.sign(f.digest)), false);
  const certificates = require("@expo/code-signing-certificates");
  const now = Date.now();
  const certificate = certificates.generateSelfSignedCodeSigningCertificate({ keyPair: f, validityNotBefore: new Date(now - 60000), validityNotAfter: new Date(now + 60000), commonName: "owned fixture" });
  certificates.validateSelfSignedCertificate(certificate, f);
  assert.equal(typeof certificates.signBufferRSASHA256AndVerify(f.privateKey, certificate, Buffer.from("owned manifest")), "string");
});

test("prior arity-only RSA image accepts malformed nonempty NULL encodings", () => {
  const root = fixture("rsa-prior-null", { originals: true });
  const patch = DEPENDENCY_SECURITY_PATCHES.find((entry) => entry.package === "node-forge");
  const target = join(root, "node_modules/node-forge/lib/rsa.js");
  const [before, after, count] = patch.replacements[0];
  const source = readFileSync(target, "utf8");
  assert.equal(source.split(before).length - 1, count);
  const prior = source.split(before).join(after);
  assert.equal(sha256(prior), patch.previousPatchedSha256);
  writeFileSync(target, prior);
  const forge = createRequire(join(root, "package.json"))("node-forge");
  const f = rsaFixture(forge);
  // The fixture owns the private key: this proves malformed-encoding
  // acceptance by the prior image, not forgery without a private key.
  for (const length of [1, 8, 32]) {
    assert.equal(f.publicKey.verify(f.digest.digest().getBytes(), f.signDer(f.der([f.oid(), f.nil("x".repeat(length))]))), true);
  }
});

test("strict RSA NULL backport rejects nonempty parameters and preserves other verification modes", () => {
  const forge = require("node-forge");
  const f = rsaFixture(forge);
  const digest = f.digest.digest().getBytes();
  const absent = f.signDer(f.der([f.oid()]));
  const empty = f.signDer(f.der([f.oid(), f.nil()]));
  assert.equal(f.publicKey.verify(digest, absent), true);
  assert.equal(f.publicKey.verify(digest, empty), true);
  for (const length of [1, 8, 32]) {
    assert.throws(() => f.publicKey.verify(digest, f.signDer(f.der([f.oid(), f.nil("x".repeat(length))]))), /valid RSASSA-PKCS1-v1_5 DigestInfo/);
  }
  const wrongDigest = forge.md.sha256.create().update("different").digest().getBytes();
  assert.equal(f.publicKey.verify(wrongDigest, empty), false);
  const der = f.der([f.oid(), f.nil()]);
  assert.equal(der.charCodeAt(0), 0x30);
  assert(der.charCodeAt(1) < 0x80);
  assert.equal(f.publicKey.verify(digest, f.signDer("\x30\x80" + der.slice(2) + "\x00\x00")), true);
  const pss = forge.pss.create({ md: forge.md.sha256.create(), mgf: forge.mgf.mgf1.create(forge.md.sha256.create()), saltLength: 20 });
  const pssSignature = f.privateKey.sign(f.digest, pss);
  assert.equal(f.publicKey.verify(digest, pssSignature, pss), true);
  assert.equal(f.publicKey.verify(wrongDigest, pssSignature, pss), false);
  const noneSignature = f.privateKey.sign(digest, "NONE");
  assert.equal(f.publicKey.verify(digest, noneSignature, "NONE"), true);
  assert.equal(f.publicKey.verify(wrongDigest, noneSignature, "NONE"), false);
  const nativeSignature = f.nativeSign();
  assert.equal(f.publicKey.verify(digest, nativeSignature), true);
  assert.equal(f.publicKey.verify(wrongDigest, nativeSignature), false);
});

test("original braces walker reproduces stack exhaustion in a bounded child", () => {
  const root = fixture("braces-original", { originals: true });
  try {
    // fixture() reconstructs and verifies the exact reviewed original bytes.
    // Bound this negative control instead of relying on the parent V8 stack size.
    const child = spawnSync(process.execPath, [
      "--stack-size=512", "--max-old-space-size=64", "--input-type=commonjs", "-e",
      `const assert = require("node:assert/strict");
       const braces = require(process.argv[1]);
       assert.throws(() => braces.compile("{".repeat(4500) + "a,b" + "}".repeat(4500)),
         error => error instanceof RangeError && /Maximum call stack size exceeded/.test(error.message));
       process.stdout.write("MUSTER_OWNED_ORIGINAL_BRACES_RANGE_ERROR\\n");`,
      join(root, "node_modules", "braces"),
    ], { cwd: root, env: {}, encoding: "utf8", timeout: 5000, maxBuffer: 65536, killSignal: "SIGKILL" });
    assert.equal(child.error, undefined);
    assert.equal(child.signal, null);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, "MUSTER_OWNED_ORIGINAL_BRACES_RANGE_ERROR\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
    assert.equal(existsSync(root), false);
  }
});

test("deep braces and parentheses reject safely through public and private string/AST entries", () => {
  const braces = require("braces");
  const matcher = createRequire(require.resolve("metro-file-map/package.json"))("micromatch");
  assert.deepEqual(braces("src/{a,b}.js", { expand: true }), ["src/a.js", "src/b.js"]);
  assert.deepEqual(matcher(["src/a.js", "src/b.js", "other.js"], "src/{a,b}.js"), ["src/a.js", "src/b.js"]);
  for (const depth of [101, 3500, 4500]) {
    for (const [open, close] of [["{", "}"], ["(", ")"]]) {
      const pattern = deepPattern(open, close, depth);
      for (const method of [braces, braces.parse, braces.compile, braces.expand, braces.stringify]) assert.throws(() => method(pattern), /Muster braces nesting/);
    }
    for (const method of [braces.compile, braces.expand, braces.stringify, require("braces/lib/compile"), require("braces/lib/expand"), require("braces/lib/stringify")]) {
      assert.throws(() => method(deepAst(depth)), /Muster braces nesting/);
    }
  }
  // Real micromatch caller rejects the same attacker-controlled pattern.
  assert.throws(() => matcher.braces(deepPattern("{", "}", 3500)), /Muster braces nesting/);
});

test("preparation keeps immutable forks untouched while adapting reviewed CLI and YAML sources", () => {
  const root = fixture("prepare");
  const result = prepareToolchain(root);
  assert.equal(result.files.filter((file) => file.changed).length, 4);
  assert.equal(verifyDependencySecurityPatches(root).files, 7);
  const before = planDependencySecurityPatches(root).files.map((file) => statSync(file.target));
  assert.equal(prepareToolchain(root).status, "unchanged");
  for (const [index, file] of planDependencySecurityPatches(root).files.entries()) {
    const after = statSync(file.target);
    assert.equal(after.ino, before[index].ino);
    assert.equal(after.mtimeMs, before[index].mtimeMs);
  }
});

test("a prior RSA image is refused without install-time repair or unrelated writes", () => {
  const root = fixture("reject-prior-rsa");
  prepareToolchain(root);
  const patch = DEPENDENCY_SECURITY_PATCHES.find((entry) => entry.package === "node-forge");
  const target = join(root, "node_modules/node-forge/lib/rsa.js");
  const [before, after] = patch.replacements[1];
  const prior = readFileSync(target, "utf8").replace(after, before);
  assert.equal(sha256(prior), patch.previousPatchedSha256);
  const unchanged = planDependencySecurityPatches(root).files.filter((file) => file.target !== target)
    .map((file) => ({ target: file.target, stat: statSync(file.target), hash: sha256(readFileSync(file.target)) }));
  writeFileSync(target, prior);
  assert.throws(() => verifyDependencySecurityPatches(root), /Unknown immutable node-forge source/);
  assert.throws(() => prepareToolchain(root), /Unknown immutable node-forge source/);
  assert.equal(sha256(readFileSync(target)), patch.previousPatchedSha256);
  for (const file of unchanged) {
    assert.equal(sha256(readFileSync(file.target)), file.hash);
    assert.equal(statSync(file.target).ino, file.stat.ino);
    assert.equal(statSync(file.target).mtimeMs, file.stat.mtimeMs);
  }
});

test("formatter dependency and unknown js-yaml CLI source are refused before preparation writes", () => {
  const dependencyRoot = fixture("reject-js-yaml-formatter");
  const dependencyLockPath = join(dependencyRoot, "package-lock.json");
  const dependencyLock = JSON.parse(readFileSync(dependencyLockPath, "utf8"));
  dependencyLock.packages["node_modules/sprintf-js"] = { version: "1.0.3" };
  writeFileSync(dependencyLockPath, JSON.stringify(dependencyLock));
  assert.throws(() => planDependencySecurityPatches(dependencyRoot), /sprintf-js/);

  const optionalFormatterRoot = fixture("reject-js-yaml-optional-formatter");
  const optionalFormatterLockPath = join(optionalFormatterRoot, "package-lock.json");
  const optionalFormatterLock = JSON.parse(readFileSync(optionalFormatterLockPath, "utf8"));
  optionalFormatterLock.packages["node_modules/optional-consumer"] = { version: "1.0.0", optionalDependencies: { "sprintf-js": "^1.0.3" } };
  writeFileSync(optionalFormatterLockPath, JSON.stringify(optionalFormatterLock));
  assert.throws(() => planDependencySecurityPatches(optionalFormatterRoot), /sprintf-js.*optionalDependencies/);

  const devFormatterRoot = fixture("reject-js-yaml-dev-formatter");
  const devFormatterLockPath = join(devFormatterRoot, "package-lock.json");
  const devFormatterLock = JSON.parse(readFileSync(devFormatterLockPath, "utf8"));
  devFormatterLock.packages[""] = { version: "1.0.0", devDependencies: { "sprintf-js": "^1.0.3" } };
  writeFileSync(devFormatterLockPath, JSON.stringify(devFormatterLock));
  assert.throws(() => planDependencySecurityPatches(devFormatterRoot), /sprintf-js.*devDependencies/);

  const optionalYamlRoot = fixture("reject-js-yaml-optional-version");
  const optionalYamlLockPath = join(optionalYamlRoot, "package-lock.json");
  const optionalYamlLock = JSON.parse(readFileSync(optionalYamlLockPath, "utf8"));
  optionalYamlLock.packages["node_modules/optional-consumer"] = { version: "1.0.0", optionalDependencies: { "js-yaml": "3.15.3" } };
  optionalYamlLock.packages["node_modules/optional-consumer/node_modules/js-yaml"] = { version: "3.15.3" };
  writeFileSync(optionalYamlLockPath, JSON.stringify(optionalYamlLock));
  assert.throws(() => planDependencySecurityPatches(optionalYamlRoot), /Unsupported js-yaml version in package graph/);

  const sourceRoot = fixture("reject-js-yaml-source");
  const cli = join(sourceRoot, yamlPackagePaths[1], "bin/js-yaml.js");
  writeFileSync(cli, readFileSync(cli, "utf8") + "\n// unexpected local edit\n");
  const expoTar = join(sourceRoot, "node_modules/@expo/cli/build/src/utils/tar.js");
  const expoTarBefore = readFileSync(expoTar, "utf8");
  assert.throws(() => prepareToolchain(sourceRoot), /Unknown js-yaml source/);
  assert.equal(readFileSync(expoTar, "utf8"), expoTarBefore);
  assert.equal(sha256(readFileSync(join(sourceRoot, yamlPackagePaths[0], "bin/js-yaml.js"))), DEPENDENCY_SECURITY_PATCHES.find((patch) => patch.package === "js-yaml").originalSha256);

  const lockVersionRoot = fixture("reject-js-yaml-lock-version");
  const lockVersionPath = join(lockVersionRoot, "package-lock.json");
  const lockVersion = JSON.parse(readFileSync(lockVersionPath, "utf8"));
  lockVersion.packages[yamlPackagePaths[1]].version = "3.15.3";
  writeFileSync(lockVersionPath, JSON.stringify(lockVersion));
  const bracesBefore = readFileSync(join(lockVersionRoot, "node_modules/braces/lib/parse.js"), "utf8");
  assert.throws(() => prepareToolchain(lockVersionRoot), /Unsupported js-yaml version in package graph/);
  assert.equal(readFileSync(join(lockVersionRoot, "node_modules/braces/lib/parse.js"), "utf8"), bracesBefore);
  assert.equal(sha256(readFileSync(join(lockVersionRoot, yamlPackagePaths[0], "bin/js-yaml.js"))), DEPENDENCY_SECURITY_PATCHES.find((patch) => patch.package === "js-yaml").originalSha256);
});

test("unknown dependency bytes or versions reject before any reviewed source is changed", () => {
  for (const change of ["bytes", "version"]) {
    const root = fixture(`reject-${change}`);
    const rsa = join(root, "node_modules/node-forge/lib/rsa.js");
    if (change === "bytes") writeFileSync(rsa, readFileSync(rsa, "utf8") + "\n// unexpected\n");
    else writeFileSync(join(root, "node_modules/node-forge/package.json"), JSON.stringify({ name: "node-forge", version: "1.4.1" }));
    assert.throws(() => prepareToolchain(root), change === "bytes" ? /Unknown immutable node-forge source|Unexpected immutable input size/ : /Unsupported node-forge version/);
    for (const patch of DEPENDENCY_SECURITY_PATCHES.filter((patch) => patch.package === "braces")) {
      assert.equal(sha256(readFileSync(join(root, "node_modules", patch.package, patch.file))), patch.patchedSha256);
    }
    assert.equal(sha256(readFileSync(join(root, "node_modules/@expo/cli/build/src/utils/tar.js"))), EXPO_TAR_PATCHES[0].originalSha256);
  }
});

test("nested resolved copies are planned and unverifiable inherited resolution is refused", () => {
  const root = fixture("nested");
  const copy = join(root, "node_modules/caller/node_modules/braces");
  cpSync(join(root, "node_modules/braces"), copy, { recursive: true });
  const lockPath = join(root, "package-lock.json");
  const lock = JSON.parse(readFileSync(lockPath));
  lock.packages["node_modules/caller/node_modules/braces"] = { ...lock.packages["node_modules/braces"] };
  writeFileSync(lockPath, JSON.stringify(lock));
  assert.equal(planDependencySecurityPatches(root).files.length, 11);
  prepareToolchain(root);
  assert.equal(verifyDependencySecurityPatches(root).packages.find((entry) => entry.name === "braces").copies, 2);
  delete lock.packages["node_modules/caller/node_modules/braces"];
  writeFileSync(lockPath, JSON.stringify(lock));
  assert.throws(() => planDependencySecurityPatches(root), /Unreviewed braces resolution/);
});

test("missing preparation and symlink/hardlink sources fail closed", () => {
  const unprepared = fixture("unprepared");
  assert.throws(() => verifyDependencySecurityPatches(unprepared), /mitigations are missing/);
  for (const link of ["symlink", "hardlink"]) {
    const root = fixture(`reject-${link}`);
    const path = join(root, "node_modules/braces/lib/parse.js");
    const source = join(root, "original-parse.js");
    writeFileSync(source, readFileSync(path));
    rmSync(path);
    if (link === "symlink") symlinkSync(source, path);
    else linkSync(source, path);
    assert.throws(() => prepareToolchain(root), /unlinked regular dependency file/);
  }
});


test("toolchain verifier stops on missing mitigation before dependency callers are resolved", () => {
  const root = fixture("verifier-refusal");
  mkdirSync(join(root, "scripts"));
  for (const name of ["verify-toolchain.mjs", "prepare-toolchain.mjs", "dependency-security-policy.mjs"]) {
    cpSync(join(companionRoot, "scripts", name), join(root, "scripts", name));
  }
  // The fixture intentionally has no plist/Metro callers. A verifier that
  // catches the prerequisite failure and continues would resolve those next.
  const result = spawnSync(process.execPath, [join(root, "scripts/verify-toolchain.mjs")], { encoding: "utf8", env: {}, timeout: 10000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Dependency mitigations are missing/);
  assert.doesNotMatch(result.stderr, /Cannot find module|MODULE_NOT_FOUND/);
  assert.equal(result.stdout, "");
});


test("immutable fork archives, provenance and every lock edge refuse drift before writes", () => {
  for (const change of ["archive", "provenance", "registry-resolution", "integrity", "root-selection"]) {
    const root = fixture(`immutable-${change}`);
    const descriptor = IMMUTABLE_DEPENDENCY_FORKS.find(({ name }) => name === "node-forge");
    const cli = join(root, "node_modules/@expo/cli/build/src/utils/tar.js");
    const cliBefore = readFileSync(cli);
    if (change === "archive" || change === "provenance") {
      const target = join(root, change === "archive" ? descriptor.relativePath : "vendor/dependency-forks/provenance.json");
      const bytes = readFileSync(target); bytes[0] ^= 1; writeFileSync(target, bytes);
    } else {
      const path = join(root, "package-lock.json"); const lock = JSON.parse(readFileSync(path));
      if (change === "registry-resolution") lock.packages["node_modules/node-forge"].resolved = "https://registry.npmjs.org/node-forge/-/node-forge-1.4.0.tgz";
      if (change === "integrity") lock.packages["node_modules/node-forge"].integrity = "sha512-unreviewed";
      if (change === "root-selection") lock.packages[""].devDependencies["node-forge"] = "1.4.0";
      writeFileSync(path, JSON.stringify(lock));
    }
    assert.throws(() => prepareToolchain(root), /Unknown immutable|Unreviewed immutable|Root must select immutable/);
    assert.deepEqual(readFileSync(cli), cliBefore);
  }
});

test("complete immutable inventory rejects unpatched entrypoints, omitted bundles and unrelated file changes", () => {
  for (const change of ["original-rsa", "added-dist", "empty-dist", "altered-license", "missing-file"]) {
    const root = fixture(`inventory-${change}`);
    const packageRoot = join(root, "node_modules/node-forge");
    const cli = join(root, "node_modules/@expo/cli/build/src/utils/tar.js"); const before = readFileSync(cli);
    if (change === "original-rsa") writeFileSync(join(packageRoot, "lib/rsa.js"), originalSource(DEPENDENCY_SECURITY_PATCHES.find(({ package: name }) => name === "node-forge")));
    if (change === "added-dist") { mkdirSync(join(packageRoot, "dist")); writeFileSync(join(packageRoot, "dist/forge.min.js"), "unreviewed vulnerable browser distribution"); }
    if (change === "empty-dist") mkdirSync(join(packageRoot, "dist"));
    if (change === "altered-license") { const target = join(packageRoot, "LICENSE"); const bytes = readFileSync(target); bytes[0] ^= 1; writeFileSync(target, bytes); }
    if (change === "missing-file") rmSync(join(packageRoot, "lib/sha256.js"));
    assert.throws(() => prepareToolchain(root), /Unknown immutable/);
    assert.deepEqual(readFileSync(cli), before);
  }
  assert.throws(() => require.resolve("node-forge/dist/forge.min.js"), { code: "MODULE_NOT_FOUND" });
  assert.throws(() => require.resolve("node-forge/dist/forge.all.min.js"), { code: "MODULE_NOT_FOUND" });
  assert.equal(typeof require("node-forge").pki.publicKeyFromPem, "function");
});


test("immutable archive links and installed source permissions fail closed", () => {
  for (const change of ["archive-symlink", "archive-hardlink", "source-mode"]) {
    const root = fixture(`identity-${change}`);
    const descriptor = IMMUTABLE_DEPENDENCY_FORKS[0];
    const target = join(root, descriptor.relativePath);
    const before = readFileSync(join(root, "node_modules/@expo/cli/build/src/utils/tar.js"));
    if (change === "source-mode") chmodSync(join(root, "node_modules/braces/index.js"), 0o600);
    else {
      const owned = join(root, "archive-copy.tgz"); writeFileSync(owned, readFileSync(target)); rmSync(target);
      if (change === "archive-symlink") symlinkSync(owned, target); else linkSync(owned, target);
    }
    assert.throws(() => prepareToolchain(root), /unlinked regular dependency file|Unknown immutable braces mode/);
    assert.deepEqual(readFileSync(join(root, "node_modules/@expo/cli/build/src/utils/tar.js")), before);
  }
});
