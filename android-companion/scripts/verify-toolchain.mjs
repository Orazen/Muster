#!/usr/bin/env node
// Offline compatibility checks for the actual Expo 52 callers of overridden
// dependencies. This does not build a native app or constitute a security scan.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EXPO_TAR_PATCHES, prepareToolchain } from "./prepare-toolchain.mjs";

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
    return root;
  }
  const preparationRoot = preparationFixture("preparation");
  await check("trusted preparation changes both reviewed imports in an owned copy", () => {
    const result = prepareToolchain(preparationRoot);
    assert.equal(result.status, "prepared");
    assert.equal(result.files.filter((file) => file.changed).length, 2);
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
    assert.deepEqual(result.files.map(({ name, changed }) => ({ name, changed })), [{ name: "tar.js", changed: false }, { name: "npm.js", changed: true }]);
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
