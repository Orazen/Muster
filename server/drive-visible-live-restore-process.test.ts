import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
const ownedRoots:string[]=[];
afterEach(()=>{for(const root of ownedRoots.splice(0))rmSync(root,{recursive:true,force:true});});
const worker=String.raw`
import {readFileSync,writeFileSync,mkdirSync,existsSync,readSync,writeSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
const args=JSON.parse(process.argv[2]);
let outbound=0;
const denied=()=>{outbound++;throw Error('Synthetic offline outbound denied')};
globalThis.fetch=denied;
const net=(await import('node:net')).default;net.Socket.prototype.connect=denied;
const dns=(await import('node:dns')).default;dns.lookup=denied;dns.resolve=denied;
const udp=(await import('node:dgram')).default;udp.createSocket=denied;
// Kill in the gap immediately after the REAL SQLite commit, before the
// coordinator can persist its next phase receipt.
const originalExec=DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec=function(sql){const result=originalExec.call(this,sql);if(args.mode==='apply'&&args.phase==='sqlite-commit'&&sql==='COMMIT'&&this.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='account_recovery_operations'").get()&&this.prepare("SELECT 1 FROM account_recovery_operations WHERE operation_id='11111111-1111-4111-8111-111111111111'").get())process.kill(process.pid,'SIGKILL');return result;};
const fs=(await import('node:fs')).default;
const originalRename=fs.renameSync;
fs.renameSync=(from,to)=>{originalRename(from,to);if(args.mode==='apply'&&String(to).includes('.preparing-')&&((args.phase==='journal-intent'&&String(to).endsWith('/intent.json'))||(args.phase==='journal-receipt'&&String(to).endsWith('/receipt.json'))))process.kill(process.pid,'SIGKILL');if(args.mode==='apply'&&((args.phase==='bots-file'&&String(to)===join(args.owned.root,'bots.json'))||(args.phase==='groups-file'&&String(to)===join(args.owned.root,'groups.json'))||(args.phase==='plans-file'&&String(to)===join(args.owned.root,'task-plans.json'))))process.kill(process.pid,'SIGKILL');};
(await import('node:module')).syncBuiltinESMExports();
const url=path=>args.repo+path;
if(args.mode==='boot') {
 // This is production's observation/refusal predicate, before storage
 // constructors. It deliberately has no recovery or adoption capability.
 await import(url('server/drive-visible-startup-refusal.ts'));
 writeFileSync(join(args.owned.root,'boot-accepted.json'),'true');process.exit(0);
}
if(args.mode==='recover'||args.mode==='inspect-owned-fixture') {
 const recovered=[];
 if(args.mode==='recover') {
  // Explicit cooperating recovery in an owned fixture, never boot adoption.
  const journal=await import(url('server/drive-visible-live-journal.ts'));
  journal.recoverPendingLiveRestores(args.owned.root);
  await import(url('server/drive-visible-startup-refusal.ts'));
 }
 // inspect-owned-fixture is forensic cache reconstruction after a refused
 // recovery, not permission for a production server to initialize.
 const mdb=await import(url('server/message-db.ts'));
 const {Store}=await import(url('server/store.ts'));const {TaskPlanEngine}=await import(url('server/task-engine.ts'));
 const store=new Store(()=>{throw Error('No fallback')});const plans=new TaskPlanEngine();
 const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
 const files=Object.fromEntries(['bots.json','groups.json','task-plans.json','auth.db','original-backup.bin'].map(name=>[name,hash(readFileSync(join(args.owned.root,name)))]));
 const foreign=mdb.readThreadSnapshot(JSON.parse(readFileSync(join(args.owned.root,'fixture.json'),'utf8')).foreignThread);
 const db=new DatabaseSync(join(args.owned.root,'messages.db'),{readOnly:true});
 const marker=db.prepare("SELECT 1 FROM sqlite_master WHERE name='account_recovery_operations'").get()
  ?db.prepare("SELECT payload FROM account_recovery_operations WHERE operation_id='11111111-1111-4111-8111-111111111111'").get():null;
 const imported=marker?JSON.parse(marker.payload):[];
 const threads=imported.map(thread=>({threadId:thread.threadId,snapshot:mdb.readThreadSnapshot(thread.threadId),cached:store.messagesFor(thread.threadId)}));
 const intents=db.prepare("SELECT intent_id,thread_id,message_id,state,owner FROM message_intents ORDER BY intent_id").all();db.close();
 writeFileSync(join(args.owned.root,args.mode==='recover'?'recovered.json':'inspected.json'),JSON.stringify({recovered,files,bots:store.bots.length,plans:plans.listPlans().length,roster:store.bots.map(bot=>({id:bot.id,name:bot.name})),threads,intents,foreign,outbound}));
 mdb.closeMessageDb();process.exit(0);
}
const importer=await import(url('server/drive-visible-live-restore.ts'));
const mdb=await import(url('server/message-db.ts'));
const {Store}=await import(url('server/store.ts'));
const {TaskPlanEngine}=await import(url('server/task-engine.ts'));
const archive=await import(url('server/drive-visible-account-archive.ts'));
const settings=await import(url('server/drive-visible-settings.ts'));
const identity=await import(url('server/follow-up-identity.ts'));
const {makeFakeDriver}=await import(url('server/testing/fake-driver.ts'));
const auth=new DatabaseSync(join(args.owned.root,'auth.db'));
if(args.mode==='init') {
 auth.exec("CREATE TABLE user(id TEXT PRIMARY KEY);CREATE TABLE organization(id TEXT PRIMARY KEY);CREATE TABLE member(id TEXT PRIMARY KEY,userId TEXT,organizationId TEXT,createdAt INTEGER);CREATE TABLE session(id TEXT PRIMARY KEY,userId TEXT,activeOrganizationId TEXT,expiresAt INTEGER);CREATE TABLE account(userId TEXT,providerId TEXT,accountId TEXT);INSERT INTO user VALUES('alice'),('bob');INSERT INTO organization VALUES('org'),('bob-org');INSERT INTO member VALUES('a','alice','org',1),('b','bob','bob-org',1);INSERT INTO account VALUES('alice','google','alice-sub'),('bob','google','bob-sub');");
 auth.prepare("INSERT INTO session VALUES('session','alice','org',?),('bob-session','bob','bob-org',?)").run(Date.now()+600000,Date.now()+600000);
}
const resolveAccount=()=>{
 const session=auth.prepare("SELECT * FROM session WHERE id='session' AND expiresAt>?").get(Date.now());if(!session)return null;
 const account=identity.resolveFollowUpAccount(auth,{userId:session.userId,sessionId:session.id},false);
 const google=auth.prepare("SELECT accountId FROM account WHERE userId=? AND providerId='google'").get(session.userId);
 return account&&google?{account,googleSub:google.accountId}:null;
};
const selection={instanceId:'fakeApi:alice',model:'fake-1'};
const store=new Store(()=>selection),plans=new TaskPlanEngine();
if(args.mode==='init') {
 const own=store.createBot({ownerId:'alice',modelSelection:selection},{seedMessages:false});
 const peer=store.createBot({ownerId:'alice',modelSelection:selection},{seedMessages:false});
 const foreign=store.createBot({ownerId:'bob',modelSelection:{instanceId:'fakeApi:bob',model:'fake-1'}},{seedMessages:false});
 mdb.replaceThreadFromSync(own.threadId,[{id:'root',parentId:null,at:1,role:'user',kind:'text',text:'Root'},{id:'older',parentId:'root',at:2,role:'bot',kind:'text',text:'Selected older'},{id:'newer',parentId:'root',at:3,role:'bot',kind:'text',text:'Newer fork'}],'older');
 mdb.replaceThreadFromSync(peer.threadId,[],null);mdb.appendMessage(foreign.threadId,{id:'foreign',parentId:null,at:1,role:'user',kind:'text',text:'FOREIGN-UNCHANGED'});
 const room=store.createGroup('Preserved room',[own.id,peer.id],false,'alice',{kind:'member',botId:peer.id});mdb.replaceThreadFromSync(room.threadId,[],null);
 plans.create({botId:own.id,ownerId:'alice',threadId:own.threadId,steps:['Original plan'],start:false});plans.create({botId:foreign.id,ownerId:'bob',threadId:foreign.threadId,steps:['Foreign plan'],start:false});
 mkdirSync(join(args.owned.root,'workspaces',own.id,'memory'),{recursive:true});writeFileSync(join(args.owned.root,'workspaces',own.id,'MEMORY.md'),'Memory');writeFileSync(join(args.owned.root,'workspaces',own.id,'memory','topic.md'),'Topic');
 settings.captureAccountSettings(auth,resolveAccount().account,{theme:'dark'});
 const built=archive.buildAccountRecoveryArchive({source:{account:resolveAccount().account,dataDir:args.owned.root,store,plans,settingsSnapshot:settings.readAccountSettings(auth,resolveAccount().account)},resolveAccount,key:{custody:'user-held',passphrase:'SYNTHETIC-OFFLINE-RECOVERY'},appVersion:'test'});
 if(built.status!=='ready')throw Error('Fixture archive unavailable');writeFileSync(join(args.owned.root,'source-archive.bin'),built.bytes);
 writeFileSync(join(args.owned.root,'original-backup.bin'),'ORIGINAL-UNCHANGED-BACKUP');writeFileSync(join(args.owned.root,'fixture.json'),JSON.stringify({foreignThread:foreign.threadId}));
 auth.close();mdb.closeMessageDb();process.exit(0);
}
const fake=makeFakeDriver(),instance=await fake.driver.create({instanceId:selection.instanceId,displayName:'Owned engine',environment:{},enabled:true,config:{}});
instance.adapter.sendTurn=denied;
const {holdRestoreRootIdentity}=await import(url('server/drive-visible-live-writer-authority.ts'));
const {createLiveRestoreRuntime,productionLiveRestoreRegistration}=await import(url('server/drive-visible-live-restore-runtime.ts'));
if(Object.keys(productionLiveRestoreRegistration()).length)throw Error('Production apply must remain unavailable');
const rootIdentity=holdRestoreRootIdentity(args.owned.root);
const published=[];
const runtime=createLiveRestoreRuntime({dataDir:args.owned.root,store,plans,rootIdentity,instances:()=>[instance],
 readAccountSettings:account=>settings.readAccountSettings(auth,account),publishRecords:(account,ids)=>published.push({account,ids})});
const bytes=readFileSync(join(args.owned.root,'source-archive.bin'));
const checked=archive.inspectAccountRecoveryArchive({bytes,key:{custody:'user-held',passphrase:'SYNTHETIC-OFFLINE-RECOVERY'},resolveAccount});
if(checked.status!=='ready')throw Error('Actual archive inspection unavailable');
try {
const result=await importer.applyLiveAccountRestore({runtime,resolveAccount,
 archive:bytes,key:{custody:'user-held',passphrase:'SYNTHETIC-OFFLINE-RECOVERY'},selection,expectedSourceDigest:checked.state.sourceDigest,operationId:'11111111-1111-4111-8111-111111111111',
 onPhase:phase=>{
  if(args.phase==='external-writer'&&phase==='readback') {
   // A pipe handshake pauses this synchronous frame until the parent has
   // received the already-open writer's mutation acknowledgement.
   writeSync(1,JSON.stringify({event:'readback',kind:rootIdentity.kind})+'\n');
   const command=Buffer.alloc(1);if(readSync(0,command,0,1,null)!==1||command[0]!==107)throw Error('Missing writer acknowledgement');
   runtime.assertReady(); // Identity still holds despite the foreign writes.
   writeSync(1,JSON.stringify({event:'identity-still-held',published:published.length})+'\n');
   process.kill(process.pid,'SIGKILL');
  }
  if(phase===args.phase)process.kill(process.pid,'SIGKILL');
 }});
writeFileSync(join(args.owned.root,'result.json'),JSON.stringify({result,outbound,published}));
} finally {rootIdentity.release();auth.close();mdb.closeMessageDb();}
`;

// This child owns its handles before the importer even starts. Neither a
// directory identity nor the cooperating journal lock can revoke them.
const retainedWriter=String.raw`
import {openSync,closeSync,writeSync,fsyncSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createInterface} from 'node:readline';
const root=JSON.parse(process.argv[2]).owned.root;
const fd=openSync(join(root,'original-backup.bin'),'r+');
const db=new DatabaseSync(join(root,'messages.db'));
const commands=createInterface({input:process.stdin});
const emit=value=>writeSync(1,JSON.stringify(value)+'\n');
try {
 const mode=db.prepare('PRAGMA journal_mode=WAL').get().journal_mode;
 db.prepare('SELECT COUNT(*) AS n FROM messages').get();
 emit({event:'ready',journalMode:mode,uid:process.getuid?.()});
 for await(const line of commands) {
  const command=JSON.parse(line);
  if(command.action==='close')break;
  if(command.action!=='mutate'||!['sql-intent','roster'].includes(command.conflict))throw Error('Unknown owned writer command');
  const marker=db.prepare("SELECT payload FROM account_recovery_operations WHERE operation_id='11111111-1111-4111-8111-111111111111'").get();
  const thread=JSON.parse(marker.payload).find(thread=>thread.messages.length);
  if(!thread)throw Error('No restored SQL postimage');
  const raw=Buffer.from('EXTERNAL');writeSync(fd,raw,0,raw.length,0);fsyncSync(fd);
  let botId=null;
  if(command.conflict==='sql-intent') {
   db.prepare("INSERT INTO message_intents(intent_id,thread_id,message_id,fingerprint,accepted_at,state,owner) VALUES(?,?,?,?,?,'accepted','alice')")
    .run('external-intent',thread.threadId,thread.messages[0].id,'external-fingerprint',1);
  } else {
   const path=join(root,'bots.json'),bots=JSON.parse(readFileSync(path,'utf8'));
   const bot=bots.find(bot=>bot.threadId===thread.threadId);if(!bot)throw Error('No restored roster postimage');
   botId=bot.id;bot.name='EXTERNAL-ROSTER';writeFileSync(path,JSON.stringify(bots,null,2));
  }
  emit({event:'mutated',threadId:thread.threadId,botId,messages:thread.messages});
 }
} finally {
 // Closing readline alone leaves its input stream alive. Retire this
 // child's owned command pipe as well, then let the process exit naturally.
 commands.close();process.stdin.destroy();db.close();closeSync(fd);
}
emit({event:'closed'});
`;

function fixture(){
  const owned={root:realpathSync(mkdtempSync(join(tmpdir(),"muster-live-process-")))};ownedRoots.push(owned.root);
  const script=join(owned.root,"worker.mjs");writeFileSync(script,worker);
  const run=(mode:string,phase?:string)=>spawnSync(process.execPath,[script,JSON.stringify({owned,repo:pathToFileURL(resolve(".")).href+"/",mode,phase})],{
    cwd:owned.root,env:{PATH:process.env.PATH,HOME:owned.root,USERPROFILE:owned.root,OMB_DATA_DIR:owned.root,SystemRoot:process.env.SystemRoot},encoding:"utf8",timeout:30_000,maxBuffer:1024*1024});
  const env={PATH:process.env.PATH,HOME:owned.root,USERPROFILE:owned.root,OMB_DATA_DIR:owned.root,SystemRoot:process.env.SystemRoot};
  const start=(kind:"writer"|"apply")=>{
    const childScript=kind==="writer"?join(owned.root,"retained-writer.mjs"):script;
    if(kind==="writer")writeFileSync(childScript,retainedWriter);
    return boundedChild(childScript,{owned,repo:pathToFileURL(resolve(".")).href+"/",mode:"apply",phase:"external-writer"},env);
  };
  const init=run("init");expect(init.status,init.stderr).toBe(0);return {owned,run,start};
}

/** Only direct, fixture-owned children; no host process discovery or signaling.
 * Handshakes order the experiment. Timeouts are failure bounds, not sleeps. */
function boundedChild(script:string,args:{owned:{root:string};repo:string;mode:string;phase:string},env:NodeJS.ProcessEnv){
  const child=spawn(process.execPath,[script,JSON.stringify(args)],{cwd:args.owned.root,env,stdio:["pipe","pipe","pipe"]});
  let buffer="",stderr="",bytes=0,failure:Error|undefined,ended=false;
  const lines:string[]=[],waiters:Array<{resolve:(line:string)=>void;reject:(error:Error)=>void}>=[];
  const fail=(error:Error)=>{failure??=error;for(const waiter of waiters.splice(0))waiter.reject(failure);child.kill("SIGKILL");};
  const timer=setTimeout(()=>fail(new Error("Owned child exceeded 15 seconds")),15_000);
  child.on("error",fail);child.stdin.on("error",fail);
  child.stdout.on("data",chunk=>{
    bytes+=chunk.length;if(bytes>64*1024){fail(new Error("Owned child output exceeded 64 KiB"));return;}
    buffer+=chunk.toString();let index:number;
    while((index=buffer.indexOf("\n"))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);const waiter=waiters.shift();if(waiter)waiter.resolve(line);else lines.push(line);}
  });
  child.stderr.on("data",chunk=>{bytes+=chunk.length;if(bytes>64*1024)fail(new Error("Owned child output exceeded 64 KiB"));else stderr+=chunk.toString();});
  const closed=new Promise<{code:number|null;signal:NodeJS.Signals|null;stderr:string;failure:Error|undefined}>(resolve=>child.once("close",(code,signal)=>{
    ended=true;clearTimeout(timer);for(const waiter of waiters.splice(0))waiter.reject(failure??new Error(`Owned child closed: ${code}/${signal}: ${stderr}`));resolve({code,signal,stderr,failure});
  }));
  return {
    nextLine:()=>failure?Promise.reject(failure):lines.length?Promise.resolve(lines.shift()!):ended?Promise.reject(new Error(`Owned child already closed: ${stderr}`)):new Promise<string>((resolve,reject)=>waiters.push({resolve,reject})),
    send:(value:string)=>child.stdin.write(value),finish:(value:string)=>child.stdin.end(value),closed,
    stop:async()=>{if(!ended)child.kill("SIGKILL");await closed;},
  };
}

function treeBytes(root:string){
  const result:Record<string,string>={};
  const visit=(relative:string)=>{for(const entry of readdirSync(join(root,relative),{withFileTypes:true})){
    const path=join(relative,entry.name);if(entry.isDirectory())visit(path);
    else {expect(entry.isFile()).toBe(true);result[path]=createHash("sha256").update(readFileSync(join(root,path))).digest("hex");}
  }};visit("");return result;
}
function assertBootRefuses(f:ReturnType<typeof fixture>){
  const before=treeBytes(f.owned.root),refused=f.run("boot");
  expect(refused.error).toBeUndefined();expect(refused.signal).toBeNull();expect(refused.status,refused.stderr).not.toBe(0);
  expect(refused.stderr).toMatch(/startup|reconciliation/i);
  expect(existsSync(join(f.owned.root,"boot-accepted.json"))).toBe(false);
  expect(treeBytes(f.owned.root)).toEqual(before);
}
describe("actual live-root process interruption and early compensation",()=>{
  it.each(["intent","sqlite-commit","threads","plans-file","plans","bots-file","groups-file","roster","memory","readback"])("compensates pending %s before storage constructors",phase=>{
    const f=fixture();const originals=Object.fromEntries(["bots.json","groups.json","task-plans.json","auth.db","original-backup.bin"].map(name=>[name,readFileSync(join(f.owned.root,name))]));
    const killed=f.run("apply",phase);expect(killed.signal,killed.stderr).toBe("SIGKILL");
    assertBootRefuses(f);
    const recovered=f.run("recover");expect(recovered.status,recovered.stderr).toBe(0);
    const evidence=JSON.parse(readFileSync(join(f.owned.root,"recovered.json"),"utf8"));expect(evidence.bots).toBe(3);expect(evidence.plans).toBe(2);
    expect(evidence.foreign).toMatchObject({messages:[{text:"FOREIGN-UNCHANGED"}]});expect(evidence.outbound).toBe(0);
    for(const [name,bytes]of Object.entries(originals))expect(readFileSync(join(f.owned.root,name)).equals(bytes)).toBe(true);
    expect(existsSync(join(f.owned.root,".account-recovery-owner.json"))).toBe(false);
  });
  it.each(["journal-intent","journal-receipt"])("preserves unfinished %s and refuses boot before any data writes",phase=>{
    const f=fixture(),original=readFileSync(join(f.owned.root,"bots.json"));
    expect(f.run("apply",phase).signal).toBe("SIGKILL");assertBootRefuses(f);
    const refused=f.run("recover");expect(refused.status).not.toBe(0);
    expect(readFileSync(join(f.owned.root,"bots.json")).equals(original)).toBe(true);
  });
  it.each(["committed","ack"])("preserves lost %s acknowledgement across restart with no compensation",phase=>{
    const f=fixture();expect(f.run("apply",phase).signal).toBe("SIGKILL");const bots=readFileSync(join(f.owned.root,"bots.json"));
    const recovered=f.run("recover");expect(recovered.status,recovered.stderr).toBe(0);expect(readFileSync(join(f.owned.root,"bots.json")).equals(bots)).toBe(true);
    expect(JSON.parse(readFileSync(join(f.owned.root,"recovered.json"),"utf8")).bots).toBe(5);
    const replay=f.run("apply");expect(replay.status,replay.stderr).toBe(0);expect(JSON.parse(readFileSync(join(f.owned.root,"result.json"),"utf8")).result.status).toBe("committed");
  });
  it.each(["sql-intent","roster"])("preserves an already-open writer's %s conflict across interruption and refused recovery",async conflict=>{
    const f=fixture(),writer=f.start("writer");let applying:ReturnType<typeof f.start>|undefined;
    try {
      const ready=JSON.parse(await writer.nextLine());
      expect(ready).toEqual({event:"ready",journalMode:"wal",uid:process.getuid?.()});
      // The writer's FD and established WAL connection predate the importer
      // process, all its constructors and its actual root-identity holder.
      applying=f.start("apply");
      expect(JSON.parse(await applying.nextLine())).toEqual({event:"readback",kind:"root-identity-only"});
      writer.send(JSON.stringify({action:"mutate",conflict})+"\n");
      const mutation=JSON.parse(await writer.nextLine());expect(mutation.event).toBe("mutated");
      applying.send("k");
      expect(JSON.parse(await applying.nextLine())).toEqual({event:"identity-still-held",published:0});
      const killed=await applying.closed;expect(killed.failure).toBeUndefined();expect(killed.signal,killed.stderr).toBe("SIGKILL");
      writer.finish(JSON.stringify({action:"close"})+"\n");
      expect(JSON.parse(await writer.nextLine())).toEqual({event:"closed"});
      const stopped=await writer.closed;expect(stopped.failure).toBeUndefined();expect(stopped.code,stopped.stderr).toBe(0);expect(stopped.signal).toBeNull();
      expect(readFileSync(join(f.owned.root,"original-backup.bin"),"utf8")).toBe("EXTERNAL-UNCHANGED-BACKUP");
      assertBootRefuses(f);
      const saved=Object.fromEntries(["bots.json","groups.json","task-plans.json","auth.db","original-backup.bin"].map(name=>[name,readFileSync(join(f.owned.root,name))]));
      const refused=f.run("recover");expect(refused.error).toBeUndefined();expect(refused.signal).toBeNull();expect(refused.status,refused.stderr).not.toBe(0);
      expect(refused.stderr).toContain("requires reconciliation before startup");
      expect(existsSync(join(f.owned.root,"recovered.json"))).toBe(false);
      const receiptPath=join(f.owned.root,"account-live-restore-journal","11111111-1111-4111-8111-111111111111","receipt.json");
      expect(JSON.parse(JSON.parse(readFileSync(receiptPath,"utf8")).body)).toMatchObject({status:"rollback-failed",phase:"compensation-unavailable"});
      assertBootRefuses(f);
      // Deliberate forensic reconstruction in this isolated fixture. This is
      // not a successful boot: ordinary startup above still refuses it.
      const inspected=f.run("inspect-owned-fixture");expect(inspected.status,inspected.stderr).toBe(0);
      const evidence=JSON.parse(readFileSync(join(f.owned.root,"inspected.json"),"utf8"));
      expect(evidence).toMatchObject({bots:5,plans:3,outbound:0,foreign:{messages:[{text:"FOREIGN-UNCHANGED"}]}});
      const restored=evidence.threads.find((thread:{threadId:string})=>thread.threadId===mutation.threadId);
      expect(restored.snapshot).toMatchObject({status:"ready",messages:mutation.messages});expect(restored.cached).toEqual(mutation.messages);
      if(conflict==="sql-intent")expect(evidence.intents).toEqual([{intent_id:"external-intent",thread_id:mutation.threadId,message_id:mutation.messages[0].id,state:"accepted",owner:"alice"}]);
      else {expect(evidence.intents).toEqual([]);expect(evidence.roster).toContainEqual({id:mutation.botId,name:"EXTERNAL-ROSTER"});}
      for(const [name,bytes]of Object.entries(saved))expect(readFileSync(join(f.owned.root,name)).equals(bytes),name).toBe(true);
    } finally {await applying?.stop();await writer.stop();}
  },30_000);
});
