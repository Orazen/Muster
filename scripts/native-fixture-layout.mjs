// Helpers for private, real-package native test fixtures. This is test preparation,
// not a production loader: an unknown package layout must fail the gate.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative } from "node:path";
import { z } from "zod";

const manifestSchema = z.object({
  name: z.string(),
  version: z.string().optional(),
  dependencies: z.record(z.string(), z.string()).default({}),
});
const bindingSchema = z.object({ getPrebuildPath: z.function(), getBinding: z.function() });
const readManifest = (directory) => manifestSchema.parse(JSON.parse(readFileSync(join(directory, "package.json"), "utf8")));

export function nativeFixtureLayout(packageDir) {
  const manifest = readManifest(packageDir);
  if (manifest.name !== "better-sqlite3") throw new Error("native fixture package must identify better-sqlite3");
  const major = Number(/^(\d+)\.\d+\.\d+(?:[-+].*)?$/.exec(manifest.version ?? "")?.[1]);
  const dependencies = manifest.dependencies;
  if (major === 12 && dependencies.bindings) {
    return { version: manifest.version, loader: "bindings", dependencies };
  }
  if (major === 13 && !dependencies.bindings && existsSync(join(packageDir, "lib", "binding.js"))) {
    const binding = createRequire(join(packageDir, "package.json"))(join(packageDir, "lib", "binding.js"));
    if (bindingSchema.safeParse(binding).success) {
      return { version: manifest.version, loader: "prebuild", dependencies };
    }
  }
  throw new Error(`unsupported better-sqlite3 native fixture layout: ${manifest.version ?? "missing version"}`);
}

// Copy the actual declared dependency graph, resolving each dependency from its
// owning installed package. In particular, v12 gets bindings and its declared
// file-uri-to-path dependency; v13 must not require those removed packages.
export function copyNativeFixtureDependencies(sourceDir, targetDir) {
  const layout = nativeFixtureLayout(sourceDir);
  function copyDependencies(source, target, ancestors) {
    const manifest = readManifest(source);
    const sourceRequire = createRequire(join(source, "package.json"));
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      const resolved = resolvePackage(sourceRequire, name);
      // A cycle resolves from the private ancestor already copied, rather than
      // recursively duplicating it forever or borrowing a checkout dependency.
      if (ancestors.has(resolved)) continue;
      const destination = join(target, "node_modules", name);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(resolved, destination, { recursive: true, dereference: true });
      copyDependencies(resolved, destination, new Set([...ancestors, resolved]));
    }
  }
  copyDependencies(sourceDir, targetDir, new Set([realpathSync(sourceDir)]));
  assertPrivateNativeDependencies(targetDir);
  return layout;
}

export function assertPrivateNativeDependencies(packageDir) {
  const root = realpathSync(packageDir);
  const visited = new Set();
  function check(directory) {
    const actual = realpathSync(directory);
    if (visited.has(actual)) return;
    visited.add(actual);
    const manifest = readManifest(actual);
    const localRequire = createRequire(join(actual, "package.json"));
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      const dependency = resolvePackage(localRequire, name);
      const path = relative(root, dependency);
      if (isAbsolute(path) || path === ".." || path.startsWith("../") || path.startsWith("..\\")) {
        throw new Error(`native fixture would borrow ${name} from outside its private package`);
      }
      check(dependency);
    }
  }
  check(packageDir);
}

function resolvePackage(packageRequire, name) {
  try {
    return realpathSync(dirname(packageRequire.resolve(`${name}/package.json`)));
  } catch (error) {
    // Some declared dependencies export their entry but not package.json.
    let directory;
    try { directory = dirname(packageRequire.resolve(name)); } catch { throw error; }
    for (;;) {
      const manifest = join(directory, "package.json");
      if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === name) {
        return realpathSync(directory);
      }
      const parent = dirname(directory);
      if (parent === directory) throw error;
      directory = parent;
    }
  }
}

// A negative-control copy must contain no healthy fallback. Enumerating every
// native binary covers platform prebuilds as well as Debug/Release and the
// additional locations that the older bindings loader can search.
export function nativeFixtureBinaries(packageDir) {
  nativeFixtureLayout(packageDir);
  const binaries = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith(".node")) binaries.push(path);
      else if (entry.isSymbolicLink()) throw new Error(`native fixture is not a dereferenced copy: ${path}`);
    }
  }
  visit(packageDir);
  return binaries;
}
