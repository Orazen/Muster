// Native-external vendoring for the packaged server (used by bundle-server.mjs).
//
// Two defects this module pins down, both observed in the 1.23.1 packaging run
// (a stale better_sqlite3.node built for a different Node ABI shipped silently
// and the packaged app died at boot with ERR_DLOPEN_FAILED):
//
//   1. cpSync into an existing destination MERGES trees — a stale native build
//      from a previous packaging pass survives a repackage unchanged, and the
//      old existence-only prebuild guard never notices. This module always
//      replaces the destination instead of merging into it.
//
//   2. Existence checks say nothing about whether the binary can be loaded.
//      After every recovery attempt (prebuilt download, source rebuild), the
//      shipped package is load-verified in a child Node process spawned with
//      cwd anchored INSIDE the vendored tree, so Node resolves the exact
//      package being shipped — not the bundler's own working copy. A binary
//      that fails dlopen (wrong ABI versions.modules, corrupt, missing) fails
//      the build loudly instead of being packaged silently.
//
// The receipt (vendor-receipt.json) records the steps for release acceptance.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";

// Returns the probe script source. Self-contained: the child imports the
// package resolved from its cwd and prints a machine-readable success marker;
// anything else (nonzero exit, ERR_DLOPEN_FAILED in stderr, missing marker)
// is a failure. Resolving through cwd/package.json anchors the load to the
// exact tree being shipped, never the bundler's own working copy.
export function loadProbeSource() {
  return [
    "import { createRequire } from \"node:module\";",
    "import { readFileSync } from \"node:fs\";",
    "import { join, resolve } from \"node:path\";",
    "const pkg = JSON.parse(readFileSync(join(process.cwd(), \"package.json\"), \"utf8\"));",
    // Absolute main path: a bare specifier would resolve through Node's
    // node_modules walk and could load a DIFFERENT copy of the package; the
    // verification must dlopen this exact tree.
    "const req = createRequire(join(process.cwd(), \"package.json\"));",
    "req(resolve(process.cwd(), pkg.main));",
    "console.log(\"NATIVE_LOAD_PROBE_OK\");",
    "",
  ].join("\n");
}

function runLoadProbe(pkgDir, { timeoutMs = 30_000 } = {}) {
  const probeFile = join(mkdtempSync(join(tmpdir(), "native-probe-")), "probe.mjs");
  try {
    writeFileSync(probeFile, loadProbeSource(), "utf8");
    const result = spawnSync(process.execPath, [probeFile], {
      cwd: pkgDir,
      encoding: "utf8",
      timeout: timeoutMs,
      env: { ...process.env, NODE_OPTIONS: "" },
    });
    if (result.status === 0 && String(result.stdout).includes("NATIVE_LOAD_PROBE_OK")) {
      return { ok: true };
    }
    const detail = [result.stderr, result.stdout, result.error?.message].filter(Boolean).join("\n").slice(-4_000);
    return { ok: false, error: detail || `probe exited with status ${result.status}` };
  } catch (error) {
    return { ok: false, error: String(error?.stack || error) };
  } finally {
    rmSync(dirname(probeFile), { recursive: true, force: true });
  }
}

// Load-verify the package rooted at pkgDir in a child Node process. The child
// runs with cwd = pkgDir, so Node resolves THIS copy of the package — the
// verification is anchored to the shipped tree, not the bundler's imports.
export function ensureLoadableNativeModule(pkgDir, packageName, { timeoutMs } = {}) {
  if (!existsSync(join(pkgDir, "package.json"))) {
    return { ok: false, error: `${packageName}: no package.json at ${pkgDir}` };
  }
  return runLoadProbe(pkgDir, { timeoutMs });
}

// Walk up from fromDir looking for node_modules/.pnpm/<packageName>@<ver>/
// node_modules/<packageName>/<binName> — the only place pnpm reliably puts it.
// Returns undefined when nothing is found; callers fall back to npx.
export function findUpBin(packageName, binName, fromDir = process.cwd()) {
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

function runRecoveryCommand(command, args, cwd, log) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 600_000, stdio: ["ignore", "pipe", "pipe"] });
  log.push(`$ ${command} ${args.join(" ")} -> exit ${result.status}`);
  if (result.status !== 0) {
    const tail = [result.stderr, result.stdout].filter(Boolean).join("\n").slice(-2_000);
    if (tail) log.push(tail);
  }
  return result.status === 0;
}

// Vendoring for one native external. options:
//   packageName  e.g. "better-sqlite3"
//   sourceDir    resolved real package directory (dereferenced source)
//   outDir       the dist output dir; destination is outDir/_native/<name>
//   helpers     (optional) array of { name, sourceDir } — nested helper
//               packages the shipped copy needs under node_modules/; the
//               CALLER resolves them (it owns the resolver context), the
//               vendor step just copies them in.
//   stubDir      (optional) loadable package swapped in instead of running
//                prebuild-install/node-gyp. Test hook (OMB_NATIVE_STUB_DIR
//                env override); never set in production.
//   recovery     "auto" (default: prebuild-install, then node-gyp) or "none"
//                (fail without attempting downloads — used by tests).
//   log          (optional) array; gets human-readable step lines
// Throws when the final package cannot be load-verified — never ships silently.
export function vendorNativeExternals({ packageName, sourceDir, outDir, helpers = [], stubDir, recovery = "auto", log = [] }) {
  stubDir = stubDir ?? process.env.OMB_NATIVE_STUB_DIR;
  const vendorDir = join(outDir, "_native");
  const dest = join(vendorDir, packageName);
  mkdirSync(vendorDir, { recursive: true });

  // 1. Replace, never merge. A previous pass's stale binary or helper must
  //    not survive a repackage.
  if (existsSync(dest)) {
    rmSync(dest, { recursive: true, force: true });
    log.push(`removed stale vendor dir ${dest}`);
  }

  // Stage through a sibling temp dir so a crash mid-copy never leaves a
  // partially merged destination that a later existence check would trust.
  const staging = join(vendorDir, `.${packageName}.staging-${process.pid}-${Date.now()}`);
  try {
    // dereference: pnpm installs are symlink farms — links would dangle in app bundles
    cpSync(sourceDir, staging, { recursive: true, dereference: true });
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }

  const receipt = {
    package: packageName,
    sourceDir,
    node: process.version,
    abi: process.versions.modules,
    arch: process.arch,
    platform: process.platform,
    loadVerified: false,
    recovered: [],
  };

  // 2. Nested helper packages (better-sqlite3 resolves bindings/
  //    file-uri-to-path via plain node_modules lookup at runtime). The caller
  //    resolves each helper's directory; resolution failures are the
  //    caller's to log/skip so this module never throws mid-vendor on them.
  if (helpers.length > 0) {
    const nested = join(staging, "node_modules");
    mkdirSync(nested, { recursive: true });
    for (const helper of helpers) {
      try {
        cpSync(helper.sourceDir, join(nested, helper.name), { recursive: true, dereference: true });
      } catch {
        log.push(`helper ${helper.name} not copyable — skipped`);
      }
    }
  }

  // 3. Binary acquisition. pnpm (and CI npm config) often skip install
  //    scripts, leaving no better_sqlite3.node. Loadability — not existence —
  //    decides whether recovery runs.
  const binaryPath = join(staging, "build", "Release", "better_sqlite3.node");
  const hasBinary = existsSync(binaryPath) || existsSync(join(staging, "prebuilds"));
  let probe = hasBinary ? ensureLoadableNativeModule(staging, packageName) : { ok: false, error: "no native binary present" };

  if (!probe.ok) {
    log.push(`native binary not loadable (${probe.error?.slice(0, 200) ?? "absent"}) — attempting recovery`);
    // a) Drop any unloadable binary before rebuilding: a stale wrong-ABI
    //    .node in the tree must never survive into the shipped copy.
    if (existsSync(binaryPath)) {
      receipt.recovered.push(`removed unloadable binary (${probe.error ? probe.error.slice(0, 120) : "absent"})`);
      rmSync(binaryPath, { force: true });
    }
    // b) Stub channel (tests): swap in a known-loadable package.
    if (stubDir && existsSync(stubDir)) {
      rmSync(staging, { recursive: true, force: true });
      cpSync(stubDir, staging, { recursive: true, dereference: true });
      receipt.recovered.push("stub package swap (test hook)");
    } else if (recovery !== "none") {
      // c) Fetch the prebuilt binary for this exact version; fall back to a
      //    source rebuild. Invoke the package's own prebuild-install bin from
      //    the pnpm store with cwd = the staged copy so the download matches
      //    this exact version.
      const prebuildBin = findUpBin("prebuild-install", "bin.js", sourceDir);
      const prebuiltOk =
        (prebuildBin
          ? runRecoveryCommand(process.execPath, [prebuildBin], staging, log)
          : runRecoveryCommand("npx", ["--yes", "prebuild-install@7.1.3"], staging, log));
      if (prebuiltOk) receipt.recovered.push("prebuild-install");
      if (!existsSync(binaryPath) || !ensureLoadableNativeModule(staging, packageName).ok) {
        log.push("prebuild-install did not produce a loadable binary — building from source");
        const gypOk = runRecoveryCommand("npx", ["--yes", "node-gyp", "rebuild"], staging, log);
        if (gypOk) receipt.recovered.push("node-gyp rebuild");
      }
    }
    probe = ensureLoadableNativeModule(staging, packageName);
  }

  if (!probe.ok) {
    // Fail loudly. Nothing is left shipped under the vendor dir.
    rmSync(staging, { recursive: true, force: true });
    throw new Error(
      `${packageName} could not be made loadable for packaging (node ${process.version}, abi ${process.versions.modules}). ` +
        `Refusing to ship a native module that fails load verification. Probe error: ${probe.error}`,
    );
  }

  // 4. Promote the verified tree and write the receipt.
  cpSync(staging, dest, { recursive: true, dereference: true });
  rmSync(staging, { recursive: true, force: true });
  receipt.loadVerified = true;
  receipt.verifiedAt = new Date().toISOString();
  writeFileSync(join(dest, "vendor-receipt.json"), JSON.stringify(receipt, null, 2), "utf8");
  log.push(`bundled native dep: ${packageName} -> ${dest} (load-verified)`);
  return receipt;
}
