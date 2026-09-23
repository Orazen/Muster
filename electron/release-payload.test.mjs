// Owned byte fixtures exercise release metadata; no installers are executed.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stringify } from "yaml";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareMirrorPayload, runReleasePayload, validateReleasePayload } from "../scripts/release-payload.mjs";

const version = "1.10.5", sha = "a".repeat(40);
const publishedAt = "2026-09-11T00:00:00Z";
let scratch, assetsDir;
beforeEach(() => { scratch = mkdtempSync(join(tmpdir(), "muster-release-payload-")); assetsDir = join(scratch, "assets"); mkdirSync(assetsDir); });
afterEach(() => { rmSync(scratch, { recursive: true, force: true }); });
const options = (requireComplete = true) => ({ assetsDir, version, sha, requireComplete, publishedAt });
const hash = (bytes, algorithm = "sha512", format = "base64") => createHash(algorithm).update(bytes).digest(format);
const put = (name, contents = `owned release bytes: ${name}`) => { writeFileSync(join(assetsDir, name), contents); return contents; };
const bytes = (name) => readFileSync(join(assetsDir, name));
const remove = (name) => rmSync(join(assetsDir, name));
function feed(name, names, overrides = {}) {
  const files = names.map((url) => ({ url, sha512: hash(bytes(url)), size: bytes(url).length }));
  const doc = { version, files, path: files[0]?.url, sha512: files[0]?.sha512, ...overrides };
  put(name, stringify(doc)); return doc;
}
function checksums(name, names) {
  put(name, names.map((item) => `${hash(bytes(item), "sha256", "hex")}  ${item}`).join("\n") + "\n");
}
// electron-builder's blockmap: gzip JSON whose outermost file entry carries
// chunk sizes summing to the paired binary's byte length.
const putBlockmap = (name, binaryName) => {
  const total = bytes(binaryName).length;
  const chunk = 64 * 1024;
  const sizes = Array.from({ length: Math.ceil(total / chunk) }, (_, index) => Math.min(chunk, total - index * chunk));
  const contents = gzipSync(JSON.stringify({ version: "2", files: [{ name: "file", offset: 0, checksums: sizes.map(() => "x".repeat(68)), sizes }] }));
  return put(name, contents);
};
function complete(intel = false, archNames = ["amd64", "x86_64"]) {
  const dmg = `Muster-${version}.dmg`, zip = `Muster-${version}-arm64.zip`, exe = `Muster-${version}-setup.exe`;
  const deb = `Muster-${version}-${archNames[0]}.deb`, appimage = `Muster-${version}-${archNames[1]}.AppImage`;
  for (const name of [dmg, zip, exe, deb, appimage]) put(name);
  for (const [stable, target] of [["Muster.dmg", dmg], ["Muster-setup.exe", exe], ["Muster.deb", deb], ["Muster.AppImage", appimage]]) put(stable, bytes(target));
  feed("latest-mac.yml", [zip]); feed("latest.yml", [exe]); feed("latest-linux.yml", [appimage]);
  checksums("SHA256SUMS-macos-arm64.txt", [dmg, zip, "Muster.dmg"]);
  checksums("SHA256SUMS-linux-x64.txt", [deb, appimage, "Muster.deb", "Muster.AppImage"]);
  const cli = `Muster-${version}-cli.mjs`;
  put(cli); put("muster-cli.mjs", bytes(cli));
  checksums("SHA256SUMS-cli.txt", [cli, "muster-cli.mjs"]);
  if (intel) {
    const intelDmg = `Muster-${version}-intel.dmg`, intelZip = `Muster-${version}-x64.zip`;
    put(intelDmg); put(intelZip); put("Muster-intel.dmg", bytes(intelDmg));
    checksums("SHA256SUMS-macos-x64.txt", [intelDmg, intelZip, "Muster-intel.dmg"]);
  }
  return { dmg, zip, exe, deb, appimage, cli };
}
function partial() { const zip = `Muster-${version}-arm64.zip`; put(zip); feed("latest-mac.yml", [zip]); return zip; }

describe("release payload validation", () => {
  it("validates a real-builder-shaped complete set without Intel or writing outputs", async () => {
    const { exe, appimage } = complete(); const before = readdirSync(assetsDir).sort();
    const result = await validateReleasePayload(options());
    expect(result.feeds).toHaveLength(3); expect(result.stableFiles).toHaveLength(5);
    expect(result.files).toEqual(expect.arrayContaining([exe, appimage, "Muster.deb"]));
    expect(result.files.some((name) => name.includes("intel"))).toBe(false);
    expect(readdirSync(assetsDir).sort()).toEqual(before);
  });

  it("supports explicit x64 Linux artifact names as well as builder's Debian/AppImage arch labels", async () => {
    complete(false, ["x64", "x64"]);
    await expect(validateReleasePayload(options())).resolves.toMatchObject({ stableFiles: expect.arrayContaining(["Muster.deb", "Muster.AppImage"]) });
  });

  it("allows a partial release with one valid feed only when complete is false", async () => {
    partial();
    await expect(validateReleasePayload(options(false))).resolves.toMatchObject({ feeds: ["latest-mac.yml"], stableFiles: [] });
    await expect(validateReleasePayload(options())).rejects.toThrow(/Missing stable/);
  });

  it("refuses zero feeds, including an otherwise nonempty artifact directory", async () => {
    put(`Muster-${version}-arm64.zip`);
    await expect(validateReleasePayload(options(false))).rejects.toThrow(/At least one/);
  });

  it.each(["", "files: []\n", "version: [broken\n", "version: 1.10.5\nversion: 1.10.4\nfiles: []\n", "!!js/function function() {}\n"])("rejects an empty or malformed feed (%s)", async (text) => {
    put("latest-mac.yml", text);
    await expect(validateReleasePayload(options(false))).rejects.toThrow();
  });

  it("rejects YAML aliases without expanding them", async () => {
    const zip = partial();
    put("latest-mac.yml", `version: ${version}\nfiles:\n  - &entry\n    url: ${zip}\n    sha512: ${hash(bytes(zip))}\n    size: ${bytes(zip).length}\n  - *entry\n`);
    await expect(validateReleasePayload(options(false))).rejects.toThrow(/aliases/);
  });

  it.each([undefined, [], [{ url: "missing.zip", size: 1, sha512: "bad" }]])("rejects missing/empty/invalid files entries (%j)", async (files) => {
    put("latest-mac.yml", stringify({ version, files }));
    await expect(validateReleasePayload(options(false))).rejects.toThrow(/Malformed update feed/);
  });

  it.each([0, -1, Infinity, NaN, 1.5, "5"])("rejects nonpositive, nonfinite or nonnumeric size (%s)", async (size) => {
    const zip = partial(); feed("latest-mac.yml", [zip], { files: [{ url: zip, sha512: hash(bytes(zip)), size }] });
    await expect(validateReleasePayload(options(false))).rejects.toThrow(/Malformed update feed/);
  });

  it("rejects a valid-length sha512 hash that describes different bytes", async () => {
    const zip = partial(); const entry = { url: zip, sha512: hash("different"), size: bytes(zip).length };
    feed("latest-mac.yml", [zip], { files: [entry], sha512: entry.sha512 });
    await expect(validateReleasePayload(options(false))).rejects.toThrow(/Feed bytes mismatch/);
  });

  it("rejects a byte size mismatch even when the hash is correct", async () => {
    const zip = partial(); feed("latest-mac.yml", [zip], { files: [{ url: zip, sha512: hash(bytes(zip)), size: bytes(zip).length + 1 }] });
    await expect(validateReleasePayload(options(false))).rejects.toThrow(/Feed bytes mismatch/);
  });

  it("rejects a feed's version mismatch", async () => {
    const zip = partial(); feed("latest-mac.yml", [zip], { version: "1.10.4" });
    await expect(validateReleasePayload(options(false))).rejects.toThrow(/Version mismatch/);
  });

  it("rejects stale unreferenced artifacts left in the download directory", async () => {
    partial(); put("Muster-1.10.4-arm64.zip");
    await expect(validateReleasePayload(options(false))).rejects.toThrow(/Stale/);
  });

  it("accepts the main DMG's blockmap companion as a versioned asset", async () => {
    // electron-builder uploads Muster-<version>.dmg.blockmap beside the dmg;
    // the allowlist once missed it and the first complete CI release failed
    // publish with "Stale or unexpected versioned asset".
    const { dmg } = complete();
    putBlockmap(`${dmg}.blockmap`, dmg);
    await expect(validateReleasePayload(options(false))).resolves.toBeTruthy();
  });

  it.each(["../outside.zip", "/tmp/outside.zip", "folder/item.zip", "folder\\item.zip", "https://example.test/item.zip", "%2e%2e%2foutside.zip", "file.zip\nother.zip"])("rejects uncontained or non-flat feed URL %s", async (url) => {
    const zip = partial(); feed("latest-mac.yml", [zip], { files: [{ url, sha512: hash(bytes(zip)), size: bytes(zip).length }] });
    await expect(validateReleasePayload(options(false))).rejects.toThrow(/Malformed update feed/);
  });

  it("rejects duplicate feed entries", async () => {
    const zip = partial(); feed("latest-mac.yml", [zip, zip]);
    await expect(validateReleasePayload(options(false))).rejects.toThrow(/Duplicate feed asset/);
  });

  it("rejects inconsistent legacy path/hash fields used by older updaters", async () => {
    const zip = partial(); feed("latest-mac.yml", [zip], { path: "other.zip" });
    await expect(validateReleasePayload(options(false))).rejects.toThrow(/Legacy feed/);
  });

  it("rejects absent referenced bytes", async () => {
    const zip = partial(); remove(zip);
    await expect(validateReleasePayload(options(false))).rejects.toThrow(/Missing release asset/);
  });

  it.each(["symlink", "hardlink", "directory"])("rejects %s assets even with otherwise matching bytes", async (kind) => {
    const zip = partial(); const outside = join(scratch, "outside.zip"); writeFileSync(outside, bytes(zip)); remove(zip);
    if (kind === "symlink") symlinkSync(outside, join(assetsDir, zip));
    if (kind === "hardlink") linkSync(outside, join(assetsDir, zip));
    if (kind === "directory") mkdirSync(join(assetsDir, zip));
    await expect(validateReleasePayload(options(false))).rejects.toThrow(/regular file/);
  });

  it("rejects a linked asset directory", async () => {
    partial(); const linked = join(scratch, "linked"); symlinkSync(assetsDir, linked, "junction");
    await expect(validateReleasePayload({ ...options(false), assetsDir: linked })).rejects.toThrow(/real directory/);
  });

  it("requires every platform feed for a complete set", async () => {
    complete(); remove("latest.yml");
    await expect(validateReleasePayload(options())).rejects.toThrow();
  });

  it("requires the Mac arm64 update ZIP even if a DMG feed is valid", async () => {
    const { dmg } = complete(); feed("latest-mac.yml", [dmg]);
    await expect(validateReleasePayload(options())).rejects.toThrow(/platform update target/);
  });

  it("rejects a stale stable alias even when all feed hashes are correct", async () => {
    complete(); put("Muster-setup.exe", "old installer");
    await expect(validateReleasePayload(options())).rejects.toThrow(/Stable alias bytes mismatch/);
  });

  it("requires a checked versioned target for the unreferenced Mac DMG", async () => {
    complete(); remove("SHA256SUMS-macos-arm64.txt");
    await expect(validateReleasePayload(options())).rejects.toThrow(/verified target/);
  });

  it("rejects incorrect checksums for assets omitted from updater feeds", async () => {
    const { dmg } = complete(); put(dmg, "corrupt DMG");
    await expect(validateReleasePayload(options())).rejects.toThrow(/Checksum bytes mismatch/);
  });

  it.each(["malformed", "duplicate", "traversal"])("rejects %s checksum records", async (kind) => {
    const { dmg } = complete(); const record = `${hash(bytes(dmg), "sha256", "hex")}  ${dmg}\n`;
    put("SHA256SUMS-macos-arm64.txt", kind === "duplicate" ? record + record : kind === "traversal" ? record.replace(dmg, "../outside") : "nonsense\n");
    await expect(validateReleasePayload(options())).rejects.toThrow(/Malformed or duplicate checksum/);
  });

  it("accepts complete Intel assets verified by their platform checksums", async () => {
    complete(true); const result = await validateReleasePayload(options());
    expect(result.files).toEqual(expect.arrayContaining(["Muster-intel.dmg", `Muster-${version}-intel.dmg`, `Muster-${version}-x64.zip`]));
  });

  it.each(["Muster-intel.dmg", `Muster-${version}-intel.dmg`, `Muster-${version}-x64.zip`, "SHA256SUMS-macos-x64.txt"])("rejects an incomplete optional Intel set missing %s", async (name) => {
    complete(true); remove(name);
    await expect(validateReleasePayload(options())).rejects.toThrow();
  });

  it("refuses an Intel ZIP omitted from otherwise valid Intel checksums", async () => {
    complete(true); checksums("SHA256SUMS-macos-x64.txt", [`Muster-${version}-intel.dmg`, "Muster-intel.dmg"]);
    await expect(validateReleasePayload(options())).rejects.toThrow(/Optional Intel release/);
  });

  it.each(["muster-cli.mjs", `Muster-${version}-cli.mjs`, "SHA256SUMS-cli.txt"])("refuses a complete release missing CLI artifact %s", async (name) => {
    complete(); remove(name);
    await expect(validateReleasePayload(options())).rejects.toThrow();
  });

  it("refuses a platform-complete legacy payload without a verified CLI", async () => {
    const { cli } = complete();
    for (const name of [cli, "muster-cli.mjs", "SHA256SUMS-cli.txt"]) remove(name);
    await expect(validateReleasePayload(options())).rejects.toThrow(/CLI release needs/);
    await expect(validateReleasePayload(options(false))).resolves.toMatchObject({ stableFiles: expect.not.arrayContaining(["muster-cli.mjs"]) });
  });

  it.each(["muster-cli.mjs", `Muster-${version}-cli.mjs`, "SHA256SUMS-cli.txt"])("rejects incomplete CLI %s even in a partial release", async (name) => {
    partial();
    put(name, name.endsWith(".txt") ? `${hash("absent", "sha256", "hex")}  muster-cli.mjs\n` : "partial CLI");
    await expect(validateReleasePayload(options(false))).rejects.toThrow();
  });

  it("refuses individually checksummed CLI aliases containing different bytes", async () => {
    const { cli } = complete();
    put("muster-cli.mjs", "old but individually checksummed CLI");
    checksums("SHA256SUMS-cli.txt", [cli, "muster-cli.mjs"]);
    await expect(validateReleasePayload(options())).rejects.toThrow(/Stable alias bytes mismatch/);
  });

  it("does not accept CLI hashes hidden in another platform's checksums", async () => {
    const { cli, dmg, zip } = complete();
    remove("SHA256SUMS-cli.txt");
    checksums("SHA256SUMS-macos-arm64.txt", [dmg, zip, "Muster.dmg", cli, "muster-cli.mjs"]);
    await expect(validateReleasePayload(options())).rejects.toThrow(/CLI release needs/);
  });

  it("rejects unrelated entries in the dedicated CLI checksum file", async () => {
    const { cli, zip } = complete();
    checksums("SHA256SUMS-cli.txt", [cli, "muster-cli.mjs", zip]);
    await expect(validateReleasePayload(options())).rejects.toThrow(/CLI release needs/);
  });

  it("selects both CLI files and binds the stable CLI into latest metadata and the transport manifest", async () => {
    const { cli } = complete();
    const result = await prepareMirrorPayload(options());
    expect(result.files).toEqual(expect.arrayContaining([cli, "muster-cli.mjs"]));
    expect(result.mirrorFiles).not.toContain("SHA256SUMS-cli.txt");
    const expected = { size: bytes(cli).length, sha256: hash(bytes(cli), "sha256", "hex") };
    expect(result.latest.files["muster-cli.mjs"]).toEqual(expected);
    expect(result.latest.checksums["muster-cli.mjs"]).toBe(expected.sha256);
    expect(result.manifest.files.filter((entry) => [cli, "muster-cli.mjs"].includes(entry.name)))
      .toEqual([cli, "muster-cli.mjs"].sort().map((name) => ({ name, ...expected })));
  });
});

describe("release mirror and CLI", () => {
  it.each([
    ["latest.json", "feed"], ["mirror-files.txt", "feed"],
    ["latest.json", "checksum"], ["mirror-files.txt", "checksum"],
    ["mirror-manifest.json", "feed"], ["mirror-manifest.json", "checksum"],
  ])("refuses generated %s in a %s before replacing its verified bytes", async (name, kind) => {
    const { zip, dmg } = complete();
    put(name, "existing verification output");
    const before = bytes(name);
    if (kind === "feed") feed("latest-mac.yml", [zip, name]);
    else checksums("SHA256SUMS-macos-arm64.txt", [dmg, zip, "Muster.dmg", name]);
    await expect(prepareMirrorPayload(options())).rejects.toThrow(/Generated mirror output cannot be a release reference/);
    expect(bytes(name)).toEqual(before);
    expect(existsSync(join(assetsDir, name === "latest.json" ? "mirror-files.txt" : "latest.json"))).toBe(false);
  });

  it("generates the current latest.json schema and exact mirror list, including versioned non-Mac feed targets", async () => {
    const { exe, appimage, deb, dmg } = complete();
    put("ignored-not-for-mirror.txt", "not selected");
    const result = await prepareMirrorPayload(options());
    const latest = JSON.parse(bytes("latest.json"));
    expect(Object.keys(latest)).toEqual(["version", "sha", "published", "files", "checksums"]);
    expect(latest).toMatchObject({ version, sha, published: publishedAt });
    expect(latest.files["Muster.dmg"]).toEqual({ size: bytes(dmg).length, sha256: hash(bytes(dmg), "sha256", "hex") });
    expect(latest.checksums["Muster.dmg"]).toBe(latest.files["Muster.dmg"].sha256);
    const lines = bytes("mirror-files.txt").toString().trimEnd().split("\n");
    expect(lines).toEqual(result.mirrorFiles);
    expect(lines).toEqual(expect.arrayContaining([exe, appimage, deb, "latest.json", "latest.yml", "latest-linux.yml", "mirror-manifest.json"]));
    expect(lines).not.toContain("Muster-intel.dmg"); expect(lines).not.toContain("mirror-files.txt"); expect(lines).not.toContain("ignored-not-for-mirror.txt");
    expect(new Set(lines).size).toBe(lines.length);
    for (const name of lines) expect(existsSync(join(assetsDir, name))).toBe(true);
    const manifestText = bytes("mirror-manifest.json");
    const manifest = JSON.parse(manifestText);
    expect(manifest).toMatchObject({ schemaVersion: 1, version, sha });
    expect(result.manifestSha256).toBe(hash(manifestText, "sha256", "hex"));
    expect(manifest.files.map((entry) => entry.name)).toEqual(lines.filter((name) => name !== "mirror-manifest.json"));
    for (const entry of manifest.files) {
      expect(entry).toEqual({ name: entry.name, size: bytes(entry.name).length, sha256: hash(bytes(entry.name), "sha256", "hex") });
    }
    // A second local invocation can replace its own previous regular outputs.
    await expect(prepareMirrorPayload(options())).resolves.toMatchObject({ mirrorFiles: lines });
    expect(bytes("mirror-manifest.json")).toEqual(manifestText);
  });

  it("includes optional Intel only when the entire checked pair exists", async () => {
    complete(true); const result = await prepareMirrorPayload(options());
    expect(result.latest.files["Muster-intel.dmg"]).toBeDefined();
    expect(result.mirrorFiles).toContain(`Muster-${version}-x64.zip`);
  });

  it("mirrors verified blockmaps riding alongside selected binaries", async () => {
    const { dmg, zip, exe } = complete(true);
    // electron-builder's actual emission: the main DMG's blockmap plus a blockmap
    // beside every Windows exe and each mac zip. Linux ships none.
    putBlockmap(`${dmg}.blockmap`, dmg); putBlockmap(`${zip}.blockmap`, zip); putBlockmap(`${exe}.blockmap`, exe);
    checksums("SHA256SUMS-macos-arm64.txt", [dmg, zip, "Muster.dmg", `${dmg}.blockmap`, `${zip}.blockmap`]);
    checksums("SHA256SUMS-macos-x64.txt", [`Muster-${version}-intel.dmg`, `Muster-${version}-x64.zip`, "Muster-intel.dmg"]);
    checksums("SHA256SUMS-windows-x64.txt", [exe, `${exe}.blockmap`]);
    const result = await prepareMirrorPayload(options());
    for (const name of [`${dmg}.blockmap`, `${zip}.blockmap`, `${exe}.blockmap`]) {
      expect(result.mirrorFiles).toContain(name);
      expect(result.hashes[name]).toEqual({ size: bytes(name).length, sha256: hash(bytes(name), "sha256", "hex"), sha512: hash(bytes(name), "sha512") });
    }
    expect(result.mirrorFiles).toEqual(expect.arrayContaining([dmg, zip, exe, `${dmg}.blockmap`]));
    // latest.json stays installer-only: differential downloads fetch blockmaps by
    // convention, so the manifest contract is unchanged.
    expect(Object.keys(result.latest.files)).not.toContain(`${dmg}.blockmap`);
  });

  it("refuses a blockmap whose chunk total no longer matches its binary (stale pairing)", async () => {
    // electron-builder emits the DMG blockmap before stapler rewrites the
    // koly trailer, so a blockmap can describe bytes that no longer exist.
    // The differ would abort on its size assertion and fall back to a full
    // download every time, so the pair must fail validation, not the delta.
    const { zip } = complete(true);
    const stale = putBlockmap(`${zip}.blockmap`, zip);
    appendFileSync(join(assetsDir, zip), Buffer.alloc(2048, 0)); // binary grows after the blockmap was cut
    checksums("SHA256SUMS-macos-arm64.txt", [`Muster-${version}.dmg`, zip, "Muster.dmg", `${zip}.blockmap`]);
    feed("latest-mac.yml", [zip]);
    await expect(prepareMirrorPayload(options())).rejects.toThrow(/Stale blockmap/);
    expect(stale).toBeTruthy();
  });

  it("refuses to mirror a blockmap whose bytes no checksum file covers", async () => {
    const { dmg } = complete(true);
    put(`${dmg}.blockmap`, "tampered-or-unknown-provenance bytes");
    await expect(prepareMirrorPayload(options())).rejects.toThrow(/Unverified blockmap cannot be mirrored/);
  });

  it("accepts a complete payload with no blockmaps at all", async () => {
    complete(); const result = await prepareMirrorPayload(options());
    expect(result.mirrorFiles.some((name) => name.endsWith(".blockmap"))).toBe(false);
  });

  it("refuses partial mirror mode before producing output", async () => {
    partial(); await expect(prepareMirrorPayload(options(false))).rejects.toThrow(/REQUIRE_COMPLETE=true/);
    expect(existsSync(join(assetsDir, "latest.json"))).toBe(false);
  });

  it("refuses prerelease versions on the stable mirror", async () => {
    await expect(prepareMirrorPayload({ ...options(), version: "1.10.5-beta.1" })).rejects.toThrow(/prerelease/);
    expect(readdirSync(assetsDir)).toEqual([]);
  });

  it.each([undefined, "", "invalid", "2026-09-11", "2026-09-11T25:00:00Z"])("refuses missing or invalid publication time (%s) before output", async (time) => {
    await expect(prepareMirrorPayload({ ...options(), publishedAt: time })).rejects.toThrow(/publishedAt/);
    expect(readdirSync(assetsDir)).toEqual([]);
  });

  it.each(["latest.yml", "latest-mac.yml", "latest-linux.yml"])("rejects a mutable extra updater target in %s before mirror output", async (name) => {
    const { exe, zip, appimage } = complete();
    const target = name === "latest.yml" ? exe : name === "latest-mac.yml" ? zip : appimage;
    feed(name, [target, "Muster.dmg"]);
    await expect(prepareMirrorPayload(options())).rejects.toThrow(/immutable versioned filename/);
    expect(existsSync(join(assetsDir, "mirror-manifest.json"))).toBe(false);
  });

  it("rejects a linked transport manifest without altering its target", async () => {
    complete(); const outside = join(scratch, "manifest-sentinel"); writeFileSync(outside, "unchanged");
    symlinkSync(outside, join(assetsDir, "mirror-manifest.json"));
    await expect(prepareMirrorPayload(options())).rejects.toThrow(/regular file/);
    expect(readFileSync(outside, "utf8")).toBe("unchanged");
  });

  it("rejects a versioned but unsupported updater target before transfer", async () => {
    const { zip } = complete(); const extra = `Muster-${version}-notes.txt`; put(extra);
    feed("latest-mac.yml", [zip, extra]);
    await expect(prepareMirrorPayload(options())).rejects.toThrow(/immutable versioned filename/);
    expect(existsSync(join(assetsDir, "mirror-manifest.json"))).toBe(false);
  });

  it("requires the canonical source SHA used by the remote promoter", async () => {
    await expect(prepareMirrorPayload({ ...options(), sha: sha.toUpperCase() })).rejects.toThrow(/canonical lowercase/);
    expect(readdirSync(assetsDir)).toEqual([]);
  });

  it("does not follow a symlink when replacing an existing mirror output", async () => {
    complete(); const outside = join(scratch, "sentinel"); writeFileSync(outside, "unchanged"); symlinkSync(outside, join(assetsDir, "latest.json"));
    await expect(prepareMirrorPayload(options())).rejects.toThrow(/regular file/);
    expect(readFileSync(outside, "utf8")).toBe("unchanged");
  });

  it.each([undefined, "", "TRUE", "1", false])("requires an explicit strict environment boolean (%s)", async (value) => {
    await expect(runReleasePayload("validate", { RELEASE_VERSION: version, RELEASE_SHA: sha, ASSETS_DIR: assetsDir, REQUIRE_COMPLETE: value })).rejects.toThrow(/exactly true or false/);
  });

  it.each([{ version: undefined }, { version: "v1.10.5" }, { sha: "short" }, { sha: undefined }, { requireComplete: "false" }])("rejects missing or malformed release inputs %j", async (overrides) => {
    await expect(validateReleasePayload({ ...options(), ...overrides })).rejects.toThrow(/required/);
  });

  it("runs the actual CLI with explicit environment and emits bounded JSON", () => {
    partial();
    const output = execFileSync(process.execPath, [resolve("scripts/release-payload.mjs"), "validate"], {
      env: { ...process.env, RELEASE_VERSION: version, RELEASE_SHA: sha, ASSETS_DIR: assetsDir, REQUIRE_COMPLETE: "false" }, encoding: "utf8",
    });
    expect(JSON.parse(output)).toEqual({ version, feeds: 1, files: 2 });
  });

  it("rejects unsupported commands without writing output", async () => {
    await expect(runReleasePayload("upload", { REQUIRE_COMPLETE: "false" })).rejects.toThrow(/Usage/);
    expect(readdirSync(assetsDir)).toEqual([]);
  });
});
