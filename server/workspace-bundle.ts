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
import { join } from "node:path";

import { z } from "zod";

import type { Store } from "./store.ts";
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

const bundleBotSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  modelSelection: z
    .object({ instanceId: z.string().min(1), model: z.string().optional() })
    .passthrough()
    .optional(),
});
const bundleGroupSchema = z.object({ id: z.string().min(1) });

const workspaceSchema = z.object({
  bots: z.array(z.record(z.string(), z.unknown())),
  groups: z.array(z.record(z.string(), z.unknown())),
  memory: z.record(z.string(), z.string()),
  topics: z.record(z.string(), z.record(z.string(), z.string())),
  exportedAt: z.number(),
});

/** Restore a decrypted workspace: insert bots/groups preserving their
 * original ids (an id that already exists locally means it IS the same bot
 * — skipped, never duplicated), and write memory + topic files under each
 * bot's workspace. A local memory file wins over the bundle: the human was
 * last editing THIS machine. Callers must reload providers after restore. */
export function restoreBundle(store: Store, dataDir: string, workspace: BundleWorkspace): RestoreResult {
  const result: RestoreResult = { botsRestored: 0, groupsRestored: 0, memoryFilesRestored: 0, skippedExisting: 0 };
  const parsed = workspaceSchema.safeParse(workspace);
  if (!parsed.success) throw new Error("bundle contents failed validation — refusing to restore");
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
    // SAFETY: the record passed bundleBotSchema (id + name validated); the
    // array is the store's own public BotRecord[] field.
    (store.bots as unknown[]).unshift(raw);
    existingBotIds.add(check.data.id);
    result.botsRestored += 1;
  }
  const existingGroupIds = new Set(store.groups.map((g) => g.id));
  for (const raw of parsed.data.groups) {
    const check = bundleGroupSchema.safeParse(raw);
    if (!check.success) continue;
    if (existingGroupIds.has(check.data.id)) continue;
    // SAFETY: same boundary as bots — id validated by bundleGroupSchema.
    (store.groups as unknown[]).unshift(raw);
    existingGroupIds.add(check.data.id);
    result.groupsRestored += 1;
  }
  store.saveBots();
  store.saveGroups();
  for (const [key, text] of Object.entries(parsed.data.memory)) {
    // bundle keys are either "MEMORY.md"-style DATA_DIR memory files or
    // "workspaces/<botId>/MEMORY.md" per-bot memory — restore both shapes
    if (key.startsWith("workspaces/") && key.endsWith("/MEMORY.md")) {
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
    if (!key.endsWith(".md")) continue;
    const dir = join(dataDir, "memory");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = join(dir, key);
    if (existsSync(target)) continue;
    writeFileSync(target, text, { mode: 0o600 });
    result.memoryFilesRestored += 1;
  }
  for (const [botId, topics] of Object.entries(parsed.data.topics)) {
    const dir = join(workspaceDir(botId), "memory");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const [name, text] of Object.entries(topics)) {
      if (!name.endsWith(".md")) continue;
      const target = join(dir, name);
      if (existsSync(target)) continue;
      writeFileSync(target, text, { mode: 0o600 });
      result.memoryFilesRestored += 1;
    }
  }
  return result;
}
