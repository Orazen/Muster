// Account-owned projections of existing data. No routes, mutation, OAuth or
// global-config fallback. The caller resolves a real live session/membership;
// after awaits it must revalidate that authority and exact grant custody.
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, type Stats } from "node:fs";
import { isAbsolute, join } from "node:path";
import { TextDecoder } from "node:util";
import { z } from "zod";

import { ownsUnderLegacyPolicy, type FollowUpAccount } from "./follow-up-identity.ts";
import { produceVisibleFiles, type VisibleFilesOutput, type MemoryBotInput } from "./drive-visible-producers.ts";
import { parseVisibleFiles, projectSettings, type ParseSuccess } from "./drive-visible.ts";
import type { Store } from "./store.ts";
import type { ThreadSnapshot } from "./message-db.ts";
import type { TaskPlanEngine } from "./task-engine.ts";
import { isMemoryTopicName, MEMORY_FILE_MAX_BYTES, MEMORY_MAX_BYTES, MEMORY_MAX_LINES } from "./workspace.ts";

const id = z.string().min(1).max(200);
const pathId = id.regex(/^[\w-]+$/);
const scalar = z.union([z.string().max(4_000), z.number().finite(), z.boolean(), z.null()]);
const accountSchema = z.object({ userId: id, sessionId: id, workspaceId: id, isPrimary: z.boolean() });
const settingsSchema = z.object({ userId: id, workspaceId: id, values: z.record(z.string().max(200), scalar) });
const taskSchema = z.object({ threadId: pathId, title: z.string().max(4_000), createdAt: z.number().finite() });
const botSchema = z.object({
  id: pathId, threadId: pathId, ownerId: id.optional(), name: z.string().max(4_000), title: z.string().max(4_000), description: z.string().max(256 * 1024),
  tasks: z.array(taskSchema).max(4_096).optional(),
  autoApprove: z.boolean().optional(), tokenBudget: z.number().finite().nullable().optional(),
  dailyUsdCap: z.number().finite().nullable().optional(), browser: z.boolean().optional(),
});
const groupSchema = z.object({
  id: pathId, threadId: pathId, ownerId: id.optional(), name: z.string().max(4_000), memberIds: z.array(pathId).max(4_096),
});
const planSchema = z.object({
  id, botId: pathId, ownerId: id.optional(), threadId: pathId.optional(), title: z.string().max(4_000),
  status: z.string(), updatedAt: z.number().finite(),
});
const rosterSchema = z.object({
  bots: z.array(botSchema).max(4_096), groups: z.array(groupSchema).max(4_096), plans: z.array(planSchema).max(4_096),
});

/** An explicit capture of actual account UI preferences, not installation
 * config. A missing capture remains unavailable until the host supplies one. */
export interface AccountSettingsSnapshot {
  readonly userId: string;
  readonly workspaceId: string;
  readonly values: Readonly<Record<string, string | number | boolean | null>>;
}

/** This is the exact durable snapshot port owned by Store. It deliberately
 * excludes messagesFor(), whose lazy legacy import mutates source data. */
export type DriveThreadSnapshot = ThreadSnapshot;

export interface AccountVisibleSourceInput {
  readonly account: FollowUpAccount;
  readonly store: Pick<Store, "bots" | "groups" | "snapshotThread">;
  readonly plans: Pick<TaskPlanEngine, "listPlans">;
  /** Operator-configured absolute data root, never a request path. */
  readonly dataDir: string;
  readonly settingsSnapshot: AccountSettingsSnapshot | null;
}

export type AccountSourceUnavailableReason =
  | "invalid-account" | "settings-unavailable" | "ownership-conflict" | "source-unavailable"
  | "invalid-data" | "read-limit" | "projection-invalid";

export type AccountVisibleSource =
  | { status: "unavailable"; reason: AccountSourceUnavailableReason }
  | ({
      status: "ready";
      /** Existing records have account ownership, not organization columns.
       * This scope does not invent separate per-organization partitioning. */
      scope: "account-owned";
      account: { userId: string; workspaceId: string };
      inventory: { botIds: string[]; groupIds: string[]; threadIds: string[]; taskIds: string[] };
      documents: ParseSuccess;
      digest: string;
    } & VisibleFilesOutput);

class SourceUnavailable extends Error {
  readonly reason: AccountSourceUnavailableReason;
  constructor(reason: AccountSourceUnavailableReason) { super(reason); this.reason = reason; }
}
function refuse(reason: AccountSourceUnavailableReason): never { throw new SourceUnavailable(reason); }
function missing(error: Error): boolean { return "code" in error && error.code === "ENOENT"; }
const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_TOPICS = 256;

/** Root is an existing deployment path. Below it every component is checked;
 * no reader creates directories, follows links or treats read errors as empty. */
function directory(path: string, optional: boolean): Stats | null {
  let stat: Stats;
  try { stat = lstatSync(path); }
  catch (error) { if (optional && error instanceof Error && missing(error)) return null; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) refuse("source-unavailable");
  return stat;
}

function sameDirectory(path: string, before: Stats): void {
  const after = directory(path, false);
  if (!after || after.dev !== before.dev || after.ino !== before.ino) refuse("source-unavailable");
}

/** Check file type before opening (avoids FIFO blocking), no-follow where
 * available, bound size, and compare both opened inode and final path. These
 * are filesystem checks, not a claim of OS isolation against a hostile host. */
function fileText(path: string, dirs: readonly { path: string; stat: Stats }[]): string | null {
  let before: Stats;
  try { before = lstatSync(path); }
  catch (error) { if (error instanceof Error && missing(error)) return null; throw error; }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) refuse("source-unavailable");
  if (before.size > MEMORY_FILE_MAX_BYTES) refuse("read-limit");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino) refuse("source-unavailable");
    if (opened.size > MEMORY_FILE_MAX_BYTES) refuse("read-limit");
    const bytes = Buffer.alloc(opened.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    const after = fstatSync(fd);
    const current = lstatSync(path);
    for (const dir of dirs) sameDirectory(dir.path, dir.stat);
    if (length !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs || current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino) {
      refuse("source-unavailable");
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
  } finally { closeSync(fd); }
}

function readMemory(dataDir: string, botId: string, charge: (text: string) => void): MemoryBotInput {
  const root = directory(dataDir, false);
  if (!root) refuse("source-unavailable");
  const paths = [join(dataDir, "workspaces"), join(dataDir, "workspaces", botId)];
  const dirs = [{ path: dataDir, stat: root }];
  for (const path of paths) {
    const stat = directory(path, true);
    if (!stat) return { botId, text: "", truncated: false, topics: [] };
    dirs.push({ path, stat });
  }
  const workspace = paths[1]!;
  const text = fileText(join(workspace, "MEMORY.md"), dirs) ?? "";
  charge(text);
  const topics: { name: string; text: string }[] = [];
  const topicDir = join(workspace, "memory");
  const topicStat = directory(topicDir, true);
  if (topicStat) {
    const entries = readdirSync(topicDir).filter(isMemoryTopicName).sort();
    if (entries.length > MAX_TOPICS) refuse("read-limit");
    const topicDirs = [...dirs, { path: topicDir, stat: topicStat }];
    for (const name of entries) {
      const body = fileText(join(topicDir, name), topicDirs);
      if (body === null) refuse("source-unavailable"); // Listed, then disappeared.
      charge(body);
      topics.push({ name, text: body });
    }
    sameDirectory(topicDir, topicStat);
    if (JSON.stringify(entries) !== JSON.stringify(readdirSync(topicDir).filter(isMemoryTopicName).sort())) refuse("source-unavailable");
  }
  for (const dir of dirs) sameDirectory(dir.path, dir.stat);
  return {
    botId, text, topics,
    truncated: text.split("\n").length > MEMORY_MAX_LINES || Buffer.byteLength(text) > MEMORY_MAX_BYTES,
  };
}

function unique(ids: readonly string[]): void {
  if (new Set(ids).size !== ids.length) refuse("ownership-conflict");
}
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

/** Synchronous, side-effect-free capture. The injected readers are existing
 * Store/TaskPlanEngine ports. Missing, partial or ambiguous data never turns
 * into a successful empty projection. No client-selected account authority. */
export function readAccountVisibleSource(input: AccountVisibleSourceInput): AccountVisibleSource {
  const accountResult = accountSchema.safeParse(input.account);
  if (!accountResult.success) return { status: "unavailable", reason: "invalid-account" };
  const account = accountResult.data;
  const settingsResult = settingsSchema.safeParse(input.settingsSnapshot);
  if (!settingsResult.success || settingsResult.data.userId !== account.userId || settingsResult.data.workspaceId !== account.workspaceId) {
    return { status: "unavailable", reason: "settings-unavailable" };
  }
  try {
    if (!isAbsolute(input.dataDir)) refuse("source-unavailable");
    directory(input.dataDir, false);
    let capturedBytes = 0;
    const charge = (text: string): void => {
      capturedBytes += Buffer.byteLength(text);
      if (capturedBytes > MAX_SOURCE_BYTES) refuse("read-limit");
    };
    const roster = () => rosterSchema.parse({ bots: input.store.bots, groups: input.store.groups, plans: input.plans.listPlans() });
    const initial = roster();
    const fingerprint = JSON.stringify(initial);
    unique(initial.bots.map(bot => bot.id));
    unique(initial.groups.map(group => group.id));
    unique(initial.plans.map(plan => plan.id));
    const bots = initial.bots.filter(bot => ownsUnderLegacyPolicy(bot, account));
    const groups = initial.groups.filter(group => ownsUnderLegacyPolicy(group, account));
    const botById = new Map(initial.bots.map(bot => [bot.id, bot]));
    // Legacy plans inherit their REAL bot's owner, as resolveFollowUpTask
    // does. Explicit plan ownership still wins; selected plans must also pass
    // the live owned-bot/thread checks below. A missing bot grants nothing.
    const plans = initial.plans.filter(plan => ownsUnderLegacyPolicy(
      { ownerId: plan.ownerId ?? botById.get(plan.botId)?.ownerId }, account,
    ));
    const ownedBotIds = new Set(bots.map(bot => bot.id));
    charge(JSON.stringify(bots)); charge(JSON.stringify(groups)); charge(JSON.stringify(plans));
    const owners = new Map<string, Set<string>>();
    const remember = (threadId: string, owner: string): void => {
      const set = owners.get(threadId) ?? new Set<string>(); set.add(owner); owners.set(threadId, set);
    };
    for (const bot of initial.bots) {
      remember(bot.threadId, `bot:${bot.id}`);
      for (const task of bot.tasks ?? []) remember(task.threadId, `bot:${bot.id}`);
    }
    for (const group of initial.groups) remember(group.threadId, `group:${group.id}`);
    const selected = new Map<string, string>();
    for (const bot of bots) {
      selected.set(bot.threadId, bot.name);
      unique((bot.tasks ?? []).map(task => task.threadId));
      for (const task of bot.tasks ?? []) selected.set(task.threadId, task.title);
    }
    for (const group of groups) {
      unique(group.memberIds);
      if (group.memberIds.some(botId => !ownedBotIds.has(botId))) refuse("ownership-conflict");
      selected.set(group.threadId, group.name);
    }
    for (const threadId of selected.keys()) if (owners.get(threadId)?.size !== 1) refuse("ownership-conflict");
    for (const plan of plans) {
      const bot = bots.find(candidate => candidate.id === plan.botId);
      if (!bot || (plan.threadId !== undefined && plan.threadId !== bot.threadId
        && !(bot.tasks ?? []).some(task => task.threadId === plan.threadId))) refuse("ownership-conflict");
    }
    const threads = [...selected].sort(([a], [b]) => a.localeCompare(b)).map(([threadId, title]) => {
      const snapshot = input.store.snapshotThread(threadId);
      if (snapshot.status !== "ready") refuse(snapshot.reason === "read-limit" ? "read-limit" : "source-unavailable");
      return { threadId, title, messages: snapshot.messages.map(message => {
        const projected = { id: message.id, role: message.role, at: message.at, kind: message.kind,
          text: message.text ?? "", parentId: message.parentId ?? null };
        charge(JSON.stringify(projected));
        return projected;
      }) };
    });
    const tasks = [
      ...bots.flatMap(bot => (bot.tasks ?? []).map(task => ({ id: task.threadId, title: task.title, updatedAt: task.createdAt }))),
      ...plans.map(plan => ({ id: plan.id, title: plan.title, status: plan.status, updatedAt: plan.updatedAt })),
    ].sort((a, b) => a.id.localeCompare(b.id));
    unique(tasks.map(task => task.id));
    // Validate at the actual parser boundary even though the producer also
    // projects preferences. This refuses credential-shaped offered settings.
    projectSettings(settingsResult.data.values);
    const produced = produceVisibleFiles({
      personas: bots.map(bot => ({ botId: bot.id, persona: {
        name: bot.name, title: bot.title, description: bot.description, autoApprove: bot.autoApprove,
        tokenBudget: bot.tokenBudget, dailyUsdCap: bot.dailyUsdCap, browser: bot.browser,
      } })),
      memoryBots: bots.map(bot => readMemory(input.dataDir, bot.id, charge)), threads, tasks, settings: settingsResult.data.values,
    });
    if (Object.values(produced.files).reduce((bytes, body) => bytes + Buffer.byteLength(body), 0) > MAX_SOURCE_BYTES) refuse("read-limit");
    const documents = parseVisibleFiles(produced.files);
    if (!documents.ok) refuse("projection-invalid");
    if (JSON.stringify(roster()) !== fingerprint || JSON.stringify(accountSchema.parse(input.account)) !== JSON.stringify(account)
      || JSON.stringify(settingsSchema.parse(input.settingsSnapshot)) !== JSON.stringify(settingsResult.data)) refuse("ownership-conflict");
    const inventory = {
      botIds: bots.map(bot => bot.id).sort(), groupIds: groups.map(group => group.id).sort(),
      threadIds: [...selected.keys()].sort(), taskIds: tasks.map(task => task.id),
    };
    const scope = { userId: account.userId, workspaceId: account.workspaceId };
    const fileHashes = Object.entries(produced.files).sort(([a], [b]) => a.localeCompare(b)).map(([name, body]) => ({ name, sha256: hash(body) }));
    return { status: "ready", scope: "account-owned", account: scope, inventory, documents, ...produced,
      digest: hash(JSON.stringify({ version: 1, account: scope, inventory, fileHashes })) };
  } catch (error) {
    // Never echo file paths, foreign record IDs, offered settings or prose.
    return { status: "unavailable", reason: error instanceof SourceUnavailable ? error.reason : "source-unavailable" };
  }
}
