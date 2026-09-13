import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const IDENTITY_LIMITS = Object.freeze({ files: 4096, fileBytes: 32 * 1024 * 1024, totalBytes: 128 * 1024 * 1024, manifestBytes: 1024 * 1024 });

export function createBuildMetadata(root, version, revisionClaim = process.env.MUSTER_SOURCE_REVISION) {
  let revision = null;
  let dirty = null;
  // Environment claims and Git output are untyped runtime boundaries.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  const validRevision = (value) => typeof value === "string" && /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(value);
  if (revisionClaim !== undefined && !validRevision(revisionClaim)) throw new Error("Invalid source revision claim");
  try {
    const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000, maxBuffer: 1024 * 1024 }).trim();
    // Never borrow provenance from an unrelated parent checkout.
    if (realpathSync(git("rev-parse", "--show-toplevel")) === realpathSync(root)) {
      const observed = git("rev-parse", "HEAD");
      if (validRevision(observed)) {
        revision = observed.toLowerCase();
        dirty = git("status", "--porcelain", "--untracked-files=all").length > 0;
      }
    }
  } catch { /* Source archives and unavailable Git deliberately remain unknown. */ }
  if (revisionClaim !== undefined) {
    // A supplied revision is only a claim, especially outside a Git checkout.
    if (revision !== revisionClaim.toLowerCase()) dirty = null;
    revision = revisionClaim.toLowerCase();
  }
  // package.json version arrives decoded but unvalidated.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  if (typeof version !== "string" || version.length > 128 || !/^[0-9A-Za-z.+-]+$/.test(version)) throw new Error("Invalid package version");
  return { schema: 1, buildId: randomUUID(), source: { revision, dirty }, version };
}

export function writeBuildIdentity(root, metadata, artifact, selectedPaths, limits = IDENTITY_LIMITS) {
  if (artifact !== "web" && artifact !== "server") throw new Error("Invalid artifact scope");
  const base = realpathSync(root);
  const paths = [];
  let visited = 0;
  const walk = (dir, prefix = "") => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = prefix + entry.name;
      if (++visited > limits.files * 2 || path.length > 512) throw new Error("Artifact traversal limit exceeded");
      if (path === "build-identity.json") continue;
      if (entry.isSymbolicLink()) throw new Error("Artifact symlink rejected");
      if (entry.isDirectory()) walk(join(dir, entry.name), path + "/");
      else { paths.push(path); if (paths.length > limits.files) throw new Error("Too many artifact files"); }
    }
  };
  if (selectedPaths === undefined) walk(base);
  else paths.push(...selectedPaths);
  if (paths.length === 0 || paths.length > limits.files || new Set(paths).size !== paths.length) throw new Error("Invalid artifact file count");
  let total = 0;
  const files = paths.sort().map((path) => {
    // Selected paths may arrive unvalidated from the caller; this is the guard.
    // oxlint-disable-next-line anti-slop/no-runtime-typeof
    if (typeof path !== "string" || !path || path.length > 512 || path === "build-identity.json" || path.includes("\\") || isAbsolute(path) || path.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Invalid artifact path");
    const full = resolve(base, path);
    const rel = relative(base, realpathSync(full));
    if (rel.startsWith(".." + sep) || rel === ".." || isAbsolute(rel)) throw new Error("Artifact escapes root");
    let current = base;
    for (const part of path.split("/")) { current = join(current, part); if (lstatSync(current).isSymbolicLink()) throw new Error("Artifact symlink rejected"); }
    const stat = lstatSync(full);
    total += stat.size;
    if (!stat.isFile() || stat.size > limits.fileBytes || total > limits.totalBytes) throw new Error("Artifact size limit exceeded");
    const bytes = readFileSync(full);
    if (bytes.length !== stat.size) throw new Error("Artifact changed during fingerprinting");
    return { path, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
  });
  const manifest = { ...metadata, artifact, files };
  const encoded = JSON.stringify(manifest) + "\n";
  if (Buffer.byteLength(encoded) > limits.manifestBytes) throw new Error("Identity manifest too large");
  const destination = join(base, "build-identity.json");
  try { if (lstatSync(destination).isSymbolicLink()) throw new Error("Identity symlink rejected"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  writeFileSync(destination, encoded);
  return manifest;
}

export function webBuildIdentityPlugin() {
  let outputRoot;
  let metadata;
  let buildSucceeded = false;
  return {
    name: "muster-build-identity",
    apply: "build",
    configResolved(config) {
      if (config.command !== "build" || config.mode === "test" || process.env.VITEST) return;
      outputRoot = resolve(config.root, config.build.outDir);
      const pkg = JSON.parse(readFileSync(join(config.root, "package.json"), "utf8"));
      metadata = createBuildMetadata(config.root, pkg.version);
    },
    buildEnd(error) { buildSucceeded = !error; },
    closeBundle() {
      if (buildSucceeded && metadata && outputRoot) writeBuildIdentity(outputRoot, metadata, "web");
    },
  };
}
