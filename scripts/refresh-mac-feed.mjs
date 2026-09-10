// Run after authorized DMG stapling, before checksums/upload. The ZIP is
// deliberately immutable; this helper never creates or edits an archive.
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseDocument } from "yaml";
import { z } from "zod";

const Size = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const Sha512 = z.string().regex(/^[A-Za-z0-9+/]{86}==$/);
const FlatName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/);
const Options = z.object({
  assetsDir: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/),
  allowDmgChange: z.boolean(),
});
const Feed = z.object({
  version: z.string(),
  files: z.array(z.object({ url: FlatName, sha512: Sha512, size: Size })).min(1).max(2),
  path: FlatName.optional(), sha512: Sha512.optional(), size: Size.optional(),
});

function regular(stat, path) {
  if (!stat.isFile() || stat.nlink !== 1 || !Size.safeParse(stat.size).success) {
    throw new Error(`Expected a nonempty regular file without links: ${path}`);
  }
}

function unchanged(before, after) {
  return before.dev === after.dev && before.ino === after.ino
    && before.size === after.size && before.mtimeMs === after.mtimeMs;
}

async function openRegular(path) {
  const before = await lstat(path);
  regular(before, path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    regular(stat, path);
    if (!unchanged(before, stat)) throw new Error(`File changed while opening: ${path}`);
    return { handle, stat };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function digest(path) {
  const { handle, stat } = await openRegular(path);
  try {
    const hash = createHash("sha512");
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk); size += chunk.length;
    }
    const after = await lstat(path);
    regular(after, path);
    if (size !== stat.size || !unchanged(stat, after)) throw new Error(`Asset changed while hashing: ${path}`);
    return { size, sha512: hash.digest("base64") };
  } finally { await handle.close(); }
}

function parseFeed(text) {
  const doc = parseDocument(text, { schema: "core", uniqueKeys: true, strict: true });
  if (doc.errors.length || doc.warnings.length) throw new Error("Malformed latest-mac.yml YAML");
  let value;
  try { value = doc.toJS({ maxAliasCount: 0 }); }
  catch { throw new Error("Unsupported YAML aliases in latest-mac.yml"); }
  const parsed = Feed.safeParse(value);
  if (!parsed.success) throw new Error("Malformed latest-mac.yml feed entries");
  return { doc, feed: parsed.data };
}

export async function refreshMacFeed(options) {
  const parsed = Options.safeParse(options);
  if (!parsed.success) throw new Error("ASSETS_DIR, exact RELEASE_VERSION and boolean allowDmgChange are required");
  const { version, allowDmgChange } = parsed.data;
  const assetsDir = resolve(parsed.data.assetsDir);
  const directory = await lstat(assetsDir);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("ASSETS_DIR must be a real directory");
  const feedPath = join(assetsDir, "latest-mac.yml");
  const { handle, stat } = await openRegular(feedPath);
  let original;
  try {
    if (stat.size > 1024 * 1024) throw new Error("latest-mac.yml exceeds the metadata size limit");
    original = await handle.readFile("utf8");
    if (!unchanged(stat, await handle.stat())) throw new Error("latest-mac.yml changed while reading");
  } finally { await handle.close(); }
  const { doc, feed } = parseFeed(original);
  if (feed.version !== version) throw new Error("latest-mac.yml version does not match RELEASE_VERSION");

  const zipName = `Muster-${version}-arm64.zip`, dmgName = `Muster-${version}.dmg`;
  const urls = new Set();
  for (const entry of feed.files) {
    if (![zipName, dmgName].includes(entry.url) || urls.has(entry.url)) {
      throw new Error(`Unexpected or duplicate ARM64 feed target: ${entry.url}`);
    }
    urls.add(entry.url);
  }
  const zip = feed.files.find((entry) => entry.url === zipName);
  if (!zip) throw new Error("latest-mac.yml must reference the expected ARM64 ZIP");
  if (feed.path !== undefined || feed.sha512 !== undefined || feed.size !== undefined) {
    const legacy = feed.files.find((entry) => entry.url === feed.path);
    if (!legacy || feed.sha512 !== legacy.sha512 || (feed.size !== undefined && feed.size !== legacy.size)) {
      throw new Error("Legacy feed path/hash/size are inconsistent with the original entry");
    }
  }
  const zipBytes = await digest(join(assetsDir, zipName));
  if (zipBytes.size !== zip.size || zipBytes.sha512 !== zip.sha512) {
    throw new Error("ZIP bytes changed; refusing to refresh the Mac feed");
  }
  const dmgIndex = feed.files.findIndex((entry) => entry.url === dmgName);
  if (dmgIndex === -1) return { version, changed: false, updated: [] };
  const dmg = feed.files[dmgIndex], dmgBytes = await digest(join(assetsDir, dmgName));
  if (dmg.size === dmgBytes.size && dmg.sha512 === dmgBytes.sha512) return { version, changed: false, updated: [] };
  if (!allowDmgChange) throw new Error("DMG bytes changed without successful notarization; refusing to refresh the Mac feed");
  doc.setIn(["files", dmgIndex, "sha512"], dmgBytes.sha512);
  doc.setIn(["files", dmgIndex, "size"], dmgBytes.size);
  if (feed.path === dmgName) {
    doc.set("sha512", dmgBytes.sha512);
    if (feed.size !== undefined) doc.set("size", dmgBytes.size);
  }

  const temporary = join(assetsDir, `.latest-mac-${randomUUID()}.tmp`);
  let staged, created = false;
  try {
    staged = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, stat.mode & 0o777);
    created = true;
    await staged.writeFile(doc.toString());
    await staged.sync();
    await staged.close(); staged = undefined;
    // Rename replaces the directory entry itself; it cannot write through
    // a destination symlink. Refuse observed concurrent replacements first.
    const current = await lstat(feedPath);
    regular(current, feedPath);
    if (!unchanged(stat, current)) throw new Error("latest-mac.yml changed before replacement");
    await rename(temporary, feedPath);
  } finally {
    try { if (staged) await staged.close(); }
    finally {
      if (created) await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
    }
  }
  return { version, changed: true, updated: [dmgName] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const run = async () => {
    if (process.argv.length !== 2) throw new Error("Usage: refresh-mac-feed.mjs");
    if (!["true", "false"].includes(process.env.ALLOW_DMG_CHANGE)) throw new Error("ALLOW_DMG_CHANGE must be exactly true or false");
    return refreshMacFeed({ assetsDir: process.env.ASSETS_DIR ?? "release", version: process.env.RELEASE_VERSION, allowDmgChange: process.env.ALLOW_DMG_CHANGE === "true" });
  };
  run().then((result) => console.log(JSON.stringify(result)))
    .catch((error) => { console.error(`Mac feed refresh rejected: ${error.message}`); process.exitCode = 1; });
}
