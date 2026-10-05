// Additive restore preparation only. A future coordinated writer must bind this
// plan to a durable journal and a fresh host inventory before touching records.
// No Store constructor, mutation, credential engine, filesystem or network IO.
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { resolveAuthenticatedVisibleAccount, sameVisibleAuthority, type ResolveVisibleAccount } from "./drive-visible-account-bundle.ts";
import { parseVisibleFiles } from "./drive-visible.ts";
import { ACCOUNT_RECOVERY_EXCLUDES, inspectAccountRecoveryState, recoveryCanonicalJson,
  type AccountRecoveryState, type RecoveryMessage } from "./drive-visible-account-state.ts";

const id = z.string().min(1).max(200).regex(/^[\w-]+$/);
const ids = z.array(id).max(32_768).refine(ids => new Set(ids).size === ids.length);
const destinationSchema = z.object({ userId: z.string().min(1).max(200), workspaceId: z.string().min(1).max(200),
  revision: z.string().min(1).max(200), botIds: ids, groupIds: ids, threadIds: ids, planIds: ids }).strict();
/** Host-read inventory must cover every existing record, including other users.
 * revision is the host's store revision, not caller-provided request metadata. */
export type RecoveryDestination = z.infer<typeof destinationSchema>;
export type ReadRecoveryDestination = () => RecoveryDestination | null;
export type RecoveryIdKind = "bot" | "group" | "thread" | "plan";
export type RecoveryIdMap = Record<RecoveryIdKind, Record<string, string>>;
const mapSchema = z.object({ bot: z.record(id, id), group: z.record(id, id), thread: z.record(id, id), plan: z.record(id, id) }).strict();
export function recoveryDestinationDigest(destination: RecoveryDestination): string {
  return createHash("sha256").update(recoveryCanonicalJson({ ...destination,
    botIds: [...destination.botIds].sort(), groupIds: [...destination.groupIds].sort(),
    threadIds: [...destination.threadIds].sort(), planIds: [...destination.planIds].sort() })).digest("hex");
}
function readDestination(read: ReadRecoveryDestination): RecoveryDestination | null {
  try { const parsed = destinationSchema.safeParse(read()); return parsed.success ? parsed.data : null; } catch { return null; }
}
const ID_KINDS = ["bot", "group", "thread", "plan"] as const;
function sourceIds(state: AccountRecoveryState) {
  return { bot: state.inventory.botIds, group: state.inventory.groupIds, thread: state.inventory.threadIds, plan: state.inventory.planIds };
}
function mapValid(mapping: RecoveryIdMap, state: AccountRecoveryState, destination: RecoveryDestination): boolean {
  const original = sourceIds(state);
  const denied = new Set([...Object.values(original).flat(), ...destination.botIds, ...destination.groupIds, ...destination.threadIds, ...destination.planIds]);
  const used = new Set<string>();
  for (const kind of ID_KINDS) {
    const keys = Object.keys(mapping[kind]);
    if (keys.length !== original[kind].length || keys.some(key => !original[kind].includes(key))) return false;
    for (const old of original[kind]) {
      const fresh = mapping[kind][old]!;
      if (denied.has(fresh) || used.has(fresh)) return false;
      used.add(fresh);
    }
  }
  return true;
}
interface RecoveryActionHistory { mode: "inert-history"; card?: RecoveryMessage["card"]; connector?: RecoveryMessage["connector"] }
function inertMessage(message: RecoveryMessage, mapping: RecoveryIdMap) {
  // Action history stays readable separately, never becomes a live respond or
  // reconnect card. Even an answered historic approval confers no permission.
  const { card, connector, ...display } = structuredClone(message);
  if (display.from) display.from.botId = mapping.bot[display.from.botId]!;
  if (display.comm) {
    display.comm.groupId = mapping.group[display.comm.groupId]!;
    display.comm.withBotId = mapping.bot[display.comm.withBotId]!;
  }
  if (display.reactions) display.reactions = display.reactions.map(reaction => ({ ...reaction,
    by: reaction.by === "user" ? "user" : mapping.bot[reaction.by]! }));
  if (display.tool) {
    const tool = z.object({ name: z.string(), ok: z.boolean().optional(), spoken: z.string().optional() }).safeParse(display.tool);
    if (!tool.success) throw new Error("Invalid historical tool");
    display.tool = tool.data;
  }
  const actionHistory: RecoveryActionHistory = { mode: "inert-history" };
  if (card !== undefined) actionHistory.card = card;
  if (connector !== undefined) actionHistory.connector = connector;
  return { message: display, actionHistory: card === undefined && connector === undefined ? null : actionHistory };
}
export type AccountImportPlan = Extract<ReturnType<typeof prepareAccountRecoveryImport>, { status: "ready" }>["plan"];

/** Revalidate untrusted decrypted state and current host identity. Returning a
 * ready plan authorizes no writes or execution. Persist its mapping with the
 * future journal; never regenerate IDs halfway through a retry. */
export function prepareAccountRecoveryImport(input: {
  state: unknown; resolveAccount: ResolveVisibleAccount; readDestination: ReadRecoveryDestination;
  mapping?: RecoveryIdMap; freshId?: (kind: RecoveryIdKind, sourceId: string) => string;
}) {
  const unavailable = (reason: "account-unavailable" | "account-changed" | "state-invalid" | "destination-unavailable" | "destination-changed" | "mapping-invalid") =>
    ({ status: "unavailable" as const, reason });
  const authority = resolveAuthenticatedVisibleAccount(input.resolveAccount);
  if (!authority) return unavailable("account-unavailable");
  const state = inspectAccountRecoveryState(input.state);
  if (!state || state.source.googleSub !== authority.googleSub) return unavailable("state-invalid");
  const destination = readDestination(input.readDestination);
  if (!destination || destination.userId !== authority.account.userId || destination.workspaceId !== authority.account.workspaceId) return unavailable("destination-unavailable");
  const destinationDigest = recoveryDestinationDigest(destination);
  try {
    const source = sourceIds(state);
    const offered = input.mapping ?? Object.fromEntries(ID_KINDS.map(kind =>
      [kind, Object.fromEntries(source[kind].map(old => [old, input.freshId?.(kind, old) ?? randomUUID()]))]));
    const parsed = mapSchema.safeParse(offered);
    if (!parsed.success || !mapValid(parsed.data, state, destination)) return unavailable("mapping-invalid");
    const mapping = parsed.data;
    const bots = state.bots.map(bot => ({ ...structuredClone(bot), id: mapping.bot[bot.id]!, ownerId: authority.account.userId,
      threadId: mapping.thread[bot.threadId]!, tasks: bot.tasks.map(task => ({ ...task, threadId: mapping.thread[task.threadId]!, resumeCursors: {} })),
      engineSelection: null, execution: "requires-explicit-engine-selection" as const, resumeCursors: {},
      autoApprove: false, alwaysAllow: [], approvePeerComms: false, chiefOfStaff: false, computer: "off" as const, browser: false, composio: false,
      // Saved speech is history, never permission to produce audio after import.
      speakReplies: false }));
    const groups = state.groups.map(group => ({ ...structuredClone(group), id: mapping.group[group.id]!, ownerId: authority.account.userId,
      threadId: mapping.thread[group.threadId]!, memberIds: group.memberIds.map(id => mapping.bot[id]!),
      defaultResponder: group.defaultResponder.kind === "member" ? { kind: "member" as const, botId: mapping.bot[group.defaultResponder.botId]! } : group.defaultResponder }));
    const threads = state.threads.map(thread => ({ threadId: mapping.thread[thread.threadId]!, activeLeafId: thread.activeLeafId,
      rows: thread.messages.map(message => inertMessage(message, mapping)) }));
    const plans = state.plans.map(plan => ({ ...structuredClone(plan), id: mapping.plan[plan.id]!, botId: mapping.bot[plan.botId]!,
      ownerId: authority.account.userId, threadId: plan.threadId === undefined ? undefined : mapping.thread[plan.threadId]!,
      status: plan.status === "succeeded" || plan.status === "failed" || plan.status === "cancelled" ? plan.status : "paused",
      pausedFrom: undefined, inputRequest: undefined, approvalRequest: undefined,
      steps: plan.steps.map(step => ({ ...step, status: step.status === "active" ? "pending" as const : step.status })),
      execution: "requires-explicit-reconsent" as const,
      history: { originalStatus: plan.status, originalPausedFrom: plan.pausedFrom, originalSteps: structuredClone(plan.steps),
        inputRequest: plan.inputRequest, approvalRequest: plan.approvalRequest } }));
    const transitions = state.transitions.map(event => ({ ...event, planId: mapping.plan[event.planId]!, botId: mapping.bot[event.botId]!,
      mode: "inert-history" as const }));
    const parsedDocuments = parseVisibleFiles(state.files);
    if (!parsedDocuments.ok) return unavailable("state-invalid");
    const memory = parsedDocuments.memory.bots.map(memory => ({ ...structuredClone(memory), botId: mapping.bot[memory.botId]! }));
    const preferences = { userId: authority.account.userId, workspaceId: authority.account.workspaceId,
      mode: "capture-only" as const, values: structuredClone(parsedDocuments.settings.settings) };
    const documents = state.files; // Preserved source projection, not overwrite instructions or live config.
    const plan = { version: 1 as const, mode: "additive-preparation" as const, writesNothing: true as const, apply: "unsupported" as const,
      account: authority.account, googleSub: authority.googleSub, sourceDigest: state.sourceDigest, destinationDigest,
      sourceAccount: state.source, mapping, bots, groups, threads, plans, transitions, memory, preferences,
      sourceProjection: structuredClone(documents), excludes: ACCOUNT_RECOVERY_EXCLUDES };
    if (!sameVisibleAuthority(authority, resolveAuthenticatedVisibleAccount(input.resolveAccount))) return unavailable("account-changed");
    const current = readDestination(input.readDestination);
    if (!current || recoveryDestinationDigest(current) !== destinationDigest) return unavailable("destination-changed");
    return { status: "ready" as const, plan };
  } catch { return unavailable("mapping-invalid"); }
}

/** This is a freshness check only, not a transaction or compare-and-swap.
 * A future writer still needs atomic owned-record insertion and crash rollback. */
export function isAccountRecoveryPlanCurrent(input: { plan: { account: NonNullable<ReturnType<typeof resolveAuthenticatedVisibleAccount>>["account"];
  googleSub: string; destinationDigest: string }; resolveAccount: ResolveVisibleAccount; readDestination: ReadRecoveryDestination }): boolean {
  const authority = resolveAuthenticatedVisibleAccount(input.resolveAccount);
  const destination = readDestination(input.readDestination);
  return sameVisibleAuthority(input.plan, authority) && destination !== null
    && destination.userId === input.plan.account.userId && destination.workspaceId === input.plan.account.workspaceId
    && recoveryDestinationDigest(destination) === input.plan.destinationDigest;
}
