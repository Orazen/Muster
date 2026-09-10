// Local byte/identity checks only. CI separately pins the checkout and verifies
// release provenance; this builder neither reads Git nor contacts a provider.
import { build } from "esbuild";
import { z } from "zod";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { join, parse, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const Version = z.string().regex(semver).refine((value) => !semver.exec(value)?.[4]?.split(".").some((part) => /^0\d+$/.test(part)));
const Identity = z.object({ version: Version, sha: z.string().regex(/^[a-f0-9]{40}$/i).transform((value) => value.toLowerCase()) });
const Options = Identity.extend({ outDir: z.string().min(1), sourceRoot: z.string().min(1).optional() });
const Package = z.object({ version: Version });
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const names = (version) => [`Muster-${version}-cli.mjs`, "muster-cli.mjs"].sort();

function options(input) {
  const parsed = Options.safeParse(input);
  if (!parsed.success) throw new Error("CLI build requires a valid RELEASE_VERSION, full RELEASE_SHA and output directory");
  return { ...parsed.data, outDir: resolve(parsed.data.outDir), sourceRoot: resolve(parsed.data.sourceRoot ?? sourceRoot) };
}

async function directoryPath(path, allowMissing = false) {
  let current = parse(path).root;
  for (const segment of path.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, segment);
    let stat;
    try { stat = await lstat(current); }
    catch (error) { if (allowMissing && error.code === "ENOENT") return; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("CLI output ancestors must be real directories without links");
  }
}

function sameFile(first, second) {
  return second.isFile() && second.nlink === 1
    && ["dev", "ino", "size", "mtimeMs", "ctimeMs"].every((key) => first[key] === second[key]);
}

async function fileSnapshot(path) {
  const before = await lstat(path);
  if (!before.isFile() || before.nlink !== 1 || before.size === 0) throw new Error(`Expected a nonempty CLI file without links: ${path}`);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!sameFile(before, await handle.stat())) throw new Error("CLI file changed while opening");
    const bytes = await handle.readFile();
    if (bytes.length !== before.size || !sameFile(before, await handle.stat()) || !sameFile(before, await lstat(path))) throw new Error("CLI file changed while reading");
    return { path, before, bytes };
  } finally { await handle.close(); }
}

function checksumText(version, bytes) {
  return names(version).map((name) => `${digest(bytes)}  ${name}\n`).join("");
}

async function verifyCommands(bytes, identity) {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "muster-cli-verify-")));
  try {
    const cli = join(scratch, "muster-cli.mjs");
    await writeFile(cli, bytes, { flag: "wx", mode: 0o755 });
    const env = {
      MUSTER_DIR: join(scratch, "data"), HOME: scratch, USERPROFILE: scratch,
      XDG_CONFIG_HOME: join(scratch, "config"), XDG_CACHE_HOME: join(scratch, "cache"), XDG_DATA_HOME: join(scratch, "data"),
      APPDATA: join(scratch, "app-data"), LOCALAPPDATA: join(scratch, "local-app-data"),
      TEMP: scratch, TMP: scratch, TMPDIR: scratch,
    };
    // Node is launched by its absolute path. No inherited hooks, CLI config,
    // provider tokens, or PATH-based child executable resolution are needed.
    for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR"]) if (process.env[key]) env[key] = process.env[key];
    const run = (args) => execute(process.execPath, args, { cwd: scratch, env, timeout: 10000, maxBuffer: 1024 * 1024 });
    await run(["--check", cli]);
    const help = await run([cli, "--help"]);
    if (!help.stdout.includes("muster — the CLI for your AI workforce") || !help.stdout.includes("--version")) throw new Error("Built CLI help failed verification");
    const version = await run([cli, "--version", "--json"]);
    const actual = Identity.strict().safeParse(JSON.parse(version.stdout));
    if (!actual.success || actual.data.version !== identity.version || actual.data.sha !== identity.sha) throw new Error("Built CLI identity differs from release inputs");
    const human = await run([cli, "--version"]);
    if (human.stdout.trim() !== `Muster ${identity.version} (source ${identity.sha})`) throw new Error("Built CLI human version failed verification");
    const logs = await run([cli, "logs"]);
    if (logs.stdout.trim() !== "No background log yet. (`muster up -d` creates one.)") throw new Error("Built CLI isolated log smoke failed verification");
    return 5;
  } catch (cause) {
    // Child output is deliberately not included; even a damaged artifact may
    // print environment details. The failing command still rejects the gate.
    throw new Error("CLI executable verification failed", { cause });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function verifyCliArtifact(input) {
  const release = options(input);
  await directoryPath(release.outDir);
  const [immutable, stable] = names(release.version);
  const snapshots = await Promise.all([immutable, stable, "SHA256SUMS-cli.txt"].map((name) => fileSnapshot(join(release.outDir, name))));
  const [compiled, alias, checksums] = snapshots;
  const bytes = compiled.bytes;
  if (!alias.bytes.equals(bytes)) throw new Error("Stable CLI differs from its immutable release artifact");
  if (checksums.bytes.toString("utf8") !== checksumText(release.version, bytes)) throw new Error("CLI checksum manifest does not match both artifacts");
  const checks = await verifyCommands(bytes, release);
  await directoryPath(release.outDir);
  for (const snapshot of snapshots) if (!sameFile(snapshot.before, await lstat(snapshot.path))) throw new Error("CLI artifact changed during executable verification");
  return { version: release.version, sha: release.sha, files: [immutable, stable, "SHA256SUMS-cli.txt"], size: bytes.length, sha256: digest(bytes), checks };
}

export async function buildCliArtifact(input) {
  const release = options(input);
  await directoryPath(release.outDir, true);
  const packageInfo = Package.parse(JSON.parse(await readFile(join(release.sourceRoot, "package.json"), "utf8")));
  if (packageInfo.version !== release.version) throw new Error("RELEASE_VERSION must exactly match the source package version");
  const result = await build({
    absWorkingDir: release.sourceRoot, entryPoints: ["cli/muster.mjs"],
    bundle: true, platform: "node", format: "esm", target: "node22",
    write: false, metafile: true, sourcemap: false, legalComments: "none", logLevel: "silent",
    define: { "import.meta.musterCliBuild": JSON.stringify({ version: release.version, sha: release.sha }) },
  });
  if (result.outputFiles.length !== 1 || Object.values(result.metafile.outputs).some((output) => output.imports.some((entry) => !entry.external || !isBuiltin(entry.path)))) {
    throw new Error("CLI must be one standalone file with only Node built-in imports");
  }
  const bytes = Buffer.from(result.outputFiles[0].contents);
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "muster-cli-build-")));
  try {
    for (const name of names(release.version)) await writeFile(join(scratch, name), bytes, { mode: 0o755, flag: "wx" });
    await writeFile(join(scratch, "SHA256SUMS-cli.txt"), checksumText(release.version, bytes), { flag: "wx" });
    const verified = await verifyCliArtifact({ ...release, outDir: scratch });
    await directoryPath(release.outDir, true);
    await mkdir(release.outDir, { recursive: true });
    await directoryPath(release.outDir);
    // Validate every destination before writing any artifact. An immutable
    // filename can be reused only for identical bytes; stable aliases may move.
    for (const name of verified.files) {
      const path = join(release.outDir, name);
      let stat;
      try { stat = await lstat(path); } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (!stat) continue;
      if (!stat.isFile() || stat.nlink !== 1) throw new Error(`CLI output must not overwrite links: ${name}`);
      if (name === names(release.version)[0] && !(await readFile(path)).equals(bytes)) throw new Error("Immutable CLI artifact already contains different bytes");
    }
    for (const name of verified.files) {
      await writeFile(join(release.outDir, name), await readFile(join(scratch, name)), { flag: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW });
      await chmod(join(release.outDir, name), name.endsWith(".mjs") ? 0o755 : 0o644);
    }
    return verified;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function runCliBuild(command = "build", env = process.env) {
  const input = { version: env.RELEASE_VERSION, sha: env.RELEASE_SHA, outDir: env.CLI_OUT_DIR ?? "release" };
  if (command === "build") return buildCliArtifact(input);
  if (command === "verify") return verifyCliArtifact(input);
  throw new Error("Expected build or verify");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length > 3) { console.error("Usage: node scripts/build-cli.mjs [verify]"); process.exitCode = 1; }
  else runCliBuild(process.argv[2]).then((result) => console.log(JSON.stringify(result))).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
