// Diagnostic observations, not runtime attestation. No identity failure may stop
// an older installation from serving its workspace.
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { SERVER_ROOT } from "./proxy-paths.ts";

export interface BuildIdentity {
  schema: 1;
  buildId: string;
  source: { revision: string | null; dirty: boolean | null };
  version: string;
}
declare const __MUSTER_BUILD_IDENTITY__: BuildIdentity | undefined;
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const MAX_FILE = 32 * 1024 * 1024;
const MAX_TOTAL = 128 * 1024 * 1024;
const MAX_FILES = 4096;

const identitySchema = z.object({
  schema: z.literal(1),
  buildId: z.string().regex(/^[a-f0-9-]{36}$/),
  source: z.object({
    revision: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/).nullable(),
    dirty: z.boolean().nullable(),
  }),
  version: z.string().regex(/^[0-9A-Za-z.+-]{1,128}$/),
});

const manifestSchema = identitySchema.extend({
  artifact: z.enum(["web", "server"]),
  files: z.array(z.object({
    path: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size: z.number().int().min(0).max(MAX_FILE),
  })).min(1).max(MAX_FILES),
});

// The bundler define has no binding outside bundled builds; an unbundled read is
// the legacy "no embedded identity" case, not a failure.
function embeddedIdentity(): BuildIdentity | null {
  try { return __MUSTER_BUILD_IDENTITY__ ?? null; } catch { return null; }
}
const embedded = embeddedIdentity();

function declaredIdentity(parsed: z.infer<typeof identitySchema>): BuildIdentity {
  const { schema, buildId, version, source } = parsed;
  return { schema, buildId, version, source };
}

function readBounded(root: string, path: string, limit: number): Buffer {
  const parts = path.split("/");
  if (!parts.length || parts.some((part) => !part || part === "." || part === ".." || part.includes("\\") || part.includes(":") || part.includes("\u0000"))) throw new Error("invalid path");
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error("symlink");
  }
  const fd = openSync(current, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > limit) throw new Error("size");
    const bytes = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = readSync(fd, bytes, count, bytes.length - count, null);
      if (!read) break;
      count += read;
    }
    const after = fstatSync(fd);
    if (count !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) throw new Error("changed");
    return bytes.subarray(0, count);
  } finally { closeSync(fd); }

}

export function observeBuild(root: string | null, artifact: "web" | "server") {
  const observedAt = new Date().toISOString();
  const unknown = { status: "unknown" as const, observedAt, artifact };
  if (!root) return unknown;
  try {
    const manifestBytes = readBounded(root, "build-identity.json", 1024 * 1024);
    const parsed = manifestSchema.safeParse(JSON.parse(manifestBytes.toString("utf8")));
    if (!parsed.success || parsed.data.artifact !== artifact) return unknown;
    const manifest = parsed.data;
    const declared = declaredIdentity(manifest);
    const seen = new Set<string>();
    const measured: { path: string; sha256: string; size: number }[] = [];
    let total = 0;
    let actualTotal = 0;
    let matches = true;
    for (const file of manifest.files) {
      if (file.path === "build-identity.json" || seen.has(file.path)) return unknown;
      seen.add(file.path);
      total += file.size;
      if (total > MAX_TOTAL) return unknown;
      const bytes = readBounded(root, file.path, Math.min(MAX_FILE, MAX_TOTAL - actualTotal));
      actualTotal += bytes.length;
      const digest = hash(bytes);
      measured.push({ path: file.path, sha256: digest, size: bytes.length });
      matches &&= bytes.length === file.size && digest === file.sha256;
    }
    if (!seen.has(artifact === "web" ? "index.html" : "index.js")) return unknown;
    if (!readBounded(root, "build-identity.json", 1024 * 1024).equals(manifestBytes)) return unknown;
    measured.sort((a, b) => a.path.localeCompare(b.path));
    return { status: matches ? "matching" as const : "mismatched" as const, observedAt, artifact,
      declared, sha256: hash(JSON.stringify(measured)), files: measured.length,
      scope: artifact === "web" ? "manifest-listed on-disk web files; served HTML may be transformed" : "backend entry JavaScript on disk; excludes native dependencies" };
  } catch { return unknown; }
}

export function createBuildDiagnostics(staticRoot: string | null, serverRoot = SERVER_ROOT, loaded: BuildIdentity | null = embedded) {
  const startup = observeBuild(serverRoot, "server");
  const parsed = identitySchema.safeParse(loaded);
  const backend = { loaded: parsed.success ? declaredIdentity(parsed.data) : null, startup };
  let web = observeBuild(staticRoot, "web");
  let observed = Date.now();
  return () => {
    // Bounded snapshots keep repeated unauthenticated probes from rehashing the
    // entire output. Timestamp and cache lifetime are explicit in the response.
    if (Date.now() - observed >= 10_000) {
      web = observeBuild(staticRoot, "web");
      observed = Date.now();
    }
    return { schema: 1, backend, web, observationCacheMs: 10_000, attestation: false };
  };
}
