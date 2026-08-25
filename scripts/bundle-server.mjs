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
import { cpSync, mkdirSync, existsSync } from "node:fs";
import { createRequire } from "node:module";

function reqResolveVaultgram() {
  const rootReq = createRequire(join(root, "package.json"));
  return rootReq.resolve("vaultgram");
}

// Resolve from vaultgram's context: better-sqlite3 is its dependency, not
// ours, and pnpm hides transitive packages from the root resolver.
const req = createRequire(reqResolveVaultgram());
mkdirSync(join(root, "dist-server", "node_modules"), { recursive: true });
for (const name of NATIVE_EXTERNALS) {
  const resolved = req.resolve(`${name}/package.json`);
  const srcDir = dirname(resolved);
  const dest = join(root, "dist-server", "node_modules", name);
  if (!existsSync(dest)) {
    cpSync(srcDir, dest, { recursive: true });
    console.log(`bundled native dep: ${name} -> ${dest}`);
  }
}
