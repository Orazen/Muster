import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, readdir, readlink, realpath, rm, symlink, stat, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const helper = resolve("scripts/promote-release-mirror.py");
const sha = "a".repeat(40);
const roots = [];
const pythonEnv = { ...process.env, PYTHONDONTWRITEBYTECODE: "1" };
const desktopStable = ["Muster.dmg", "Muster-setup.exe", "Muster.deb", "Muster.AppImage", "Muster-intel.dmg"];
const cli = "muster-cli.mjs";
const stable = [...desktopStable, cli];
const feeds = ["latest-mac.yml", "latest.yml", "latest-linux.yml"];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function tree() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "muster-mirror-")));
  roots.push(root); await mkdir(join(root, ".incoming")); return root;
}
async function candidate(root, version = "1.10.5", sourceSha = sha, intel = true, includeCli = true) {
  const directory = join(root, ".incoming", `run-${(await readdir(join(root, ".incoming"))).length}`);
  await mkdir(directory);
  const entries = [], files = {}, checksums = {};
  for (const name of [...desktopStable.filter((name) => intel || name !== "Muster-intel.dmg"), ...feeds, `Muster-${version}-arm64.zip`, ...(includeCli ? [cli, `Muster-${version}-cli.mjs`] : [])]) {
    const bytes = Buffer.from(`${version}:${name.endsWith("-cli.mjs") ? cli : name}`); await writeFile(join(directory, name), bytes);
    entries.push({ name, size: bytes.length, sha256: digest(bytes) });
    if (stable.includes(name)) { files[name] = { size: bytes.length, sha256: digest(bytes) }; checksums[name] = digest(bytes); }
  }
  const latest = JSON.stringify({ version, sha: sourceSha, published: "2026-09-11T00:00:00Z", files, checksums });
  await writeFile(join(directory, "latest.json"), latest);
  entries.push({ name: "latest.json", size: Buffer.byteLength(latest), sha256: digest(latest) });
  // Python compares code points; manifest producer also uses the default sort.
  entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const manifest = { schemaVersion: 1, version, sha: sourceSha, files: entries };
  const text = JSON.stringify(manifest); await writeFile(join(directory, "mirror-manifest.json"), text);
  return { directory, version, sha: sourceSha, hash: digest(text), manifest };
}
function args(root, c) { return [helper, "--root", root, "--candidate", c.directory, "--version", c.version, "--sha", c.sha, "--manifest-sha256", c.hash]; }
function promote(root, c) { return spawnSync("python3", args(root, c), { encoding: "utf8", timeout: 5000, env: pythonEnv }); }
async function published(root) { return JSON.parse(await readFile(join(root, "latest.json"), "utf8")); }
async function legacy(root, version = "1.10.4") {
  const c = await candidate(root, version, sha, true, false);
  for (const entry of c.manifest.files) await writeFile(join(root, entry.name), await readFile(join(c.directory, entry.name)));
  await writeFile(join(root, cli), `${version}:untracked-cli`);
  return c;
}
async function managedLegacy(root) {
  const c = await legacy(root);
  const relative = ".generations/release-old";
  const generation = join(root, relative);
  await mkdir(generation, { recursive: true });
  for (const entry of c.manifest.files) {
    await writeFile(join(generation, entry.name), await readFile(join(root, entry.name)));
    if ([...desktopStable, ...feeds, "latest.json"].includes(entry.name)) {
      await rm(join(root, entry.name)); await symlink(`.current/${entry.name}`, join(root, entry.name));
    }
  }
  await writeFile(join(generation, ".mirror-state.json"), JSON.stringify({
    schemaVersion: 1, kind: "release", version: c.version, sha: c.sha,
    files: Object.fromEntries(c.manifest.files.map((entry) => [entry.name, entry])), manifestSha256: c.hash,
  }));
  await symlink(relative, join(root, ".current"));
  return c;
}
async function rewriteManifest(c, change) {
  change(c.manifest); const text = JSON.stringify(c.manifest);
  await writeFile(join(c.directory, "mirror-manifest.json"), text); c.hash = digest(text);
}
async function replaceCandidateFile(c, name, bytes) {
  await writeFile(join(c.directory, name), bytes);
  await rewriteManifest(c, (manifest) => {
    const entry = manifest.files.find((entry) => entry.name === name);
    entry.size = Buffer.byteLength(bytes); entry.sha256 = digest(bytes);
  });
}
const importHelper = `import importlib.util,sys,os,time,json\nspec=importlib.util.spec_from_file_location('mirror',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\n`;
function interrupt(root, c, phase, detail = "") {
  const script = importHelper + `def checkpoint(phase,detail):\n if phase==sys.argv[7] and (not sys.argv[8] or sys.argv[8] in detail): os._exit(97)\nm.promote(sys.argv[2],sys.argv[3],sys.argv[4],sys.argv[5],sys.argv[6],checkpoint)\n`;
  return spawnSync("python3", ["-c", script, helper, root, c.directory, c.version, c.sha, c.hash, phase, detail], { encoding: "utf8", timeout: 5000, env: pythonEnv });
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe.skipIf(process.platform === "win32")("Unix release mirror promotion", () => {
  it("promotes CLI with the desktop release, retains updater URLs and leaves unrelated files", async () => {
    const root = await tree(); const old = await legacy(root); const next = await candidate(root);
    await writeFile(join(root, "support.txt"), "unrelated support"); const inode = (await stat(root)).ino;
    const result = promote(root, next); expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).status).toBe("promoted"); expect((await published(root)).version).toBe(next.version);
    expect((await stat(root)).ino).toBe(inode); expect((await lstat(join(root, "latest.json"))).isSymbolicLink()).toBe(true);
    expect((await lstat(join(root, `Muster-${old.version}-arm64.zip`))).isFile()).toBe(true);
    expect(await readFile(join(root, `Muster-${old.version}-arm64.zip`), "utf8")).toBe(`${old.version}:Muster-${old.version}-arm64.zip`);
    expect(await readFile(join(root, cli), "utf8")).toBe(`${next.version}:${cli}`);
    expect(await readlink(join(root, cli))).toBe(`.current/${cli}`);
    expect(await readFile(join(root, "support.txt"), "utf8")).toBe("unrelated support");
    const retry = promote(root, next); expect(retry.status, retry.stderr).toBe(0); expect(JSON.parse(retry.stdout).status).toBe("unchanged");
  });
  it.each(["generation-ready", "legacy-current-ready", "alias-ready", "target-ready", "before-promote", "promoted"])("recovers a killed legacy migration at %s", async (phase) => {
    const root = await tree(); await legacy(root); const next = await candidate(root);
    const result = interrupt(root, next, phase, phase === "generation-ready" ? "legacy-" : "");
    expect(result.status, result.stderr).toBe(97);
    expect((await published(root)).version).toBe(phase === "promoted" ? next.version : "1.10.4");
    for (const name of [...desktopStable, ...feeds]) expect(await readFile(join(root, name), "utf8")).toBe(`${phase === "promoted" ? next.version : "1.10.4"}:${name}`);
    expect(await readFile(join(root, cli), "utf8")).toBe(phase === "promoted" ? `${next.version}:${cli}` : "1.10.4:untracked-cli");
    const retry = promote(root, next); expect(retry.status, retry.stderr).toBe(0); expect((await published(root)).version).toBe(next.version);
  });
  it.each(["empty-current-ready", "alias-ready", "target-ready", "before-promote"])("recovers an interrupted first-ever mirror at %s", async (phase) => {
    const root = await tree(); const next = await candidate(root);
    expect(interrupt(root, next, phase).status).toBe(97);
    const retry = promote(root, next); expect(retry.status, retry.stderr).toBe(0); expect((await published(root)).version).toBe(next.version);
  });
  it.each(["generation-ready", "auxiliary-current-ready", "alias-ready", "before-promote", "promoted"])("preserves an old managed mirror's flat CLI through interruption at %s", async (phase) => {
    const root = await tree(); await managedLegacy(root); const next = await candidate(root);
    const previousLatest = await readFile(join(root, "latest.json"));
    const result = interrupt(root, next, phase, phase === "alias-ready" ? cli : "");
    expect(result.status, result.stderr).toBe(97);
    const promoted = phase === "promoted";
    expect(await readFile(join(root, cli), "utf8")).toBe(promoted ? `${next.version}:${cli}` : "1.10.4:untracked-cli");
    if (!promoted) {
      expect(await readFile(join(root, "latest.json"))).toEqual(previousLatest);
      expect((await published(root)).files[cli]).toBeUndefined();
      if (phase !== "generation-ready") {
        const current = join(root, await readlink(join(root, ".current")));
        const state = JSON.parse(await readFile(join(current, ".mirror-state.json"), "utf8"));
        expect(state.auxiliary[cli].sha256).toBe(digest("1.10.4:untracked-cli"));
        expect(state.files[cli]).toBeUndefined();
      }
    }
    const retry = promote(root, next); expect(retry.status, retry.stderr).toBe(0);
    expect(await readFile(join(root, cli), "utf8")).toBe(`${next.version}:${cli}`);
    expect((await published(root)).files[cli].sha256).toBe(digest(`${next.version}:${cli}`));
  });
  it.each(["empty-current-ready", "alias-ready", "before-promote"])("preserves a CLI-only legacy root before first promotion at %s", async (phase) => {
    const root = await tree(); await writeFile(join(root, cli), "standalone old CLI");
    const next = await candidate(root);
    expect(interrupt(root, next, phase, phase === "alias-ready" ? cli : "").status).toBe(97);
    expect(await readFile(join(root, cli), "utf8")).toBe("standalone old CLI");
    await expect(readFile(join(root, "latest.json"))).rejects.toMatchObject({ code: "ENOENT" });
    const retry = promote(root, next); expect(retry.status, retry.stderr).toBe(0);
    expect(await readFile(join(root, cli), "utf8")).toBe(`${next.version}:${cli}`);
  });
  it.each(["missing CLI", "missing immutable CLI", "mismatched immutable CLI", "corrupt CLI", "wrong CLI version", "CLI symlink"])("rejects %s before legacy promotion", async (fault) => {
    const root = await tree(); await legacy(root);
    const next = await candidate(root, "1.10.5", sha, true, fault !== "missing CLI");
    const target = `Muster-${next.version}-cli.mjs`;
    if (fault === "missing immutable CLI" || fault === "wrong CLI version") {
      const bytes = await readFile(join(next.directory, target)); await rm(join(next.directory, target));
      await rewriteManifest(next, (manifest) => { manifest.files = manifest.files.filter((entry) => entry.name !== target); });
      if (fault === "wrong CLI version") {
        const name = "Muster-1.10.4-cli.mjs";
        await writeFile(join(next.directory, name), bytes);
        await rewriteManifest(next, (manifest) => {
          manifest.files.push({ name, size: bytes.length, sha256: digest(bytes) });
          manifest.files.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
        });
      }
    }
    if (fault === "mismatched immutable CLI") await replaceCandidateFile(next, target, "different checksummed CLI");
    if (fault === "corrupt CLI") await writeFile(join(next.directory, cli), "tampered CLI");
    if (fault === "CLI symlink") { await rm(join(next.directory, cli)); await symlink(join(root, cli), join(next.directory, cli)); }
    const previousLatest = await readFile(join(root, "latest.json"));
    const result = promote(root, next); expect(result.status, result.stdout).toBe(1);
    expect(await readFile(join(root, "latest.json"))).toEqual(previousLatest);
    expect((await lstat(join(root, "latest.json"))).isFile()).toBe(true);
    expect(await readFile(join(root, cli), "utf8")).toBe("1.10.4:untracked-cli");
  });
  it("retains old immutable CLI URLs and repairs the current target on an identical retry", async () => {
    const root = await tree(); const old = await candidate(root); expect(promote(root, old).status).toBe(0);
    const next = await candidate(root, "1.10.6"); expect(promote(root, next).status).toBe(0);
    expect(await readFile(join(root, `Muster-${old.version}-cli.mjs`), "utf8")).toBe(`${old.version}:${cli}`);
    const name = `Muster-${next.version}-cli.mjs`; await rm(join(root, name));
    const result = promote(root, next); expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).status).toBe("unchanged");
    expect(await readFile(join(root, name))).toEqual(await readFile(join(root, cli)));
  });
  it("rejects immutable CLI collisions before adopting an old flat CLI", async () => {
    const root = await tree(); await managedLegacy(root); const next = await candidate(root);
    const before = await readlink(join(root, ".current"));
    await writeFile(join(root, `Muster-${next.version}-cli.mjs`), "previous immutable bytes");
    const result = promote(root, next); expect(result.status).toBe(1); expect(result.stderr).toContain("collision");
    expect(await readlink(join(root, ".current"))).toBe(before);
    expect((await lstat(join(root, cli))).isFile()).toBe(true);
    expect(await readFile(join(root, cli), "utf8")).toBe("1.10.4:untracked-cli");
  });
  it("refuses same-version CLI replacement, downgrade and removing a published CLI", async () => {
    const root = await tree(); const current = await candidate(root); expect(promote(root, current).status).toBe(0);
    const changed = await candidate(root); const bytes = "different release CLI";
    await replaceCandidateFile(changed, cli, bytes);
    await replaceCandidateFile(changed, `Muster-${changed.version}-cli.mjs`, bytes);
    const latest = JSON.parse(await readFile(join(changed.directory, "latest.json"), "utf8"));
    latest.files[cli] = { size: Buffer.byteLength(bytes), sha256: digest(bytes) }; latest.checksums[cli] = digest(bytes);
    await replaceCandidateFile(changed, "latest.json", JSON.stringify(latest));
    const downgrade = await candidate(root, "1.10.4");
    const dropped = await candidate(root, "1.10.6", sha, true, false);
    const before = await readlink(join(root, ".current"));
    for (const next of [changed, downgrade, dropped]) expect(promote(root, next).status).toBe(1);
    expect(await readlink(join(root, ".current"))).toBe(before);
    expect(await readFile(join(root, cli), "utf8")).toBe(`${current.version}:${cli}`);
  });
  it("rejects downgrade, changed SHA, changed same-version bytes and removed Intel", async () => {
    const root = await tree(); const first = await candidate(root); expect(promote(root, first).status).toBe(0);
    const old = await candidate(root, "1.10.4"), other = await candidate(root, first.version, "b".repeat(40));
    const changed = await candidate(root); const name = `Muster-${changed.version}-arm64.zip`;
    await writeFile(join(changed.directory, name), "changed bytes");
    await rewriteManifest(changed, (manifest) => { const entry = manifest.files.find((entry) => entry.name === name); entry.size = 13; entry.sha256 = digest("changed bytes"); });
    const noIntel = await candidate(root, "1.10.6", sha, false);
    for (const c of [old, other, changed, noIntel]) expect(promote(root, c).status).toBe(1);
    expect((await published(root)).version).toBe(first.version);
  });
  it("compares version components numerically", async () => {
    const root = await tree(); const old = await candidate(root, "1.9.9"); expect(promote(root, old).status).toBe(0);
    const next = await candidate(root, "1.10.0"); expect(promote(root, next).status).toBe(0);
    expect((await published(root)).version).toBe("1.10.0");
  });
  it("rejects versioned target collision before changing legacy aliases", async () => {
    const root = await tree(); await legacy(root); const next = await candidate(root);
    await writeFile(join(root, `Muster-${next.version}-arm64.zip`), "different installer");
    const r = promote(root, next); expect(r.status).toBe(1); expect(r.stderr).toContain("collision");
    expect((await lstat(join(root, "latest.json"))).isFile()).toBe(true); expect((await published(root)).version).toBe("1.10.4");
  });
  it.each(["hash", "manifest", "duplicate", "traversal", "extra", "file-link", "stage-link", "bad-latest", "bad-legacy"])("rejects %s before public mutation", async (mode) => {
    const root = await tree(); await legacy(root); const c = await candidate(root);
    if (mode === "hash") c.hash = "0".repeat(64);
    if (mode === "manifest") await writeFile(join(c.directory, "Muster.dmg"), "tampered");
    if (mode === "duplicate") await rewriteManifest(c, (m) => m.files.push(m.files[0]));
    if (mode === "traversal") await rewriteManifest(c, (m) => { m.files[0].name = "../escape"; });
    if (mode === "extra") await writeFile(join(c.directory, "extra"), "unexpected");
    if (mode === "file-link") { await rm(join(c.directory, "Muster.dmg")); await symlink(join(root, "Muster.dmg"), join(c.directory, "Muster.dmg")); }
    if (mode === "stage-link") { const alias = join(root, ".incoming", "stage-link"); await symlink(c.directory, alias); c.directory = alias; }
    if (mode === "bad-latest") { const bytes = '{"version":"0.0.0"}'; await writeFile(join(c.directory, "latest.json"), bytes); await rewriteManifest(c, (m) => { const e = m.files.find((e) => e.name === "latest.json"); e.size = Buffer.byteLength(bytes); e.sha256 = digest(bytes); }); }
    if (mode === "bad-legacy") await writeFile(join(root, "latest.json"), "{}");
    const before = await readFile(join(root, "latest.json")); const result = promote(root, c);
    expect(result.status, result.stdout).toBe(1); expect(await readFile(join(root, "latest.json"))).toEqual(before);
    expect((await lstat(join(root, "latest.json"))).isFile()).toBe(true);
  });
  it("rejects metadata-only drift for an already published version", async () => {
    const root = await tree(); const c = await candidate(root); expect(promote(root, c).status).toBe(0);
    const retry = await candidate(root); const latest = JSON.parse(await readFile(join(retry.directory, "latest.json"), "utf8"));
    latest.published = "2026-09-12T00:00:00Z"; const bytes = JSON.stringify(latest);
    await writeFile(join(retry.directory, "latest.json"), bytes);
    await rewriteManifest(retry, (m) => { const e = m.files.find((entry) => entry.name === "latest.json"); e.size = Buffer.byteLength(bytes); e.sha256 = digest(bytes); });
    const result = promote(root, retry); expect(result.status).toBe(1); expect(result.stderr).toContain("different published bytes");
    expect((await published(root)).published).toBe("2026-09-11T00:00:00Z");
  });
  it("repairs a missing immutable target on an otherwise identical retry", async () => {
    const root = await tree(); const c = await candidate(root); expect(promote(root, c).status).toBe(0);
    const name = `Muster-${c.version}-arm64.zip`; await rm(join(root, name));
    const result = promote(root, c); expect(result.status, result.stderr).toBe(0); expect(JSON.parse(result.stdout).status).toBe("unchanged");
    expect(await readFile(join(root, name))).toEqual(await readFile(join(c.directory, name)));
  });
  it("rejects a symlink ancestor without altering the actual legacy root", async () => {
    const root = await tree(); await legacy(root); const c = await candidate(root);
    const alias = join(root, "root-alias"); await symlink(root, alias);
    expect(promote(alias, c).status).toBe(1); expect((await lstat(join(root, "latest.json"))).isFile()).toBe(true);
    expect((await published(root)).version).toBe("1.10.4");
  });
  it("recovers after candidate generation is complete but before publication", async () => {
    const root = await tree(); await legacy(root); const c = await candidate(root);
    expect(interrupt(root, c, "generation-ready", "release-").status).toBe(97);
    expect((await published(root)).version).toBe("1.10.4");
    expect(promote(root, c).status).toBe(0); expect((await published(root)).version).toBe(c.version);
  });
  it("runs through Python stdin as used by the deployment workflow", async () => {
    const root = await tree(); const c = await candidate(root);
    const result = spawnSync("python3", ["-", ...args(root, c).slice(1)], { input: await readFile(helper), encoding: "utf8", timeout: 5000, env: pythonEnv });
    expect(result.status, result.stderr).toBe(0); expect((await published(root)).version).toBe(c.version);
  });
  it("holds a process lock and releases it automatically after the owner dies", async () => {
    const root = await tree(); const c = await candidate(root);
    const script = importHelper + `def checkpoint(phase,detail):\n if phase=='locked':\n  print('locked',flush=True)\n  time.sleep(30)\nm.promote(sys.argv[2],sys.argv[3],sys.argv[4],sys.argv[5],sys.argv[6],checkpoint)\n`;
    const child = spawn("python3", ["-c", script, helper, root, c.directory, c.version, c.sha, c.hash], { stdio: ["ignore", "pipe", "pipe"], env: pythonEnv });
    const closed = new Promise((yes) => { child.once("close", yes); child.once("error", yes); });
    const ready = new Promise((yes, no) => {
      child.stdout.once("data", yes); child.once("error", no);
      child.once("close", (code) => no(new Error(`lock holder exited ${code}`)));
    });
    const bounded = async (promise) => {
      let timer;
      try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("child lifecycle timed out")), 3000); })]); }
      finally { clearTimeout(timer); }
    };
    try {
      await bounded(ready);
      const blocked = promote(root, c); expect(blocked.status).toBe(1); expect(blocked.stderr).toContain("holds the lock");
    } finally { child.kill("SIGKILL"); await bounded(closed); }
    const retry = promote(root, c); expect(retry.status, retry.stderr).toBe(0);
  });
});
