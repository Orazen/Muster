// Bundle each harness-server entry point into a self-contained ESM file.
//
// Why this exists: the packaged app ships ZERO node_modules (see the files:
// exclusion in electron-builder.yml), so anything the server imports by bare
// specifier has to be inlined — `tsc` only transpiles, it leaves
// `import { z } from "zod"` verbatim and the packaged server dies at startup
// with ERR_MODULE_NOT_FOUND. That shipped once, in 0.1.24.
//
// Bundling every entry point rather than only index.ts is deliberate: the
// proxies are spawned as their own processes and today import nothing from
// node_modules, but nothing stops the next one from doing so, and the failure
// is invisible until a packaged build is actually launched.
//
// Entry points must keep their exact relative paths under dist-server — the
// server locates each proxy by path (server/index.ts:108,
// container-computer.ts:773, drivers/acp/core.ts:43), preferring the .ts in
// dev and falling back to the sibling .js in the packaged tree. outbase keeps
// drivers/ nested; import.meta.url still resolves to the same location, so
// that lookup is unaffected.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import childProcess from "node:child_process";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const server = join(root, "server");

// Every file run as its own process. Keep in sync with the spawn sites above.
const ENTRY_POINTS = [
  "index.ts",
  "computer-proxy.ts",
  "container-mcp.ts",
  "permission-proxy.ts",
  "connector-proxy.ts",
  "hi-new-proxy.ts",
  "drivers/agents-proxy.ts",
  "drivers/dweb-proxy.ts",
];

// better-sqlite3 carries a native .node addon — esbuild cannot inline it,
// and bundling its JS produces "Dynamic require of fs" crashes at boot
// (shipped once as the muster.orazen.online outage). Externalize it and
// ship a real copy next to the bundle instead; Node resolves
// dist-server/node_modules before falling back further up the tree.
const NATIVE_EXTERNALS = ["better-sqlite3"];

await build({
  external: NATIVE_EXTERNALS,
  // Bundled CJS deps (telegraf, vaultgram's internals) call require() at
  // runtime; under ESM output esbuild's stub throws "Dynamic require".
  // Give it a real require via createRequire so those calls resolve.
  banner: {
    js: `import { createRequire as __creq } from "node:module"; const require = __creq(import.meta.url);`,
  },
  entryPoints: ENTRY_POINTS.map((entry) => join(server, entry)),
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outbase: server,
  outdir: join(root, "dist-server"),
  // Written after tsc, replacing its output for these entry points.
  allowOverwrite: true,
  logLevel: "info",
});


// Copy each native external's real package directory (pnpm layout included)
// into dist-server/node_modules so the externalized import still resolves in
// the packaged tree, where no other node_modules exist.
import { cpSync, mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";

function reqResolveVaultgram() {
  const rootReq = createRequire(join(root, "package.json"));
  return rootReq.resolve("vaultgram");
}

// Resolve from vaultgram's context: better-sqlite3 is its dependency, not
// ours, and pnpm hides transitive packages from the root resolver.
const req = createRequire(reqResolveVaultgram());
// Vendor under a name electron-builder never prunes ("node_modules" dirs are
// silently dropped from extraResources), then rewrite the bare specifier in
// the emitted bundle to the vendored relative path.
const VENDOR_DIR = "_native";
mkdirSync(join(root, "dist-server", VENDOR_DIR), { recursive: true });
for (const name of NATIVE_EXTERNALS) {
  const resolved = req.resolve(`${name}/package.json`);
  const srcDir = dirname(resolved);
  const dest = join(root, "dist-server", VENDOR_DIR, name);
  // dereference: pnpm installs are symlink farms — links would dangle in app bundles
  cpSync(srcDir, dest, { recursive: true, dereference: true });
  // better-sqlite3 resolves its helpers via plain node_modules lookup — give
  // the vendored copy its own nested node_modules with real files.
  if (name === "better-sqlite3") {
    const nested = join(dest, "node_modules");
    mkdirSync(nested, { recursive: true });
    for (const helper of ["bindings", "file-uri-to-path"]) {
      try {
        const helperSrc = dirname(req.resolve(`${helper}/package.json`));
        cpSync(helperSrc, join(nested, helper), { recursive: true, dereference: true });
      } catch {
        console.log(`helper ${helper} not resolvable from vaultgram context — skipped`);
      }
    }
  }
  // pnpm (and CI npm config) often skips install scripts, leaving no
  // better_sqlite3.node. Fetch the prebuilt binary; fall back to source build.
  // `npx --yes prebuild-install` used to resolve through a global npx cache
  // path that doesn't exist under pnpm's layout in CI (Cannot find module
  // .../prebuild-install/bin.js), and its failure fell back to a source
  // build whose binary the health gate still couldn't serve. Invoke the
  // package's own bin directly from the pnpm store where it actually
  // lives — with cwd = the vendored copy so the prebuilt download matches
  // this exact better-sqlite3 version.
  const { execSync } = childProcess;
  if (!existsSync(join(dest, "build", "Release", "better_sqlite3.node")) &&
      !existsSync(join(dest, "prebuilds"))) {
    try {
      const prebuildBin = findUpBin("prebuild-install", "bin.js");
      if (prebuildBin) {
        execSync(`"${process.execPath}" "${prebuildBin}"`, { cwd: dest, stdio: "inherit" });
      } else {
        execSync("npx --yes prebuild-install@7.1.3", { cwd: dest, stdio: "inherit" });
      }
      console.log(`prebuilt binary fetched for ${name}`);
    } catch {
      console.log(`prebuild-install failed for ${name} — building from source`);
      execSync("npx --yes node-gyp rebuild", { cwd: dest, stdio: "inherit" });
    }
  }
  console.log(`bundled native dep: ${name} -> ${dest}`);
}

/** Walk up from cwd looking for node_modules/.pnpm/prebuild-install@<ver>
 * /node_modules/prebuild-install/bin.js — the only place pnpm reliably
 * puts it. Returns undefined when nothing is found; callers fall back to
 * npx. */
function findUpBin(packageName, binName) {
  let dir = process.cwd();
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

// Rewrite every remaining bare "better-sqlite3" specifier in dist-server/**/*.js
// to the vendored copy, relative to the importing file's depth.
function rewriteSpecifiers(dir, relPrefix) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      rewriteSpecifiers(full, relPrefix + "../");
    } else if (entry.name.endsWith(".js")) {
      let text = readFileSync(full, "utf8");
      if (!text.includes('"better-sqlite3"') && !text.includes("'better-sqlite3'")) continue;
      text = text.replaceAll('"better-sqlite3"', `"${relPrefix}${VENDOR_DIR}/better-sqlite3/lib/index.js"`);
      text = text.replaceAll("'better-sqlite3'", `'${relPrefix}${VENDOR_DIR}/better-sqlite3/lib/index.js'`);
      writeFileSync(full, text);
      console.log(`rewrote better-sqlite3 specifier -> ${full}`);
    }
  }
}
rewriteSpecifiers(join(root, "dist-server"), "./");
