// Actual additive writer for newly owned SYNTHETIC offline roots only. No HTTP,
// runtime boot binding, Drive mutation, settings overwrite or engine dispatch.
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { DATA_DIR } from "./config.ts";
import { EFFORT_LEVELS, type ModelSelection, type ProviderInstance, type TaskPlanRecord } from "./contracts.ts";
import { AGENT_CHARACTERS, type BotRecord, type GroupRecord, type Message, type Store } from "./store.ts";
import type { TaskPlanEngine } from "./task-engine.ts";
import * as messageDb from "./message-db.ts";
import { normalizeBotProfile } from "./bot-profile.ts";
import { userInstanceOwner } from "./user-keys.ts";
import { resolveAuthenticatedVisibleAccount, sameVisibleAuthority, type ResolveVisibleAccount } from "./drive-visible-account-bundle.ts";
import { inspectAccountRecoveryArchive, MAX_ACCOUNT_RECOVERY_ARCHIVE_BYTES } from "./drive-visible-account-archive.ts";
import type { UserHeldAccountDecryption } from "./drive-visible-restore.ts";
import { prepareAccountRecoveryImport, type AccountImportPlan, type RecoveryIdMap, type RecoveryDestination } from "./drive-visible-account-import-plan.ts";
import { recoveryCanonicalJson } from "./drive-visible-account-state.ts";
import { acquireOfflineRecoveryLease, assertOwnedOfflineRecoveryRoot, absentRecoveryDirectories, beginRecoveryOperation,
  compensateRecoveryFiles, listRecoveryOperations, loadRecoveryOperation, markRecoveryOperation, readRecoveryTarget,
  recoveryByteHash, recoveryTargetsMatch, syncRecoveryDirectory, writeFreshRecoveryTarget,
  type OwnedOfflineRecoveryRoot, type RecoveryJournal, type RecoveryReceipt, type OfflineRecoveryLease } from "./drive-visible-account-restore-journal.ts";

export type OfflineImportPhase = "preflight" | "intent" | "threads" | "plans" | "roster" | "memory" | "readback" | "committed" | "ack";
export interface CurrentOwnedRecoveryEngine { ownerId: string; selection: ModelSelection; instance: ProviderInstance }
export type ResolveRecoveryEngine = (sourceBotId: string, account: NonNullable<ReturnType<typeof resolveAuthenticatedVisibleAccount>>["account"]) => CurrentOwnedRecoveryEngine | null;
const selectionSchema = z.object({ instanceId: z.string().min(1).max(200), model: z.string().min(1).max(200), effort: z.enum(EFFORT_LEVELS).optional() }).strict();
const threadSchema = z.array(z.object({ threadId:z.string().min(1).max(200).regex(/^[\w-]+$/), activeLeafId:z.string().nullable(),
  messages:z.array(z.looseObject({ id:z.string().min(1), role:z.enum(["user","bot"]), kind:z.enum(["text","options","activity","screen","connector","compaction","privacy"]),at:z.number().finite(),parentId:z.string().nullable().optional() })) }).strict());
function savedThreads(journal: RecoveryJournal): messageDb.FreshRecoveryThread[] {
  // SAFETY: immutable journal threads passed the closed account display
  // projection and this identity schema; the SQLite marker binds exact bytes.
  return threadSchema.parse(JSON.parse(journal.threadPayload)) as messageDb.FreshRecoveryThread[];
}
function assertFixture(owned: OwnedOfflineRecoveryRoot): void {
  assertOwnedOfflineRecoveryRoot(owned);
  if (resolve(DATA_DIR) !== owned.root) throw new Error("Offline recovery data root differs from configured Store");
  for (const name of ["messages.db","messages.db-wal","messages.db-shm"]) {
    const path=join(owned.root,name);
    if(existsSync(path)) { const stat=lstatSync(path); if(!stat.isFile() || stat.isSymbolicLink() || stat.nlink!==1)throw new Error("Unsafe offline message database"); }
  }
}
function inventory(input: { owned: OwnedOfflineRecoveryRoot; store: Store; plans: TaskPlanEngine }, account: { userId:string; workspaceId:string }): RecoveryDestination {
  assertFixture(input.owned);
  if (resolve(input.plans.recoveryFile()) !== join(input.owned.root,"task-plans.json")) throw new Error("Offline plan engine root differs");
  const ids = new Set([...messageDb.recoveryThreadIds(), ...input.store.bots.flatMap(bot => [bot.threadId,...(bot.tasks??[]).map(task=>task.threadId)]),...input.store.groups.map(group=>group.threadId)]);
  for (const name of readdirSync(input.owned.root)) { const match=/^messages-([\w-]+)\.json(?:\.imported)?$/.exec(name); if(match)ids.add(match[1]!); }
  const threadIds=[...ids].sort();
  const snapshots=threadIds.map(threadId=>({threadId,snapshot:messageDb.readThreadSnapshot(threadId)}));
  if (snapshots.some(item=>item.snapshot.status!=="ready")) throw new Error("Destination snapshot unavailable");
  const revision=recoveryByteHash(recoveryCanonicalJson({ bots:input.store.bots,groups:input.store.groups,
    plans:input.plans.listPlans(),transitions:input.plans.transitionsFor(),snapshots,
    files:["bots.json","groups.json","task-plans.json"].map(path=>readRecoveryTarget(input.owned,path).bytes) }));
  return {userId:account.userId,workspaceId:account.workspaceId,revision,
    botIds:[...new Set([...input.store.bots.map(bot=>bot.id),...input.store.groups.flatMap(group=>group.memberIds),...input.plans.listPlans().map(plan=>plan.botId),...messageDb.recoveryReservedBotIds()])],
    groupIds:input.store.groups.map(group=>group.id),threadIds,planIds:input.plans.recoveryPlanIds()};
}
async function engineSelections(plan: AccountImportPlan, resolver: ResolveRecoveryEngine): Promise<Map<string,ModelSelection>> {
  const result=new Map<string,ModelSelection>();
  for(const sourceBotId of Object.keys(plan.mapping.bot)) {
    const offered=resolver(sourceBotId,plan.account);
    if(!offered || offered.ownerId!==plan.account.userId || !offered.instance.enabled)throw new Error("Current owned engine unavailable");
    const selection=selectionSchema.parse(offered.selection), declaredOwner=userInstanceOwner(selection.instanceId);
    if(selection.instanceId!==offered.instance.instanceId || (declaredOwner!==null && declaredOwner!==plan.account.userId))throw new Error("Current owned engine unavailable");
    const snapshot=await offered.instance.snapshot();
    if(snapshot.state!=="available" || snapshot.authenticated===false)throw new Error("Current owned engine unavailable");
    result.set(plan.mapping.bot[sourceBotId]!,selection);
  }
  return result;
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
function fileChanges(owned:OwnedOfflineRecoveryRoot,plans:TaskPlanEngine,material:ReturnType<typeof materialize>,plan:AccountImportPlan): RecoveryJournal["changes"] {
  // SAFETY: these actual owned roster arrays are preserved as saved; the Store
  // insertion port checks them against its live cache and exact before bytes.
  const previousBots=JSON.parse(readRecoveryTarget(owned,"bots.json").bytes??"[]") as BotRecord[];
  // SAFETY: the same actual owned GroupRecord array is checked by the Store
  // insertion port before writes; no imported authority is read from this cast.
  const previousGroups=JSON.parse(readRecoveryTarget(owned,"groups.json").bytes??"[]") as GroupRecord[];
  const offered:Array<{path:string;after:string}>=[
    {path:"bots.json",after:JSON.stringify([...previousBots,...material.bots],null,2)},
    {path:"groups.json",after:JSON.stringify([...previousGroups,...material.groups.map(({busyBotId:_busy,...group})=>group)],null,2)},
    {path:"task-plans.json",after:JSON.stringify({version:1,plans:[...plans.listPlans(),...material.plans],transitions:plans.transitionsFor()},null,2)}
  ];
  for(const memory of plan.memory) {
    if(existsSync(join(owned.root,"workspaces",memory.botId)))throw new Error("Recovery workspace collision");
    offered.push({path:`workspaces/${memory.botId}/MEMORY.md`,after:memory.text});
    for(const topic of memory.topics)offered.push({path:`workspaces/${memory.botId}/memory/${topic.name}`,after:topic.text});
  }
  return offered.map(item=>{const before=readRecoveryTarget(owned,item.path);return {...item,before:before.bytes,mode:before.mode};});
}
export interface OfflineImportInput {
  owned:OwnedOfflineRecoveryRoot; store:Store; plans:TaskPlanEngine; resolveAccount:ResolveVisibleAccount;
  resolveEngine:ResolveRecoveryEngine; archive:Buffer; key:UserHeldAccountDecryption; operationId?:string;
  mapping?:RecoveryIdMap; signal?:AbortSignal; onPhase?:(phase:OfflineImportPhase)=>void;
}
export type OfflineImportResult = {status:"committed";operationId:string;mapping:RecoveryIdMap;execution:"not-started";durability:"process-restart-only"}
  | {status:"unavailable";reason:"preflight-refused"|"operation-blocked"|"rolled-back"|"rollback-failed";operationId:string};
function committed(operationId:string,mapping:RecoveryIdMap):OfflineImportResult {
  return {status:"committed",operationId,mapping:structuredClone(mapping),execution:"not-started",durability:"process-restart-only"};
}
function rollback(lease:OfflineRecoveryLease,journal:RecoveryJournal,receipt:RecoveryReceipt,closeCaches?:()=>void):RecoveryReceipt {
  try {
    compensateRecoveryFiles(lease,journal,()=>messageDb.compensateFreshRecoveryThreads(journal.operationId,savedThreads(journal)));
    // Close the durable ambiguity receipt only after live caches also pass
    // their exact before/postimage guards. A guarded reload failure stays open.
    closeCaches?.();
    return markRecoveryOperation(lease,receipt,"rolled-back","compensated");
  } catch { return markRecoveryOperation(lease,receipt,"rollback-failed","compensation-unavailable"); }
}
/** Must be called BEFORE constructing Store/TaskPlanEngine in the owned child.
 * No new import or execution is authorized from these persisted provenance IDs. */
export function recoverOfflineAccountImports(owned:OwnedOfflineRecoveryRoot): Array<{operationId:string;status:RecoveryReceipt["status"]}> {
  assertFixture(owned);const lease=acquireOfflineRecoveryLease(owned,true);
  try {
    return listRecoveryOperations(lease).map(operationId=>{
      const operation=loadRecoveryOperation(lease,operationId);
      if(!operation)throw new Error("Recovery operation unavailable");
      // A cold process cannot reconstruct a newer volatile cache. Its durable
      // ambiguity receipt must remain open instead of silently compensating SQL.
      const ambiguousCache=operation.receipt.status==="rollback-failed" && operation.receipt.phase==="cache-postimage-changed";
      const receipt=!ambiguousCache && (operation.receipt.status==="pending" || operation.receipt.status==="rollback-failed")
        ? rollback(lease,operation.journal,operation.receipt):operation.receipt;
      return {operationId,status:receipt.status};
    });
  } finally {lease.release();}
}
export async function applyAccountRecoveryOffline(input:OfflineImportInput):Promise<OfflineImportResult> {
  const operationId=input.operationId??randomUUID();let lease:OfflineRecoveryLease|undefined;
  let journal:RecoveryJournal|undefined,receipt:RecoveryReceipt|undefined;
  const priorRoster={bots:structuredClone(input.store.bots),groups:structuredClone(input.store.groups)};
  const priorPlans={plans:input.plans.listPlans(),transitions:input.plans.transitionsFor()};
  let expectedRoster=structuredClone(priorRoster),expectedPlans=structuredClone(priorPlans);
  try {
    assertFixture(input.owned);lease=acquireOfflineRecoveryLease(input.owned);
    const authority=resolveAuthenticatedVisibleAccount(input.resolveAccount);
    if(!authority)throw new Error("Current account unavailable");
    if(!Buffer.isBuffer(input.archive) || input.archive.byteLength>MAX_ACCOUNT_RECOVERY_ARCHIVE_BYTES)throw new Error("Archive bound exceeded");
    const archive=Buffer.from(input.archive),archiveHash=recoveryByteHash(archive);
    const old=loadRecoveryOperation(lease,operationId);
    if(old) {
      if(old.journal.archiveHash!==archiveHash || old.journal.account.userId!==authority.account.userId
        || old.journal.account.workspaceId!==authority.account.workspaceId || old.journal.account.googleSub!==authority.googleSub)throw new Error("Recovery operation binding changed");
      if(old.receipt.status==="committed") {
        const threads=savedThreads(old.journal);
        if(!recoveryTargetsMatch(lease,old.journal) || !messageDb.freshRecoveryThreadsMatch(operationId,threads)
          || !input.store.recoveryThreadCachesMatch(threads))throw new Error("Committed recovery changed");
        return committed(operationId,old.journal.mapping);
      }
      if(old.receipt.status!=="rolled-back")return {status:"unavailable",reason:"operation-blocked",operationId};
    }
    for(const existingId of listRecoveryOperations(lease)) {
      const existing=loadRecoveryOperation(lease,existingId);
      if(existing && (existing.receipt.status==="pending" || existing.receipt.status==="rollback-failed"))return {status:"unavailable",reason:"operation-blocked",operationId};
    }
    const inspected=inspectAccountRecoveryArchive({bytes:archive,key:input.key,resolveAccount:input.resolveAccount});
    if(inspected.status!=="ready")throw new Error("Account archive unavailable");
    const readDestination=()=>inventory(input,authority.account);
    const prepared=prepareAccountRecoveryImport({state:inspected.state,resolveAccount:input.resolveAccount,readDestination,mapping:old?.journal.mapping??input.mapping});
    if(prepared.status!=="ready")throw new Error("Recovery plan unavailable: "+prepared.reason);
    const plan=prepared.plan,engines=await engineSelections(plan,input.resolveEngine);
    const material=materialize(plan,engines),changes=fileChanges(input.owned,input.plans,material,plan);
    expectedRoster={bots:[...priorRoster.bots,...material.bots],groups:[...priorRoster.groups,...material.groups]};
    expectedPlans={plans:[...priorPlans.plans,...material.plans],transitions:priorPlans.transitions};
    const cachesMatchPostimage=()=>isDeepStrictEqual(input.store.bots,expectedRoster.bots) && isDeepStrictEqual(input.store.groups,expectedRoster.groups)
      && isDeepStrictEqual(input.plans.listPlans(),expectedPlans.plans) && isDeepStrictEqual(input.plans.transitionsFor(),expectedPlans.transitions)
      && input.store.recoveryThreadCachesMatch(material.threads);
    input.plans.checkFreshRecoveryPlans(material.plans,changes.find(change=>change.path==="task-plans.json")!.before);
    const freshCheck=()=>{
      lease!.assert();
      if(input.signal?.aborted || !sameVisibleAuthority(authority,resolveAuthenticatedVisibleAccount(input.resolveAccount)))throw new Error("Recovery cancelled or authority changed");
    };
    const phase=(value:OfflineImportPhase)=>{freshCheck();input.onPhase?.(value);freshCheck();};
    phase("preflight");
    const rebound=prepareAccountRecoveryImport({state:inspected.state,resolveAccount:input.resolveAccount,readDestination,mapping:plan.mapping});
    if(rebound.status!=="ready" || rebound.plan.destinationDigest!==plan.destinationDigest)throw new Error("Recovery destination changed");
    journal={version:1,operationId,sourceDigest:plan.sourceDigest,archiveHash,
      account:{userId:plan.account.userId,workspaceId:plan.account.workspaceId,googleSub:plan.googleSub},mapping:plan.mapping,
      changes,threadPayload:JSON.stringify(material.threads),inertHistory:recoveryCanonicalJson(plan),createdDirs:absentRecoveryDirectories(input.owned,changes)};
    if(old) {
      if(!isDeepStrictEqual(old.journal,journal))throw new Error("Retry requires original unchanged mapping and inputs");
      receipt=markRecoveryOperation(lease,old.receipt,"pending","intent");
    } else receipt=beginRecoveryOperation(lease,journal,archive);
    phase("intent");
    messageDb.insertFreshRecoveryThreads(operationId,material.threads);
    receipt=markRecoveryOperation(lease,receipt,"pending","threads");phase("threads");
    input.plans.insertFreshRecoveryPlans(material.plans,changes.find(change=>change.path==="task-plans.json")!.before);
    syncRecoveryDirectory(input.owned.root);
    receipt=markRecoveryOperation(lease,receipt,"pending","plans");phase("plans");
    input.store.insertFreshRecoveryRoster(material,{bots:changes.find(change=>change.path==="bots.json")!.before,groups:changes.find(change=>change.path==="groups.json")!.before});
    syncRecoveryDirectory(input.owned.root);
    receipt=markRecoveryOperation(lease,receipt,"pending","roster");phase("roster");
    for(const change of changes.filter(change=>change.path.startsWith("workspaces/"))) {freshCheck();writeFreshRecoveryTarget(lease,change);}
    receipt=markRecoveryOperation(lease,receipt,"pending","memory");phase("memory");
    if(!recoveryTargetsMatch(lease,journal) || !messageDb.freshRecoveryThreadsMatch(operationId,material.threads)
      || !cachesMatchPostimage())throw new Error("Recovery read-back unavailable");
    phase("readback");
    const currentEngines=await engineSelections(plan,input.resolveEngine);
    if(!isDeepStrictEqual([...engines],[...currentEngines]))throw new Error("Engine selection changed");
    freshCheck();
    if(!recoveryTargetsMatch(lease,journal) || !messageDb.freshRecoveryThreadsMatch(operationId,material.threads)
      || !cachesMatchPostimage())throw new Error("Recovery changed before commit");
    receipt=markRecoveryOperation(lease,receipt,"committed","committed");
    // Committed is irreversible for cancellation: a lost acknowledgement is
    // retried by the same operation ID, never compensated as a pending write.
    input.onPhase?.("committed"); input.onPhase?.("ack");
    return committed(operationId,plan.mapping);
  } catch {
    if(lease && journal && receipt && receipt.status!=="committed") {
      // A newer in-memory writer is an ambiguous postimage too. Preserve its
      // cache AND all pending durable evidence instead of blindly resetting it.
      const threads=savedThreads(journal);
      const cachesOwned=input.store.recoveryRosterMatches(priorRoster,expectedRoster) && input.plans.recoveryPlansMatch(priorPlans,expectedPlans)
        && input.store.recoveryThreadCachesMatch(threads,true);
      receipt=cachesOwned?rollback(lease,journal,receipt,()=>{
        input.store.reloadCompensatedRecoveryRoster(priorRoster,expectedRoster,threads);
        input.plans.reloadCompensatedRecoveryPlans(priorPlans,expectedPlans);
      }):markRecoveryOperation(lease,receipt,"rollback-failed","cache-postimage-changed");
      return {status:"unavailable",reason:receipt.status==="rolled-back"?"rolled-back":"rollback-failed",operationId};
    }
    if(receipt?.status==="committed" && journal)return committed(operationId,journal.mapping);
    return {status:"unavailable",reason:"preflight-refused",operationId};
  } finally {lease?.release();}
}
