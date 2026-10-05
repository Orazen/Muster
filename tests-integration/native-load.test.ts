// Real-package native-load regressions, run OUTSIDE ordinary vitest shard
// discovery (see tests-integration/README.md). The dependency must be built
// for the Node runtime executing this suite: run `pnpm test:native-load`,
// which prepares the fixture first and fails fatally when the binary cannot
// be produced. Every destructive case edits a private dereferenced copy, and
// recovery is either a copied valid package or disabled.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { assertPrivateNativeDependencies, copyNativeFixtureDependencies, nativeFixtureBinaries, nativeFixtureLayout } from "../scripts/native-fixture-layout.mjs";

const { ensureLoadableNativeModule, loadProbeSource, vendorNativeExternals } = await import("../scripts/native-vendor.mjs");

const packageName = "better-sqlite3";
// The fixture prepared by scripts/prepare-native-fixture.mjs — a real
// better-sqlite3 package built for THIS runtime. Tests copy it; they never
// mutate the fixture itself.
const fixturePackage = join(process.cwd(), ".omb-native-fixture", "better-sqlite3");
const packageRequire = createRequire(join(fixturePackage, "package.json"));

const tempRoots: string[] = [];
function scratch() {
  const root = mkdtempSync(join(tmpdir(), "muster-native-load-"));
  tempRoots.push(root);
  return root;
}
afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

beforeAll(() => {
  if (!existsSync(join(fixturePackage, "package.json"))) {
    throw new Error(
      `native fixture missing at ${fixturePackage} — run \`pnpm test:native-load\` (which prepares it); absence is an environment failure, never a skipped test`,
    );
  }
  nativeFixtureLayout(fixturePackage);
  assertPrivateNativeDependencies(fixturePackage);
  expect(nativeFixtureBinaries(fixturePackage).length).toBeGreaterThan(0);
});

function copyNative(root: string, name = "package") {
  const copy = join(root, name);
  cpSync(fixturePackage, copy, { recursive: true, dereference: true });
  assertPrivateNativeDependencies(copy);
  return copy;
}

function corrupt(copy: string) {
  const binaries = nativeFixtureBinaries(copy);
  expect(binaries.length).toBeGreaterThan(0);
  for (const binary of binaries) writeFileSync(binary, "NOT A NATIVE BINARY", "utf8");
}

describe("native runtime verification", () => {
  it("accepts a real package that opens, queries and closes in this runtime", () => {
    const pkgDir = copyNative(scratch());
    const localRequire = createRequire(join(pkgDir, "package.json"));
    const Database = localRequire(join(pkgDir, "lib", "index.js"));
    const db = new Database(":memory:");
    try {
      expect(db.prepare("SELECT 1 AS value").get()).toEqual({ value: 1 });
    } finally {
      db.close();
    }
    expect(db.open).toBe(false);
    expect(ensureLoadableNativeModule(pkgDir, packageName)).toEqual({ ok: true });
  });

  it("rejects a corrupted real lazy-loading package even when requiring its JS succeeds", () => {
    const pkgDir = copyNative(scratch());
    corrupt(pkgDir);
    const localRequire = createRequire(join(pkgDir, "package.json"));
    expect(() => localRequire(join(pkgDir, "lib", "index.js"))).not.toThrow();
    const verdict = ensureLoadableNativeModule(pkgDir, packageName);
    expect(verdict.ok).toBe(false);
    expect(verdict.error).toMatch(/dlopen|ERR_DLOPEN|invalid|not a valid/i);
  });

  it("rejects a real package with a missing native binary", () => {
    const pkgDir = copyNative(scratch());
    const binaries = nativeFixtureBinaries(pkgDir);
    expect(binaries.length).toBeGreaterThan(0);
    for (const binary of binaries) rmSync(binary);
    expect(nativeFixtureBinaries(pkgDir)).toEqual([]);
    const verdict = ensureLoadableNativeModule(pkgDir, packageName);
    expect(verdict.ok).toBe(false);
    expect(verdict.error).toMatch(/bindings|locate|not found|Cannot find module/i);
  });

  it("rejects unsupported package probes instead of claiming generic native verification", () => {
    const pkgDir = copyNative(scratch());
    expect(ensureLoadableNativeModule(pkgDir, "unknown-native")).toMatchObject({ ok: false });
    expect(() => loadProbeSource("unknown-native")).toThrow(/No native load probe/);
  });

  it("fails closed when the installed version uses an unsupported fixture layout", () => {
    const pkgDir = copyNative(scratch());
    const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ ...manifest, version: "99.0.0" }));
    expect(() => nativeFixtureLayout(pkgDir)).toThrow(/unsupported better-sqlite3 native fixture layout/);
  });

  it("requires the old bindings helper when the package version declares it", () => {
    const pkgDir = copyNative(scratch());
    const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({
      ...manifest, version: "12.11.1", dependencies: { bindings: "^1.5.0" },
    }));
    expect(() => copyNativeFixtureDependencies(pkgDir, join(scratch(), "target")))
      .toThrow(/Cannot find module 'bindings/);
  });

  it("rejects a manifest that does not identify the requested supported package", () => {
    const pkgDir = copyNative(scratch());
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "different-package", main: "lib/index.js" }));
    const verdict = ensureLoadableNativeModule(pkgDir, packageName);
    expect(verdict.ok).toBe(false);
    expect(verdict.error).toMatch(/does not match/);
  });
});

describe("vendoring acceptance", () => {
  it("replaces the old destination and records a verified real package", () => {
    const root = scratch();
    const sourceDir = copyNative(root, "source");
    const outDir = join(root, "dist");
    const dest = join(outDir, "_native", packageName);
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "stale-helper.js"), "STALE");
    const receipt = vendorNativeExternals({ packageName, sourceDir, outDir, recovery: "none", stubDir: "" });
    expect(existsSync(join(dest, "stale-helper.js"))).toBe(false);
    expect(receipt).toMatchObject({ package: packageName, loadVerified: true, abi: process.versions.modules });
    expect(ensureLoadableNativeModule(dest, packageName)).toEqual({ ok: true });
  });

  it("recovers a corrupt real package only through the supplied valid private copy", () => {
    const root = scratch();
    const sourceDir = copyNative(root, "corrupt");
    corrupt(sourceDir);
    const stubDir = copyNative(root, "valid");
    const outDir = join(root, "dist");
    const receipt = vendorNativeExternals({ packageName, sourceDir, outDir, stubDir, recovery: "none" });
    expect(receipt.recovered).toContain("stub package swap (test hook)");
    expect(receipt.loadVerified).toBe(true);
    expect(ensureLoadableNativeModule(join(outDir, "_native", packageName), packageName)).toEqual({ ok: true });
  });

  it("refuses to ship a corrupt real package when recovery is disabled", () => {
    const root = scratch();
    const sourceDir = copyNative(root, "corrupt");
    corrupt(sourceDir);
    const outDir = join(root, "dist");
    expect(() => vendorNativeExternals({ packageName, sourceDir, outDir, recovery: "none", stubDir: "" }))
      .toThrow(/could not be made loadable/);
    expect(existsSync(join(outDir, "_native", packageName))).toBe(false);
  });

  it("refuses unsupported packages before changing a previous destination", () => {
    const root = scratch();
    const outDir = join(root, "dist");
    const dest = join(outDir, "_native", "unknown-native");
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "existing"), "preserved");
    expect(() => vendorNativeExternals({ packageName: "unknown-native", sourceDir: fixturePackage, outDir, recovery: "none", stubDir: "" }))
      .toThrow(/No native load probe/);
    expect(readFileSync(join(dest, "existing"), "utf8")).toBe("preserved");
  });
});

describe("probe resolution", () => {
  it("resolves the actual package entry independently of symlinked checkout location", () => {
    expect(JSON.parse(readFileSync(join(fixturePackage, "package.json"), "utf8"))).toMatchObject({ name: packageName });
    expect(realpathSync(packageRequire.resolve("./lib/index.js"))).toBe(realpathSync(join(fixturePackage, "lib", "index.js")));
    // The corrupt-copy case above additionally proves the child cannot fall
    // back to a healthy dependency when the requested copy is unloadable.
  });

  it("refuses to borrow an actual declared dependency from outside the private copy", () => {
    const root = scratch();
    const pkgDir = copyNative(root);
    const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
    const [dependency] = Object.keys(manifest.dependencies);
    expect(dependency).toBeDefined();
    const local = join(pkgDir, "node_modules", dependency);
    const outside = join(root, "node_modules", dependency);
    mkdirSync(join(root, "node_modules"), { recursive: true });
    cpSync(local, outside, { recursive: true, dereference: true });
    rmSync(local, { recursive: true });
    expect(() => assertPrivateNativeDependencies(pkgDir)).toThrow(/outside its private package/);
  });
});
