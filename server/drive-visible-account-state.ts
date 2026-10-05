// Account recovery preparation only: complete safe records and selected heads,
// no routes, credential readers, source mutation, staging or live import.
import { createHash } from "node:crypto";
import { z } from "zod";

import { readAccountVisibleSource, type AccountVisibleSourceInput } from "./drive-visible-data-source.ts";
import { parseVisibleFiles, CREDENTIAL_KEYS } from "./drive-visible.ts";
import { inspectAccountProjection, resolveAuthenticatedVisibleAccount, sameVisibleAuthority,
  type ResolveVisibleAccount } from "./drive-visible-account-bundle.ts";
import type { Message } from "./store.ts";
import type { TaskPlanEngine } from "./task-engine.ts";
import { isMemoryTopicName, MEMORY_FILE_MAX_BYTES } from "./workspace.ts";

export const RECOVERY_STATE_FORMAT = "muster-account-recovery";
export const MAX_RECOVERY_STATE_BYTES = 24 * 1024 * 1024;
export const ACCOUNT_RECOVERY_EXCLUDES = [
  "auth-users-organizations-memberships-sessions-and-credentials",
  "provider-keys-engines-cursors-computers-and-standing-permissions",
  "attachments-arbitrary-workspace-files-and-memory-history",
  "routines-goals-decision-ledger-social-and-live-dispatch-receipts",
  "live-apply-and-synchronization",
] as const;
const id = z.string().min(1).max(200);
const recordId = id.regex(/^[\w-]+$/);
const text = z.string().max(1024 * 1024);
const at = z.number().finite();
const optionalFlag = z.boolean().optional();
const task = z.object({ threadId: recordId, title: text, createdAt: at, titleSource: z.enum(["user", "generated"]).optional(),
  usage: z.object({ input: at, output: at, costUsd: at.nullable(), turns: at }).strict().optional() }).strict();
const bot = z.object({ id: recordId, threadId: recordId, name: text, title: text, description: text,
  color: text, character: text.optional(), mascotExpression: text.nullable().optional(), createdAt: at,
  notifications: z.boolean(), unread: z.boolean(), tasks: z.array(task).max(4096),
  pinned: optionalFlag, hidden: optionalFlag, privacyShield: optionalFlag,
  speakReplies: optionalFlag, voice: text.optional(), tokenBudget: at.nullable().optional(), dailyUsdCap: at.nullable().optional(),
}).strict();
const responder = z.discriminatedUnion("kind", [z.object({ kind: z.literal("member"), botId: recordId }).strict(),
  z.object({ kind: z.literal("everyone") }).strict(), z.object({ kind: z.literal("mentions") }).strict()]);
const group = z.object({ id: recordId, threadId: recordId, name: text, memberIds: z.array(recordId).max(4096),
  defaultResponder: responder, bulletin: text, unread: z.boolean(), createdAt: at, dm: optionalFlag }).strict();
// Closed display contracts from Store.OptionCardData / ConnectorCardData,
// approval-why.ts and model-context.ts. Historical evidence is not driver,
// environment, proxy, credential or execution configuration.
const count = z.number().int().nonnegative();
const why = z.object({ source: z.literal("previous-run"), runId: id, botId: recordId, threadId: recordId,
  at, intent: text, decisions: z.array(text).max(4096), outcome: z.enum(["done", "failed", "partial"]),
  hypothesis: text.optional(), findings: text.optional() }).strict();
const rehearsal = z.object({ plannedSteps: count, matchedSteps: count, matchedRuns: count, reviewedRuns: count, summary: text }).strict();
const decisionHistory = z.object({ total: count, approved: count, denied: count, auto: count,
  lastDecision: z.enum(["approved", "denied", "auto"]).nullable(), summary: text.nullable() }).strict();
const card = z.object({ title: text, subtitle: text, options: z.array(text).max(4096), answered: text.optional(), dismissed: optionalFlag,
  why: why.optional(), rehearsal: rehearsal.optional(), tool: text.optional(), held: text.optional(), history: decisionHistory.optional() }).strict();
const connector = z.object({ slug: id, label: text, description: text,
  status: z.enum(["required", "authorizing", "connected", "failed"]), error: text.optional(), dismissed: optionalFlag }).strict();
const tool = z.object({ name: text, ok: optionalFlag, spoken: text.optional(), setup: optionalFlag }).strict();
const compaction = z.object({ summary: text, firstKeptId: z.string().min(1).max(1024), tokensBefore: count, at }).strict();
const privacy = z.object({ secrets: count, emails: count, phones: count }).strict();
const message = z.object({ id: z.string().min(1).max(1024), role: z.enum(["user", "bot"]),
  kind: z.enum(["text", "options", "activity", "screen", "connector", "compaction", "privacy"]), at,
  parentId: z.string().min(1).max(1024).nullable(), text: text.optional(), png: text.optional(), mime: text.optional(),
  // Structured display history is bounded before schema parsing. Action and
  // credential fields are removed at capture and refused in imported bytes.
  card: card.optional(), connector: connector.optional(), tool: tool.optional(),
  compaction: compaction.optional(), privacy: privacy.optional(),
  from: z.object({ botId: recordId, name: text, color: text }).strict().optional(),
  comm: z.object({ groupId: recordId, withBotId: recordId, withName: text, withColor: text }).strict().optional(),
  reactions: z.array(z.object({ emoji: text, by: id }).strict()).max(4096).optional(),
  via: z.object({ model: text, effort: text.optional() }).strict().optional(),
}).strict();
const thread = z.object({ threadId: recordId, activeLeafId: z.string().min(1).max(1024).nullable(),
  messages: z.array(message).max(100_000) }).strict();
const status = z.enum(["queued", "running", "waiting_input", "waiting_approval", "paused", "succeeded", "failed", "cancelled"]);
const step = z.object({ n: z.number().int().min(1).max(12), title: text, kind: z.enum(["checkpoint", "input", "approval"]),
  status: z.enum(["pending", "active", "done", "skipped", "failed"]), startedAt: at.optional(), finishedAt: at.optional() }).strict();
const inputRequest = z.object({ prompt: text, fields: z.array(z.object({ name: id, label: text,
  type: z.enum(["text", "number", "boolean", "select"]), required: z.boolean(), options: z.array(text).max(4096).optional() }).strict()).max(8),
  step: z.number().int().min(1).max(12), askedAt: at }).strict();
const approvalRequest = z.object({ title: text, step: z.number().int().min(1).max(12), askedAt: at, by: text.optional() }).strict();
const inputAnswer = z.object({ name: id, value: z.union([text, z.number().finite(), z.boolean()]), at }).strict();
const plan = z.object({ id, botId: recordId, threadId: recordId.optional(), title: text, status,
  steps: z.array(step).max(12), currentStep: z.number().int().min(1).max(12).nullable(), pausedFrom: status.optional(),
  attempts: z.number().int().nonnegative(), maxAttempts: z.number().int().nonnegative(),
  inputRequest: inputRequest.optional(), approvalRequest: approvalRequest.optional(), inputAnswers: z.array(inputAnswer).max(4096),
  lastError: text.optional(), createdAt: at, updatedAt: at }).strict();
const transition = z.object({ planId: id, botId: recordId, from: status, to: status, at,
  action: text, step: z.number().int().min(1).max(12).optional(), reason: text.optional() }).strict();
const fileText = z.string().max(MAX_RECOVERY_STATE_BYTES).refine(value => Buffer.from(value, "utf8").toString("utf8") === value);
const files = z.object({ "soul.md": fileText, "memory.json": fileText, "sessions.json": fileText,
  "tasks.json": fileText, "settings.json": fileText }).strict();
const ids = z.array(id).max(32_768);
export const accountRecoveryStateSchema = z.object({
  version: z.literal(1), kind: z.literal(RECOVERY_STATE_FORMAT), scope: z.literal("account-owned"),
  source: z.object({ userId: id, workspaceId: id, googleSub: z.string().min(1).max(1024) }).strict(),
  inventory: z.object({ botIds: ids, groupIds: ids, threadIds: ids, planIds: ids }).strict(),
  files, bots: z.array(bot).max(4096), groups: z.array(group).max(4096), threads: z.array(thread).max(8192),
  plans: z.array(plan).max(4096), transitions: z.array(transition).max(32_768),
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type AccountRecoveryState = z.infer<typeof accountRecoveryStateSchema>;
export type RecoveryMessage = z.infer<typeof message>;
export type AccountRecoverySourceInput = Omit<AccountVisibleSourceInput, "plans"> & {
  plans: Pick<TaskPlanEngine, "listPlans" | "transitionsFor">;
};
const forbidden = new Set<string>([...CREDENTIAL_KEYS, "authToken", "secret", "resumeCursors",
  "requestId", "allowKey", "seedAnswer", "resumeKey", "executionHost", "instanceId", "lease", "delivery"].map(key => key.toLowerCase()));

/** Bound recursive JSON before z.json() traverses it; reject unsupported
 * values, cycles, unsafe property keys and explicitly nonportable authority. */
const scalarJson = z.union([z.null(), z.boolean(), z.string(), z.number().finite()]);
const containerJson = z.union([z.array(z.unknown()).max(500_000), z.record(z.string(), z.unknown())]);
function boundedJson<T>(value: T): boolean {
  const pending: Array<{ value: unknown; depth: number; exit?: boolean }> = [{ value, depth: 0 }];
  const seen = new Set<unknown>(); let nodes = 0;
  while (pending.length) {
    const item = pending.pop()!;
    const v = item.value;
    if (item.exit) { seen.delete(v); continue; }
    if (++nodes > 500_000 || item.depth > 24) return false;
    if (scalarJson.safeParse(v).success) continue;
    const container = containerJson.safeParse(v);
    if (!container.success || seen.has(v)) return false;
    seen.add(v);
    pending.push({ value: v, depth: item.depth, exit: true });
    if (!Array.isArray(container.data) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) return false;
    for (const key of Object.getOwnPropertyNames(v)) {
      if (forbidden.has(key.toLowerCase()) || key === "__proto__" || key === "constructor" || key === "prototype") return false;
    }
    for (const next of Object.values(container.data)) pending.push({ value: next, depth: item.depth + 1 });
  }
  return true;
}
function sameIds(left: readonly string[], right: readonly string[]) {
  return new Set(left).size === left.length && left.length === right.length && left.every(id => right.includes(id));
}
export function recoveryCanonicalJson<T>(value: T): string {
  return JSON.stringify(value, (_key, current) => Object.prototype.toString.call(current) === "[object Object]"
    ? Object.fromEntries(Object.entries(current).sort(([a], [b]) => a.localeCompare(b))) : current);
}
export function recoveryStateDigest<T extends object>(state: T): string {
  const { sourceDigest: _discarded, ...body } = { ...state, sourceDigest: "" };
  return createHash("sha256").update(recoveryCanonicalJson(body)).digest("hex");
}

/** Untrusted decrypted state is checked independently of a typed ready tag.
 * Content hashes establish consistency, never authorization or host custody. */
export function inspectAccountRecoveryState<T>(offered: T): AccountRecoveryState | null {
  try {
    if (!boundedJson(offered)) return null;
    if (Buffer.byteLength(JSON.stringify(offered)) > MAX_RECOVERY_STATE_BYTES) return null;
    const parsed = accountRecoveryStateSchema.safeParse(offered);
    if (!parsed.success) return null;
    const state = parsed.data;
    if (recoveryStateDigest(state) !== state.sourceDigest) return null;
    const documents = parseVisibleFiles(state.files);
    if (!documents.ok) return null;
    const botIds = state.bots.map(bot => bot.id), groupIds = state.groups.map(group => group.id);
    const threadIds = state.threads.map(thread => thread.threadId), planIds = state.plans.map(plan => plan.id);
    if (!sameIds(state.inventory.botIds, botIds) || !sameIds(state.inventory.groupIds, groupIds)
      || !sameIds(state.inventory.threadIds, threadIds) || !sameIds(state.inventory.planIds, planIds)
      || !sameIds(documents.soul.personas.map(persona => persona.botId), botIds)
      || !sameIds(documents.memory.bots.map(bot => bot.botId), botIds)
      || !sameIds(documents.sessions.threads.map(thread => thread.threadId), threadIds)) return null;
    for (const memory of documents.memory.bots) {
      if (Buffer.byteLength(memory.text) > MEMORY_FILE_MAX_BYTES || new Set(memory.topics.map(topic => topic.name)).size !== memory.topics.length
        || memory.topics.some(topic => !isMemoryTopicName(topic.name) || Buffer.byteLength(topic.text) > MEMORY_FILE_MAX_BYTES)) return null;
    }
    const owners = new Map<string, string>();
    const own = (id: string, owner: string) => {
      const prior = owners.get(id); if (prior !== undefined && prior !== owner) throw new Error("Ambiguous thread");
      owners.set(id, owner);
    };
    for (const bot of state.bots) {
      if (!bot.tasks.length || !sameIds(bot.tasks.map(task => task.threadId), [...new Set(bot.tasks.map(task => task.threadId))])
        || !bot.tasks.some(task => task.threadId === bot.threadId)) return null;
      for (const task of bot.tasks) own(task.threadId, `bot:${bot.id}`);
    }
    for (const group of state.groups) {
      if (!sameIds(group.memberIds, [...new Set(group.memberIds)]) || group.memberIds.some(id => !botIds.includes(id))
        || (group.defaultResponder.kind === "member" && !group.memberIds.includes(group.defaultResponder.botId))) return null;
      own(group.threadId, `group:${group.id}`);
    }
    if (!sameIds([...owners.keys()], threadIds)) return null;
    if (state.threads.reduce((total, thread) => total + thread.messages.length, 0) > 200_000) return null;
    for (const thread of state.threads) {
      const byId = new Map(thread.messages.map(message => [message.id, message]));
      if (byId.size !== thread.messages.length || (thread.messages.length > 0 && thread.activeLeafId === null)
        || (thread.activeLeafId !== null && !byId.has(thread.activeLeafId))) return null;
      const complete = new Set<string>();
      for (const message of thread.messages) {
        const chain = new Set<string>(); let cursor: string | null = message.id;
        while (cursor !== null && !complete.has(cursor)) {
          const current = byId.get(cursor);
          if (!current || chain.has(cursor)) return null;
          chain.add(cursor); cursor = current.parentId;
        }
        for (const id of chain) complete.add(id);
        if ((message.from && !botIds.includes(message.from.botId))
          || (message.comm && (!groupIds.includes(message.comm.groupId) || !botIds.includes(message.comm.withBotId)))
          || message.reactions?.some(reaction => reaction.by !== "user" && !botIds.includes(reaction.by))) return null;
      }
      const projected = documents.sessions.threads.find(candidate => candidate.threadId === thread.threadId)!;
      if (recoveryCanonicalJson(projected.messages) !== recoveryCanonicalJson(thread.messages.map(message => ({
        id: message.id, role: message.role, at: message.at, kind: message.kind, text: message.text ?? "", parentId: message.parentId,
      })))) return null;
    }
    for (const plan of state.plans) {
      const bot = state.bots.find(bot => bot.id === plan.botId);
      if (!bot || (plan.threadId !== undefined && !bot.tasks.some(task => task.threadId === plan.threadId))) return null;
      if (!sameIds(plan.steps.map(step => String(step.n)), [...new Set(plan.steps.map(step => String(step.n)))])
        || plan.steps.some((step, index) => step.n !== index + 1)
        || (plan.currentStep !== null && !plan.steps.some(step => step.n === plan.currentStep))
        || (plan.inputRequest && !plan.steps.some(step => step.n === plan.inputRequest!.step))
        || (plan.approvalRequest && !plan.steps.some(step => step.n === plan.approvalRequest!.step))) return null;
    }
    if (!sameIds(documents.tasks.tasks.map(task => task.id), [...state.bots.flatMap(bot => bot.tasks.map(task => task.threadId)), ...planIds])) return null;
    for (const event of state.transitions) {
      const plan = state.plans.find(plan => plan.id === event.planId);
      if (!plan || plan.botId !== event.botId || (event.step !== undefined && !plan.steps.some(step => step.n === event.step))) return null;
    }
    return structuredClone(state);
  } catch { return null; }
}
function pick<T extends object, K extends keyof T>(value: T, keys: readonly K[]): Pick<T, K> {
  // SAFETY: Only the requested keyof T properties are copied, with their exact original value types.
  const out = {} as Pick<T, K>;
  for (const key of keys) if (value[key] !== undefined) out[key] = value[key];
  return out;
}
function safeMessage(value: Message): RecoveryMessage {
  const raw = pick(value, ["id", "role", "kind", "at", "parentId", "text", "png", "mime", "from", "comm", "reactions"]);
  if (value.card) {
    const display = pick(value.card, ["title", "subtitle", "options", "answered", "dismissed", "tool", "held"]);
    if (value.card.why) Object.assign(display, { why: pick(value.card.why, ["source", "runId", "botId", "threadId", "at", "intent", "decisions", "outcome", "hypothesis", "findings"]) });
    if (value.card.rehearsal) Object.assign(display, { rehearsal: pick(value.card.rehearsal, ["plannedSteps", "matchedSteps", "matchedRuns", "reviewedRuns", "summary"]) });
    if (value.card.history) Object.assign(display, { history: pick(value.card.history, ["total", "approved", "denied", "auto", "lastDecision", "summary"]) });
    Object.assign(raw, { card: display });
  }
  if (value.connector) Object.assign(raw, { connector: pick(value.connector, ["slug", "label", "description", "status", "error", "dismissed"]) });
  if (value.tool) Object.assign(raw, { tool: pick(value.tool, ["name", "ok", "spoken", "setup"]) });
  if (value.compaction) Object.assign(raw, { compaction: pick(value.compaction, ["summary", "firstKeptId", "tokensBefore", "at"]) });
  if (value.privacy) Object.assign(raw, { privacy: pick(value.privacy, ["secrets", "emails", "phones"]) });
  if (value.via) Object.assign(raw, { via: pick(value.via, ["model", "effort"]) });
  if (!boundedJson(raw)) throw new Error("Invalid source row");
  return message.parse(raw);
}

export function captureAccountRecoveryState(input: {
  source: AccountRecoverySourceInput; resolveAccount: ResolveVisibleAccount;
}): { status: "ready"; state: AccountRecoveryState; excludes: typeof ACCOUNT_RECOVERY_EXCLUDES }
  | { status: "unavailable"; reason: "account-unavailable" | "account-changed" | "source-unavailable" | "state-invalid" } {
  const authority = resolveAuthenticatedVisibleAccount(input.resolveAccount);
  if (!authority) return { status: "unavailable", reason: "account-unavailable" };
  if (!sameVisibleAuthority(authority, { account: input.source.account, googleSub: authority.googleSub })) return { status: "unavailable", reason: "account-changed" };
  try {
    const fingerprint = () => JSON.stringify({ bots: input.source.store.bots, groups: input.source.store.groups,
      plans: input.source.plans.listPlans(), transitions: input.source.plans.transitionsFor() });
    const before = fingerprint();
    const originals = new Map<string, string>();
    const visible = readAccountVisibleSource({ ...input.source, store: {
      bots: input.source.store.bots, groups: input.source.store.groups,
      snapshotThread: threadId => { const snapshot = input.source.store.snapshotThread(threadId);
        originals.set(threadId, JSON.stringify(snapshot)); return snapshot; },
    } });
    if (visible.status !== "ready" || !inspectAccountProjection(visible)) return { status: "unavailable", reason: "source-unavailable" };
    const bots = input.source.store.bots.filter(bot => visible.inventory.botIds.includes(bot.id)).map(value => ({
      ...pick(value, ["id", "threadId", "name", "title", "description", "color", "character", "mascotExpression", "createdAt",
        "notifications", "unread", "pinned", "hidden", "privacyShield", "speakReplies", "voice", "tokenBudget", "dailyUsdCap"]),
      tasks: (value.tasks ?? []).map(task => pick(task, ["threadId", "title", "createdAt", "titleSource", "usage"])),
    }));
    const groups = input.source.store.groups.filter(group => visible.inventory.groupIds.includes(group.id)).map(value =>
      pick(value, ["id", "threadId", "name", "memberIds", "defaultResponder", "bulletin", "unread", "createdAt", "dm"]));
    const plans = input.source.plans.listPlans().filter(plan => visible.inventory.taskIds.includes(plan.id)).map(value =>
      pick(value, ["id", "botId", "threadId", "title", "status", "steps", "currentStep", "pausedFrom", "attempts", "maxAttempts",
        "inputRequest", "approvalRequest", "inputAnswers", "lastError", "createdAt", "updatedAt"]));
    const planIds = plans.map(plan => plan.id).sort();
    const transitions = input.source.plans.transitionsFor().filter(event => planIds.includes(event.planId)).map(value =>
      pick(value, ["planId", "botId", "from", "to", "at", "action", "step", "reason"]));
    const threads = visible.inventory.threadIds.map(threadId => {
      const snapshot = input.source.store.snapshotThread(threadId);
      if (snapshot.status !== "ready") throw new Error("Unavailable source");
      if (originals.get(threadId) !== JSON.stringify(snapshot)) throw new Error("Source changed");
      return { threadId, activeLeafId: snapshot.activeLeafId, messages: snapshot.messages.map(safeMessage) };
    });
    const body = { version: 1 as const, kind: RECOVERY_STATE_FORMAT, scope: "account-owned" as const,
      source: { userId: authority.account.userId, workspaceId: authority.account.workspaceId, googleSub: authority.googleSub },
      inventory: { botIds: visible.inventory.botIds, groupIds: visible.inventory.groupIds, threadIds: visible.inventory.threadIds, planIds },
      files: visible.files, bots, groups, threads, plans, transitions };
    const offered = { ...body, sourceDigest: recoveryStateDigest(body) };
    const state = inspectAccountRecoveryState(offered);
    if (!state) return { status: "unavailable", reason: "state-invalid" };
    for (const [id, original] of originals) if (JSON.stringify(input.source.store.snapshotThread(id)) !== original) throw new Error("Source changed");
    const repeated = readAccountVisibleSource(input.source);
    if (repeated.status !== "ready" || repeated.digest !== visible.digest || before !== fingerprint()) throw new Error("Source changed");
    if (!sameVisibleAuthority(authority, resolveAuthenticatedVisibleAccount(input.resolveAccount))) return { status: "unavailable", reason: "account-changed" };
    return { status: "ready", state, excludes: ACCOUNT_RECOVERY_EXCLUDES };
  } catch { return { status: "unavailable", reason: "source-unavailable" }; }
}
