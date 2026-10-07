#!/usr/bin/env node
// Offline compatibility checks for the actual Expo 52 callers of overridden
// dependencies. This does not build a native app or constitute a security scan.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { constants, createHash, generateKeyPairSync, privateEncrypt, sign as nodeSign } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { EXPO_TAR_PATCHES, prepareToolchain } from "./prepare-toolchain.mjs";
import { DEPENDENCY_SECURITY_PATCHES, verifyDependencySecurityPatches } from "./dependency-security-policy.mjs";

const require = createRequire(new URL("../package.json", import.meta.url));
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "muster-expo-compat-")));
const originalCwd = process.cwd();
let checks = 0;
let passed = 0;
const failures = [];

async function check(name, action) {
  checks += 1;
  try {
    await action();
    passed += 1;
    console.log(`ok ${checks} - ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`not ok ${checks} - ${name}`);
    console.error(error);
  }
}

async function main() {
  // Resolve installed code from this companion, then give its callers an owned
  // HOME/cache/cwd. Clear credentials, proxies and hooks before loading callers;
  // this cannot undo a Node preload that already ran at process startup.
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  for (const key of Object.keys(process.env)) delete process.env[key];
  const home = join(scratch, "home");
  const noTools = join(scratch, "no-executables");
  mkdirSync(home);
  mkdirSync(noTools);
  Object.assign(process.env, {
    HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
    XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, XDG_DATA_HOME: home, XDG_STATE_HOME: home,
    TMPDIR: scratch, TEMP: scratch, TMP: scratch,
    PATH: noTools, EXPO_OFFLINE: "1", EXPO_NO_TELEMETRY: "1", CI: "1",
  });
  if (systemRoot) process.env.SystemRoot = systemRoot;
  process.chdir(scratch);

  // This prerequisite is deliberately outside check(): a failure must stop
  // before resolving/evaluating any Expo or Metro dependency caller.
  const securityReceipt = verifyDependencySecurityPatches(fileURLToPath(new URL("..", import.meta.url)));
  await check("all installed vulnerable-package sources have reviewed mitigations before loading callers", () => {
    const receipt = securityReceipt;
    assert.equal(receipt.files, 7);
    assert.equal(receipt.packages.length, 3);
    assert(receipt.consumers >= 6);
  });

  const cliRoot = dirname(require.resolve("@expo/cli/package.json"));
  const tarCaller = join(cliRoot, "build/src/utils/tar.js");
  const npmCaller = join(cliRoot, "build/src/utils/npm.js");
  const plistCaller = join(cliRoot, "build/src/utils/plist.js");
  const tarRequire = createRequire(tarCaller);
  const plistRequire = createRequire(plistCaller);
  const plistEntry = plistRequire.resolve("@expo/plist");
  const xcodeCaller = join(dirname(require.resolve("@expo/config-plugins/package.json")), "build/ios/utils/Xcodeproj.js");
  const xcodeRequire = createRequire(xcodeCaller);
  const xcodeEntry = xcodeRequire.resolve("xcode");
  const metroCaller = join(dirname(require.resolve("@expo/metro-config/package.json")), "build/transform-worker/postcss.js");
  const metroRequire = createRequire(metroCaller);
  const bunyanEntry = createRequire(tarCaller).resolve("@expo/bunyan");
  const versions = {
    tar: tarRequire("tar/package.json").version,
    npmTar: createRequire(npmCaller)("tar/package.json").version,
    xmldom: createRequire(plistEntry)("@xmldom/xmldom/package.json").version,
    postcss: metroRequire("postcss/package.json").version,
    xcodeUuid: createRequire(xcodeEntry)("uuid/package.json").version,
    bunyanUuid: createRequire(bunyanEntry)("uuid/package.json").version,
  };

  await check("actual caller resolution uses the intended dependency versions", () => {
    assert.deepEqual(versions, { tar: "7.5.22", npmTar: "7.5.22", xmldom: "0.8.15", postcss: "8.5.28", xcodeUuid: "11.1.1", bunyanUuid: "11.1.1" });
  });

  const jsYamlCliPaths = [
    join(fileURLToPath(new URL("..", import.meta.url)), "node_modules/@istanbuljs/load-nyc-config/node_modules/js-yaml/bin/js-yaml.js"),
    join(fileURLToPath(new URL("..", import.meta.url)), "node_modules/cosmiconfig/node_modules/js-yaml/bin/js-yaml.js"),
  ];
  await check("both js-yaml 3 CLIs preserve behavior with argparse 2 and no sprintf-js", () => {
    for (const cliPath of jsYamlCliPaths) {
      assert.equal(createRequire(cliPath)("argparse/package.json").version, "2.0.1");
      const yamlApi = createRequire(cliPath)("../");
      const roundTripValue = { name: "Muster", enabled: true, count: 2 };
      assert.deepEqual(yamlApi.safeLoad(yamlApi.safeDump(roundTripValue)), roundTripValue);
      const invoke = (args, input) => {
        const result = spawnSync(process.execPath, [cliPath, ...args], { cwd: scratch, env: process.env, input, encoding: "utf8", timeout: 5000, maxBuffer: 256 * 1024 });
        assert.equal(result.error, undefined, result.error?.message);
        assert.equal(result.signal, null);
        assert.equal(result.stderr.includes("DeprecationWarning"), false, result.stderr);
        return result;
      };
      for (const flag of ["-v", "--version"]) {
        const version = invoke([flag]);
        assert.equal(version.status, 0);
        assert.equal(version.stdout, "3.15.2\n");
      }
      const expectedHelp = [
        "usage: js-yaml [-h] [-v] [-c] [-t] [file]",
        "",
        "Positional arguments:",
        "  file           File to read, utf-8 encoded without BOM",
        "",
        "Optional arguments:",
        "  -h, --help     Show this help message and exit.",
        "  -v, --version  Show program's version number and exit.",
        "  -c, --compact  Display errors in compact mode",
        "  -t, --trace    Show stack trace on error",
        "",
      ].join("\n");
      for (const flag of ["-h", "--help"]) {
        const help = invoke([flag]);
        assert.equal(help.status, 0);
        assert.equal(help.stdout, expectedHelp);
        assert.equal(help.stderr, "");
      }
      const usage = "usage: js-yaml [-h] [-v] [-c] [-t] [file]\n";
      const invalidOption = invoke(["--not-a-flag"]);
      assert.equal(invalidOption.status, 2);
      assert.equal(invalidOption.stdout, usage);
      assert.equal(invalidOption.stderr, "js-yaml: error: Unrecognized arguments: --not-a-flag.\n");
      const extraPositional = invoke(["one", "two"]);
      assert.equal(extraPositional.status, 2);
      assert.equal(extraPositional.stdout, usage);
      assert.equal(extraPositional.stderr, "js-yaml: error: Unrecognized arguments: two.\n");
      const ambiguousOption = invoke(["--t"]);
      assert.equal(ambiguousOption.status, 2);
      assert.equal(ambiguousOption.stdout, usage);
      assert.equal(ambiguousOption.stderr, "js-yaml: error: Ambiguous option: \"--t\" could match --to-json, --trace.\n");
      for (const flag of ["--compact=x", "-c=x", "--trace=x", "-t=x", "--to-json=x", "-j=x"]) {
        const explicitBooleanValue = invoke([flag]);
        assert.equal(explicitBooleanValue.status, 2);
        assert.equal(explicitBooleanValue.stdout, usage);
        assert.equal(explicitBooleanValue.stderr, "js-yaml: error: [sprintf] unexpected placeholder\n");
      }
      const yaml = invoke([], "name: Muster\ncount: 2\n");
      assert.equal(yaml.status, 0);
      assert.equal(yaml.stdout, "{\n  \"name\": \"Muster\",\n  \"count\": 2\n}\n");
      const json = invoke([], "{\"name\":\"Muster\",\"count\":2}");
      assert.equal(json.status, 0);
      assert.equal(json.stdout, "name: Muster\ncount: 2\n\n");
      for (const flag of ["-j", "--to-json"]) {
        const legacyFlag = invoke([flag], "name: Muster\n");
        assert.equal(legacyFlag.status, 0);
        assert.equal(legacyFlag.stdout, "{\n  \"name\": \"Muster\"\n}\n");
      }
      for (const flag of ["-c", "--compact"]) {
        const compact = invoke([flag], "name: [\n");
        assert.equal(compact.status, 1);
        assert.match(compact.stderr, /^YAMLException: unexpected end of the stream within a flow collection\n$/);
      }
      for (const flag of ["-t", "--trace"]) {
        const trace = invoke([flag], "name: [\n");
        assert.equal(trace.status, 1);
        assert.match(trace.stderr, /^YAMLException: unexpected end of the stream within a flow collection/);
        assert.match(trace.stderr, /at generateError/);
        assert(trace.stderr.split("\n").some((line) => line.endsWith(`${cliPath}:108:14`)), "Trace should retain the original CLI call-site line");
      }
      const missing = join(scratch, "missing.yml");
      const notFound = invoke([missing]);
      assert.equal(notFound.status, 2);
      assert.equal(notFound.stderr, `File not found: ${missing}\n`);
    }
  });

  // Behavioral regression checks for the reviewed braces and node-forge
  // mitigations, exercised through the real installed consumers. The hash
  // receipt above proves which bytes are loaded; these prove what they do.
  const braces = require("braces");
  const micromatch = createRequire(require.resolve("metro-file-map/package.json"))("micromatch");
  const fastGlob = require("fast-glob");
  const forge = require("node-forge");
  const certificates = require("@expo/code-signing-certificates");
  const selfsigned = require("selfsigned");
  const deepPattern = (open, close, depth) => open.repeat(depth) + "a,b" + close.repeat(depth);
  const nestingError = /Muster braces nesting/;

  await check("mitigated braces keeps reviewed expansions identical and fails closed through real callers", () => {
    assert.deepEqual(braces("src/{a,b}.js", { expand: true }), ["src/a.js", "src/b.js"]);
    assert.deepEqual(braces("a/{b,{c,d}}/e", { expand: true }), ["a/b/e", "a/c/e", "a/d/e"]);
    assert.deepEqual(braces("file-{1..3}.txt", { expand: true }), ["file-1.txt", "file-2.txt", "file-3.txt"]);
    assert.deepEqual(braces("{a,b}/{c,d}"), ["(a|b)/(c|d)"]);
    assert.deepEqual(micromatch(["src/a.js", "src/b.js", "other.js"], "src/{a,b}.js"), ["src/a.js", "src/b.js"]);
    for (const depth of [101, 3500]) {
      for (const [open, close] of [["{", "}"], ["(", ")"]]) {
        const pattern = deepPattern(open, close, depth);
        for (const method of [braces, braces.parse, braces.expand, braces.compile, braces.stringify]) {
          assert.throws(() => method(pattern), nestingError);
        }
        // micromatch short-circuits patterns without "{" before reaching braces.
        if (open === "{") {
          assert.throws(() => micromatch.braces(pattern), nestingError);
          assert.throws(() => fastGlob.sync([pattern], { cwd: scratch }), nestingError);
        }
      }
    }
  });

  // The positive RSA vectors are signed with Node's OpenSSL backend (and one
  // raw-signed DigestInfo pair), so legitimate PKCS#1 v1.5 signatures must keep
  // verifying after the strict DigestInfo patch.
  const vectorKeys = (() => {
    const generated = generateKeyPairSync("rsa", { modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
    return { pem: generated, pair: { publicKey: forge.pki.publicKeyFromPem(generated.publicKey), privateKey: forge.pki.privateKeyFromPem(generated.privateKey) } };
  })();
  const vectorMessage = Buffer.from("muster offline advisory regression");
  const vectorDigest = () => forge.md.sha256.create().update(vectorMessage.toString("binary"));
  const sha256Oid = () => forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.OID, false, forge.asn1.oidToDer(forge.pki.oids.sha256).getBytes());
  const nullParameters = () => forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.NULL, false, "");
  const digestInfoDer = (algorithmChildren, trailing = []) => forge.asn1.toDer(forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
    forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, algorithmChildren),
    forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.OCTETSTRING, false, vectorDigest().digest().getBytes()),
    ...trailing,
  ])).getBytes();
  const rawSign = (binaryDigestInfo) => {
    const body = Buffer.from(binaryDigestInfo, "binary");
    const modulusLength = (vectorKeys.pair.privateKey.n.bitLength() + 7) >> 3;
    const encoded = Buffer.concat([Buffer.from([0, 1]), Buffer.alloc(modulusLength - body.length - 3, 0xff), Buffer.from([0]), body]);
    return privateEncrypt({ key: vectorKeys.pem.privateKey, padding: constants.RSA_NO_PADDING }, encoded).toString("binary");
  };

  await check("mitigated node-forge verifies OpenSSL and forge signatures and real Expo certificates", () => {
    const digest = vectorDigest().digest().getBytes();
    const verify = (signature) => vectorKeys.pair.publicKey.verify(digest, signature);
    assert.equal(verify(nodeSign("sha256", vectorMessage, vectorKeys.pem.privateKey).toString("binary")), true);
    assert.equal(verify(vectorKeys.pair.privateKey.sign(vectorDigest())), true);
    assert.equal(verify(rawSign(digestInfoDer([sha256Oid(), nullParameters()]))), true);
    assert.equal(verify(rawSign(digestInfoDer([sha256Oid()]))), true);
    const now = Date.now();
    const certificate = certificates.generateSelfSignedCodeSigningCertificate({ keyPair: vectorKeys.pair,
      validityNotBefore: new Date(now - 60000), validityNotAfter: new Date(now + 60000), commonName: "owned offline fixture" });
    certificates.validateSelfSignedCertificate(certificate, vectorKeys.pair);
    assert.equal(typeof certificates.signBufferRSASHA256AndVerify(vectorKeys.pair.privateKey, certificate, vectorMessage), "string");
    const generated = selfsigned.generate([{ name: "commonName", value: "owned offline fixture" }], { keySize: 2048, days: 1, algorithm: "sha256" });
    const parsed = forge.pki.certificateFromPem(generated.cert);
    assert.equal(parsed.verify(parsed), true);
  });

  await check("mitigated node-forge rejects extra nested DigestAlgorithm elements in signatures", () => {
    const nested = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.OCTETSTRING, false, "nested garbage");
    for (const algorithmChildren of [[sha256Oid(), nullParameters(), nested], [sha256Oid(), sha256Oid()]]) {
      assert.throws(() => vectorKeys.pair.publicKey.verify(vectorDigest().digest().getBytes(), rawSign(digestInfoDer(algorithmChildren))),
        /valid RSASSA-PKCS1-v1_5 DigestInfo/);
    }
  });

  // Copy only the reviewed source bytes and package metadata. Preparation
  // checks never mutate the installed toolchain from inside this verifier.
  const originalSources = new Map(EXPO_TAR_PATCHES.map((patch) => {
    const source = readFileSync(join(cliRoot, "build/src/utils", patch.name), "utf8");
    const original = source.replace('const data = { default: require("tar") };', 'const data = /*#__PURE__*/ _interopRequireDefault(require("tar"));');
    assert.equal(createHash("sha256").update(original).digest("hex"), patch.originalSha256, `Cannot construct reviewed original fixture for ${patch.name}`);
    return [patch.name, original];
  }));
  const fixturePath = (root, name) => join(root, "node_modules/@expo/cli/build/src/utils", name);
  function preparationFixture(name) {
    const root = join(scratch, name);
    mkdirSync(join(root, "node_modules/@expo/cli/build/src/utils"), { recursive: true });
    mkdirSync(join(root, "node_modules/tar"));
    writeFileSync(join(root, "node_modules/@expo/cli/package.json"), JSON.stringify({ name: "@expo/cli", version: "0.22.28" }));
    writeFileSync(join(root, "node_modules/tar/package.json"), JSON.stringify({ name: "tar", version: "7.5.22" }));
    for (const [file, source] of originalSources) writeFileSync(fixturePath(root, file), source);
    const securityPackages = {};
    for (const patch of DEPENDENCY_SECURITY_PATCHES) {
      const packagePaths = patch.package === "js-yaml"
        ? [
          "node_modules/@istanbuljs/load-nyc-config/node_modules/js-yaml",
          "node_modules/cosmiconfig/node_modules/js-yaml",
        ]
        : [`node_modules/${patch.package}`];
      for (const packagePath of packagePaths) {
        const packageRoot = join(root, packagePath);
        mkdirSync(join(packageRoot, dirname(patch.file)), { recursive: true });
        writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: patch.package, version: patch.version }));
        securityPackages[packagePath] = { version: patch.version };
        const originalPath = patch.package === "js-yaml"
          ? join(fileURLToPath(new URL("..", import.meta.url)), "node_modules/@istanbuljs/load-nyc-config/node_modules/js-yaml", patch.file)
          : require.resolve(`${patch.package}/${patch.file}`);
        let source = readFileSync(originalPath, "utf8");
        if (createHash("sha256").update(source).digest("hex") === patch.patchedSha256) {
          for (const [before, after] of [...patch.replacements].reverse()) source = source.split(after).join(before);
        }
        assert.equal(createHash("sha256").update(source).digest("hex"), patch.originalSha256);
        writeFileSync(join(packageRoot, patch.file), source);
      }
    }
    mkdirSync(join(root, "node_modules/argparse"), { recursive: true });
    writeFileSync(join(root, "node_modules/argparse/package.json"), JSON.stringify({ name: "argparse", version: "2.0.1" }));
    securityPackages["node_modules/argparse"] = { version: "2.0.1" };
    for (const [packagePath, name, version] of [
      ["node_modules/@istanbuljs/load-nyc-config", "@istanbuljs/load-nyc-config", "1.1.0"],
      ["node_modules/cosmiconfig", "cosmiconfig", "5.2.1"],
    ]) {
      mkdirSync(join(root, packagePath), { recursive: true });
      writeFileSync(join(root, packagePath, "package.json"), JSON.stringify({ name, version, dependencies: { "js-yaml": "^3.15.2" } }));
      securityPackages[packagePath] = { version, dependencies: { "js-yaml": "^3.15.2" } };
    }
    writeFileSync(join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: securityPackages }));
    return root;
  }
  const preparationRoot = preparationFixture("preparation");
  await check("trusted preparation changes both reviewed imports in an owned copy", () => {
    const result = prepareToolchain(preparationRoot);
    assert.equal(result.status, "prepared");
    assert.equal(result.files.filter((file) => file.changed).length, 9);
    for (const patch of EXPO_TAR_PATCHES) {
      assert.equal(createHash("sha256").update(readFileSync(fixturePath(preparationRoot, patch.name))).digest("hex"), patch.patchedSha256);
    }
  });
  await check("preparation reapplication keeps identical bytes without replacing files", () => {
    const before = EXPO_TAR_PATCHES.map(({ name }) => statSync(fixturePath(preparationRoot, name)));
    const result = prepareToolchain(preparationRoot);
    assert.equal(result.status, "unchanged");
    assert.equal(result.files.some((file) => file.changed), false);
    for (const [index, patch] of EXPO_TAR_PATCHES.entries()) {
      assert.equal(createHash("sha256").update(readFileSync(fixturePath(preparationRoot, patch.name))).digest("hex"), patch.patchedSha256);
      const after = statSync(fixturePath(preparationRoot, patch.name));
      assert.equal(after.ino, before[index].ino);
      assert.equal(after.mtimeMs, before[index].mtimeMs);
      assert.equal(after.ctimeMs, before[index].ctimeMs);
    }
  });
  await check("an unknown second input rejects preparation before either source changes", () => {
    const root = preparationFixture("unknown-source");
    const unknown = originalSources.get("npm.js") + "\n// unexpected local edit\n";
    writeFileSync(fixturePath(root, "npm.js"), unknown);
    assert.throws(() => prepareToolchain(root), /Unknown Expo CLI source: npm\.js/);
    assert.equal(readFileSync(fixturePath(root, "tar.js"), "utf8"), originalSources.get("tar.js"));
    assert.equal(readFileSync(fixturePath(root, "npm.js"), "utf8"), unknown);
  });
  await check("unsupported Expo and tar versions are refused without source changes", () => {
    const root = preparationFixture("unknown-version");
    const cliPackage = join(root, "node_modules/@expo/cli/package.json");
    writeFileSync(cliPackage, JSON.stringify({ name: "@expo/cli", version: "0.22.29" }));
    assert.throws(() => prepareToolchain(root), /Unsupported Expo CLI version/);
    writeFileSync(cliPackage, JSON.stringify({ name: "@expo/cli", version: "0.22.28" }));
    writeFileSync(join(root, "node_modules/tar/package.json"), JSON.stringify({ name: "tar", version: "7.5.23" }));
    assert.throws(() => prepareToolchain(root), /Unsupported tar version/);
    for (const [name, source] of originalSources) assert.equal(readFileSync(fixturePath(root, name), "utf8"), source);
  });
  await check("preparation completes an interrupted mixed original and patched pair", () => {
    const root = preparationFixture("interrupted-prepare");
    writeFileSync(fixturePath(root, "tar.js"), readFileSync(fixturePath(preparationRoot, "tar.js")));
    const result = prepareToolchain(root);
    assert.equal(result.status, "prepared");
    assert.deepEqual(result.files.filter((file) => ["tar.js", "npm.js"].includes(file.name)).map(({ name, changed }) => ({ name, changed })), [{ name: "tar.js", changed: false }, { name: "npm.js", changed: true }]);
    assert.equal(prepareToolchain(root).status, "unchanged");
  });

  const source = join(scratch, "source");
  mkdirSync(join(source, "package", "nested folder"), { recursive: true });
  writeFileSync(join(source, "package", "package.json"), '{"name":"owned-template","version":"1.0.0"}\n');
  writeFileSync(join(source, "package", "nested folder", "hello.txt"), "Owned template — café\n");
  writeFileSync(join(source, "package", "gitignore"), "node_modules/\n");
  const archive = join(scratch, "fixture.tgz");
  await tarRequire("tar").create({ cwd: source, file: archive, gzip: true }, ["package"]);

  await check("Expo archive extraction uses its JS fallback and preserves nested bytes", async () => {
    const output = join(scratch, "archive-output");
    mkdirSync(output);
    // Empty owned PATH makes native tar unavailable on POSIX. Windows already
    // chooses this JS branch. No host tar binary can mask an API mismatch.
    await require(tarCaller).extractAsync(archive, output);
    assert.equal(readFileSync(join(output, "package", "nested folder", "hello.txt"), "utf8"), "Owned template — café\n");
    assert.equal(readFileSync(join(output, "package", "package.json"), "utf8"), readFileSync(join(source, "package", "package.json"), "utf8"));
  });

  await check("Expo local template extraction strips the root, renames gitignore, and hashes the stream", async () => {
    const output = join(scratch, "template-output");
    const checksum = await require(npmCaller).extractLocalNpmTarballAsync(archive, { cwd: output, checksumAlgorithm: "sha256" });
    assert.equal(checksum, createHash("sha256").update(readFileSync(archive)).digest("hex"));
    assert.equal(readFileSync(join(output, "nested folder", "hello.txt"), "utf8"), "Owned template — café\n");
    assert.equal(readFileSync(join(output, ".gitignore"), "utf8"), "node_modules/\n");
    assert.deepEqual(JSON.parse(readFileSync(join(output, "package.json"), "utf8")), { name: "owned-template", version: "1.0.0" });
  });

  const plist = plistRequire("@expo/plist").default;
  const plistValue = { CFBundleDisplayName: "Muster & Friends <Preview> ☀", Enabled: true, Disabled: false, BuildNumber: 7, Fraction: 1.25, Nested: { Names: ["A", "B"], Empty: "" } };
  let xml;
  await check("Expo plist builds and parses structured values through xmldom", () => {
    xml = plist.build(plistValue);
    assert.match(xml, /&amp;/);
    assert.match(xml, /&lt;Preview&gt;/);
    assert.deepEqual(plist.parse(xml), plistValue);
  });

  await check("Expo CLI parses the generated plist from bytes and an owned file", async () => {
    const target = join(scratch, "Info.plist");
    writeFileSync(target, xml);
    const parser = require(plistCaller);
    assert.deepEqual(parser.parsePlistBuffer(Buffer.from(xml)), plistValue);
    assert.deepEqual(await parser.parsePlistAsync(target), plistValue);
  });

  await check("xcode generates UUID-backed groups that survive project serialization", () => {
    const target = join(scratch, "project.pbxproj");
    writeFileSync(target, `// !$*UTF8*$!
{
  archiveVersion = 1;
  classes = {};
  objectVersion = 46;
  objects = {
    /* Begin PBXGroup section */
    000000000000000000000001 = { isa = PBXGroup; children = (); sourceTree = "<group>"; };
    /* End PBXGroup section */
    /* Begin PBXFileReference section */
    000000000000000000000002 = { isa = PBXFileReference; path = App.swift; sourceTree = "<group>"; };
    /* End PBXFileReference section */
    /* Begin PBXProject section */
    000000000000000000000003 = { isa = PBXProject; mainGroup = 000000000000000000000001; targets = (); };
    /* End PBXProject section */
  };
  rootObject = 000000000000000000000003;
}
`);
    const xcode = xcodeRequire("xcode");
    const project = xcode.project(target).parseSync();
    const first = project.addPbxGroup([], "OwnedTools", "OwnedTools");
    const second = project.addPbxGroup([], "OwnedTests", "OwnedTests");
    assert.match(first.uuid, /^[0-9A-F]{24}$/);
    assert.match(second.uuid, /^[0-9A-F]{24}$/);
    assert.notEqual(first.uuid, second.uuid);
    project.hash.project.objects.PBXGroup["000000000000000000000001"].children.push({ value: first.uuid, comment: "OwnedTools" }, { value: second.uuid, comment: "OwnedTests" });
    writeFileSync(target, project.writeSync());
    const restored = xcode.project(target).parseSync();
    assert.equal(restored.hash.project.objects.PBXGroup[first.uuid].name, "OwnedTools");
    assert.equal(restored.hash.project.objects.PBXGroup[second.uuid].name, "OwnedTests");
    assert.equal(restored.hash.project.objects.PBXGroup["000000000000000000000001"].children.length, 2);
  });

  await check("Expo bunyan generates its UUID v1 record ID without external output", () => {
    const records = [];
    const logger = require(bunyanEntry).createLogger({ name: "owned-compatibility", streams: [{ type: "raw", stream: { write: (record) => records.push(record) } }] });
    logger.info("owned fixture");
    assert.equal(records.length, 1);
    assert.match(records[0].id, /^[0-9a-f]{8}-[0-9a-f]{4}-1[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(records[0].msg, "owned fixture");
  });

  const metro = require(metroCaller);
  const cssRoot = join(scratch, "css-project");
  mkdirSync(cssRoot);
  // The fixture may be under a caller's TMPDIR inside an ESM repository.
  // Expo 52 loads postcss.config.js, so give that local config its own type.
  writeFileSync(join(cssRoot, "package.json"), '{"private":true,"type":"commonjs"}\n');
  const filename = join(cssRoot, "card.css");
  const css = '.card { color: red; --caption: "Muster & friends"; }';
  await check("Metro keeps CSS unchanged when no PostCSS configuration exists", async () => {
    assert.deepEqual(await metro.transformPostCssModule(cssRoot, { src: css, filename }), { src: css, hasPostcss: false });
  });

  writeFileSync(join(cssRoot, "postcss.config.js"), `module.exports = { plugins: [{ postcssPlugin: 'owned-color-fixture', Declaration(declaration) { if (declaration.prop === 'color' && declaration.value === 'red') declaration.value = '#f08a24'; } }] };\n`);
  await check("Metro's actual PostCSS caller runs a local plugin and preserves other declarations", async () => {
    const result = await metro.transformPostCssModule(cssRoot, { src: css, filename });
    assert.equal(result.hasPostcss, true);
    const parsed = metroRequire("postcss").parse(result.src);
    assert.equal(parsed.first.selector, ".card");
    assert.equal(parsed.first.nodes.find((node) => node.prop === "color").value, "#f08a24");
    assert.equal(parsed.first.nodes.find((node) => node.prop === "--caption").value, '"Muster & friends"');
  });

  await check("Metro preserves a syntax failure for an unfinished local stylesheet", async () => {
    await assert.rejects(metro.transformPostCssModule(cssRoot, { src: ".card { color: red;", filename }), { name: "CssSyntaxError" });
  });

  if (failures.length) process.exitCode = 1;
  console.log(JSON.stringify({ status: failures.length ? "failed" : "passed", checks, passed, failed: failures.length, failures, versions, scope: "Owned offline caller compatibility; no native build, device, provider, or security-scan proof" }));
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  process.chdir(originalCwd);
  rmSync(scratch, { recursive: true, force: true });
}
