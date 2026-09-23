// Validate downloaded release bytes before publishing or copying a feed.
// This is a local filesystem gate; release/draft provenance stays in CI.
import { createHash } from "node:crypto";
import { constants, createReadStream, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseDocument } from "yaml";
import { z } from "zod";

const FlatName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/);
const Version = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/);
const PublishedAt = z.string().datetime();
const Options = z.object({
  assetsDir: z.string().min(1), version: Version,
  sha: z.string().regex(/^[a-f0-9]{40}$/i), requireComplete: z.boolean(),
});
const Size = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const Sha512 = z.string().regex(/^[A-Za-z0-9+/]{86}==$/);
const Feed = z.object({
  version: z.string(),
  files: z.array(z.object({ url: FlatName, sha512: Sha512, size: Size })).min(1).max(100),
  path: FlatName.optional(), sha512: Sha512.optional(), size: Size.optional(),
});
const FEEDS = ["latest-mac.yml", "latest.yml", "latest-linux.yml"];
const CHECKSUMS = ["SHA256SUMS-macos-arm64.txt", "SHA256SUMS-macos-x64.txt", "SHA256SUMS-windows-x64.txt", "SHA256SUMS-linux-x64.txt", "SHA256SUMS-cli.txt"];
const STABLE = ["Muster.dmg", "Muster-setup.exe", "Muster.deb", "Muster.AppImage", "Muster-intel.dmg", "muster-cli.mjs"];
const GENERATED = ["latest.json", "mirror-files.txt", "mirror-manifest.json"];

function fail(message) { throw new Error(message); }

async function regularFile(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.nlink !== 1 || !Size.safeParse(stat.size).success) {
    fail(`Expected a nonempty regular file without links: ${path}`);
  }
  return stat;
}

async function inventory(assetsDir, version) {
  const directory = await lstat(assetsDir);
  if (!directory.isDirectory() || directory.isSymbolicLink()) fail("ASSETS_DIR must be a real directory");
  const files = new Map();
  for (const name of await readdir(assetsDir)) {
    if (!FlatName.safeParse(name).success) fail(`Invalid flat asset name: ${name}`);
    // The versioned-name allowlist must include every companion the real
    // builder emits: the main DMG's .blockmap rides alongside it (the first
    // complete CI release failed publish on exactly this omission).
    const versionedNames = [`Muster-${version}.dmg`, `Muster-${version}.dmg.blockmap`];
    if (name.startsWith("Muster-") && !STABLE.includes(name)
      && !name.startsWith(`Muster-${version}-`) && !versionedNames.includes(name)) {
      fail(`Stale or unexpected versioned asset: ${name}`);
    }
    files.set(name, await regularFile(join(assetsDir, name)));
  }
  return files;
}

// Parse an electron-builder blockmap: gzip JSON whose outermost file entry
// carries chunk sizes summing to the paired binary's byte length when the
// pair is in sync.
function blockmapChunkTotal(path) {
  let raw;
  try {
    raw = gunzipSync(readFileSync(path));
  } catch {
    return fail(`Blockmap is not valid gzip: ${path}`);
  }
  let doc;
  try {
    doc = JSON.parse(raw.toString("utf8"));
  } catch {
    return fail(`Blockmap is not valid JSON: ${path}`);
  }
  const sizes = doc?.files?.[0]?.sizes;
  if (!Array.isArray(sizes) || !sizes.every((entry) => Number.isSafeInteger(entry) && entry > 0)) {
    return fail(`Blockmap has no chunk sizes: ${path}`);
  }
  return { chunkTotal: sizes.reduce((total, entry) => total + entry, 0) };
}

function parseFeed(text, name) {
  // Reject duplicate keys, custom tags and aliases rather than allowing
  // parser-specific overrides or alias expansion in a downloaded feed.
  const doc = parseDocument(text, { schema: "core", uniqueKeys: true, strict: true });
  if (doc.errors.length || doc.warnings.length) fail(`Malformed YAML in ${name}`);
  let value;
  try { value = doc.toJS({ maxAliasCount: 0 }); }
  catch { fail(`Unsupported YAML aliases in ${name}`); }
  const parsed = Feed.safeParse(value);
  if (!parsed.success) fail(`Malformed update feed: ${name}`);
  return parsed.data;
}

export async function validateReleasePayload(options) {
  const parsed = Options.safeParse(options);
  if (!parsed.success) fail("RELEASE_VERSION, full RELEASE_SHA, ASSETS_DIR and boolean REQUIRE_COMPLETE are required");
  const { version, sha, requireComplete } = parsed.data;
  const assetsDir = resolve(parsed.data.assetsDir);
  const files = await inventory(assetsDir, version);
  const hashes = new Map();
  const digest = async (name) => {
    // These outputs are replaced after validation. A feed or checksum must
    // never claim their old bytes are part of the verified release payload.
    if (GENERATED.includes(name)) fail(`Generated mirror output cannot be a release reference: ${name}`);
    if (!files.has(name)) fail(`Missing release asset: ${name}`);
    if (hashes.has(name)) return hashes.get(name);
    const sha256 = createHash("sha256"), sha512 = createHash("sha512");
    let size = 0;
    for await (const chunk of createReadStream(join(assetsDir, name), { flags: constants.O_RDONLY | constants.O_NOFOLLOW })) {
      size += chunk.length; sha256.update(chunk); sha512.update(chunk);
    }
    const after = await regularFile(join(assetsDir, name));
    const before = files.get(name);
    if (size !== before.size || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs) {
      fail(`Release asset changed while validating: ${name}`);
    }
    const result = { size, sha256: sha256.digest("hex"), sha512: sha512.digest("base64") };
    hashes.set(name, result);
    return result;
  };
  const verified = new Set(), referenced = new Set(), feeds = new Map();
  for (const name of FEEDS.filter((item) => files.has(item))) {
    if (files.get(name).size > 1024 * 1024) fail(`Update feed is too large: ${name}`);
    const feed = parseFeed(await readFile(join(assetsDir, name), "utf8"), name);
    if (feed.version !== version) fail(`Version mismatch in ${name}`);
    const urls = new Set();
    for (const entry of feed.files) {
      if (urls.has(entry.url)) fail(`Duplicate feed asset: ${entry.url}`);
      urls.add(entry.url);
      const actual = await digest(entry.url);
      if (entry.size !== actual.size || entry.sha512 !== actual.sha512) fail(`Feed bytes mismatch: ${entry.url}`);
      verified.add(entry.url); referenced.add(entry.url);
    }
    if (feed.path !== undefined || feed.sha512 !== undefined || feed.size !== undefined) {
      const entry = feed.files.find((item) => item.url === feed.path);
      if (!entry || feed.sha512 !== entry.sha512 || (feed.size !== undefined && feed.size !== entry.size)) {
        fail(`Legacy feed path/hash mismatch in ${name}`);
      }
    }
    feeds.set(name, feed);
  }
  if (feeds.size === 0) fail("At least one update feed is required");
  const checksumEntries = new Map();
  for (const name of CHECKSUMS.filter((item) => files.has(item))) {
    if (files.get(name).size > 1024 * 1024) fail(`Checksum file is too large: ${name}`);
    const entries = new Set();
    for (const line of (await readFile(join(assetsDir, name), "utf8")).trim().split(/\r?\n/)) {
      const match = /^([a-fA-F0-9]{64}) [ *]([A-Za-z0-9][A-Za-z0-9._+-]*)$/.exec(line);
      if (!match || entries.has(match[2])) fail(`Malformed or duplicate checksum in ${name}`);
      const [, expected, asset] = match;
      if ((await digest(asset)).sha256 !== expected.toLowerCase()) fail(`Checksum bytes mismatch: ${asset}`);
      entries.add(asset); verified.add(asset);
    }
    checksumEntries.set(name, entries);
  }

  const stableFiles = [];
  const selected = new Set([...feeds.keys(), ...referenced]);
  const alias = async (stable, candidates, required) => {
    if (!files.has(stable)) {
      if (required) fail(`Missing stable release asset: ${stable}`);
      return;
    }
    const present = candidates.filter((name) => files.has(name));
    if (present.length !== 1 || !verified.has(present[0])) fail(`Missing or ambiguous verified target for ${stable}`);
    const target = present[0];
    const actual = await digest(stable);
    if (actual.sha256 !== (await digest(target)).sha256) fail(`Stable alias bytes mismatch: ${stable}`);
    stableFiles.push(stable); selected.add(stable); selected.add(target);
  };
  await alias("Muster.dmg", [`Muster-${version}.dmg`], requireComplete);
  await alias("Muster-setup.exe", [`Muster-${version}-setup.exe`], requireComplete);
  await alias("Muster.deb", [`Muster-${version}-amd64.deb`, `Muster-${version}-x64.deb`], requireComplete);
  await alias("Muster.AppImage", [`Muster-${version}-x86_64.AppImage`, `Muster-${version}-x64.AppImage`], requireComplete);

  const intel = ["Muster-intel.dmg", `Muster-${version}-intel.dmg`, `Muster-${version}-x64.zip`];
  if (intel.some((name) => files.has(name))) {
    const checksums = checksumEntries.get("SHA256SUMS-macos-x64.txt");
    if (!intel.every((name) => files.has(name)) || !intel.slice(1).every((name) => checksums?.has(name))) {
      fail("Optional Intel release needs stable/versioned DMG, x64 ZIP and verified Intel checksums");
    }
    await alias(intel[0], [intel[1]], true);
    selected.add(intel[2]);
  }
  const cli = ["muster-cli.mjs", `Muster-${version}-cli.mjs`];
  if (requireComplete || [...cli, "SHA256SUMS-cli.txt"].some((name) => files.has(name))) {
    const checksums = checksumEntries.get("SHA256SUMS-cli.txt");
    if (!cli.every((name) => files.has(name) && checksums?.has(name)) || checksums.size !== cli.length) {
      fail("CLI release needs stable/versioned bundles and their exact dedicated checksums");
    }
    await alias(cli[0], [cli[1]], true);
  }
  if (requireComplete) {
    if (!FEEDS.every((name) => feeds.has(name))) fail("A complete release requires all three update feeds");
    const expects = [
      ["latest-mac.yml", [`Muster-${version}-arm64.zip`]],
      ["latest.yml", [`Muster-${version}-setup.exe`]],
      ["latest-linux.yml", [`Muster-${version}-x86_64.AppImage`, `Muster-${version}-x64.AppImage`]],
    ];
    for (const [name, targets] of expects) {
      if (!feeds.get(name).files.some((entry) => targets.includes(entry.url))) fail(`Missing platform update target in ${name}`);
    }
  }
  // Blockmaps ride alongside their binaries for electron-updater's differential
  // (delta) downloads, which fetch `<installer-url>.blockmap` by convention —
  // the feeds never reference them. Without this, the platform legs upload
  // blockmaps to the release but the mirror silently ships without them and
  // every delta update falls back to a full re-download. Adopt any blockmap
  // whose binary is already mirrored and whose bytes are covered by that
  // platform's checksum file, so only verified bytes reach the inventory.
  // The blockmap must also describe its binary exactly: the differ asserts
  // downloadSize+copySize === new-file size and aborts on mismatch, and a
  // blockmap generated before a later rewrite of the binary (e.g. stapler
  // touching the DMG's koly trailer) desynchronizes chunk offsets — the
  // delta then always falls back to a full download. Pairing drift is a
  // packaging bug, so it fails validation rather than shipping a blockmap
  // that can never produce a delta.
  if (requireComplete) {
    const binaryOf = (name) => name.slice(0, -".blockmap".length);
    for (const name of files.keys()) {
      if (!name.endsWith(".blockmap")) continue;
      const binary = binaryOf(name);
      if (!selected.has(binary)) continue;
      const checksumsFile = CHECKSUMS.find((item) => checksumEntries.get(item)?.has(name));
      if (!checksumsFile) fail(`Unverified blockmap cannot be mirrored: ${name}`);
      await digest(name);
      const { size: binarySize } = await digest(binary);
      const { chunkTotal } = blockmapChunkTotal(join(assetsDir, name));
      if (chunkTotal !== binarySize) {
        fail(`Stale blockmap for ${binary}: covers ${chunkTotal} bytes but the binary is ${binarySize} bytes — regenerate the binary before staging (blockmap is emitted before late rewrites like codesign stapling)`);
      }
      selected.add(name);
    }
  }
  // Feeds themselves are transferred too. Bind their bytes, not only the
  // installer hashes they contain, to the later remote promotion gate.
  for (const name of selected) await digest(name);
  return { assetsDir, version, sha, requireComplete, feeds: [...feeds.keys()], feedTargets: [...referenced].sort(), stableFiles, files: [...selected].sort(), hashes: Object.fromEntries(hashes) };
}

export async function prepareMirrorPayload(options) {
  if (options.requireComplete !== true) fail("Mirror requires REQUIRE_COMPLETE=true");
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(options.version ?? "")) fail("Stable mirror refuses prerelease or noncanonical versions");
  if (!/^[a-f0-9]{40}$/.test(options.sha ?? "")) fail("Mirror requires a canonical lowercase source SHA");
  const publishedAt = PublishedAt.safeParse(options.publishedAt);
  if (!publishedAt.success) fail("Mirror requires the release's authoritative publishedAt UTC timestamp");
  const validated = await validateReleasePayload(options);
  const immutable = (name) => (name === `Muster-${validated.version}.dmg` || name.startsWith(`Muster-${validated.version}-`)) &&
    [".zip", ".dmg", ".exe", ".deb", ".AppImage", ".blockmap"].some((extension) => name.endsWith(extension));
  if (!validated.feedTargets.every(immutable)) fail("Every mirrored updater feed target must have an immutable versioned filename");
  const latest = { version: validated.version, sha: validated.sha, published: new Date(publishedAt.data).toISOString().replace(/\.000Z$/, "Z"), files: {}, checksums: {} };
  for (const name of validated.stableFiles) {
    const { size, sha256 } = validated.hashes[name];
    latest.files[name] = { size, sha256 }; latest.checksums[name] = sha256;
  }
  const latestText = JSON.stringify(latest, null, 2) + "\n";
  const manifestFiles = validated.files.map((name) => ({ name, size: validated.hashes[name].size, sha256: validated.hashes[name].sha256 }));
  manifestFiles.push({ name: "latest.json", size: Buffer.byteLength(latestText), sha256: createHash("sha256").update(latestText).digest("hex") });
  manifestFiles.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const manifest = { schemaVersion: 1, version: validated.version, sha: validated.sha, files: manifestFiles };
  const manifestText = JSON.stringify(manifest, null, 2) + "\n";
  const manifestSha256 = createHash("sha256").update(manifestText).digest("hex");
  const mirrorFiles = [...validated.files, "latest.json", "mirror-manifest.json"].sort();
  // Inventory has rejected pre-existing symlink/hardlink outputs. O_NOFOLLOW
  // also prevents a replacement symlink from redirecting these local writes.
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW;
  await writeFile(join(validated.assetsDir, "latest.json"), latestText, { flag: flags });
  await writeFile(join(validated.assetsDir, "mirror-manifest.json"), manifestText, { flag: flags });
  await writeFile(join(validated.assetsDir, "mirror-files.txt"), mirrorFiles.join("\n") + "\n", { flag: flags });
  return { ...validated, mirrorFiles, latest, manifest, manifestSha256 };
}

export async function runReleasePayload(command, env) {
  if (!["true", "false"].includes(env.REQUIRE_COMPLETE)) fail("REQUIRE_COMPLETE must be exactly true or false");
  const options = { assetsDir: env.ASSETS_DIR ?? "assets", version: env.RELEASE_VERSION, sha: env.RELEASE_SHA, requireComplete: env.REQUIRE_COMPLETE === "true", publishedAt: env.RELEASE_PUBLISHED_AT };
  if (command === "validate") return validateReleasePayload(options);
  if (command === "mirror") return prepareMirrorPayload(options);
  fail("Usage: release-payload.mjs validate|mirror");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runReleasePayload(process.argv.length === 3 ? process.argv[2] : undefined, process.env)
    .then((result) => console.log(JSON.stringify({ version: result.version, feeds: result.feeds.length, files: result.files.length, mirrorFiles: result.mirrorFiles?.length })))
    .catch((error) => { console.error(`Release payload rejected: ${error.message}`); process.exitCode = 1; });
}
