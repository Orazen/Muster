import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { applyLiveAccountRestore } from "./drive-visible-live-restore.ts";
import type { Message } from "./store.ts";


interface OwnedLiveRoot { root: string }
let owned:OwnedLiveRoot;
let importer:typeof import("./drive-visible-live-restore.ts"),mdb:typeof import("./message-db.ts");
let auth:DatabaseSync,input:Parameters<typeof applyLiveAccountRestore>[0];
let originalBots:string,originalGroups:string,originalPlans:string,authBefore:string,foreignThread:string;
interface FixtureIds { own:string;peer:string;room:string;plan:string;thread:string }

let ids:FixtureIds;
let send:ReturnType<typeof vi.fn<import("./contracts.ts").ProviderAdapter["sendTurn"]>>,fetch:ReturnType<typeof vi.fn>;
const authRows=()=>JSON.stringify(["user","organization","member","session","account","drive_visible_settings","provider_keys","drive_visible_grants","attachment_canaries"].map(table=>auth.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
beforeEach(async()=>{
  mdb?.closeMessageDb();vi.resetModules();owned={root:realpathSync(mkdtempSync(join(tmpdir(),"muster-live-restore-")))};vi.stubEnv("OMB_DATA_DIR",owned.root);
  const modules=await Promise.all([import("./store.ts"),import("./message-db.ts"),import("./task-engine.ts"),import("./drive-visible-live-restore.ts"),
    import("./drive-visible-account-archive.ts"),import("./drive-visible-settings.ts"),import("./follow-up-identity.ts"),import("./testing/fake-driver.ts")]);
  const [s,m,p,i,archive,settings,identity,fake]=modules;mdb=m;importer=i;
  auth=new DatabaseSync(join(owned.root,"auth.db"));
  auth.exec(`CREATE TABLE user(id TEXT PRIMARY KEY); CREATE TABLE organization(id TEXT PRIMARY KEY);
    CREATE TABLE member(id TEXT PRIMARY KEY,userId TEXT,organizationId TEXT,createdAt INTEGER);
    CREATE TABLE session(id TEXT PRIMARY KEY,userId TEXT,activeOrganizationId TEXT,expiresAt INTEGER);
    CREATE TABLE account(userId TEXT,providerId TEXT,accountId TEXT);
    CREATE TABLE provider_keys(userId TEXT,value TEXT);
    CREATE TABLE drive_visible_grants(userId TEXT,value TEXT); CREATE TABLE attachment_canaries(userId TEXT,value TEXT);
    INSERT INTO drive_visible_grants VALUES('alice','SYNTHETIC-GRANT'),('bob','FOREIGN-GRANT');
    INSERT INTO attachment_canaries VALUES('alice','ORIGINAL-ATTACHMENT'),('bob','FOREIGN-ATTACHMENT');
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
  const inspected=archive.inspectAccountRecoveryArchive({bytes:built.bytes,key:{custody:"user-held",passphrase:"SYNTHETIC-OFFLINE-RECOVERY"},resolveAccount});if(inspected.status!=="ready")throw Error("No real archive inspection");
  input={runtime:{dataDir:owned.root,store,plans,assertReady:()=>{if(!existsSync(owned.root))throw Error("Owned test root missing");},readSettings:account=>settings.readAccountSettings(auth,account),resolveEngine:()=>({ownerId:"alice",selection:selected,instance})},
    resolveAccount,archive:built.bytes,selection:selected,expectedSourceDigest:inspected.state.sourceDigest,
    key:{custody:"user-held",passphrase:"SYNTHETIC-OFFLINE-RECOVERY"},operationId:randomUUID()};
  ids={own:own.id,peer:peer.id,room:room.id,plan:plan.id,thread:own.threadId};
  originalBots=readFileSync(join(owned.root,"bots.json"),"utf8");originalGroups=readFileSync(join(owned.root,"groups.json"),"utf8");
  originalPlans=readFileSync(join(owned.root,"task-plans.json"),"utf8");authBefore=authRows();
});
afterEach(()=>{auth?.close();mdb?.closeMessageDb();vi.unstubAllGlobals();vi.unstubAllEnvs();rmSync(owned.root,{recursive:true,force:true});});
function unchanged(){expect(readFileSync(join(owned.root,"bots.json"),"utf8")).toBe(originalBots);expect(readFileSync(join(owned.root,"groups.json"),"utf8")).toBe(originalGroups);expect(readFileSync(join(owned.root,"task-plans.json"),"utf8")).toBe(originalPlans);expect(authRows()).toBe(authBefore);expect(mdb.readThreadSnapshot(foreignThread)).toMatchObject({messages:[{text:"FOREIGN-UNCHANGED"}]});expect(send).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();}


describe("actual additive live-root account transactions",()=>{
  it("uses a genuine root with no synthetic marker, real parsed branches/rooms/plans/memory and no dispatch",async()=>{
    const publish=vi.fn(),events=vi.fn();input.runtime.publish=publish;input.runtime.store.onChange(events);
    let targetReadBeforeSql=false;input.onPhase=phase=>{if(phase!=="intent")return;
      const bytes=readFileSync(join(owned.root,"account-live-restore-journal",input.operationId,"target-before.bin"));
      expect(bytes.equals(input.archive)).toBe(false);expect(bytes.includes(Buffer.from("SYNTHETIC-OFFLINE-RECOVERY"))).toBe(false);
      expect(input.runtime.store.bots).toHaveLength(3);expect(mdb.recoveryThreadIds()).toHaveLength(4);targetReadBeforeSql=true;};
    const result=await importer.applyLiveAccountRestore(input);expect(targetReadBeforeSql).toBe(true);
    expect(result).toMatchObject({status:"committed",rollback:"pending-only",history:"archive-only",execution:"not-started"});
    expect(existsSync(join(owned.root,".account-recovery-owner.json"))).toBe(false);
    expect(mdb.readThreadSnapshot(result.mapping.thread[ids.thread]!)).toMatchObject({activeLeafId:"selected",messages:[{id:"root"},{id:"selected"},{id:"newer-fork"}]});
    expect(input.runtime.store.group(result.mapping.group[ids.room]!)).toMatchObject({ownerId:"alice",memberIds:[result.mapping.bot[ids.own],result.mapping.bot[ids.peer]]});
    expect(input.runtime.plans.plan(result.mapping.plan[ids.plan]!)).toMatchObject({ownerId:"alice",status:"paused",currentStep:null});
    expect(readFileSync(join(owned.root,"workspaces",result.mapping.bot[ids.own]!,"MEMORY.md"),"utf8")).toBe("Original memory");
    expect(authRows()).toBe(authBefore);expect(send).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();expect(events).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledOnce();expect(publish).toHaveBeenCalledWith({userId:"alice",workspaceId:"alice-org"},result);
    const journal=await import("./drive-visible-live-journal.ts"),held=journal.openLiveJournal(owned.root);
    try{expect(held.load(input.operationId)!.intent.inertHistory).toContain("Historic approval");
      const archive=await import("./drive-visible-account-archive.ts");
      const target=archive.inspectAccountRecoveryArchive({bytes:held.targetCopy(input.operationId),key:input.key,resolveAccount:input.resolveAccount});
      expect(target.status).toBe("ready");if(target.status!=="ready")throw Error("No target readback");
      expect(target.state.bots.map(bot=>bot.id)).toEqual(expect.arrayContaining([ids.own,ids.peer]));expect(target.state.bots).toHaveLength(2);
      expect(target.state.sourceDigest).toBe(result.targetCopy.sourceDigest);
      expect(held.targetCopy(input.operationId).equals(input.archive)).toBe(false);
      expect(JSON.stringify(target.state)).not.toContain("FOREIGN-UNCHANGED");}finally{held.release();}
  });
  it.each(["intent","threads","plans","roster","memory","readback"])("compensates real %s interruption and keeps unrelated account/auth/settings bytes",async phase=>{
    const publish=vi.fn();input.runtime.publish=publish;input.onPhase=at=>{if(at===phase)throw Error("Owned IO phase failure");};
    await expect(importer.applyLiveAccountRestore(input)).rejects.toMatchObject({code:"rolled-back"});unchanged();expect(publish).not.toHaveBeenCalled();
  });
  it("reconciles lost ACK after unrelated roster, plan and transcript activity without inserting twice",async()=>{
    input.onPhase=phase=>{if(phase==="ack")throw Error("Lost acknowledgement");};
    const first=await importer.applyLiveAccountRestore(input);
    const foreign=input.runtime.store.bots.find(bot=>bot.ownerId==="bob")!;input.runtime.store.patchBot(foreign.id,{name:"Bob changed later"});
    input.runtime.plans.create({botId:foreign.id,ownerId:"bob",threadId:foreign.threadId,steps:["Later Bob work"],start:false});
    mdb.appendMessage(foreign.threadId,{id:"later",parentId:"foreign",at:9,role:"user",kind:"text",text:"Later Bob message"});
    const beforeBots=readFileSync(join(owned.root,"bots.json")),beforePlans=readFileSync(join(owned.root,"task-plans.json"));
    input.runtime.resolveEngine=()=>{throw Error("No provider for receipt replay");};
    expect(await importer.applyLiveAccountRestore(input)).toEqual(first);
    expect(importer.readLiveRestoreReceipt(input.runtime,input.operationId,{userId:"alice",workspaceId:"alice-org"})).toEqual(first);
    expect(readFileSync(join(owned.root,"bots.json")).equals(beforeBots)).toBe(true);expect(readFileSync(join(owned.root,"task-plans.json")).equals(beforePlans)).toBe(true);
    expect(mdb.readThreadSnapshot(foreign.threadId)).toMatchObject({messages:[{text:"FOREIGN-UNCHANGED"},{text:"Later Bob message"}]});
    expect(()=>importer.readLiveRestoreReceipt(input.runtime,input.operationId,{userId:"bob",workspaceId:"bob-org"})).toThrow("could not be confirmed");
  });
  it.each(["cancel","session","member","subject"])("compensates current %s invalidation before commit",async reason=>{
    const control=new AbortController();input.signal=control.signal;input.onPhase=phase=>{if(phase!=="roster")return;
      if(reason==="cancel")control.abort();if(reason==="session")auth.exec("DELETE FROM session WHERE id='alice-session'");
      if(reason==="member")auth.exec("DELETE FROM member WHERE userId='alice'");if(reason==="subject")auth.exec("UPDATE account SET accountId='changed' WHERE userId='alice'");};
    await expect(importer.applyLiveAccountRestore(input)).rejects.toMatchObject({code:"rolled-back"});
    expect(readFileSync(join(owned.root,"bots.json"),"utf8")).toBe(originalBots);expect(mdb.readThreadSnapshot(foreignThread)).toMatchObject({messages:[{text:"FOREIGN-UNCHANGED"}]});
  });
  it("compensates SQLite session revocation during final engine resolution before committed receipt",async()=>{
    const resolve=input.runtime.resolveEngine,publish=vi.fn();input.runtime.publish=publish;let finalReadback=false,revokedRows="";
    input.onPhase=phase=>{if(phase==="readback")finalReadback=true;};
    input.runtime.resolveEngine=(selection,account)=>{
      const engine=resolve(selection,account);
      if(finalReadback){finalReadback=false;auth.exec("DELETE FROM session WHERE id='alice-session'");revokedRows=authRows();}
      return engine;
    };
    await expect(importer.applyLiveAccountRestore(input)).rejects.toMatchObject({code:"rolled-back"});
    expect(readFileSync(join(owned.root,"bots.json"),"utf8")).toBe(originalBots);expect(readFileSync(join(owned.root,"groups.json"),"utf8")).toBe(originalGroups);
    expect(readFileSync(join(owned.root,"task-plans.json"),"utf8")).toBe(originalPlans);expect(authRows()).toBe(revokedRows);
    expect(mdb.recoveryThreadIds()).toHaveLength(4);expect(mdb.readThreadSnapshot(foreignThread)).toMatchObject({messages:[{text:"FOREIGN-UNCHANGED"}]});
    expect(publish).not.toHaveBeenCalled();expect(send).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
    const journal=await import("./drive-visible-live-journal.ts"),held=journal.openLiveJournal(owned.root);
    try{expect(held.load(input.operationId)!.receipt).toMatchObject({status:"rolled-back",phase:"compensated"});}finally{held.release();}
  });
  it.each(["cancel","session","member","subject","account","runtime"])("keeps committed data without publication after committed-phase %s invalidation",async reason=>{
    const control=new AbortController(),publish=vi.fn(),phases:string[]=[];
    const originalReady=input.runtime.assertReady;let ready=true,committedFiles:string[]=[],committedThreads:string="",invalidatedAuth="";
    input.signal=control.signal;input.runtime.publish=publish;
    input.runtime.assertReady=()=>{if(!ready)throw Error("Retired owned runtime");originalReady();};
    input.onPhase=phase=>{
      phases.push(phase);if(phase!=="committed")return;
      committedFiles=["bots.json","groups.json","task-plans.json"].map(name=>readFileSync(join(owned.root,name),"utf8"));
      committedThreads=JSON.stringify(mdb.recoveryThreadIds());
      if(reason==="cancel")control.abort();
      if(reason==="session")auth.exec("DELETE FROM session WHERE id='alice-session'");
      if(reason==="member")auth.exec("DELETE FROM member WHERE userId='alice'");
      if(reason==="subject")auth.exec("UPDATE account SET accountId='changed' WHERE userId='alice'");
      if(reason==="account")auth.exec("UPDATE session SET userId='bob',activeOrganizationId='bob-org' WHERE id='alice-session'");
      if(reason==="runtime")ready=false;
      invalidatedAuth=authRows();
    };
    const restored=await importer.applyLiveAccountRestore(input);
    expect(restored.status).toBe("committed");expect(publish).not.toHaveBeenCalled();expect(phases).not.toContain("ack");
    expect(committedFiles).toHaveLength(3);
    expect(["bots.json","groups.json","task-plans.json"].map(name=>readFileSync(join(owned.root,name),"utf8"))).toEqual(committedFiles);
    expect(JSON.stringify(mdb.recoveryThreadIds())).toBe(committedThreads);expect(authRows()).toBe(invalidatedAuth);
    expect(mdb.readThreadSnapshot(restored.mapping.thread[ids.thread]!)).toMatchObject({activeLeafId:"selected",messages:[{id:"root"},{id:"selected"},{id:"newer-fork"}]});
    expect(readFileSync(join(owned.root,"workspaces",restored.mapping.bot[ids.own]!,"MEMORY.md"),"utf8")).toBe("Original memory");
    expect(mdb.readThreadSnapshot(foreignThread)).toMatchObject({messages:[{text:"FOREIGN-UNCHANGED"}]});
    expect(send).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
    // The original account's durable receipt survives even though publication
    // lost authority. Restoring only the fixture runtime permits receipt reads;
    // it does not reauthorize the cancelled request or the replaced account.
    input.runtime.assertReady=originalReady;
    expect(importer.readLiveRestoreReceipt(input.runtime,input.operationId,{userId:"alice",workspaceId:"alice-org"})).toEqual(restored);
    expect(()=>importer.readLiveRestoreReceipt(input.runtime,input.operationId,{userId:"bob",workspaceId:"bob-org"})).toThrow("could not be confirmed");
    const journal=await import("./drive-visible-live-journal.ts"),held=journal.openLiveJournal(owned.root);
    try{expect(held.load(input.operationId)!.receipt).toMatchObject({status:"committed",phase:"committed"});}finally{held.release();}
  });
  it("retains the committed receipt when the current account's sole publication throws",async()=>{
    const publish=vi.fn(()=>{throw Error("Owned publication failure");});input.runtime.publish=publish;
    const restored=await importer.applyLiveAccountRestore(input);
    expect(publish).toHaveBeenCalledOnce();expect(publish).toHaveBeenCalledWith({userId:"alice",workspaceId:"alice-org"},restored);
    expect(importer.readLiveRestoreReceipt(input.runtime,input.operationId,{userId:"alice",workspaceId:"alice-org"})).toEqual(restored);
    expect(mdb.readThreadSnapshot(restored.mapping.thread[ids.thread]!)).toMatchObject({activeLeafId:"selected"});
    expect(send).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects stale archive digest, wrong key and foreign engine before record mutation",async()=>{
    await expect(importer.applyLiveAccountRestore({...input,expectedSourceDigest:"0".repeat(64)})).rejects.toMatchObject({code:"preflight-refused"});
    await expect(importer.applyLiveAccountRestore({...input,key:{custody:"user-held",passphrase:"wrong-user-held-key"}})).rejects.toMatchObject({code:"preflight-refused"});
    const resolve=input.runtime.resolveEngine;input.runtime.resolveEngine=(selection,account)=>{const value=resolve(selection,account)!;return {...value,ownerId:"bob"};};
    await expect(importer.applyLiveAccountRestore(input)).rejects.toMatchObject({code:"preflight-refused"});unchanged();
  });
  it("refuses missing current target settings before creating recovery intent or inserting records",async()=>{
    input.runtime.readSettings=()=>null;await expect(importer.applyLiveAccountRestore(input)).rejects.toMatchObject({code:"preflight-refused"});unchanged();
    const journal=await import("./drive-visible-live-journal.ts"),held=journal.openLiveJournal(owned.root);try{expect(held.list()).toEqual([]);}finally{held.release();}
  });
  it("rolls back a real SQLite trigger failure with no partial thread rows",async()=>{
    const database=new DatabaseSync(join(owned.root,"messages.db"));database.exec("CREATE TRIGGER live_insert_fail BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT,'owned trigger failure'); END");
    try{await expect(importer.applyLiveAccountRestore(input)).rejects.toMatchObject({code:"rolled-back"});unchanged();}finally{database.close();}
  });
  it("preserves a conflicting external file postimage and refuses boot instead of resetting newer bytes",async()=>{
    let newer="";input.onPhase=phase=>{if(phase!=="roster")return;newer=readFileSync(join(owned.root,"bots.json"),"utf8")+"\n";writeFileSync(join(owned.root,"bots.json"),newer);throw Error("Conflicting external writer");};
    await expect(importer.applyLiveAccountRestore(input)).rejects.toMatchObject({code:"rollback-failed"});expect(readFileSync(join(owned.root,"bots.json"),"utf8")).toBe(newer);
    const journal=await import("./drive-visible-live-journal.ts");expect(()=>journal.assertLiveRestoreStartupReady(owned.root)).toThrow();
    expect(()=>journal.recoverPendingLiveRestores(owned.root)).toThrow();expect(readFileSync(join(owned.root,"bots.json"),"utf8")).toBe(newer);
  });
  it("preserves a newer foreign roster postimage observed after the real compensation SQL COMMIT",async()=>{
    const original=DatabaseSync.prototype.exec;let compensation=false,newer="",wrote=false;
    const spy=vi.spyOn(DatabaseSync.prototype,"exec").mockImplementation(function(this:DatabaseSync,sql:string){
      original.call(this,sql);
      if(compensation&&sql==="COMMIT"){
        compensation=false;const rows=JSON.parse(readFileSync(join(owned.root,"bots.json"),"utf8"));
        const foreign=rows.find((row:{ownerId?:string})=>row.ownerId==="bob");foreign.name="Bob newer after SQL compensation";
        newer=JSON.stringify(rows,null,2);writeFileSync(join(owned.root,"bots.json"),newer);wrote=true;
      }
    });
    input.onPhase=phase=>{if(phase==="roster"){compensation=true;throw Error("Owned pending failure");}};
    try{
      const error=await importer.applyLiveAccountRestore(input).catch(error=>error);
      expect(wrote).toBe(true);expect.soft(error).toMatchObject({code:"rollback-failed"});
      expect.soft(readFileSync(join(owned.root,"bots.json"),"utf8")).toBe(newer);
      expect(mdb.readThreadSnapshot(foreignThread)).toMatchObject({messages:[{text:"FOREIGN-UNCHANGED"}]});expect(authRows()).toBe(authBefore);
      const journal=await import("./drive-visible-live-journal.ts"),held=journal.openLiveJournal(owned.root);
      try{expect.soft(held.load(input.operationId)!.receipt.status).toBe("rollback-failed");}finally{held.release();}
    }finally{spy.mockRestore();}
  });
  it("refuses a changed imported cache without compensation or publication",async()=>{
    input.onPhase=phase=>{if(phase==="readback")input.runtime.store.bots.at(-1)!.name="Newer cache write";};
    await expect(importer.applyLiveAccountRestore(input)).rejects.toMatchObject({code:"rollback-failed"});
    const journal=await import("./drive-visible-live-journal.ts");expect(()=>journal.recoverPendingLiveRestores(owned.root)).toThrow("cache evidence");
    expect(input.runtime.store.bots.at(-1)!.name).toBe("Newer cache write");
  });
  it("serializes two simultaneous requests with the same operation into one durable receipt",async()=>{
    const [one,two]=await Promise.allSettled([importer.applyLiveAccountRestore(input),importer.applyLiveAccountRestore(input)]);
    expect(one.status).toBe("fulfilled");expect(two.status).toBe("rejected");
    expect(input.runtime.store.bots).toHaveLength(5);expect(await importer.applyLiveAccountRestore(input)).toEqual(one.status==="fulfilled"?one.value:undefined);
  });
});
