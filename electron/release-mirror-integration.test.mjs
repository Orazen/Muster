// Owned byte fixtures only: no installers execute and all HTTP stays on loopback.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareMirrorPayload } from "../scripts/release-payload.mjs";

const promoter = fileURLToPath(new URL("../scripts/promote-release-mirror.py", import.meta.url));
const publishedAt = "2026-09-11T00:00:00Z";
const feeds = ["latest-mac.yml", "latest.yml", "latest-linux.yml"];
const stableNames = ["Muster.dmg", "Muster-intel.dmg", "Muster-setup.exe", "Muster.deb", "Muster.AppImage"];
const digest = (bytes, algorithm = "sha256", encoding = "hex") => createHash(algorithm).update(bytes).digest(encoding);

// The production promoter uses POSIX symlinks and flock; Windows does not run it.
describe.skipIf(process.platform === "win32")("release payload → mirror promotion → downloaded bytes", () => {
  let scratch, root, server, baseUrl, run;

  beforeEach(async () => {
    // macOS tmpdir can contain /var's symlink; the promoter requires real ancestors.
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "muster-mirror-integration-")));
    root = join(scratch, "mirror");
    mkdirSync(join(root, ".incoming"), { recursive: true });
    writeFileSync(join(root, "muster-cli.mjs"), "unrelated owned CLI fixture\n");
    run = 1000;
    server = createServer((request, response) => {
      const name = request.url?.slice(1);
      if (request.method !== "GET" || !name || !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(name)) {
        response.writeHead(404).end();
        return;
      }
      // readFile follows the actual promoted symlinks, as a filesystem server does.
      void readFile(join(root, name)).then(
        (bytes) => response.writeHead(200, { "Content-Length": bytes.length }).end(bytes),
        () => response.writeHead(404).end(),
      );
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
    });
    const address = z.object({ port: z.number().int().positive() }).parse(server.address());
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    try {
      if (server?.listening) {
        await new Promise((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
          server.closeAllConnections();
        });
      }
    } finally {
      if (scratch) rmSync(scratch, { recursive: true, force: true });
    }
  });

  async function payload(version = "1.10.5", sha = "a".repeat(40)) {
    const assetsDir = join(scratch, `assets-${version}`);
    mkdirSync(assetsDir);
    const names = {
      dmg: `Muster-${version}.dmg`, zip: `Muster-${version}-arm64.zip`,
      intelDmg: `Muster-${version}-intel.dmg`, intelZip: `Muster-${version}-x64.zip`,
      exe: `Muster-${version}-setup.exe`, deb: `Muster-${version}-amd64.deb`,
      appImage: `Muster-${version}-x86_64.AppImage`,
    };
    const bytes = (name) => readFileSync(join(assetsDir, name));
    const put = (name, data) => writeFileSync(join(assetsDir, name), data);
    for (const name of Object.values(names)) put(name, `Owned inert ${version} installer bytes: ${name}\n`);
    for (const [stable, target] of [
      ["Muster.dmg", names.dmg], ["Muster-intel.dmg", names.intelDmg],
      ["Muster-setup.exe", names.exe], ["Muster.deb", names.deb], ["Muster.AppImage", names.appImage],
    ]) put(stable, bytes(target));
    for (const [name, targets] of [
      ["latest-mac.yml", [names.zip, names.intelZip]],
      ["latest.yml", [names.exe]], ["latest-linux.yml", [names.appImage]],
    ]) {
      const files = targets.map((url) => ({ url, sha512: digest(bytes(url), "sha512", "base64"), size: bytes(url).length }));
      put(name, stringify({ version, files, path: files[0].url, sha512: files[0].sha512 }));
    }
    for (const [name, targets] of [
      ["SHA256SUMS-macos-arm64.txt", [names.dmg, names.zip]],
      ["SHA256SUMS-macos-x64.txt", [names.intelDmg, names.intelZip]],
      ["SHA256SUMS-windows-x64.txt", [names.exe]],
      ["SHA256SUMS-linux-x64.txt", [names.deb, names.appImage]],
    ]) put(name, targets.map((target) => `${digest(bytes(target))}  ${target}\n`).join(""));
    return prepareMirrorPayload({ assetsDir, version, sha, requireComplete: true, publishedAt });
  }

  function stage(prepared) {
    const candidate = join(root, ".incoming", `${run++}-1`);
    mkdirSync(candidate);
    // Mirror-files.txt is a local transfer instruction, never a served file.
    for (const name of prepared.mirrorFiles) copyFileSync(join(prepared.assetsDir, name), join(candidate, name));
    return candidate;
  }

  function promote(prepared, candidate = stage(prepared), manifestSha256 = prepared.manifestSha256) {
    const result = spawnSync("python3", [promoter,
      "--root", root, "--candidate", candidate, "--version", prepared.version,
      "--sha", prepared.sha, "--manifest-sha256", manifestSha256,
    ], { encoding: "utf8", timeout: 10000, env: { PATH: process.env.PATH ?? "", PYTHONDONTWRITEBYTECODE: "1" } });
    if (result.error) throw result.error;
    return result;
  }

  function succeeded(result) {
    expect(result.status, result.stderr || result.stdout).toBe(0);
    return JSON.parse(result.stdout);
  }

  async function get(name) {
    const response = await fetch(`${baseUrl}/${name}`, { signal: AbortSignal.timeout(3000) });
    expect(response.status, `GET ${name}`).toBe(200);
    return Buffer.from(await response.arrayBuffer());
  }

  async function verifyLive(prepared) {
    expect(JSON.parse((await get("latest.json")).toString())).toEqual(prepared.latest);
    for (const entry of prepared.manifest.files) {
      const actual = await get(entry.name);
      expect(actual.length, entry.name).toBe(entry.size);
      expect(digest(actual), entry.name).toBe(entry.sha256);
    }
    expect((await get("muster-cli.mjs")).toString()).toBe("unrelated owned CLI fixture\n");
  }

  it("promotes all four platform payloads through real aliases while preserving the root and unrelated CLI", async () => {
    const prepared = await payload();
    const inode = lstatSync(root).ino;
    const result = succeeded(promote(prepared));
    expect(result).toMatchObject({ status: "promoted", version: prepared.version, sha: prepared.sha });
    expect(lstatSync(root).ino).toBe(inode);
    expect(readlinkSync(join(root, ".current"))).toBe(result.generation);
    for (const name of ["latest.json", ...feeds, ...stableNames]) {
      expect(readlinkSync(join(root, name))).toBe(`.current/${name}`);
    }
    for (const name of prepared.files.filter((item) => item.startsWith(`Muster-${prepared.version}`))) {
      expect(lstatSync(join(root, name)).isFile(), name).toBe(true);
      expect(lstatSync(join(root, name)).isSymbolicLink(), name).toBe(false);
    }
    await verifyLive(prepared);
  });

  it("serves an upgraded release while cached old feeds still download their exact old versioned bytes", async () => {
    const old = await payload();
    succeeded(promote(old));
    const cachedFeeds = await Promise.all(feeds.map(async (name) => parse((await get(name)).toString())));
    const before = readlinkSync(join(root, ".current"));
    const next = await payload("1.10.6", "b".repeat(40));
    succeeded(promote(next));
    expect(readlinkSync(join(root, ".current"))).not.toBe(before);
    await verifyLive(next);
    for (const feed of cachedFeeds) {
      expect(feed.version).toBe(old.version);
      for (const entry of feed.files) {
        const actual = await get(entry.url);
        expect(actual.length).toBe(entry.size);
        expect(digest(actual, "sha512", "base64"), entry.url).toBe(entry.sha512);
      }
      expect(digest(await get(feed.path), "sha512", "base64")).toBe(feed.sha512);
    }
  });

  it("reprepares and promotes identical release bytes without changing the live generation", async () => {
    const prepared = await payload();
    succeeded(promote(prepared));
    const current = readlinkSync(join(root, ".current"));
    const generations = readdirSync(join(root, ".generations")).sort();
    const manifestBytes = readFileSync(join(prepared.assetsDir, "mirror-manifest.json"));
    const again = await prepareMirrorPayload({
      assetsDir: prepared.assetsDir, version: prepared.version, sha: prepared.sha,
      requireComplete: true, publishedAt,
    });
    expect(readFileSync(join(prepared.assetsDir, "mirror-manifest.json"))).toEqual(manifestBytes);
    expect(again.manifestSha256).toBe(prepared.manifestSha256);
    expect(succeeded(promote(again))).toMatchObject({ status: "unchanged", generation: current });
    expect(readlinkSync(join(root, ".current"))).toBe(current);
    expect(readdirSync(join(root, ".generations")).sort()).toEqual(generations);
    await verifyLive(prepared);
  });

  it.each(["corrupted installer", "malformed manifest", "extra unlisted file", "wrong manifest digest"])(
    "refuses %s without changing any live release bytes",
    async (fault) => {
      const old = await payload();
      succeeded(promote(old));
      const current = readlinkSync(join(root, ".current"));
      const rootEntries = readdirSync(root).sort();
      const next = await payload("1.10.6", "b".repeat(40));
      const candidate = stage(next);
      let manifestSha256 = next.manifestSha256;
      if (fault === "corrupted installer") writeFileSync(join(candidate, "Muster-setup.exe"), "corrupted download\n");
      if (fault === "extra unlisted file") writeFileSync(join(candidate, "unlisted.txt"), "unexpected bytes\n");
      if (fault === "wrong manifest digest") manifestSha256 = "0".repeat(64);
      if (fault === "malformed manifest") {
        const malformed = JSON.stringify({ ...next.manifest, files: "not a file catalogue" });
        writeFileSync(join(candidate, "mirror-manifest.json"), malformed);
        // Bind the malformed bytes correctly so this tests schema rejection.
        manifestSha256 = digest(malformed);
      }
      const rejected = promote(next, candidate, manifestSha256);
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr.trim()).not.toBe("");
      expect(readlinkSync(join(root, ".current"))).toBe(current);
      expect(readdirSync(root).sort()).toEqual(rootEntries);
      await verifyLive(old);
    },
  );
});
