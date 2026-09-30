// Regression tests for scripts/native-vendor.mjs — the step that copies the
// native external (better-sqlite3) into dist-server and guarantees the shipped
// binary actually loads in the packaging runtime.
//
// History: the vendored copy was produced by cpSync into a possibly-existing
// destination directory, which merges instead of replacing — a stale
// build/Release/better_sqlite3.node (built for a different Node ABI) survived
// a repackage unchanged, because the prebuild fallback was guarded only by
// existence checks. The packaged app then died at boot with ERR_DLOPEN_FAILED.
// These tests pin both behaviors:
//   1. the destination is replaced, never merged (stale files are gone);
//   2. a binary that cannot be loaded is never shipped — recovery runs and,
//      if the binary still cannot be made loadable, vendoring fails loudly.
// No test touches the network: the recovery channel is either a stub package
// (a real, loadable copy of the repo's own better-sqlite3) or `recovery:"none"`.
import { afterAll, describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { ensureLoadableNativeModule, loadProbeSource, vendorNativeExternals } = await import("./native-vendor.mjs");

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
// The real native dependency this repo actually ships — used both as a
// known-loadable verification subject and as the source of the test stub.
const realNativePackage = dirname(require.resolve("better-sqlite3/package.json"));

const tempRoots: string[] = [];
function scratch() {
  const root = mkdtempSync(join(tmpdir(), "muster-native-vendor-"));
  tempRoots.push(root);
  return root;
}
afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

function writeFakeNativePackage(dir: string, binaryBody?: string) {
  mkdirSync(join(dir, "lib"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fake-native", version: "0.0.1", main: "lib/index.js" }), "utf8");
  // Mirror real better-sqlite3: requiring the package main dlopens the native
  // binary at load time, so the probe's package require genuinely exercises
  // dlopen whenever a binary exists.
  const main = binaryBody !== undefined
    ? "module.exports = require('../build/Release/better_sqlite3.node');"
    : "module.exports = {};";
  writeFileSync(join(dir, "lib", "index.js"), main, "utf8");
  if (binaryBody !== undefined) {
    mkdirSync(join(dir, "build", "Release"), { recursive: true });
    writeFileSync(join(dir, "build", "Release", "better_sqlite3.node"), binaryBody, "utf8");
  }
}

// A loadable native package used as the recovery stub: a dereferenced copy of
// the repo's real better-sqlite3, so the load probe exercises genuine dlopen.
function makeStub(root: string) {
  const stubDir = join(root, "stub");
  cpSync(realNativePackage, stubDir, { recursive: true, dereference: true });
  return stubDir;
}

describe("vendorNativeExternals destination semantics", () => {
  it("replaces an existing destination instead of merging stale files into it", () => {
    const root = scratch();
    const outDir = join(root, "dist");
    const dest = join(outDir, "_native", "fake-native");
    // A previous (stale) vendor pass left an old binary and an old helper
    // that no longer exist upstream.
    mkdirSync(join(dest, "build", "Release"), { recursive: true });
    writeFileSync(join(dest, "build", "Release", "better_sqlite3.node"), "STALE ABI-999 BINARY", "utf8");
    writeFileSync(join(dest, "stale-helper.js"), "// stale helper no longer upstream", "utf8");
    // Fresh package has neither file; the stub supplies a loadable package.
    const src = join(root, "src-pkg");
    writeFakeNativePackage(src);

    const receipt = vendorNativeExternals({
      packageName: "fake-native",
      sourceDir: src,
      outDir,
      stubDir: makeStub(root),
    });

    // Merge semantics would have preserved stale-helper.js; replacement removes it.
    expect(existsSync(join(dest, "stale-helper.js"))).toBe(false);
    expect(existsSync(join(dest, "lib", "index.js"))).toBe(true);
    expect(existsSync(join(dest, "vendor-receipt.json"))).toBe(true);
    expect(receipt.package).toBe("fake-native");
    expect(receipt.loadVerified).toBe(true);
    // And the shipped copy load-verifies in its own right.
    expect(ensureLoadableNativeModule(dest, "fake-native").ok).toBe(true);
  });
});

describe("load verification", () => {
  it("accepts a genuinely loadable native module", () => {
    const verdict = ensureLoadableNativeModule(realNativePackage, "better-sqlite3");
    expect(verdict.ok).toBe(true);
    expect(verdict.error).toBeUndefined();
  });

  it("refuses a corrupt .node binary without attempting any recovery", () => {
    const root = scratch();
    const pkgDir = join(root, "fake-native");
    writeFakeNativePackage(pkgDir, "definitely not a dylib");
    const verdict = ensureLoadableNativeModule(pkgDir, "fake-native");
    expect(verdict.ok).toBe(false);
    expect(String(verdict.error).length).toBeGreaterThan(0);
    expect(String(verdict.error)).toMatch(/fake-native|dlopen|load|ERR_/i);
  });

  it("replaces a stale wrong-ABI binary with a loadable one during vendoring", () => {
    const root = scratch();
    const src = join(root, "src-pkg");
    const dest = join(root, "dist", "_native", "fake-native");
    // The stale case: the source tree itself carries a binary built for a
    // different Node ABI (e.g. produced under a different Node previously).
    writeFakeNativePackage(src, "STALE WRONG-ABI BINARY");

    const receipt = vendorNativeExternals({
      packageName: "fake-native",
      sourceDir: src,
      outDir: join(root, "dist"),
      stubDir: makeStub(root),
    });

    // The stale bytes must not survive as the shipped binary, and the shipped
    // copy must load, with the receipt recording the recovery step.
    expect(ensureLoadableNativeModule(dest, "fake-native").ok).toBe(true);
    expect(JSON.stringify(receipt.recovered)).toMatch(/stub|rebuild|prebuild/);
    expect(readFileSync(join(dest, "vendor-receipt.json"), "utf8")).toContain("loadVerified");
  });

  it("fails loudly (no silent ship) when the binary cannot be made loadable", () => {
    const root = scratch();
    const src = join(root, "src-pkg");
    // Unloadable binary and NO recovery channel at all.
    writeFakeNativePackage(src, "UNLOADABLE BINARY, NO RECOVERY POSSIBLE");
    expect(() =>
      vendorNativeExternals({
        packageName: "fake-native",
        sourceDir: src,
        outDir: join(root, "dist"),
        recovery: "none",
      }),
    ).toThrow(/could not be made loadable/i);
    // Nothing was left shipped under the vendor dir without verification.
    expect(existsSync(join(root, "dist", "_native", "fake-native"))).toBe(false);
  });
});

describe("load probe plumbing", () => {
  it("probe source reports success through a dedicated marker and resolves from cwd", () => {
    const source = loadProbeSource();
    expect(source).toContain("NATIVE_LOAD_PROBE_OK");
    expect(source).toContain("createRequire");
    expect(source).toContain("process.cwd()");
  });

  it("verifies against the real repo-root native dependency, not the test's own imports", () => {
    // Guards against a self-referential test: the subject must live under the
    // real checkout's package store, and the probe genuinely dlopens it in a
    // child process (covered by the accept case above).
    expect(realNativePackage.startsWith(repoRoot)).toBe(true);
    expect(realNativePackage).toContain("better-sqlite3");
  });
});
