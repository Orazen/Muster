// Additive adapter for a host-supplied, same-runtime cooperating write capability.
// Production registration supplies none until lifetime writer/boot authority exists.
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { DATA_DIR } from "./data-root-path.ts";
import { EFFORT_LEVELS, type ModelSelection, type TaskPlanRecord } from "./contracts.ts";
import { AGENT_CHARACTERS, type BotRecord, type GroupRecord, type Message, type Store } from "./store.ts";
import type { TaskPlanEngine } from "./task-engine.ts";
import * as messageDb from "./message-db.ts";
import { normalizeBotProfile } from "./bot-profile.ts";
import { userInstanceOwner } from "./user-keys.ts";
import { resolveAuthenticatedVisibleAccount, sameVisibleAuthority, type ResolveVisibleAccount } from "./drive-visible-account-bundle.ts";
import { buildAccountRecoveryArchive, inspectAccountRecoveryArchive, MAX_ACCOUNT_RECOVERY_ARCHIVE_BYTES } from "./drive-visible-account-archive.ts";
import type { UserHeldAccountDecryption } from "./drive-visible-restore.ts";
import { prepareAccountRecoveryImport, type AccountImportPlan, type RecoveryDestination } from "./drive-visible-account-import-plan.ts";
import type { CurrentOwnedRecoveryEngine } from "./drive-visible-account-import.ts";
import type { AccountSettingsSnapshot } from "./drive-visible-data-source.ts";
import { recoveryCanonicalJson } from "./drive-visible-account-state.ts";
import { liveRead, liveHash, openLiveJournal, type LiveIntent, type LiveReceipt } from "./drive-visible-live-journal.ts";

export const liveSelectionSchema = z.object({ instanceId: z.string().min(1).max(200), model: z.string().min(1).max(200), effort: z.enum(EFFORT_LEVELS).optional() }).strict();
export interface LiveRestoreRuntime {
  dataDir: string; store: Store; plans: TaskPlanEngine;
  /** Required host capability, never request metadata/boolean/marker. It must
   * remain held through the synchronous frame. This is NOT OS isolation. */
  assertReady(): void;
  resolveEngine(selection: ModelSelection, account: NonNullable<ReturnType<typeof resolveAuthenticatedVisibleAccount>>["account"]): CurrentOwnedRecoveryEngine | null;
  readSettings(account: NonNullable<ReturnType<typeof resolveAuthenticatedVisibleAccount>>["account"]): AccountSettingsSnapshot | null;
  engineChoices?(account: NonNullable<ReturnType<typeof resolveAuthenticatedVisibleAccount>>["account"]): Array<{ label: string; selection: ModelSelection }>;
  publish?(account: { userId: string; workspaceId: string }, result: LiveRestoreResult): void;
}
export type LiveRestoreResult = { status: "committed"; operationId: string; scope: "account-owned"; mode: "additive";
  sourceDigest: string; mapping: LiveIntent["mapping"]; execution: "not-started"; rollback: "pending-only";
  history: "archive-only"; durability: "process-restart-only"; targetCopy: LiveIntent["targetCopy"] };
export class LiveRestoreFailure extends Error {
  readonly code: "preflight-refused" | "operation-unavailable" | "operation-blocked" | "rolled-back" | "rollback-failed";
  constructor(code: LiveRestoreFailure["code"]) { super("Account restore could not be confirmed"); this.code = code; }
}
function result(intent: LiveIntent): LiveRestoreResult {
  return { status: "committed", operationId: intent.operationId, scope: "account-owned", mode: "additive", sourceDigest: intent.sourceDigest,
    mapping: structuredClone(intent.mapping), execution: "not-started", rollback: "pending-only", history: "archive-only", durability: "process-restart-only", targetCopy: structuredClone(intent.targetCopy) };
}
function bound(runtime: LiveRestoreRuntime): void {
  runtime.assertReady();
  const canonical = realpathSync(runtime.dataDir), captured = realpathSync(DATA_DIR), planFile = runtime.plans.recoveryFile();
  if (resolve(runtime.dataDir) !== canonical || canonical !== captured || basename(planFile) !== "task-plans.json"
    || realpathSync(dirname(planFile)) !== canonical) throw new LiveRestoreFailure("preflight-refused");
}
function inventory(runtime: LiveRestoreRuntime, account: { userId: string; workspaceId: string }): RecoveryDestination {
  bound(runtime);
  const bots = runtime.store.bots, groups = runtime.store.groups;
  const threads = new Set([...messageDb.recoveryThreadIds(), ...bots.flatMap(bot => [bot.threadId, ...(bot.tasks ?? []).map(task => task.threadId)]), ...groups.map(group => group.threadId)]);
  for (const name of readdirSync(runtime.dataDir)) { const match = /^messages-([\w-]+)\.json(?:\.imported)?$/.exec(name); if (match) threads.add(match[1]!); }
  // IDs/roster/plan bytes suffice for a fresh-only append. Never read another
  // account's full transcripts to construct destination freshness.
  return { userId: account.userId, workspaceId: account.workspaceId,
    revision: liveHash(recoveryCanonicalJson({ bots, groups, plans: runtime.plans.listPlans(), transitions: runtime.plans.transitionsFor(),
      files: ["bots.json", "groups.json", "task-plans.json"].map(name => liveRead(join(runtime.dataDir, name)).bytes) })),
    botIds: [...new Set([...bots.map(bot => bot.id), ...groups.flatMap(group => group.memberIds), ...runtime.plans.listPlans().map(plan => plan.botId), ...messageDb.recoveryReservedBotIds()])],
    groupIds: groups.map(group => group.id), threadIds: [...threads], planIds: runtime.plans.recoveryPlanIds() };
}
function engine(runtime: LiveRestoreRuntime, selection: ModelSelection, authority: NonNullable<ReturnType<typeof resolveAuthenticatedVisibleAccount>>) {
  bound(runtime); const offered = runtime.resolveEngine(selection, authority.account), declared = userInstanceOwner(selection.instanceId);
  if (!offered || offered.ownerId !== authority.account.userId || !offered.instance.enabled || offered.instance.instanceId !== selection.instanceId
    || !isDeepStrictEqual(offered.selection, selection) || (declared !== null ? declared !== authority.account.userId : !authority.account.isPrimary)
    || !offered.instance.models.options.some(option => option.id === selection.model)
    || (selection.effort !== undefined && !(offered.instance.adapter.capabilities.effortLevels ?? []).includes(selection.effort))) throw new LiveRestoreFailure("preflight-refused");
  return offered;
}
function materialize(plan: AccountImportPlan, engines: Map<string,ModelSelection>) {
  const bots:BotRecord[]=plan.bots.map(bot=>{
    const {engineSelection:_engine,execution:_execution,...safe}=bot;
    if(safe.character!==undefined && safe.character!=="lottie" && !AGENT_CHARACTERS.some(character=>character===safe.character))throw new Error("Unsupported recovered character");
    // Source display strings are schema-validated here instead of fabricated
    // engine/provenance IDs. Historical via-chips remain in the inert archive.
    const normalized=normalizeBotProfile({...safe,modelSelection:engines.get(bot.id)!});
    if(normalized.color!==safe.color)throw new Error("Unsupported recovered color");
    // SAFETY: character is checked against the actual BotRecord vocabulary
    // above; mascotExpression is the captured optional string/null display value.
    return {...normalized,character:safe.character as BotRecord["character"],mascotExpression:safe.mascotExpression as BotRecord["mascotExpression"],busy:false,activity:"idle"};
  });
  const groups:GroupRecord[]=plan.groups.map(group=>({...group,busyBotId:null}));
  const threads:messageDb.FreshRecoveryThread[]=plan.threads.map(thread=>({threadId:thread.threadId,activeLeafId:thread.activeLeafId,
    messages:thread.rows.map(row=>{
      const {via:_historicalVia,...display}=row.message;
      // SAFETY: the closed archive display schema validates Message fields;
      // planner removes actionable cards/connectors and historical via is omitted.
      return display as Message;
    })}));
  const plans:TaskPlanRecord[]=plan.plans.map(plan=>{
    const {execution:_execution,history:_history,...record}=plan;
    // SAFETY: the planner emits only the actual paused/terminal TaskPlanStatus
    // vocabulary with all live lease/input/approval/delivery authority removed.
    return {...record,status:record.status as TaskPlanRecord["status"],currentStep:null};
  });
  // SAFETY: this JSON round-trip preserves the typed, validated material above
  // and only removes undefined optional fields for actual durable comparisons.
  return JSON.parse(JSON.stringify({bots,groups,threads,plans})) as {bots:BotRecord[];groups:GroupRecord[];threads:messageDb.FreshRecoveryThread[];plans:TaskPlanRecord[]};
}

export function readLiveRestoreReceipt(runtime: LiveRestoreRuntime, operationId: string, account: { userId: string; workspaceId: string }): LiveRestoreResult {
  bound(runtime);
  if (!existsSync(join(runtime.dataDir, "account-live-restore-journal"))) throw new LiveRestoreFailure("operation-unavailable");
  const journal = openLiveJournal(runtime.dataDir);
  try {
    const saved = journal.load(operationId);
    if (!saved || saved.intent.userId !== account.userId || saved.intent.workspaceId !== account.workspaceId || saved.receipt.status !== "committed") throw new LiveRestoreFailure("operation-unavailable");
    // A durable historical receipt is not a claim that restored records have
    // never subsequently changed. Other account saves do not invalidate it.
    return result(saved.intent);
  } finally { journal.release(); }
}
export async function applyLiveAccountRestore(input: { runtime: LiveRestoreRuntime; resolveAccount: ResolveVisibleAccount;
  archive: Buffer; key: UserHeldAccountDecryption; operationId: string; expectedSourceDigest: string; selection: ModelSelection;
  signal?: AbortSignal; onPhase?: (phase: string) => void }): Promise<LiveRestoreResult> {
  const { runtime } = input;
  z.string().uuid().parse(input.operationId); z.string().regex(/^[a-f0-9]{64}$/).parse(input.expectedSourceDigest);
  const selection = liveSelectionSchema.parse(input.selection); bound(runtime);
  const authority = resolveAuthenticatedVisibleAccount(input.resolveAccount);
  if (!authority || !Buffer.isBuffer(input.archive) || input.archive.length > MAX_ACCOUNT_RECOVERY_ARCHIVE_BYTES) throw new LiveRestoreFailure("preflight-refused");
  const archive = Buffer.from(input.archive), archiveHash = liveHash(archive);
  const current = () => { bound(runtime); if (input.signal?.aborted || !sameVisibleAuthority(authority, resolveAuthenticatedVisibleAccount(input.resolveAccount))) throw new LiveRestoreFailure("preflight-refused"); };
  current();
  // Before any engine await, replay a historical committed receipt. Keys and
  // provider availability are not needed to repeat an already accepted intent.
  const prior = openLiveJournal(runtime.dataDir);
  try {
    const saved = prior.load(input.operationId);
    if (saved) {
      if (saved.intent.userId !== authority.account.userId || saved.intent.workspaceId !== authority.account.workspaceId
        || saved.intent.googleSub !== authority.googleSub || saved.intent.archiveHash !== archiveHash || saved.intent.sourceDigest !== input.expectedSourceDigest) throw new LiveRestoreFailure("operation-unavailable");
      if (saved.receipt.status === "committed") return result(saved.intent);
      throw new LiveRestoreFailure("operation-blocked");
    }
    for (const id of prior.list()) { const saved = prior.load(id)!; if (["pending", "rollback-failed"].includes(saved.receipt.status)) throw new LiveRestoreFailure("operation-blocked"); }
  } finally { prior.release(); }
  const inspected = inspectAccountRecoveryArchive({ bytes: archive, key: input.key, resolveAccount: input.resolveAccount });
  if (inspected.status !== "ready" || inspected.state.sourceDigest !== input.expectedSourceDigest) throw new LiveRestoreFailure("preflight-refused");
  const selected = engine(runtime, selection, authority), snapshot = await selected.instance.snapshot();
  current();
  if (snapshot.state !== "available" || snapshot.authenticated === false || engine(runtime, selection, authority).instance !== selected.instance) throw new LiveRestoreFailure("preflight-refused");
  // There is NO await from acquisition through commit/compensation. Normal
  // same-runtime writers cannot interleave. Unknown external writers are not
  // excluded; conflicting postimages retain evidence rather than overwrite.
  const journal = openLiveJournal(runtime.dataDir);
  let receipt: LiveReceipt | undefined, intent: LiveIntent | undefined;
  const beforeRoster = { bots: structuredClone(runtime.store.bots), groups: structuredClone(runtime.store.groups) };
  const beforePlans = { plans: runtime.plans.listPlans(), transitions: runtime.plans.transitionsFor() };
  let afterRoster = structuredClone(beforeRoster), afterPlans = structuredClone(beforePlans);
  const phase = (phase: string) => { current(); journal.assert(); input.onPhase?.(phase); current(); journal.assert(); };
  try {
    current(); if (journal.load(input.operationId)) throw new LiveRestoreFailure("operation-blocked");
    for (const id of journal.list()) { if (["pending", "rollback-failed"].includes(journal.load(id)!.receipt.status)) throw new LiveRestoreFailure("operation-blocked"); }
    const prepared = prepareAccountRecoveryImport({ state: inspected.state, resolveAccount: input.resolveAccount, readDestination: () => inventory(runtime, authority.account) });
    if (prepared.status !== "ready") throw new LiveRestoreFailure("preflight-refused");
    const plan = prepared.plan, material = materialize(plan, new Map(Object.values(plan.mapping.bot).map(id => [id, selection])));
    afterRoster = { bots: [...beforeRoster.bots, ...material.bots], groups: [...beforeRoster.groups, ...material.groups] };
    afterPlans = { plans: [...beforePlans.plans, ...material.plans], transitions: beforePlans.transitions };
    const before = (name: string) => liveRead(join(runtime.dataDir, name));
    const bots = before("bots.json"), groups = before("groups.json"), plans = before("task-plans.json");
    runtime.plans.checkFreshRecoveryPlans(material.plans, plans.bytes);
    const changes: LiveIntent["changes"] = [
      { path: "bots.json", before: bots.bytes, mode: bots.mode, after: JSON.stringify([...JSON.parse(bots.bytes ?? "[]"), ...material.bots], null, 2) },
      { path: "groups.json", before: groups.bytes, mode: groups.mode, after: JSON.stringify([...JSON.parse(groups.bytes ?? "[]"), ...material.groups.map(({ busyBotId: _busy, ...group }) => group)], null, 2) },
      { path: "task-plans.json", before: plans.bytes, mode: plans.mode, after: JSON.stringify({ version: 1, plans: afterPlans.plans, transitions: beforePlans.transitions }, null, 2) },
    ];
    for (const memory of plan.memory) {
      if (existsSync(join(runtime.dataDir, "workspaces", memory.botId))) throw new LiveRestoreFailure("preflight-refused");
      changes.push({ path: `workspaces/${memory.botId}/MEMORY.md`, before: null, after: memory.text, mode: 0o600 });
      for (const topic of memory.topics) changes.push({ path: `workspaces/${memory.botId}/memory/${topic.name}`, before: null, after: topic.text, mode: 0o600 });
    }
    const dirs = new Set<string>();
    for (const change of changes.filter(change => change.path.startsWith("workspaces/"))) {
      for (let path = dirname(change.path); path !== "."; path = dirname(path)) if (!existsSync(join(runtime.dataDir, path))) dirs.add(path);
    }
    phase("preflight"); engine(runtime, selection, authority);
    if (changes.some(change => liveRead(join(runtime.dataDir, change.path)).bytes !== change.before)
      || !isDeepStrictEqual(runtime.store.bots, beforeRoster.bots) || !isDeepStrictEqual(runtime.store.groups, beforeRoster.groups)
      || !isDeepStrictEqual(runtime.plans.listPlans(), beforePlans.plans) || !isDeepStrictEqual(runtime.plans.transitionsFor(), beforePlans.transitions)) throw new LiveRestoreFailure("preflight-refused");
    const heldSecret = input.key.passphrase ?? input.key.recoveryCode;
    if (!heldSecret) throw new LiveRestoreFailure("preflight-refused");
    const targetKey = { custody: "user-held" as const, passphrase: heldSecret };
    const target = buildAccountRecoveryArchive({ source: { account: authority.account, dataDir: runtime.dataDir, store: runtime.store, plans: runtime.plans,
      settingsSnapshot: runtime.readSettings(authority.account) }, resolveAccount: input.resolveAccount, key: targetKey, appVersion: "account-live-recovery" });
    current();
    if (target.status !== "ready") throw new LiveRestoreFailure("preflight-refused");
    const verifiedTarget = inspectAccountRecoveryArchive({ bytes: target.bytes, key: targetKey, resolveAccount: input.resolveAccount });
    if (verifiedTarget.status !== "ready" || verifiedTarget.state.sourceDigest !== target.sourceDigest) throw new LiveRestoreFailure("preflight-refused");
    phase("target-copy");
    if (changes.some(change => liveRead(join(runtime.dataDir, change.path)).bytes !== change.before)
      || !isDeepStrictEqual(runtime.store.bots, beforeRoster.bots) || !isDeepStrictEqual(runtime.store.groups, beforeRoster.groups)
      || !isDeepStrictEqual(runtime.plans.listPlans(), beforePlans.plans) || !isDeepStrictEqual(runtime.plans.transitionsFor(), beforePlans.transitions)) throw new LiveRestoreFailure("preflight-refused");
    receipt = journal.begin({ version: 1, kind: "account-live-additive", operationId: input.operationId, userId: authority.account.userId,
      workspaceId: authority.account.workspaceId, googleSub: authority.googleSub, archiveHash, sourceDigest: plan.sourceDigest, mapping: plan.mapping,
      targetCopy: { sha256: liveHash(target.bytes), sourceDigest: target.sourceDigest, keyMode: "provided-secret-as-passphrase" },
      changes, threads: material.threads.map(thread => ({ ...thread, messages: thread.messages.map(message => ({ ...message })) })),
      inertHistory: recoveryCanonicalJson(plan), createdDirs: [...dirs] }, target.bytes);
    intent = journal.load(input.operationId)!.intent;
    const durableTarget = inspectAccountRecoveryArchive({ bytes: journal.targetCopy(input.operationId), key: targetKey, resolveAccount: input.resolveAccount });
    if (durableTarget.status !== "ready" || durableTarget.state.sourceDigest !== intent.targetCopy.sourceDigest) throw new LiveRestoreFailure("preflight-refused");
    // The exact normalized signed payload is also the SQL marker payload.
    // SAFETY: the strict archive/planner material was schema-normalized when signed.
    const threads = intent.threads as messageDb.FreshRecoveryThread[];
    phase("intent"); messageDb.insertFreshRecoveryThreads(input.operationId, threads);
    receipt = journal.mark(receipt, "pending", "threads"); phase("threads");
    runtime.plans.insertFreshRecoveryPlans(material.plans, plans.bytes); receipt = journal.mark(receipt, "pending", "plans"); phase("plans");
    runtime.store.insertFreshRecoveryRoster(material, { bots: bots.bytes, groups: groups.bytes }); receipt = journal.mark(receipt, "pending", "roster"); phase("roster");
    for (const change of changes.filter(change => change.path.startsWith("workspaces/"))) { current(); journal.writeFresh(change); }
    receipt = journal.mark(receipt, "pending", "memory"); phase("memory");
    const matches = () => !changes.some(change => liveRead(join(runtime.dataDir, change.path)).bytes !== change.after)
      && messageDb.freshRecoveryThreadsMatch(input.operationId, threads) && isDeepStrictEqual(runtime.store.bots, afterRoster.bots)
      && isDeepStrictEqual(runtime.store.groups, afterRoster.groups) && isDeepStrictEqual(runtime.plans.listPlans(), afterPlans.plans)
      && isDeepStrictEqual(runtime.plans.transitionsFor(), afterPlans.transitions) && runtime.store.recoveryThreadCachesMatch(threads);
    if (!matches()) throw new LiveRestoreFailure("preflight-refused");
    phase("readback"); engine(runtime, selection, authority);
    if (!matches()) throw new LiveRestoreFailure("preflight-refused");
    // Recheck account/grant/cancellation after engine resolution and durable
    // postimage reads, immediately before the completion marker.
    current(); journal.assert();
    receipt = journal.mark(receipt, "committed", "committed");
    const committed = result(intent);
    try {
      input.onPhase?.("committed");
      // Publication needs current authority even after the durable commit.
      // Losing it suppresses the event, never compensates committed records.
      current();
      runtime.publish?.({ userId: authority.account.userId, workspaceId: authority.account.workspaceId }, committed);
      input.onPhase?.("ack");
    } catch { /* Receipt remains committed; publication/ack is never a rollback trigger. */ }
    return committed;
  } catch (error) {
    if (!intent || !receipt) throw error;
    if (journal.load(input.operationId)?.receipt.status === "committed") return result(intent);
    // SAFETY: the strict archive/planner material was schema-normalized when signed.
    const threads = intent.threads as messageDb.FreshRecoveryThread[];
    const owned = runtime.store.recoveryRosterMatches(beforeRoster, afterRoster) && runtime.plans.recoveryPlansMatch(beforePlans, afterPlans)
      && runtime.store.recoveryThreadCachesMatch(threads, true);
    if (!owned) { journal.mark(receipt, "rollback-failed", "cache-postimage-changed"); throw new LiveRestoreFailure("rollback-failed"); }
    try {
      journal.compensate(intent);
      runtime.store.reloadCompensatedRecoveryRoster(beforeRoster, afterRoster, threads); runtime.plans.reloadCompensatedRecoveryPlans(beforePlans, afterPlans);
      journal.mark(receipt, "rolled-back", "compensated");
    } catch { journal.mark(receipt, "rollback-failed", "compensation-unavailable"); throw new LiveRestoreFailure("rollback-failed"); }
    throw new LiveRestoreFailure("rolled-back");
  } finally { journal.release(); }
}
