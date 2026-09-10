// Synthetic ZIP/DMG bytes only; no stapler, installer or remote is invoked.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { refreshMacFeed } from "../scripts/refresh-mac-feed.mjs";

const version = "1.10.5", zipName = `Muster-${version}-arm64.zip`, dmgName = `Muster-${version}.dmg`;
let scratch, assetsDir, feedPath;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "muster-refresh-mac-feed-"));
  assetsDir = join(scratch, "release"); mkdirSync(assetsDir); feedPath = join(assetsDir, "latest-mac.yml");
});
afterEach(() => { rmSync(scratch, { recursive: true, force: true }); });
const options = () => ({ assetsDir, version, allowDmgChange: true });
const sha512 = (bytes) => createHash("sha512").update(bytes).digest("base64");
const put = (name, contents) => writeFileSync(join(assetsDir, name), contents);
const bytes = (name) => readFileSync(join(assetsDir, name));
function fixture({ dmg = true, legacy = "zip", legacySize = false } = {}) {
  put(zipName, Buffer.from("owned ZIP bytes that stapling must never change\0\xff"));
  put(dmgName, "owned original DMG bytes");
  const entry = (url) => ({ url, sha512: sha512(bytes(url)), size: bytes(url).length, customFileMetadata: { retained: true } });
  const files = dmg ? [entry(zipName), entry(dmgName)] : [entry(zipName)];
  const doc = { version, files, releaseDate: "2026-09-10T21:00:00.000Z", releaseNotes: "First line\nSecond line\n", extra: { nested: ["keep", 7], boolean: false } };
  if (legacy !== "none") {
    const selected = files[legacy === "dmg" ? 1 : 0];
    doc.path = selected.url; doc.sha512 = selected.sha512;
    if (legacySize) doc.size = selected.size;
  }
  put("latest-mac.yml", "# preserve this release comment\n" + stringify(doc));
  return doc;
}
async function rejectedUnchanged(pattern = undefined) {
  const before = readFileSync(feedPath);
  await expect(refreshMacFeed(options())).rejects.toThrow(pattern);
  expect(readFileSync(feedPath)).toEqual(before);
  expect(readdirSync(assetsDir).some((name) => name.startsWith(".latest-mac-"))).toBe(false);
}

describe("post-staple Mac feed refresh", () => {
  it("refreshes only the DMG bytes atomically while preserving ZIP, URLs and other metadata", async () => {
    const original = fixture({ legacySize: true });
    const originalZip = bytes(zipName), zipStat = lstatSync(join(assetsDir, zipName));
    const feedStat = lstatSync(feedPath); chmodSync(feedPath, 0o640);
    put(dmgName, Buffer.concat([bytes(dmgName), Buffer.from("\nsynthetic stapled ticket")]));
    const result = await refreshMacFeed(options());
    const after = parse(readFileSync(feedPath, "utf8"));
    expect(result).toEqual({ version, changed: true, updated: [dmgName] });
    expect(after).toEqual({ ...original, files: [original.files[0], { ...original.files[1], size: bytes(dmgName).length, sha512: sha512(bytes(dmgName)) }] });
    expect(readFileSync(feedPath, "utf8")).toContain("# preserve this release comment");
    expect(bytes(zipName)).toEqual(originalZip);
    expect(lstatSync(join(assetsDir, zipName)).mtimeMs).toBe(zipStat.mtimeMs);
    expect(lstatSync(feedPath).ino).not.toBe(feedStat.ino);
    expect(lstatSync(feedPath).mode & 0o777).toBe(0o640);
    expect(readdirSync(assetsDir).sort()).toEqual([dmgName, zipName, "latest-mac.yml"].sort());
  });

  it("updates matching legacy DMG path/hash/size fields", async () => {
    const original = fixture({ legacy: "dmg", legacySize: true }); put(dmgName, "synthetic stapled DMG bytes, longer than before");
    await refreshMacFeed(options());
    const after = parse(readFileSync(feedPath, "utf8"));
    expect(after.path).toBe(original.path); expect(after.sha512).toBe(sha512(bytes(dmgName))); expect(after.size).toBe(bytes(dmgName).length);
    expect(after.files[0]).toEqual(original.files[0]);
  });

  it("preserves an absent legacy size field and supports a feed without legacy fields", async () => {
    fixture({ legacy: "none" }); put(dmgName, "synthetic stapled DMG");
    await refreshMacFeed(options());
    const after = parse(readFileSync(feedPath, "utf8"));
    expect(after.path).toBeUndefined(); expect(after.sha512).toBeUndefined(); expect(after.size).toBeUndefined();
  });

  it.each([{ dmg: true }, { dmg: false }])("does not rewrite an already-current or ZIP-only feed (%j)", async (settings) => {
    fixture(settings); const before = readFileSync(feedPath), stat = lstatSync(feedPath);
    if (!settings.dmg) put(dmgName, "unreferenced DMG changes are irrelevant to this feed");
    expect(await refreshMacFeed(options())).toEqual({ version, changed: false, updated: [] });
    expect(readFileSync(feedPath)).toEqual(before); expect(lstatSync(feedPath).ino).toBe(stat.ino); expect(lstatSync(feedPath).mtimeMs).toBe(stat.mtimeMs);
  });

  it("is a no-op after a successful refresh is repeated", async () => {
    fixture(); put(dmgName, "synthetic stapled DMG"); await refreshMacFeed(options());
    const before = readFileSync(feedPath), stat = lstatSync(feedPath);
    expect(await refreshMacFeed(options())).toMatchObject({ changed: false });
    expect(readFileSync(feedPath)).toEqual(before); expect(lstatSync(feedPath).ino).toBe(stat.ino);
  });

  it("refuses changed DMG bytes when notarization was skipped", async () => {
    fixture(); put(dmgName, "DMG changed without notarization");
    const before = readFileSync(feedPath);
    await expect(refreshMacFeed({ ...options(), allowDmgChange: false })).rejects.toThrow(/without successful notarization/);
    expect(readFileSync(feedPath)).toEqual(before);
    expect(readdirSync(assetsDir).some((name) => name.startsWith(".latest-mac-"))).toBe(false);
  });

  it.each([{ dmg: true }, { dmg: false }])("validates unchanged unsigned or ZIP-only feeds without rewrite (%j)", async (settings) => {
    fixture(settings); const before = readFileSync(feedPath), stat = lstatSync(feedPath);
    await expect(refreshMacFeed({ ...options(), allowDmgChange: false })).resolves.toMatchObject({ changed: false });
    expect(readFileSync(feedPath)).toEqual(before); expect(lstatSync(feedPath).ino).toBe(stat.ino);
  });

  it.each([undefined, "false", "true", 0, 1])("requires an explicit boolean function authorization (%s)", async (allowDmgChange) => {
    fixture(); put(dmgName, "changed"); const before = readFileSync(feedPath);
    await expect(refreshMacFeed({ ...options(), allowDmgChange })).rejects.toThrow(/boolean allowDmgChange/);
    expect(readFileSync(feedPath)).toEqual(before);
  });

  it.each(["same size", "different size"])("rejects a changed ZIP (%s), leaving the feed untouched", async (kind) => {
    fixture(); const zip = bytes(zipName);
    put(zipName, kind === "same size" ? Buffer.alloc(zip.length, 88) : Buffer.concat([zip, Buffer.from("changed")]));
    put(dmgName, "synthetic stapled DMG");
    await rejectedUnchanged(/ZIP bytes changed/);
  });

  it("still verifies ZIP immutability when the feed has no DMG", async () => {
    fixture({ dmg: false }); put(zipName, "changed"); await rejectedUnchanged(/ZIP bytes changed/);
  });

  it.each([zipName, dmgName])("rejects missing target %s without changing the feed", async (name) => {
    fixture(); rmSync(join(assetsDir, name)); await rejectedUnchanged();
  });

  it.each([zipName, dmgName])("rejects an empty target %s without changing the feed", async (name) => {
    fixture(); put(name, ""); await rejectedUnchanged(/nonempty regular file/);
  });

  it.each(["symlink", "hardlink", "directory"])("rejects a %s target without touching its source", async (kind) => {
    fixture(); const outside = join(scratch, "outside.dmg"); writeFileSync(outside, bytes(dmgName)); rmSync(join(assetsDir, dmgName));
    if (kind === "symlink") symlinkSync(outside, join(assetsDir, dmgName));
    if (kind === "hardlink") linkSync(outside, join(assetsDir, dmgName));
    if (kind === "directory") mkdirSync(join(assetsDir, dmgName));
    const before = readFileSync(outside); await rejectedUnchanged(/nonempty regular file/); expect(readFileSync(outside)).toEqual(before);
  });

  it.each(["symlink", "hardlink"])("rejects a linked feed (%s) without redirecting output", async (kind) => {
    fixture(); const outside = join(scratch, "outside.yml"); writeFileSync(outside, readFileSync(feedPath)); rmSync(feedPath);
    if (kind === "symlink") symlinkSync(outside, feedPath); else linkSync(outside, feedPath);
    put(dmgName, "synthetic stapled DMG"); const before = readFileSync(outside);
    await rejectedUnchanged(/nonempty regular file/); expect(readFileSync(outside)).toEqual(before);
  });

  it("rejects a linked assets directory", async () => {
    fixture(); const linked = join(scratch, "linked"); symlinkSync(assetsDir, linked, "junction");
    await expect(refreshMacFeed({ ...options(), assetsDir: linked })).rejects.toThrow(/real directory/);
  });

  it.each(["", "files: []\n", "version: [invalid\n", "version: 1.10.5\nversion: 1.10.4\nfiles: []\n", "!!js/function function() {}\n"])("refuses empty/malformed YAML (%s)", async (text) => {
    fixture(); put("latest-mac.yml", text); await rejectedUnchanged();
  });

  it("rejects YAML aliases even inside otherwise unused metadata", async () => {
    fixture(); put("latest-mac.yml", readFileSync(feedPath, "utf8") + "anchored: &value [one, two]\nreused: *value\n");
    await rejectedUnchanged(/aliases/);
  });

  it("rejects a stale feed version", async () => {
    const doc = fixture(); put("latest-mac.yml", stringify({ ...doc, version: "1.10.4" }));
    await rejectedUnchanged(/version does not match/);
  });

  it.each(["../outside.dmg", "/tmp/outside.dmg", "sub/target.dmg", "sub\\target.dmg", "https://example.test/file.dmg", "Muster-1.10.4.dmg", `Muster-${version}-intel.dmg`, `Muster-${version}-x64.zip`])("rejects uncontained, stale or non-ARM64 target %s", async (url) => {
    const doc = fixture(); doc.files[1].url = url; put("latest-mac.yml", stringify(doc));
    await rejectedUnchanged();
  });

  it("rejects duplicate targets", async () => {
    const doc = fixture(); doc.files = [doc.files[0], structuredClone(doc.files[0])]; put("latest-mac.yml", stringify(doc));
    await rejectedUnchanged(/duplicate/);
  });

  it("requires the expected ARM64 ZIP, even when the DMG alone is valid", async () => {
    const doc = fixture({ legacy: "dmg" }); doc.files = [doc.files[1]]; put("latest-mac.yml", stringify(doc));
    await rejectedUnchanged(/must reference/);
  });

  it.each(["size", "hash", "path"])("rejects inconsistent original legacy %s", async (kind) => {
    const doc = fixture({ legacy: "dmg", legacySize: true });
    if (kind === "size") doc.size += 1;
    if (kind === "hash") doc.sha512 = sha512("different");
    if (kind === "path") doc.path = "missing.zip";
    put("latest-mac.yml", stringify(doc)); put(dmgName, "synthetic stapled DMG");
    await rejectedUnchanged(/Legacy feed/);
  });

  it.each([0, Infinity, "12"])("rejects malformed original entry size %s", async (size) => {
    const doc = fixture(); doc.files[1].size = size; put("latest-mac.yml", stringify(doc)); await rejectedUnchanged(/Malformed/);
  });

  it.each([undefined, "v1.10.5", "1.10", "1.10.5/../../other"])("requires an exact version (%s)", async (value) => {
    fixture(); const before = readFileSync(feedPath);
    await expect(refreshMacFeed({ ...options(), version: value })).rejects.toThrow(/exact RELEASE_VERSION/);
    expect(readFileSync(feedPath)).toEqual(before);
  });

  it("runs the real CLI with environment inputs and rejects changed ZIP bytes with exit 1", () => {
    fixture(); put(dmgName, "synthetic stapled DMG");
    const command = resolve("scripts/refresh-mac-feed.mjs"), env = { ...process.env, ASSETS_DIR: assetsDir, RELEASE_VERSION: version, ALLOW_DMG_CHANGE: "true" };
    const success = spawnSync(process.execPath, [command], { env, encoding: "utf8" });
    expect(success.status).toBe(0); expect(JSON.parse(success.stdout)).toEqual({ version, changed: true, updated: [dmgName] });
    const before = readFileSync(feedPath); put(zipName, "changed ZIP");
    const failure = spawnSync(process.execPath, [command], { env, encoding: "utf8" });
    expect(failure.status).toBe(1); expect(failure.stderr).toContain("ZIP bytes changed"); expect(failure.stdout).toBe(""); expect(readFileSync(feedPath)).toEqual(before);
    expect(existsSync(join(assetsDir, ".latest-mac.yml.tmp"))).toBe(false);
  });

  it.each([undefined, "", "TRUE", "1", "false"])("CLI fails closed for missing/invalid authorization or a changed unsigned DMG (%s)", (flag) => {
    fixture(); put(dmgName, "changed without notarization"); const before = readFileSync(feedPath);
    const env = { ...process.env, ASSETS_DIR: assetsDir, RELEASE_VERSION: version };
    delete env.ALLOW_DMG_CHANGE;
    if (flag !== undefined) env.ALLOW_DMG_CHANGE = flag;
    const result = spawnSync(process.execPath, [resolve("scripts/refresh-mac-feed.mjs")], { env, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(flag === "false" ? "without successful notarization" : "ALLOW_DMG_CHANGE must be exactly true or false");
    expect(result.stdout).toBe(""); expect(readFileSync(feedPath)).toEqual(before);
  });
});
