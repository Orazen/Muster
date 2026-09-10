// Actual esbuild + Node subprocess checks; all profiles and outputs are owned
// temporary fixtures. Nothing pairs, starts a server, tags or publishes.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCliArtifact, runCliBuild, verifyCliArtifact } from "../scripts/build-cli.mjs";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const sha = "a".repeat(40);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
let scratch, sourceRoot, outDir, version;

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "muster-cli-artifact-test-")));
  sourceRoot = join(scratch, "owned source");
  outDir = join(scratch, "release output");
  version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  mkdirSync(join(sourceRoot, "cli"), { recursive: true });
  for (const file of ["muster.mjs", "qr.mjs", "runtime-contracts.mjs"]) copyFileSync(join(root, "cli", file), join(sourceRoot, "cli", file));
  writeFileSync(join(sourceRoot, "package.json"), JSON.stringify({ version }));
});

afterEach(() => { vi.unstubAllEnvs(); rmSync(scratch, { recursive: true, force: true }); });
const options = (extra = {}) => ({ version, sha, sourceRoot, outDir, ...extra });
const artifact = (name = `Muster-${version}-cli.mjs`) => join(outDir, name);
const files = () => Object.fromEntries(readdirSync(outDir).map((name) => [name, readFileSync(join(outDir, name))]));
function childOptions(extra = {}) {
  const env = { MUSTER_DIR: join(scratch, "data"), TMP: scratch, TEMP: scratch, TMPDIR: scratch, ...extra };
  for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR"]) if (process.env[key]) env[key] = process.env[key];
  return { cwd: scratch, env, timeout: 10000, maxBuffer: 1024 * 1024 };
}

describe("reproducible CLI release artifact", () => {
  it("builds matching stable/versioned executables, verifies five real commands and hashes both files", async () => {
    const result = await buildCliArtifact(options());
    expect(result).toMatchObject({ version, sha, checks: 5 });
    expect(result.files).toEqual([`Muster-${version}-cli.mjs`, "muster-cli.mjs", "SHA256SUMS-cli.txt"]);
    const bytes = readFileSync(artifact());
    expect(bytes).toEqual(readFileSync(artifact("muster-cli.mjs")));
    expect(result.sha256).toBe(hash(bytes));
    expect(result.size).toBe(bytes.length);
    expect(readFileSync(artifact("SHA256SUMS-cli.txt"), "utf8")).toBe(`${hash(bytes)}  Muster-${version}-cli.mjs\n${hash(bytes)}  muster-cli.mjs\n`);
    if (process.platform !== "win32") expect(lstatSync(artifact()).mode & 0o111).toBe(0o111);
    const versionResult = await run(process.execPath, [artifact(), "--version", "--json"], childOptions());
    expect(JSON.parse(versionResult.stdout)).toEqual({ version, sha });
    // No hidden default profile is created or read to make the smoke succeed.
    await expect(run(process.execPath, [artifact(), "status", "--json"], childOptions())).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining("Not paired") });
    expect(existsSync(join(scratch, "data"))).toBe(false);
  });

  it("produces identical bytes across source/output locations and preserves unrelated output", async () => {
    const first = await buildCliArtifact(options());
    const before = files();
    const secondRoot = join(scratch, "second source"), secondOutput = join(scratch, "second output");
    mkdirSync(join(secondRoot, "cli"), { recursive: true });
    for (const file of ["muster.mjs", "qr.mjs", "runtime-contracts.mjs"]) copyFileSync(join(sourceRoot, "cli", file), join(secondRoot, "cli", file));
    copyFileSync(join(sourceRoot, "package.json"), join(secondRoot, "package.json"));
    const second = await buildCliArtifact(options({ sourceRoot: secondRoot, outDir: secondOutput }));
    expect(second).toEqual(first);
    for (const name of first.files) expect(readFileSync(join(secondOutput, name))).toEqual(before[name]);
    writeFileSync(join(outDir, "keep.txt"), "unrelated fixture");
    await expect(buildCliArtifact(options())).resolves.toEqual(first);
    expect(readFileSync(join(outDir, "keep.txt"), "utf8")).toBe("unrelated fixture");
  });

  it("verifies a downloaded pair without source, package dependencies or changing its files", async () => {
    const built = await buildCliArtifact(options());
    const before = files();
    rmSync(sourceRoot, { recursive: true });
    const result = await verifyCliArtifact({ version, sha, outDir });
    expect(result).toEqual(built);
    expect(files()).toEqual(before);
  });

  it("supports a valid prerelease with build metadata while preserving its exact version", async () => {
    version = "1.10.5-rc.1+build.7";
    writeFileSync(join(sourceRoot, "package.json"), JSON.stringify({ version }));
    const built = await buildCliArtifact(options());
    expect(built.version).toBe(version);
    expect(existsSync(artifact())).toBe(true);
  });

  it.each(["", "1.2", "01.2.3", "1.2.3-01", "../escape", "1.2.3\n"])("rejects invalid version %j before creating outputs", async (version) => {
    await expect(buildCliArtifact(options({ version }))).rejects.toThrow(/valid RELEASE_VERSION/);
    expect(existsSync(outDir)).toBe(false);
  });

  it.each(["main", "a".repeat(39), "z".repeat(40)])("rejects a non-commit source identity %s", async (sha) => {
    await expect(buildCliArtifact(options({ sha }))).rejects.toThrow(/full RELEASE_SHA/);
    expect(existsSync(outDir)).toBe(false);
  });

  it("refuses a package version mismatch before creating artifacts", async () => {
    await expect(buildCliArtifact(options({ version: "99.0.0" }))).rejects.toThrow(/exactly match/);
    expect(existsSync(outDir)).toBe(false);
  });

  it("does not publish build output after source compilation or executable verification fails", async () => {
    writeFileSync(join(sourceRoot, "cli", "muster.mjs"), "function broken( {");
    await expect(buildCliArtifact(options())).rejects.toThrow();
    expect(existsSync(outDir)).toBe(false);
    writeFileSync(join(sourceRoot, "cli", "muster.mjs"), "console.log('This is not a working Muster CLI');\n");
    await expect(buildCliArtifact(options())).rejects.toThrow(/executable verification failed/);
    expect(existsSync(outDir)).toBe(false);
  });

  it.each(["stable", "checksums", "identity"])("refuses a downloaded CLI with mismatched %s", async (fault) => {
    await buildCliArtifact(options());
    if (fault === "stable") writeFileSync(artifact("muster-cli.mjs"), "different bytes\n");
    if (fault === "checksums") writeFileSync(artifact("SHA256SUMS-cli.txt"), "0".repeat(64) + "  muster-cli.mjs\n");
    const before = files();
    await expect(verifyCliArtifact(options({ sha: fault === "identity" ? "b".repeat(40) : sha }))).rejects.toThrow();
    expect(files()).toEqual(before);
  });

  it("refuses missing outputs and a different immutable artifact without replacing the earlier release", async () => {
    await expect(verifyCliArtifact(options())).rejects.toThrow();
    await buildCliArtifact(options());
    const before = files();
    await expect(buildCliArtifact(options({ sha: "b".repeat(40) }))).rejects.toThrow(/Immutable CLI artifact/);
    expect(files()).toEqual(before);
  });

  it.skipIf(process.platform === "win32")("refuses output links before writing any artifacts or following the destination", async () => {
    const outside = join(scratch, "outside.txt");
    writeFileSync(outside, "preserve this file");
    mkdirSync(outDir);
    symlinkSync(outside, artifact("muster-cli.mjs"));
    await expect(buildCliArtifact(options())).rejects.toThrow(/overwrite links/);
    expect(readdirSync(outDir)).toEqual(["muster-cli.mjs"]);
    expect(readFileSync(outside, "utf8")).toBe("preserve this file");
  });

  it.skipIf(process.platform === "win32")("rejects a linked ancestor before creating missing output descendants", async () => {
    const outside = join(scratch, "outside"), linked = join(scratch, "linked");
    mkdirSync(outside);
    symlinkSync(outside, linked, "dir");
    await expect(buildCliArtifact(options({ outDir: join(linked, "must-not-be-created", "release") }))).rejects.toThrow(/ancestors/);
    expect(readdirSync(outside)).toEqual([]);
    await buildCliArtifact(options());
    const downloadLink = join(scratch, "download-link");
    symlinkSync(outDir, downloadLink, "dir");
    await expect(verifyCliArtifact(options({ outDir: downloadLink }))).rejects.toThrow(/ancestors/);
  });

  it("rejects artifact replacement during a real verification command", async () => {
    await buildCliArtifact(options());
    // A correctly hashed owned fixture mutates its original file while the
    // copied CLI runs `logs`; the final snapshot check must catch replacement.
    const replacement = Buffer.from(`${readFileSync(artifact(), "utf8")}\nif (process.argv[2] === 'logs') writeFileSync(${JSON.stringify(artifact())}, 'replaced during verification');\n`);
    writeFileSync(artifact(), replacement);
    writeFileSync(artifact("muster-cli.mjs"), replacement);
    writeFileSync(artifact("SHA256SUMS-cli.txt"), `${hash(replacement)}  Muster-${version}-cli.mjs\n${hash(replacement)}  muster-cli.mjs\n`);
    await expect(verifyCliArtifact(options())).rejects.toThrow(/changed during executable verification/);
    expect(readFileSync(artifact(), "utf8")).toBe("replaced during verification");
  });

  it("excludes inherited Node hooks and provider credentials from executable verification", async () => {
    const marker = join(scratch, "unexpected-hook.txt"), hook = join(scratch, "hook.mjs");
    writeFileSync(hook, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'hook ran'); throw new Error('hook must not run');\n`);
    vi.stubEnv("NODE_OPTIONS", `--import=${pathToFileURL(hook).href}`);
    vi.stubEnv("NODE_PATH", join(scratch, "unexpected-modules"));
    vi.stubEnv("ANTHROPIC_API_KEY", "owned-placeholder-not-a-provider-secret");
    // Source runs this guard in the actual isolated verification process.
    const original = readFileSync(join(sourceRoot, "cli", "muster.mjs"), "utf8");
    const environmentGuard = `
if (process.env.ANTHROPIC_API_KEY || process.env.NODE_OPTIONS || process.env.NODE_PATH) throw new Error('inherited environment');
if (homedir() !== process.cwd() || process.env.USERPROFILE !== process.cwd()) throw new Error('home is not owned');
for (const name of ['XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR']) {
  if (!process.env[name]?.startsWith(process.cwd())) throw new Error('cache is not owned');
}
`;
    writeFileSync(join(sourceRoot, "cli", "muster.mjs"), original + environmentGuard);
    await expect(buildCliArtifact(options())).resolves.toMatchObject({ checks: 5 });
    expect(existsSync(marker)).toBe(false);
  });

  it("implements the environment-driven build/verify entrypoints and rejects unsupported commands", async () => {
    const env = { RELEASE_VERSION: version, RELEASE_SHA: sha, CLI_OUT_DIR: outDir };
    const built = await runCliBuild("build", env);
    await expect(runCliBuild("verify", env)).resolves.toEqual(built);
    const before = files();
    const result = await run(process.execPath, [join(root, "scripts/build-cli.mjs"), "verify"], childOptions(env));
    expect(JSON.parse(result.stdout)).toEqual(built);
    expect(files()).toEqual(before);
    await expect(runCliBuild("publish", env)).rejects.toThrow(/build or verify/);
  });

  it("reports the source checkout version without fabricating a commit from the environment", async () => {
    const result = await run(process.execPath, [join(sourceRoot, "cli/muster.mjs"), "--version", "--json"], childOptions({ RELEASE_SHA: sha }));
    expect(JSON.parse(result.stdout)).toEqual({ version, sha: null });
    const human = await run(process.execPath, [join(sourceRoot, "cli/muster.mjs"), "-v"], childOptions());
    expect(human.stdout.trim()).toBe(`Muster ${version} (source unbundled checkout)`);
    const help = await run(process.execPath, [join(sourceRoot, "cli/muster.mjs"), "help"], childOptions());
    expect(help.stdout).toContain("muster --version [--json]");
  });
});
