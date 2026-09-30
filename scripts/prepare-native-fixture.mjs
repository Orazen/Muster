// Prepare the isolated native-load fixture used by tests-integration.
//
// Why this exists: pnpm-workspace.yaml deliberately permits install scripts
// only for Electron and esbuild, so a fresh `pnpm install` (CI, release
// runners) leaves better-sqlite3 WITHOUT its native binary. The
// tests-integration/native-load suite verifies real native operation —
// open, query, close — so it needs a real built package. This script builds
// that fixture under .omb-native-fixture/ and fails fatally when the binary
// cannot be produced: absence is an environment failure, never a pass.
//
// Usage: node scripts/prepare-native-fixture.mjs
// Output: a receipt line on stdout ending with NATIVE_FIXTURE_OK and the
// fixture path, so callers can confirm the exact tree that was prepared.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

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
const packageRequire = createRequire(join(realPackage, "package.json"));

// Dereference the pnpm symlink farm into a private, self-contained copy.
rmSync(fixtureRoot, { recursive: true, force: true });
mkdirSync(join(fixturePackage, "node_modules"), { recursive: true });
cpSync(realPackage, fixturePackage, { recursive: true, dereference: true });
// Helpers must live inside the fixture: the probe must never borrow
// dependencies from the checkout above it.
try {
  cpSync(dirname(packageRequire.resolve("bindings/package.json")), join(fixturePackage, "node_modules", "bindings"), { recursive: true, dereference: true });
  const bindingsRequire = createRequire(join(dirname(packageRequire.resolve("bindings/package.json")), "package.json"));
  cpSync(dirname(bindingsRequire.resolve("file-uri-to-path/package.json")), join(fixturePackage, "node_modules", "file-uri-to-path"), { recursive: true, dereference: true });
} catch (error) {
  fail(`helper resolution failed: ${error?.message ?? error}`);
}

const binaryRelative = join("build", "Release", "better_sqlite3.node");
const binary = join(fixturePackage, binaryRelative);
if (existsSync(binary)) {
  console.log(`[native-fixture] binary already present at ${binary} (abi ${process.versions.modules})`);
} else {
  // Build for the EXECUTING runtime. prebuild-install first (downloads the
  // prebuilt for this exact version+ABI), then node-gyp rebuild from source.
  // No global installs; both tools come from the fixture's own dependency
  // context or the pnpm store.
  let built = false;
  const prebuildBin = findUpBin("prebuild-install", "bin.js", realPackage);
  if (prebuildBin) {
    const result = spawnSync(process.execPath, [prebuildBin], { cwd: fixturePackage, stdio: "inherit" });
    built = result.status === 0 && existsSync(binary);
  }
  if (!built) {
    console.log("[native-fixture] prebuild-install unavailable or failed — building from source with node-gyp");
    const gyp = spawnSync("npx", ["--yes", "node-gyp", "rebuild"], { cwd: fixturePackage, stdio: "inherit" });
    built = gyp.status === 0 && existsSync(binary);
  }
  if (!built) fail(`could not produce ${binaryRelative} for node ${process.version} (abi ${process.versions.modules})`);
}

// The fixture must actually operate before the suite trusts it: open, query,
// close against the freshly prepared copy.
const probe = spawnSync(
  process.execPath,
  ["-e", `const D=require(${JSON.stringify(join(fixturePackage, "lib", "index.js"))});const db=new D(":memory:");if(db.prepare("SELECT 1 AS v").get().v!==1)throw new Error("query failed");db.close();`],
  { encoding: "utf8", timeout: 60_000 },
);
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
    preparedAt: new Date().toISOString(),
  }, null, 2),
  "utf8",
);
console.log(`NATIVE_FIXTURE_OK ${fixturePackage} node=${process.version} abi=${process.versions.modules}`);

// Walk up from fromDir looking for node_modules/.pnpm/<packageName>@<ver>/
// node_modules/<packageName>/<binName>. Returns undefined when nothing is
// found; the caller falls back to npx.
function findUpBin(packageName, binName, fromDir) {
  let dir = fromDir;
  for (;;) {
    try {
      const pnpmDir = join(dir, "node_modules", ".pnpm");
      for (const entry of readdirSync(pnpmDir)) {
        if (!entry.startsWith(`${packageName}@`)) continue;
        const candidate = join(pnpmDir, entry, "node_modules", packageName, binName);
        if (existsSync(candidate)) return candidate;
      }
    } catch {
      /* no node_modules/.pnpm here — keep walking */
    }
    const parent = join(dir, "..");
    if (parent === dir) return undefined;
    dir = parent;
  }
}
