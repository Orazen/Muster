// Workspace bundle — the portable, encrypted export of everything that
// makes an install "yours": bots, groups, memory files, SOUL.md files, and
// (opt-in) threads. Provider keys are NEVER included by default; they are
// write-only secrets that stay on the machine.
//
// The bundle is AES-256-GCM encrypted under a key derived (scrypt) from the
// workspace passphrase + the deployment auth secret, so the Google Drive
// transport (drive.appdata) only ever holds ciphertext. Sync transports
// (Drive folder watcher, plain folder, Muster Cloud) all consume this exact
// shape — docs/plans/account-sync-portable-profile.md.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { z } from "zod";

import { newId, type ModelSelection, type ThreadId } from "./contracts.ts";
import {
  normalizeGroupDefaultResponder,
  type GroupDefaultResponder,
  type GroupRecord,
  type Store,
} from "./store.ts";
import { confinedTarget, RESTORE_DROPPED_BOT_FIELDS, RESTORE_DROPPED_GROUP_FIELDS } from "./workspace-bundle-v2.ts";
import { workspaceDir } from "./workspace.ts";

const BUNDLE_MAGIC = "muster-workspace-bundle";
const BUNDLE_VERSION = 1;
const KEY_LEN = 32;

export interface BundleWorkspace {
  bots: unknown;
  groups: unknown;
  memory: MemoryFiles;
  topics: Record<string, MemoryFiles>;
  exportedAt: number;
  counts: { bots: number; groups: number; memoryFiles: number };
}

export interface BundleResult {
  /** base64 of iv:authtag:ciphertext — safe for Drive appData upload */
  payload: string;
  counts: BundleWorkspace["counts"];
}

function deriveKey(passphrase: string, salt: Buffer, secret: string): Buffer {
  return scryptSync(`${passphrase}:${secret}`, salt, KEY_LEN);
}

type MemoryFiles = Record<string, string>;

function readMemoryTree(dataDir: string) {
  const dir = join(dataDir, "memory");
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    try {
      out[f] = readFileSync(join(dir, f), "utf8");
    } catch {
      /* unreadable file — skip, never wedge the export */
    }
  }
  return out;
}

function readTopicTree(dataDir: string, botIds: string[]) {
  const root = join(dataDir, "workspaces");
  const out: Record<string, MemoryFiles> = {};
  for (const botId of botIds) {
    const dir = join(root, botId, "memory");
    if (!existsSync(dir)) continue;
    const topics: MemoryFiles = {};
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      try {
        topics[f] = readFileSync(join(dir, f), "utf8");
      } catch {
        /* skip */
      }
    }
    if (Object.keys(topics).length) out[botId] = topics;
  }
  return out;
}

/** Build the workspace bundle (still unencrypted) from the live store.
 * Memory lives per bot: workspaceDir(botId)/MEMORY.md plus the memory/
 * topic files under it. Seed-only MEMORY.md files carry no information and
 * are skipped so bundles stay meaningful. */
export function buildBundle(store: Store, dataDir: string): BundleWorkspace {
  const bots = store.bots.filter((b) => !b.hidden);
  const groups = store.groups;
  const topics = readTopicTree(dataDir, bots.map((b) => b.id));
  const memory = { ...readMemoryTree(dataDir) };
  for (const bot of bots) {
    const file = join(workspaceDir(bot.id), "MEMORY.md");
    if (!existsSync(file)) continue;
    try {
      const text = readFileSync(file, "utf8");
      const stripped = text
        .replace(/^# MEMORY[\s\S]*?(?=\n## |\n\S|$)/, "")
        .trim();
      if (stripped) memory[`workspaces/${bot.id}/MEMORY.md`] = text;
    } catch {
      /* unreadable — skip */
    }
  }
  return {
    // SAFETY: store records are trusted domain objects being serialized for
    // export; the clone is a persistence copy, not unknown-input shaping.
    bots: JSON.parse(JSON.stringify(bots)),
    groups: JSON.parse(JSON.stringify(groups)),
    memory,
    topics,
    exportedAt: Date.now(),
    counts: {
      bots: bots.length,
      groups: groups.length,
      memoryFiles: Object.keys(memory).length + Object.values(topics).reduce((n, t) => n + Object.keys(t).length, 0),
    },
  } satisfies BundleWorkspace;
}

/** Encrypt a bundle into a portable payload string. */
export function encryptBundle(workspace: BundleWorkspace, passphrase: string, secret: string): BundleResult {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(passphrase, salt, secret);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(workspace), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const payload = [
    BUNDLE_MAGIC,
    String(BUNDLE_VERSION),
    salt.toString("base64"),
    iv.toString("base64"),
    authTag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
  return { payload, counts: workspace.counts };
}

const payloadSchema = z.string().min(1);

export interface DecryptResult {
  workspace: BundleWorkspace;
  counts: BundleWorkspace["counts"];
}

/** Decrypt a payload produced by encryptBundle. Throws with a readable
 * message on a wrong passphrase or corrupted payload. */
export function decryptBundle(payload: string, passphrase: string, secret: string): DecryptResult {
  const text = payloadSchema.parse(payload);
  const parts = text.split(":");
  if (parts.length !== 6 || parts[0] !== BUNDLE_MAGIC) throw new Error("this does not look like a Muster workspace bundle");
  const salt = Buffer.from(parts[2], "base64");
  const iv = Buffer.from(parts[3], "base64");
  const authTag = Buffer.from(parts[4], "base64");
  const ciphertext = Buffer.from(parts[5], "base64");
  let key: Buffer;
  try {
    key = deriveKey(passphrase, salt, secret);
  } catch {
    throw new Error("could not derive the workspace key");
  }
  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error("wrong passphrase — the bundle could not be decrypted");
  }
  // SAFETY: the plaintext is our own encrypted export whose shape
  // workspaceSchema validates at restore; the cast types what we wrote.
  const workspace = JSON.parse(plaintext.toString("utf8")) as BundleWorkspace;
  return { workspace, counts: workspace.counts };
}

export interface RestoreResult {
  botsRestored: number;
  groupsRestored: number;
  memoryFilesRestored: number;
  /** Bots whose id already existed locally were left untouched. */
  skippedExisting: number;
}

/** A bundle-supplied name that will be turned into a path. These come from
 * inside the encrypted payload, so they are data, not identifiers: a key
 * carrying `..` or a separator must never reach `join`, or a restore
 * writes wherever the bundle says. The v2 restore learned this the hard
 * way (`isSafeRelativePath` in workspace-bundle-v2.ts); the v1 path is
 * the one the contract at docs/plans/portable-backup-contract-2026-09-12.md
 * warns must not be reused blindly, so it gets the same rule. */
const isSafeBundleName = (name: string): boolean =>
  name.length > 0 && name.length <= 255 && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\") && !name.includes("\0");

const bundleBotSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  modelSelection: z
    .object({ instanceId: z.string().min(1), model: z.string().optional() })
    .passthrough()
    .optional(),
});

/** One restored bot, parsed at the boundary: the Store constructor
 * dereferences threadId (a SQLite bind) and createdAt unguarded, so a bundle
 * bot missing them would crash the NEXT app launch — same rule as the group
 * schema below. Unknown bundle fields ride through `passthrough()`. */
const botRecordSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    // SAFETY: compile-time only — pins the parsed threadId to the store's
    // ThreadId alias (both are string); without it zod's widened output
    // would not satisfy BotRecord.
    threadId: z.string().min(1).catch(newId()) as z.ZodType<ThreadId>,
    createdAt: z.number().catch(Date.now()),
    title: z.string().catch(""),
    description: z.string().catch(""),
    notifications: z.boolean().catch(true),
    color: z.enum(["green", "blue", "red", "orange", "purple", "cyan", "pink", "yellow", "teal", "coral"]).catch("orange"),
    unread: z.boolean().catch(false),
    resumeCursors: z.record(z.string(), z.string()).catch({}),
    // SAFETY: compile-time only — a bundle bot without a pinned model
    // carries the empty selection instead of undefined, keeping the parsed
    // record assignable to BotRecord (whose modelSelection is required).
    modelSelection: z
      .object({ instanceId: z.string().min(1), model: z.string().optional() })
      .passthrough()
      .catch({ instanceId: "" }) as z.ZodType<ModelSelection>,
  })
  .passthrough();
const bundleGroupSchema = z.object({ id: z.string().min(1) });
/** One bundle record, as the schemas above produce: an open record whose
 * fields vary by version. Schema-derived rather than a bare dictionary so the
 * helper below has a declared contract to work against. */
const bundleRecordSchema = z.record(z.string(), z.unknown());
type BundleRecord = z.infer<typeof bundleRecordSchema>;

/** A raw bundle group before restore processing: keys are data. */
const bundleGroupRawSchema = z.record(z.string(), z.unknown());

/** One restored group, as this installation will hold it — parsed, not cast:
 * the store's boot migration dereferences threadId/name/memberIds/bulletin
 * unguarded, so every field it touches is either present or defaulted here,
 * at the boundary. Unknown bundle fields ride through `passthrough()` and
 * are preserved. */
const groupRecordSchema = z
  .object({
    id: z.string().min(1),
    // Every one of these reaches a SQLite bind or a path join downstream:
    // empty strings are refused, not merely defaulted.
    threadId: z.string().min(1).catch(newId()),
    name: z.string().min(1).catch("Restored room"),
    memberIds: z.array(z.string().min(1)).catch([]),
    defaultResponder: z.unknown().optional(),
    bulletin: z.string().catch(""),
    createdAt: z.number().catch(Date.now()),
    dm: z.boolean().optional(),
  })
  .passthrough();

/** Group fields a restored record may not keep — now spelled in
 * `workspace-bundle-v2.ts` as RESTORE_DROPPED_GROUP_FIELDS and imported, so
 * there is one policy in one place. `ownerId` is the load-bearing one: a
 * bundle is data, and a restored group that kept the exporting account's
 * owner would answer to an account that is not on this machine. */

/** A bundle-supplied group, as this installation will hold it.
 *
 * `bundleGroupSchema` above validates only the id, and that was enough to
 * write an *incomplete* GroupRecord: the store's boot migration reads
 * `g.memberIds.length` unguarded (server/store.ts:424), so a restored group
 * carrying no member list took the next `new Store()` — the next app launch
 * — down with a TypeError before the UI ever rendered. A restore that
 * leaves the app unbootable is worse than one that restores less, so
 * groupRecordSchema fills every field the migration dereferences with the
 * same default `createGroup` uses (server/store.ts:640-651). */
/** A restored group: parse first, then drop the restricted fields via rest
 * destructuring — the caller's object is never mutated. The schema fills
 * every field the store's boot migration dereferences. */
function restoredGroup(raw: z.infer<typeof bundleGroupRawSchema>): GroupRecord {
  // Ownership and machine-specific handles are dropped first — exactly the
  // fields v2 restores without (RESTORE_DROPPED_GROUP_FIELDS; the boot
  // ownership migration assigns unowned records) — then the remainder is
  // parsed at the boundary. The helper copies, so the caller's bundle object
  // is never mutated.
  const parsed = groupRecordSchema.parse(withoutBundleOwnership(raw, RESTORE_DROPPED_GROUP_FIELDS));
  return {
    ...parsed,
    id: parsed.id,
    threadId: parsed.threadId,
    name: parsed.name,
    memberIds: [...parsed.memberIds],
    defaultResponder: normalizeGroupDefaultResponder(
      // SAFETY: defaultResponder is z.unknown() because legacy records carry
      // pre-schema shapes; the normalizer accepts exactly those shapes and
      // re-derives a safe policy from memberIds.
      parsed.defaultResponder as GroupDefaultResponder,
      parsed.memberIds,
      parsed.dm === true,
    ),
    bulletin: parsed.bulletin,
    unread: false,
    createdAt: parsed.createdAt,
    dm: parsed.dm === true || undefined,
  };
}

/** Fields a restored bot may not keep — spelled in `workspace-bundle-v2.ts`
 * as RESTORE_DROPPED_BOT_FIELDS and imported, so v1 and v2 drop the same
 * list. `ownerId` is the load-bearing one: a bundle is data, and a restored
 * bot that kept the exporting account's owner would answer to an account
 * that is not on this machine. */

const workspaceSchema = z.object({
  bots: z.array(z.record(z.string(), z.unknown())),
  groups: z.array(z.record(z.string(), z.unknown())),
  memory: z.record(z.string(), z.string()),
  topics: z.record(z.string(), z.record(z.string(), z.string())),
  exportedAt: z.number(),
});

/** A bundle record with the fields a restore must not carry over.
 *
 * Ownership and machine-specific handles are the two classes that cannot
 * transfer: whoever produced the bundle knows nothing about who owns what here,
 * and a path or CLI handle from another machine is wrong on this one. v2 spells
 * the list out as `RESTORE_DROPPED_*`; this is the same list applied on the v1
 * path, so there is one policy in two places rather than two policies.
 *
 * The input is left untouched: the bundle object may be shared with a caller
 * that wants to inspect exactly what arrived. */
function withoutBundleOwnership(record: BundleRecord, dropped: readonly string[]): BundleRecord {
  // The caller has already been through bundleBotSchema / bundleGroupSchema,
  // which are z.record() shapes, so the record is an object by contract here and
  // needs no runtime type test of its own.
  const next = { ...record };
  for (const field of dropped) delete next[field];
  return next;
}

/** Restore a decrypted workspace: insert bots/groups preserving their
 * original ids (an id that already exists locally means it IS the same bot
 * — skipped, never duplicated), and write memory + topic files under each
 * bot's workspace. A local memory file wins over the bundle: the human was
 * last editing THIS machine. Callers must reload providers after restore. */
export function restoreBundle(store: Store, dataDir: string, workspace: BundleWorkspace): RestoreResult {
  const result: RestoreResult = { botsRestored: 0, groupsRestored: 0, memoryFilesRestored: 0, skippedExisting: 0 };
  const parsed = workspaceSchema.safeParse(workspace);
  if (!parsed.success) throw new Error("bundle contents failed validation — refusing to restore");
  // Memory paths are validated as a WHOLE before anything is written: a
  // payload that carries a path escape is not partially trusted — restoring
  // the harmless-looking files alongside the malicious one is exactly the
  // confusion an attacker wants. One unsafe name ANYWHERE (a top-level memory
  // key, a topic directory, a topic filename, a per-bot id) suppresses the
  // top-level memory branch and the topics branch wholesale. The per-bot
  // MEMORY.md keys are the exception: their targets are a strict id plus a
  // fixed filename, so the branch keeps its own per-key id check and still
  // honours its safe entries.
  const isPerBotMemoryKey = (key: string): boolean => key.startsWith("workspaces/") && key.endsWith("/MEMORY.md");
  const globalMemoryUnsafe =
    Object.keys(parsed.data.memory).some((key) => {
      if (isPerBotMemoryKey(key)) return !/^[a-zA-Z0-9-]+$/.test(key.split("/")[1] ?? "");
      return !isSafeBundleName(key);
    }) ||
    Object.entries(parsed.data.topics).some(
      ([botId, topics]) => !isSafeBundleName(botId) || Object.keys(topics).some((name) => !isSafeBundleName(name)),
    );
  // store.bots / store.groups are public typed fields on Store (BotRecord[] /
  // GroupRecord[]); restore unshifts validated bundle records and persists
  // through the store's own save methods.
  const existingBotIds = new Set(store.bots.map((b) => b.id));
  for (const raw of parsed.data.bots) {
    const check = bundleBotSchema.safeParse(raw);
    if (!check.success) {
      result.skippedExisting += 1;
      continue;
    }
    if (existingBotIds.has(check.data.id)) {
      result.skippedExisting += 1;
      continue;
    }
    // The bundle is not evidence about who owns anything on THIS installation:
    // drop exactly the fields v2 drops (RESTORE_DROPPED_BOT_FIELDS — ownerId
    // is the load-bearing one; the boot ownership migration and
    // restore-apply.ts assign unowned records), then parse at the boundary:
    // the Store constructor dereferences threadId/createdAt unguarded, and
    // unknown bundle fields ride through passthrough() so a restore loses
    // nothing the bundle carried.
    const bot = botRecordSchema.parse(withoutBundleOwnership(raw, RESTORE_DROPPED_BOT_FIELDS));
    // A bundle bot without its own model pick is legal: it carries the
    // empty selection resolveInstanceForBot heals at first send — the same
    // rule a bot whose engine vanished gets — so the bundle never invents
    // an instance binding. The schema pins the parsed threadId/modelSelection
    // to BotRecord's aliases, so `bot` is assignable without an assertion.
    store.bots.unshift(bot);
    existingBotIds.add(check.data.id);
    result.botsRestored += 1;
  }
  const existingGroupIds = new Set(store.groups.map((g) => g.id));
  for (const raw of parsed.data.groups) {
    const check = bundleGroupSchema.safeParse(raw);
    if (!check.success) continue;
    if (existingGroupIds.has(check.data.id)) continue;
    store.groups.unshift(restoredGroup(raw));
    existingGroupIds.add(check.data.id);
    result.groupsRestored += 1;
  }
  store.saveBots();
  store.saveGroups();
  for (const [key, text] of Object.entries(parsed.data.memory)) {
    // bundle keys are either "MEMORY.md"-style DATA_DIR memory files or
    // "workspaces/<botId>/MEMORY.md" per-bot memory — restore both shapes
    if (isPerBotMemoryKey(key)) {
      const botId = key.split("/")[1];
      if (!/^[a-zA-Z0-9-]+$/.test(botId)) continue;
      // the bot's workspace dir may not exist on a fresh install — create it
      mkdirSync(workspaceDir(botId), { recursive: true, mode: 0o700 });
      const target = join(workspaceDir(botId), "MEMORY.md");
      if (existsSync(target)) continue; // local file wins
      writeFileSync(target, text, { mode: 0o600 });
      result.memoryFilesRestored += 1;
      continue;
    }
    if (globalMemoryUnsafe) continue;
    if (!key.endsWith(".md")) continue;
    // The bundle names its own write target, so the target is confined to the
    // data directory by the same rule v2 uses. A key carrying `..` used to
    // write anywhere the process could reach: this is the "must not be reused
    // blindly" clause of the portable-backup contract, and the v1 key is the
    // deployment signing secret, so a bundle from elsewhere must not get to
    // choose its own destination.
    const confined = confinedTarget(dataDir, join("memory", key));
    if (!confined) continue;
    mkdirSync(dirname(confined), { recursive: true, mode: 0o700 });
    if (existsSync(confined)) continue;
    writeFileSync(confined, text, { mode: 0o600 });
    result.memoryFilesRestored += 1;
  }
  if (globalMemoryUnsafe) return result;
  for (const [botId, topics] of Object.entries(parsed.data.topics)) {
    // Both halves come from the bundle: `botId` builds a directory and `name`
    // builds a file inside it. Neither was validated, so the same confinement
    // rule applies to the whole relative path, built once from the two parts.
    for (const [name, text] of Object.entries(topics)) {
      if (!name.endsWith(".md")) continue;
      const confined = confinedTarget(dataDir, join("workspaces", botId, "memory", name));
      if (!confined) continue;
      mkdirSync(dirname(confined), { recursive: true, mode: 0o700 });
      if (existsSync(confined)) continue;
      writeFileSync(confined, text, { mode: 0o600 });
      result.memoryFilesRestored += 1;
    }
  }
  return result;
}
