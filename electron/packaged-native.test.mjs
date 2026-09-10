// Filesystem/process-contract tests only. Real Electron loading is verified
// separately by the packaged runtime smoke; these fixtures contain no addon.
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { Arch } from "electron-builder";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareElectronNative, resolveElectronNativeTarget } from "../build/prepare-electron-native.mjs";

let scratch;
beforeEach(() => { scratch = mkdtempSync(join(tmpdir(), "muster-packaged-native-")); });
afterEach(() => { rmSync(scratch, { recursive: true, force: true }); });

function put(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function snapshot(directory) {
  const files = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else files.push([relative(directory, path), readFileSync(path).toString("hex")]);
    }
  };
  visit(directory);
  return files;
}

function fixture(platform = "darwin", arch = Arch.arm64) {
  const projectDir = join(scratch, "project with spaces");
  const appOutDir = join(scratch, "release", `${platform}-${Arch[arch]}`);
  const resourcesDir = platform === "darwin"
    ? join(appOutDir, "Muster.app", "Contents", "Resources")
    : join(appOutDir, "resources");
  const sourceDir = join(projectDir, "dist-server", "_native", "better-sqlite3");
  const targetDir = join(resourcesDir, "server", "_native", "better-sqlite3");
  const nodeGypPath = join(scratch, "toolchain", "node-gyp.js");
  const headersDir = join(scratch, "electron-headers", "43.4.0");
  put(join(sourceDir, "package.json"), JSON.stringify({ name: "better-sqlite3", version: "12.11.1" }));
  put(join(sourceDir, "binding.gyp"), "{ 'targets': [] }");
  put(join(sourceDir, "src", "better_sqlite3.cpp"), "// owned source fixture\n");
  put(join(sourceDir, "deps", "sqlite3", "sqlite3.c"), "/* owned sqlite source fixture */\n");
  put(join(sourceDir, "lib", "index.js"), "module.exports = 'owned javascript fixture';\n");
  put(join(sourceDir, "build", "Release", "better_sqlite3.node"), "host-node-addon");
  put(join(sourceDir, "build", "stale.obj"), "host-build-object");
  put(join(sourceDir, "prebuilds", "host", "old.node"), "host-prebuilt-addon");
  put(join(sourceDir, "legacy", "old.node"), "host-addon-outside-build");
  for (const helper of ["bindings", "file-uri-to-path"]) {
    const entry = helper === "bindings" ? "bindings.js" : "index.js";
    put(join(sourceDir, "node_modules", helper, "package.json"), JSON.stringify({ name: helper, main: entry }));
    put(join(sourceDir, "node_modules", helper, entry), `module.exports = '${helper} fixture';\n`);
  }
  put(join(projectDir, "dist-server", "index.js"), "// standalone Node server\n");
  put(join(resourcesDir, "server", "index.js"), "// packaged server fixture\n");
  put(join(targetDir, "build", "Release", "better_sqlite3.node"), "previous-package-addon");
  put(join(targetDir, "prebuilds", "old-target", "old.node"), "previous-package-prebuilt");
  put(join(resourcesDir, "ui", "index.html"), "owned UI must remain unchanged");
  put(join(resourcesDir, "server", "_native", "another-package", "keep.node"), "unrelated-addon");
  put(nodeGypPath, "// process runner is injected; this file must never execute\n");
  put(join(headersDir, "include", "node", "config.gypi"), "{}");
  const context = {
    appOutDir,
    arch,
    electronPlatformName: platform,
    packager: {
      projectDir,
      config: { electronVersion: "43.4.0" },
      getResourcesDir: () => resourcesDir,
    },
  };
  return { context, projectDir, resourcesDir, sourceDir, targetDir, nodeGypPath, headersDir };
}

function options(owned, run) {
  return { run, nodeGypPath: owned.nodeGypPath, headersDir: owned.headersDir, hostPlatform: owned.context.electronPlatformName };
}

function successfulBuild(owned, calls = []) {
  return async (executable, args, settings) => {
    calls.push({ executable, args, settings });
    expect(settings.cwd).toBe(owned.targetDir);
    expect(existsSync(join(owned.targetDir, "build", "Release", "better_sqlite3.node"))).toBe(false);
    expect(existsSync(join(owned.targetDir, "build", "stale.obj"))).toBe(false);
    expect(existsSync(join(owned.targetDir, "prebuilds"))).toBe(false);
    expect(snapshot(owned.targetDir).filter(([path]) => path.endsWith(".node"))).toEqual([]);
    put(join(settings.cwd, "build", "Release", "better_sqlite3.node"), "new-electron-addon-fixture");
  };
}

describe("packaged Electron native target", () => {
  it.each([
    ["darwin", Arch.arm64, "arm64"],
    ["darwin", Arch.x64, "x64"],
    ["win32", Arch.x64, "x64"],
    ["linux", Arch.x64, "x64"],
  ])("resolves the exact Electron runtime and %s/%s package paths", (platform, arch, expectedArch) => {
    const owned = fixture(platform, arch);
    expect(resolveElectronNativeTarget(owned.context, { hostPlatform: platform })).toMatchObject({
      version: "43.4.0", platform, arch: expectedArch,
      resourcesDir: owned.resourcesDir, sourceDir: owned.sourceDir, targetDir: owned.targetDir,
    });
  });

  it.each([undefined, "^43.4.0", "43", "43.4.0 --arch=ia32"])("rejects a non-exact Electron version (%s)", (version) => {
    const owned = fixture();
    owned.context.packager.config.electronVersion = version;
    expect(() => resolveElectronNativeTarget(owned.context, { hostPlatform: "darwin" })).toThrow(/version/i);
  });

  it.each([
    ["freebsd", Arch.x64],
    ["darwin", Arch.universal],
    ["win32", Arch.ia32],
  ])("rejects an unsupported target %s/%s", (platform, arch) => {
    const owned = fixture(platform, arch);
    expect(() => resolveElectronNativeTarget(owned.context, { hostPlatform: platform })).toThrow();
  });

  it("rejects a different host operating system before changing the packaged copy", async () => {
    const owned = fixture("win32", Arch.x64);
    const before = snapshot(owned.resourcesDir);
    let calls = 0;
    await expect(prepareElectronNative(owned.context, {
      ...options(owned, async () => { calls++; }), hostPlatform: "linux",
    })).rejects.toThrow();
    expect(calls).toBe(0);
    expect(snapshot(owned.resourcesDir)).toEqual(before);
  });

  it("rejects resources outside the owned package before touching files", async () => {
    const owned = fixture();
    const outside = join(scratch, "outside-package");
    put(join(outside, "keep.txt"), "outside sentinel");
    const sourceBefore = snapshot(owned.projectDir);
    owned.context.packager.getResourcesDir = () => outside;
    let calls = 0;
    await expect(prepareElectronNative(owned.context, options(owned, async () => { calls++; }))).rejects.toThrow();
    expect(calls).toBe(0);
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("outside sentinel");
    expect(snapshot(owned.projectDir)).toEqual(sourceBefore);
  });

  it("rejects a symlink from the packaged native directory into the source tree", async () => {
    const owned = fixture();
    rmSync(owned.targetDir, { recursive: true });
    symlinkSync(owned.sourceDir, owned.targetDir, "junction");
    const sourceBefore = snapshot(owned.projectDir);
    let calls = 0;
    await expect(prepareElectronNative(owned.context, options(owned, async () => { calls++; }))).rejects.toThrow();
    expect(calls).toBe(0);
    expect(snapshot(owned.projectDir)).toEqual(sourceBefore);
  });
});

describe("packaged Electron native rebuild", () => {
  it("prevents inherited npm and node-gyp settings from overriding the packaged target", async () => {
    const owned = fixture();
    const inherited = [
      ["npm_config_target", "22.0.0"],
      ["NPM_CONFIG_ARCH", "x64"],
      ["npm_config_nodedir", join(scratch, "wrong-node-headers")],
      ["NPM_PACKAGE_CONFIG_NODE_GYP_FORCE_PROCESS_CONFIG", "true"],
      ["npm_package_config_node_gyp_directory", owned.sourceDir],
      ["npm_package_config_node_gyp_debug", "true"],
    ];
    const previous = inherited.map(([key]) => [key, process.env[key]]);
    try {
      for (const [key, value] of inherited) process.env[key] = value;
      const calls = [];
      await prepareElectronNative(owned.context, options(owned, successfulBuild(owned, calls)));
      expect(calls).toHaveLength(1);
      const { args, settings } = calls[0];
      expect(settings.cwd).toBe(owned.targetDir);
      expect(args).toEqual(expect.arrayContaining([
        "--target=43.4.0", "--arch=arm64", `--nodedir=${owned.headersDir}`,
      ]));
      const inheritedOptionKeys = Object.keys(settings.env)
        .filter((key) => /^(npm_config_|npm_package_config_node_gyp_)/i.test(key)).sort();
      expect(inheritedOptionKeys).toEqual(["npm_config_arch", "npm_config_runtime", "npm_config_target"]);
      expect(settings.env).toMatchObject({
        npm_config_runtime: "electron", npm_config_target: "43.4.0", npm_config_arch: "arm64",
      });
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("rejects incomplete JavaScript helpers before removing the previous package", async () => {
    const owned = fixture();
    rmSync(join(owned.sourceDir, "node_modules", "bindings", "bindings.js"));
    const before = snapshot(owned.resourcesDir);
    let calls = 0;
    await expect(prepareElectronNative(owned.context, options(owned, async () => { calls++; }))).rejects.toThrow();
    expect(calls).toBe(0);
    expect(snapshot(owned.resourcesDir)).toEqual(before);
  });

  it.each([
    ["darwin", Arch.arm64, "arm64"],
    ["darwin", Arch.x64, "x64"],
    ["win32", Arch.x64, "x64"],
    ["linux", Arch.x64, "x64"],
  ])("rebuilds only the %s/%s packaged copy and preserves its JavaScript helpers", async (platform, arch, expectedArch) => {
    const owned = fixture(platform, arch);
    const sourceBefore = snapshot(owned.projectDir);
    const calls = [];
    await prepareElectronNative(owned.context, options(owned, successfulBuild(owned, calls)));
    expect(calls).toHaveLength(1);
    expect(calls[0].executable).toBe(process.execPath);
    expect(calls[0].args).toEqual(expect.arrayContaining([
      owned.nodeGypPath, "rebuild", "--target=43.4.0", `--arch=${expectedArch}`,
    ]));
    expect(calls[0].args.some((arg) => arg === `--nodedir=${owned.headersDir}`)).toBe(true);
    expect(readFileSync(join(owned.targetDir, "build", "Release", "better_sqlite3.node"), "utf8")).toBe("new-electron-addon-fixture");
    for (const helper of ["bindings", "file-uri-to-path"]) {
      for (const file of ["package.json", helper === "bindings" ? "bindings.js" : "index.js"]) {
        expect(readFileSync(join(owned.targetDir, "node_modules", helper, file)))
          .toEqual(readFileSync(join(owned.sourceDir, "node_modules", helper, file)));
      }
    }
    expect(snapshot(owned.projectDir)).toEqual(sourceBefore);
    expect(readFileSync(join(owned.resourcesDir, "ui", "index.html"), "utf8")).toBe("owned UI must remain unchanged");
    expect(readFileSync(join(owned.resourcesDir, "server", "_native", "another-package", "keep.node"), "utf8")).toBe("unrelated-addon");
  });

  it("propagates a compiler failure instead of retaining the host addon", async () => {
    const owned = fixture();
    const sourceBefore = snapshot(owned.projectDir);
    await expect(prepareElectronNative(owned.context, options(owned, async () => {
      throw new Error("owned compiler failed");
    }))).rejects.toThrow("owned compiler failed");
    expect(existsSync(join(owned.targetDir, "build", "Release", "better_sqlite3.node"))).toBe(false);
    expect(snapshot(owned.projectDir)).toEqual(sourceBefore);
  });

  it("rejects a successful process exit that did not produce an addon", async () => {
    const owned = fixture();
    const sourceBefore = snapshot(owned.projectDir);
    let calls = 0;
    await expect(prepareElectronNative(owned.context, options(owned, async () => { calls++; }))).rejects.toThrow(/addon/i);
    expect(calls).toBe(1);
    expect(existsSync(join(owned.targetDir, "build", "Release", "better_sqlite3.node"))).toBe(false);
    expect(snapshot(owned.projectDir)).toEqual(sourceBefore);
  });
});
