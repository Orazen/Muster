// Prepare the isolated native-load fixture used by tests-integration.
//
// Why this exists: pnpm-workspace.yaml deliberately permits install scripts
// only for Electron and esbuild, so a fresh `pnpm install` (CI, release
// runners) can leave older better-sqlite3 versions without a built binary;
// newer versions ship platform N-API prebuilds instead. The
// tests-integration/native-load suite verifies real native operation —
// open, query, close — so it needs a real built package. This script prepares
// a private package under .omb-native-fixture/ and fails fatally when its real
// loader cannot operate: absence is an environment failure, never a pass.
//
// Usage: node scripts/prepare-native-fixture.mjs
// Output: a receipt line on stdout ending with NATIVE_FIXTURE_OK and the
// fixture path, so callers can confirm the exact tree that was prepared.
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { copyNativeFixtureDependencies, nativeFixtureLayout } from "./native-fixture-layout.mjs";

const repoRoot = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));
const fixtureRoot = join(repoRoot, ".omb-native-fixture");
const fixturePackage = join(fixtureRoot, "better-sqlite3");

function fail(message) {
  console.error(`[native-fixture] FATAL: ${message}`);
  console.error("[native-fixture] The native-load integration suite cannot run without a real built binary.");
  process.exit(1);
}

const require = createRequire(join(repoRoot, "package.json"));
let realPackage;
try {
  realPackage = dirname(require.resolve("better-sqlite3/package.json"));
} catch (error) {
  fail(`better-sqlite3 is not resolvable from the repository root: ${error?.message ?? error}`);
}
let layout;
try { layout = nativeFixtureLayout(realPackage); } catch (error) { fail(error.message); }

// Dereference the pnpm symlink farm into a private, self-contained copy.
rmSync(fixtureRoot, { recursive: true, force: true });
mkdirSync(join(fixturePackage, "node_modules"), { recursive: true });
cpSync(realPackage, fixturePackage, { recursive: true, dereference: true });
// Dependencies must live inside the fixture. Copy only the installed package's
// actual declarations; better-sqlite3 13 removed the old bindings helpers.
try {
  copyNativeFixtureDependencies(realPackage, fixturePackage);
} catch (error) {
  fail(`declared dependency resolution failed: ${error?.message ?? error}`);
}

function probeFixture() {
  return spawnSync(
    process.execPath,
    ["-e", `const D=require(${JSON.stringify(join(fixturePackage, "lib", "index.js"))});const db=new D(":memory:");if(db.prepare("SELECT 1 AS v").get().v!==1)throw new Error("query failed");db.close();`],
    { encoding: "utf8", timeout: 60_000 },
  );
}

// The actual package loader selects its binary. A v13 platform N-API prebuild
// is valid even when there is no legacy build/Release file.
let probe = probeFixture();
if (probe.status !== 0) {
  // Build for the EXECUTING runtime. prebuild-install first (downloads the
  // prebuilt for this exact version+ABI), then node-gyp rebuild from source.
  // No global installs; both tools come from the fixture's own dependency
  // context or the pnpm store.
  if (layout.dependencies["prebuild-install"]) {
    const fixtureRequire = createRequire(join(fixturePackage, "package.json"));
    const prebuildBin = fixtureRequire.resolve("prebuild-install/bin.js");
    const result = spawnSync(process.execPath, [prebuildBin], { cwd: fixturePackage, stdio: "inherit" });
    if (result.status === 0) probe = probeFixture();
  }
  if (probe.status !== 0) {
    console.log("[native-fixture] prebuild-install unavailable or failed — building from source with node-gyp");
    let gypBin;
    try { gypBin = require.resolve("node-gyp/bin/node-gyp.js"); } catch (error) { fail(`declared node-gyp is unavailable: ${error.message}`); }
    const gyp = spawnSync(process.execPath, [gypBin, "rebuild"], { cwd: fixturePackage, stdio: "inherit" });
    if (gyp.status === 0) probe = probeFixture();
  }
}

// The fixture must actually operate before the suite trusts it: open, query,
// close against the freshly prepared copy.
if (probe.status !== 0) {
  fail(`fixture probe failed under node ${process.version} (abi ${process.versions.modules}):\n${[probe.stderr, probe.stdout].filter(Boolean).join("\n").slice(-2000)}`);
}

writeFileSync(
  join(fixtureRoot, "fixture-receipt.json"),
  JSON.stringify({
    fixture: fixturePackage,
    node: process.version,
    abi: process.versions.modules,
    arch: process.arch,
    platform: process.platform,
    packageVersion: layout.version,
    loader: layout.loader,
    preparedAt: new Date().toISOString(),
  }, null, 2),
  "utf8",
);
console.log(`NATIVE_FIXTURE_OK ${fixturePackage} node=${process.version} abi=${process.versions.modules}`);
