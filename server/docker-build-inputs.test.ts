import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { z } from "zod";
import { describe, expect, it } from "vitest";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspace = z.object({ patchedDependencies: z.record(z.string(), z.string()) })
  .parse(parse(readFileSync(join(project, "pnpm-workspace.yaml"), "utf8")));
const lock = z.object({ patchedDependencies: z.record(z.string(), z.object({ path: z.string() })) })
  .parse(parse(readFileSync(join(project, "pnpm-lock.yaml"), "utf8")));
const patchPaths = Object.values(workspace.patchedDependencies);

// Inspect only the literal COPY instructions preceding the dependency install.
// Resolve directory copies from the real context: checking for the word
// "patches" alone would miss wrong destinations or a copy after the install.
function dependencyLayer(recipe: string): Map<string, string> {
  const files = new Map<string, string>();
  const install = recipe.indexOf("RUN pnpm install --frozen-lockfile");
  if (install < 0) throw new Error("No frozen dependency install");
  const add = (source: string, target: string) => {
    if (statSync(join(project, source)).isDirectory()) {
      for (const entry of readdirSync(join(project, source))) {
        add(posix.join(source, entry), posix.join(target, entry));
      }
    } else files.set(posix.normalize(target), source);
  };
  for (const line of recipe.slice(0, install).split("\n")) {
    if (!line.startsWith("COPY ")) continue;
    const parts = line.trim().split(/\s+/).slice(1);
    if (parts.some(part => part.startsWith("--"))) throw new Error("Inspect new COPY option semantics");
    const target = parts.pop()!;
    for (const source of parts) {
      const dest = statSync(join(project, source)).isDirectory()
        ? target : posix.join(target, posix.basename(source));
      add(source, dest);
    }
  }
  return files;
}

function requireInstallInputs(recipe: string): void {
  const available = dependencyLayer(recipe);
  for (const path of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ...patchPaths]) {
    if (available.get(path) !== path) throw new Error(`Missing dependency install input: ${path}`);
  }
}

describe("container dependency layers", () => {
  it("uses the same patch paths in the workspace and frozen lockfile", () => {
    expect(patchPaths.length).toBeGreaterThan(0);
    expect(Object.fromEntries(Object.entries(lock.patchedDependencies).map(([name, value]) => [name, value.path])))
      .toEqual(workspace.patchedDependencies);
    for (const path of patchPaths) expect(readFileSync(join(project, path)).length).toBeGreaterThan(0);
  });

  for (const filename of ["Dockerfile", "Dockerfile.cloud"]) {
    const recipe = readFileSync(join(project, filename), "utf8");
    it(`${filename} supplies every locked install input at the correct destination`, () => {
      expect(() => requireInstallInputs(recipe)).not.toThrow();
    });
    it(`${filename} detects the original omission and a late or misplaced copy`, () => {
      const missing = recipe.replace(/^COPY patches \.\/patches\n/m, "");
      expect(() => requireInstallInputs(missing)).toThrow("Missing dependency install input: patches/");
      expect(() => requireInstallInputs(`${missing}\nCOPY patches ./patches\n`)).toThrow("Missing dependency install input: patches/");
      expect(() => requireInstallInputs(recipe.replace("COPY patches ./patches", "COPY patches ./wrong")))
        .toThrow("Missing dependency install input: patches/");
    });
  }
});
