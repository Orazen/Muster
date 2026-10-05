import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createOwnedOfflineRecoveryRoot, type OwnedOfflineRecoveryRoot } from "./drive-visible-account-restore-journal.ts";
import type { OfflineImportInput, OfflineImportPhase } from "./drive-visible-account-import.ts";
import type { Message } from "./store.ts";
import type { TaskPlanRecord, TaskTransitionEvent } from "./contracts.ts";

let owned:OwnedOfflineRecoveryRoot;
let importer:typeof import("./drive-visible-account-import.ts"),mdb:typeof import("./message-db.ts");
let auth:DatabaseSync,input:OfflineImportInput;
let originalBots:string,originalGroups:string,originalPlans:string,authBefore:string,foreignThread:string;
interface FixtureIds { own:string;peer:string;room:string;plan:string;thread:string }
interface FixturePlanCaches { plans:TaskPlanRecord[];transitions:TaskTransitionEvent[] }
let ids:FixtureIds;
let send:ReturnType<typeof vi.fn<import("./contracts.ts").ProviderAdapter["sendTurn"]>>,fetch:ReturnType<typeof vi.fn>;
const authRows=()=>JSON.stringify(["user","organization","member","session","account","drive_visible_settings","provider_keys"].map(table=>auth.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
beforeEach(async()=>{
  mdb?.closeMessageDb();vi.resetModules();owned=createOwnedOfflineRecoveryRoot();vi.stubEnv("OMB_DATA_DIR",owned.root);
  const modules=await Promise.all([import("./store.ts"),import("./message-db.ts"),import("./task-engine.ts"),import("./drive-visible-account-import.ts"),
    import("./drive-visible-account-archive.ts"),import("./drive-visible-settings.ts"),import("./follow-up-identity.ts"),import("./testing/fake-driver.ts")]);
  const [s,m,p,i,archive,settings,identity,fake]=modules;mdb=m;importer=i;
  auth=new DatabaseSync(join(owned.root,"auth.db"));
  auth.exec(`CREATE TABLE user(id TEXT PRIMARY KEY); CREATE TABLE organization(id TEXT PRIMARY KEY);
    CREATE TABLE member(id TEXT PRIMARY KEY,userId TEXT,organizationId TEXT,createdAt INTEGER);
    CREATE TABLE session(id TEXT PRIMARY KEY,userId TEXT,activeOrganizationId TEXT,expiresAt INTEGER);
    CREATE TABLE account(userId TEXT,providerId TEXT,accountId TEXT);
    CREATE TABLE provider_keys(userId TEXT,value TEXT);
    INSERT INTO user VALUES('alice'),('bob');INSERT INTO organization VALUES('alice-org'),('bob-org');
    INSERT INTO member VALUES('alice-member','alice','alice-org',1),('bob-member','bob','bob-org',1);
    INSERT INTO account VALUES('alice','google','alice-google'),('bob','google','bob-google');
    INSERT INTO provider_keys VALUES('alice','SYNTHETIC-UNCHANGED'),('bob','SYNTHETIC-FOREIGN');`);
  auth.prepare("INSERT INTO session VALUES('alice-session','alice','alice-org',?),('bob-session','bob','bob-org',?)").run(Date.now()+60_000,Date.now()+60_000);
  const resolveAccount=()=>{
    const session=z.object({id:z.string().min(1),userId:z.string().min(1)}).safeParse(auth.prepare("SELECT id,userId FROM session WHERE id='alice-session' AND expiresAt>?").get(Date.now()));
    if(!session.success)return null;
    const account=identity.resolveFollowUpAccount(auth,{userId:session.data.userId,sessionId:session.data.id},false);
    const google=z.object({accountId:z.string().min(1)}).safeParse(auth.prepare("SELECT accountId FROM account WHERE userId=? AND providerId='google'").get(session.data.userId));
    return account&&google.success?{account,googleSub:google.data.accountId}:null;
  };
  const selected={instanceId:"fakeApi:alice",model:"fake-1"};
  const store=new s.Store(()=>selected),plans=new p.TaskPlanEngine({file:join(owned.root,"task-plans.json")});
  const own=store.createBot({ownerId:"alice",name:"Original",modelSelection:selected},{seedMessages:false});
  const peer=store.createBot({ownerId:"alice",name:"Peer",modelSelection:selected},{seedMessages:false});
  const foreign=store.createBot({ownerId:"bob",name:"Foreign",modelSelection:{instanceId:"fakeApi:bob",model:"fake-1"}},{seedMessages:false});
  foreignThread=foreign.threadId;mdb.appendMessage(foreign.threadId,{id:"foreign",parentId:null,role:"user",kind:"text",text:"FOREIGN-UNCHANGED",at:1});
  const room=store.createGroup("Original room",[own.id,peer.id],false,"alice",{kind:"member",botId:peer.id});
  store.patchGroup(room.id,{bulletin:"Original bulletin"});
  const rows:Message[]=[{id:"root",parentId:null,at:1,role:"user",kind:"text",text:"Root"},
    {id:"selected",parentId:"root",at:2,role:"bot",kind:"options",card:{title:"Historic approval",subtitle:"Kept",options:["Yes"],answered:"Yes"},from:{botId:peer.id,name:"Peer",color:"blue"},reactions:[{by:peer.id,emoji:"👍"}]},
    {id:"newer-fork",parentId:"root",at:3,role:"bot",kind:"text",text:"Newer unselected fork"}];
  mdb.replaceThreadFromSync(own.threadId,rows,"selected");
  mdb.replaceThreadFromSync(peer.threadId,[],null);const roomMessage:Message={id:"room-message",parentId:null,at:4,role:"bot",kind:"text",text:"Room",from:{botId:own.id,name:"Original",color:"green"}};mdb.replaceThreadFromSync(room.threadId,[roomMessage],"room-message");
  const plan=plans.create({botId:own.id,ownerId:"alice",threadId:own.threadId,title:"Original plan",steps:["Keep checkpoint"],start:false});
  plans.create({botId:foreign.id,ownerId:"bob",threadId:foreign.threadId,title:"Foreign plan",steps:["Remain"],start:false});
  mkdirSync(join(owned.root,"workspaces",own.id,"memory"),{recursive:true});
  writeFileSync(join(owned.root,"workspaces",own.id,"MEMORY.md"),"Original memory");writeFileSync(join(owned.root,"workspaces",own.id,"memory","topic.md"),"Original topic");
  const account=resolveAccount()!.account;settings.captureAccountSettings(auth,account,{theme:"dark"});
  const built=archive.buildAccountRecoveryArchive({source:{account,dataDir:owned.root,store,plans,settingsSnapshot:settings.readAccountSettings(auth,account)!},
    resolveAccount,key:{custody:"user-held",passphrase:"SYNTHETIC-OFFLINE-RECOVERY"},appVersion:"test"});
  if(built.status!=="ready")throw new Error(JSON.stringify(built));
  settings.captureAccountSettings(auth,account,{theme:"light"}); // imported preference must not overwrite it
  const handle=fake.makeFakeDriver(),instance=await handle.driver.create({instanceId:selected.instanceId,displayName:"Owned fixture engine",environment:{},enabled:true,config:{}});
  send=vi.fn<import("./contracts.ts").ProviderAdapter["sendTurn"]>(()=>{throw new Error("No dispatch allowed");});instance.adapter.sendTurn=send;
  fetch=vi.fn(()=>{throw new Error("No outbound allowed");});vi.stubGlobal("fetch",fetch);
  input={owned,store,plans,resolveAccount,resolveEngine:()=>({ownerId:"alice",selection:selected,instance}),archive:built.bytes,
    key:{custody:"user-held",passphrase:"SYNTHETIC-OFFLINE-RECOVERY"},operationId:"owned-operation"};
  ids={own:own.id,peer:peer.id,room:room.id,plan:plan.id,thread:own.threadId};
  originalBots=readFileSync(join(owned.root,"bots.json"),"utf8");originalGroups=readFileSync(join(owned.root,"groups.json"),"utf8");
  originalPlans=readFileSync(join(owned.root,"task-plans.json"),"utf8");authBefore=authRows();
});
afterEach(()=>{auth?.close();mdb?.closeMessageDb();vi.unstubAllGlobals();vi.unstubAllEnvs();rmSync(owned.root,{recursive:true,force:true});});
function unchanged(){expect(readFileSync(join(owned.root,"bots.json"),"utf8")).toBe(originalBots);expect(readFileSync(join(owned.root,"groups.json"),"utf8")).toBe(originalGroups);expect(readFileSync(join(owned.root,"task-plans.json"),"utf8")).toBe(originalPlans);expect(authRows()).toBe(authBefore);expect(mdb.readThreadSnapshot(foreignThread)).toMatchObject({messages:[{text:"FOREIGN-UNCHANGED"}]});expect(send).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();}

describe("actual additive offline account apply",()=>{
  it("preserves two-account data and old selected head, room membership, task and memory in fresh records without events",async()=>{
    const events=vi.fn();input.store.onChange(events);
    const result=await importer.applyAccountRecoveryOffline(input);expect(result.status).toBe("committed");if(result.status!=="committed")throw new Error(JSON.stringify(result));
    const snapshot=mdb.readThreadSnapshot(result.mapping.thread[ids.thread]!);
    expect(snapshot).toMatchObject({activeLeafId:"selected",messages:[{id:"root"},{id:"selected",from:{botId:result.mapping.bot[ids.peer]},reactions:[{by:result.mapping.bot[ids.peer]}]},{id:"newer-fork"}]});
    if(snapshot.status!=="ready")throw new Error("No snapshot");expect(snapshot.messages[1]).not.toHaveProperty("card");
    expect(input.store.group(result.mapping.group[ids.room]!)).toMatchObject({memberIds:[result.mapping.bot[ids.own],result.mapping.bot[ids.peer]],defaultResponder:{botId:result.mapping.bot[ids.peer]},bulletin:"Original bulletin"});
    expect(input.plans.plan(result.mapping.plan[ids.plan]!)).toMatchObject({status:"paused",currentStep:null,ownerId:"alice",steps:[{status:"pending"}]});
    expect(readFileSync(join(owned.root,"workspaces",result.mapping.bot[ids.own]!,"MEMORY.md"),"utf8")).toBe("Original memory");
    expect(readFileSync(join(owned.root,"workspaces",result.mapping.bot[ids.own]!,"memory","topic.md"),"utf8")).toBe("Original topic");
    expect(JSON.parse(readFileSync(join(owned.root,"bots.json"),"utf8")).slice(0,3)).toEqual(JSON.parse(originalBots));
    expect(authRows()).toBe(authBefore);expect(events).not.toHaveBeenCalled();expect(send).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
    const immutable=readFileSync(join(owned.root,"account-recovery-journal","owned-operation","immutable.json"),"utf8");
    expect(immutable).toContain("Historic approval");expect(immutable).not.toContain("SYNTHETIC-OFFLINE-RECOVERY");expect(immutable).not.toContain("SYNTHETIC-FOREIGN");
    const current=input.store.bot(result.mapping.bot[ids.own]!)!;expect(current).toMatchObject({modelSelection:{instanceId:"fakeApi:alice"},computer:"off",composio:false,browser:false,autoApprove:false,resumeCursors:{}});
  });
  it("same committed ID replays only its receipt and never duplicates IDs",async()=>{
    const first=await importer.applyAccountRecoveryOffline(input),bytes=readFileSync(join(owned.root,"bots.json"),"utf8");
    const second=await importer.applyAccountRecoveryOffline({...input,resolveEngine:()=>{throw new Error("No new selection for receipt");}});
    expect(second).toEqual(first);expect(second.status).toBe("committed");expect(readFileSync(join(owned.root,"bots.json"),"utf8")).toBe(bytes);
  });
  it.each(["intent","threads","plans","roster","memory","readback"] satisfies OfflineImportPhase[])("rolls back actual %s failure and preserves prior rows",async phase=>{
    const result=await importer.applyAccountRecoveryOffline({...input,onPhase:at=>{if(at===phase)throw new Error("Owned injected failure");}});
    expect(result).toMatchObject({status:"unavailable",reason:"rolled-back"});unchanged();
  });
  it("returns committed for a lost acknowledgement rather than undoing completed data",async()=>{
    expect(await importer.applyAccountRecoveryOffline({...input,onPhase:phase=>{if(phase==="ack")throw new Error("Lost ack");}})).toMatchObject({status:"committed"});
    expect(await importer.applyAccountRecoveryOffline(input)).toMatchObject({status:"committed"});
  });
  it.each(["cancel","session","member","subject"])("compensates %s invalidation before commit",async reason=>{
    const controller=new AbortController();input.signal=controller.signal;
    input.onPhase=phase=>{if(phase!=="roster")return;if(reason==="cancel")controller.abort();if(reason==="session")auth.exec("DELETE FROM session WHERE id='alice-session'");if(reason==="member")auth.exec("DELETE FROM member WHERE userId='alice'");if(reason==="subject")auth.exec("UPDATE account SET accountId='changed' WHERE userId='alice'");};
    expect(await importer.applyAccountRecoveryOffline(input)).toMatchObject({status:"unavailable",reason:"rolled-back"});
    expect(readFileSync(join(owned.root,"bots.json"),"utf8")).toBe(originalBots);expect(readFileSync(join(owned.root,"groups.json"),"utf8")).toBe(originalGroups);expect(readFileSync(join(owned.root,"task-plans.json"),"utf8")).toBe(originalPlans);
  });
  it("refuses missing engine and foreign owner selection before mutation",async()=>{
    expect(await importer.applyAccountRecoveryOffline({...input,resolveEngine:()=>null})).toMatchObject({reason:"preflight-refused"});unchanged();
    const original=input.resolveEngine;expect(await importer.applyAccountRecoveryOffline({...input,resolveEngine:(...args)=>({...original(...args)!,ownerId:"bob"})})).toMatchObject({reason:"preflight-refused"});unchanged();
  });
  it("wrong key and changed subject do not expose or mutate account data",async()=>{
    expect(await importer.applyAccountRecoveryOffline({...input,key:{custody:"user-held",passphrase:"WRONG-SYNTHETIC-PASSPHRASE"}})).toMatchObject({reason:"preflight-refused"});unchanged();
    const resolveAccount=input.resolveAccount;expect(await importer.applyAccountRecoveryOffline({...input,resolveAccount:()=>({...resolveAccount()!,googleSub:"foreign-google"})})).toMatchObject({reason:"preflight-refused"});unchanged();
  });
  it("capacity refusal occurs before thread insertion",async()=>{
    const {TaskPlanEngine}=await import("./task-engine.ts");input.plans=new TaskPlanEngine({file:join(owned.root,"task-plans.json"),maxPlans:2});
    expect(await importer.applyAccountRecoveryOffline(input)).toMatchObject({reason:"preflight-refused"});unchanged();
    expect(existsSync(join(owned.root,"account-recovery-journal","owned-operation"))).toBe(false);
  });
  it("ambiguous changed target preserves the newer writer and pending evidence",async()=>{
    let newer="";input.onPhase=phase=>{if(phase==="roster"){newer=readFileSync(join(owned.root,"bots.json"),"utf8")+"\n";writeFileSync(join(owned.root,"bots.json"),newer);throw new Error("Changed by another writer");}};
    expect(await importer.applyAccountRecoveryOffline(input)).toMatchObject({reason:"rollback-failed"});expect(readFileSync(join(owned.root,"bots.json"),"utf8")).toBe(newer);
    expect(await importer.applyAccountRecoveryOffline({...input,onPhase:undefined})).toMatchObject({reason:"operation-blocked"});
  });
  it("same map retries a fully compensated operation",async()=>{
    const first=await importer.applyAccountRecoveryOffline({...input,onPhase:phase=>{if(phase==="threads")throw new Error("Retry fixture");}});expect(first).toMatchObject({reason:"rolled-back"});
    const old=JSON.parse(readFileSync(join(owned.root,"account-recovery-journal","owned-operation","immutable.json"),"utf8"));
    const next=await importer.applyAccountRecoveryOffline(input);expect(next).toMatchObject({status:"committed",mapping:old.mapping});
  });
  it("actual SQLite trigger failure rolls back the whole account operation",async()=>{
    const database=new DatabaseSync(join(owned.root,"messages.db"));
    database.exec("CREATE TRIGGER recovery_fail BEFORE INSERT ON messages WHEN NOT EXISTS(SELECT 1 FROM thread_state WHERE thread_id=NEW.thread_id) BEGIN SELECT RAISE(ABORT,'owned-fixture-trigger'); END");
    try{expect(await importer.applyAccountRecoveryOffline(input)).toMatchObject({reason:"rolled-back"});unchanged();}finally{database.close();}
  });
  it("second roster IO failure compensates the already written first file and SQL/plans",async()=>{
    const atomic=await import("./atomic.ts"),original=atomic.writeFileAtomic;
    const write=vi.spyOn(atomic,"writeFileAtomic").mockImplementation((path,...args)=>{
      if(path===join(owned.root,"groups.json"))throw new Error("Owned injected IO failure");original(path,...args);
    });
    try{expect(await importer.applyAccountRecoveryOffline(input)).toMatchObject({reason:"rolled-back"});unchanged();}finally{write.mockRestore();}
  });
  it("current engine removal during final read-back compensates without starting a provider",async()=>{
    const engine=input.resolveEngine;input.onPhase=phase=>{if(phase==="readback")input.resolveEngine=()=>null;};
    expect(await importer.applyAccountRecoveryOffline(input)).toMatchObject({reason:"rolled-back"});input.resolveEngine=engine;unchanged();
  });
  it("destination collision on an offered fixed map refuses instead of replacing foreign IDs",async()=>{
    const opened=(await import("./drive-visible-account-archive.ts")).inspectAccountRecoveryArchive({bytes:input.archive,key:input.key,resolveAccount:input.resolveAccount});
    if(opened.status!=="ready")throw new Error("No fixture state");
    const mapping={bot:Object.fromEntries(opened.state.inventory.botIds.map((id,n)=>[id,n===0?input.store.bots.find(bot=>bot.ownerId==="bob")!.id:`fresh-${n}`])),
      group:Object.fromEntries(opened.state.inventory.groupIds.map((id,n)=>[id,`fresh-group-${n}`])),thread:Object.fromEntries(opened.state.inventory.threadIds.map((id,n)=>[id,`fresh-thread-${n}`])),plan:Object.fromEntries(opened.state.inventory.planIds.map((id,n)=>[id,`fresh-plan-${n}`]))};
    expect(await importer.applyAccountRecoveryOffline({...input,mapping})).toMatchObject({reason:"preflight-refused"});unchanged();
  });
  it.each(["bots","groups","plans","transitions"])("refuses a newer %s cache during the final engine await and preserves pending evidence",async domain=>{
    const engine=input.resolveEngine(ids.own,input.resolveAccount()!.account)!.instance,originalSnapshot=engine.snapshot.bind(engine);
    let changed=false;
    input.onPhase=phase=>{if(phase!=="readback")return;engine.snapshot=async()=>{
      await Promise.resolve();
      if(!changed){changed=true;
        if(domain==="bots")input.store.bots.find(bot=>![ids.own,ids.peer].includes(bot.id)&&bot.ownerId==="alice")!.autoApprove=true;
        if(domain==="groups")input.store.groups.find(group=>group.id!==ids.room)!.bulletin="NEWER-CACHE-WRITER";
        // The actual TaskPlanEngine declares these private cache arrays;
        // this owned adversarial fixture mutates them without an IO write.
        const caches:FixturePlanCaches={plans:Object.getOwnPropertyDescriptor(input.plans,"plans")!.value,transitions:Object.getOwnPropertyDescriptor(input.plans,"transitions")!.value};
        if(domain==="plans")caches.plans.find(plan=>plan.id!==ids.plan&&plan.ownerId==="alice")!.title="NEWER-CACHE-WRITER";
        if(domain==="transitions")caches.transitions.push({planId:ids.plan,botId:ids.own,from:"paused",to:"paused",at:999,action:"NEWER-CACHE-WRITER"});
      }
      return originalSnapshot();
    };};
    const result=await importer.applyAccountRecoveryOffline(input);
    expect(changed).toBe(true);expect(result).toMatchObject({status:"unavailable",reason:"rollback-failed"});
    const receipt=JSON.parse(readFileSync(join(owned.root,"account-recovery-journal","owned-operation","receipt.json"),"utf8"));
    expect(receipt).toMatchObject({status:"rollback-failed",phase:"cache-postimage-changed"});
    if(domain==="bots")expect(input.store.bots.some(bot=>bot.autoApprove)).toBe(true);
    if(domain==="groups")expect(input.store.groups.some(group=>group.bulletin==="NEWER-CACHE-WRITER")).toBe(true);
    if(domain==="plans")expect(input.plans.listPlans().some(plan=>plan.title==="NEWER-CACHE-WRITER")).toBe(true);
    if(domain==="transitions")expect(input.plans.transitionsFor().some(event=>event.action==="NEWER-CACHE-WRITER")).toBe(true);
    expect(await importer.applyAccountRecoveryOffline({...input,onPhase:undefined})).toMatchObject({reason:"operation-blocked"});
    expect(authRows()).toBe(authBefore);expect(send).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["pending-best-effort","message-cache","selected-head"].flatMap(domain=>["available","refused"].map(outcome=>({domain,outcome}))))("preserves changed imported $domain with final engine $outcome and its open journal",async({domain,outcome})=>{
    const engine=input.resolveEngine(ids.own,input.resolveAccount()!.account)!.instance,originalSnapshot=engine.snapshot.bind(engine);
    let freshThread="",sqlBefore="",changed=false;
    const database=new DatabaseSync(join(owned.root,"messages.db"));
    const sqlImage=()=>JSON.stringify({rows:database.prepare("SELECT thread_id,id,at,role,kind,text,json FROM messages WHERE thread_id=? ORDER BY rowid").all(freshThread),
      heads:database.prepare("SELECT thread_id,active_leaf_id FROM thread_state WHERE thread_id=?").all(freshThread),
      marker:database.prepare("SELECT * FROM account_recovery_operations WHERE operation_id=?").all(input.operationId!)});
    const errorLog=vi.spyOn(console,"error").mockImplementation(()=>{});
    try {
      input.onPhase=phase=>{if(phase!=="readback")return;engine.snapshot=async()=>{
        await Promise.resolve();
        if(!changed){changed=true;
          const immutable=z.object({mapping:z.object({thread:z.record(z.string(),z.string())})}).parse(JSON.parse(readFileSync(join(owned.root,"account-recovery-journal","owned-operation","immutable.json"),"utf8")));
          freshThread=immutable.mapping.thread[ids.thread]!;
          input.store.messagesFor(freshThread);sqlBefore=sqlImage();
          if(domain==="pending-best-effort"){
            database.exec("CREATE TRIGGER owned_volatile_recovery BEFORE INSERT ON messages WHEN NEW.text='NEWER-IMPORTED-CACHE' BEGIN SELECT RAISE(ABORT,'owned-pending-write'); END");
            input.store.appendMessage(freshThread,{role:"bot",kind:"text",text:"NEWER-IMPORTED-CACHE"},{bestEffort:true});
          } else if(domain==="message-cache")input.store.messagesFor(freshThread)[0]!.text="NEWER-IMPORTED-CACHE";
          else {
            // The actual Store thread map is private. This owned adversarial
            // fixture changes only its selected head, leaving durable SQL intact.
            const threads:Map<string,{activeLeafId:string|null}>=Object.getOwnPropertyDescriptor(input.store,"threads")!.value;
            threads.get(freshThread)!.activeLeafId="newer-fork";
          }
        }
        if(outcome==="refused")throw new Error("Owned final engine refusal after cache mutation");
        return originalSnapshot();
      };};
      const result=await importer.applyAccountRecoveryOffline(input);
      expect(changed).toBe(true);expect(result).toMatchObject({status:"unavailable",reason:"rollback-failed"});
      expect(sqlImage()).toBe(sqlBefore);
      if(domain==="selected-head")expect(input.store.activeLeaf(freshThread)).toBe("newer-fork");
      else expect(input.store.messagesFor(freshThread).some(message=>message.text==="NEWER-IMPORTED-CACHE")).toBe(true);
      if(domain==="pending-best-effort")expect(input.store.snapshotThread(freshThread)).toEqual({status:"unavailable",reason:"pending-writes"});
      const receipt=JSON.parse(readFileSync(join(owned.root,"account-recovery-journal","owned-operation","receipt.json"),"utf8"));
      expect(receipt).toMatchObject({status:"rollback-failed",phase:"cache-postimage-changed"});
      // A restart cannot establish ownership of the lost in-memory postimage.
      // The durable ambiguity receipt must keep SQL/journal evidence open.
      expect(importer.recoverOfflineAccountImports(owned)).toEqual([{operationId:"owned-operation",status:"rollback-failed"}]);
      expect(sqlImage()).toBe(sqlBefore);
      expect(await importer.applyAccountRecoveryOffline({...input,onPhase:undefined})).toMatchObject({reason:"operation-blocked"});
      expect(authRows()).toBe(authBefore);expect(mdb.readThreadSnapshot(foreignThread)).toMatchObject({messages:[{text:"FOREIGN-UNCHANGED"}]});
      expect(send).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
    } finally {database.close();errorLog.mockRestore();}
  });
  it("does not replay a committed receipt as current when an imported thread has a newer volatile write",async()=>{
    const result=await importer.applyAccountRecoveryOffline(input);
    expect(result.status).toBe("committed");if(result.status!=="committed")throw new Error("No committed fixture");
    const threadId=result.mapping.thread[ids.thread]!,database=new DatabaseSync(join(owned.root,"messages.db"));
    const errorLog=vi.spyOn(console,"error").mockImplementation(()=>{});
    try {
      database.exec("CREATE TRIGGER owned_committed_volatile BEFORE INSERT ON messages WHEN NEW.text='AFTER-COMMIT-VOLATILE' BEGIN SELECT RAISE(ABORT,'owned-pending-write'); END");
      input.store.appendMessage(threadId,{role:"bot",kind:"text",text:"AFTER-COMMIT-VOLATILE"},{bestEffort:true});
      expect(await importer.applyAccountRecoveryOffline(input)).toMatchObject({status:"unavailable",reason:"preflight-refused"});
      expect(input.store.messagesFor(threadId).some(message=>message.text==="AFTER-COMMIT-VOLATILE")).toBe(true);
      expect(input.store.snapshotThread(threadId)).toEqual({status:"unavailable",reason:"pending-writes"});
      expect(JSON.parse(readFileSync(join(owned.root,"account-recovery-journal","owned-operation","receipt.json"),"utf8"))).toMatchObject({status:"committed"});
      expect(authRows()).toBe(authBefore);expect(send).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
    } finally {database.close();errorLog.mockRestore();}
  });
});
