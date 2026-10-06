import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
const ownedRoots:string[]=[];
afterEach(()=>{for(const root of ownedRoots.splice(0))rmSync(root,{recursive:true,force:true});});
const worker=`
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
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
if(args.mode==='recover') {
 const journal=await import(url('server/drive-visible-live-journal.ts'));
 const recovered=[];journal.recoverPendingLiveRestores(args.owned.root);
 await import(url('server/drive-visible-startup-refusal.ts'));
 const mdb=await import(url('server/message-db.ts'));
 const {Store}=await import(url('server/store.ts'));const {TaskPlanEngine}=await import(url('server/task-engine.ts'));
 const store=new Store(()=>{throw Error('No fallback')});const plans=new TaskPlanEngine();
 const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
 const files=Object.fromEntries(['bots.json','groups.json','task-plans.json','auth.db','original-backup.bin'].map(name=>[name,hash(readFileSync(join(args.owned.root,name)))]));
 const foreign=mdb.readThreadSnapshot(JSON.parse(readFileSync(join(args.owned.root,'fixture.json'),'utf8')).foreignThread);
 writeFileSync(join(args.owned.root,'recovered.json'),JSON.stringify({recovered,files,bots:store.bots.length,plans:plans.listPlans().length,foreign,outbound}));
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
const bytes=readFileSync(join(args.owned.root,'source-archive.bin'));
const checked=archive.inspectAccountRecoveryArchive({bytes,key:{custody:'user-held',passphrase:'SYNTHETIC-OFFLINE-RECOVERY'},resolveAccount});
if(checked.status!=='ready')throw Error('Actual archive inspection unavailable');
const result=await importer.applyLiveAccountRestore({runtime:{dataDir:args.owned.root,store,plans,assertReady:()=>{},readSettings:account=>settings.readAccountSettings(auth,account),resolveEngine:()=>({ownerId:'alice',selection,instance})},resolveAccount,
 archive:bytes,key:{custody:'user-held',passphrase:'SYNTHETIC-OFFLINE-RECOVERY'},selection,expectedSourceDigest:checked.state.sourceDigest,operationId:'11111111-1111-4111-8111-111111111111',
 onPhase:phase=>{if(phase===args.phase)process.kill(process.pid,'SIGKILL');}});
writeFileSync(join(args.owned.root,'result.json'),JSON.stringify({result,outbound}));auth.close();mdb.closeMessageDb();
`;

function fixture(){
  const owned={root:realpathSync(mkdtempSync(join(tmpdir(),"muster-live-process-")))};ownedRoots.push(owned.root);
  const script=join(owned.root,"worker.mjs");writeFileSync(script,worker);
  const run=(mode:string,phase?:string)=>spawnSync(process.execPath,[script,JSON.stringify({owned,repo:pathToFileURL(resolve(".")).href+"/",mode,phase})],{
    cwd:owned.root,env:{PATH:process.env.PATH,HOME:owned.root,USERPROFILE:owned.root,OMB_DATA_DIR:owned.root,SystemRoot:process.env.SystemRoot},encoding:"utf8",timeout:30_000,maxBuffer:1024*1024});
  const init=run("init");expect(init.status,init.stderr).toBe(0);return {owned,run};
}
describe("actual live-root process interruption and early compensation",()=>{
  it.each(["intent","sqlite-commit","threads","plans-file","plans","bots-file","groups-file","roster","memory","readback"])("compensates pending %s before storage constructors",phase=>{
    const f=fixture();const originals=Object.fromEntries(["bots.json","groups.json","task-plans.json","auth.db","original-backup.bin"].map(name=>[name,readFileSync(join(f.owned.root,name))]));
    const killed=f.run("apply",phase);expect(killed.signal,killed.stderr).toBe("SIGKILL");
    const recovered=f.run("recover");expect(recovered.status,recovered.stderr).toBe(0);
    const evidence=JSON.parse(readFileSync(join(f.owned.root,"recovered.json"),"utf8"));expect(evidence.bots).toBe(3);expect(evidence.plans).toBe(2);
    expect(evidence.foreign).toMatchObject({messages:[{text:"FOREIGN-UNCHANGED"}]});expect(evidence.outbound).toBe(0);
    for(const [name,bytes]of Object.entries(originals))expect(readFileSync(join(f.owned.root,name)).equals(bytes)).toBe(true);
    expect(existsSync(join(f.owned.root,".account-recovery-owner.json"))).toBe(false);
  });
  it.each(["journal-intent","journal-receipt"])("preserves unfinished %s and refuses boot before any data writes",phase=>{
    const f=fixture(),original=readFileSync(join(f.owned.root,"bots.json"));
    expect(f.run("apply",phase).signal).toBe("SIGKILL");const refused=f.run("recover");expect(refused.status).not.toBe(0);
    expect(readFileSync(join(f.owned.root,"bots.json")).equals(original)).toBe(true);
  });
  it.each(["committed","ack"])("preserves lost %s acknowledgement across restart with no compensation",phase=>{
    const f=fixture();expect(f.run("apply",phase).signal).toBe("SIGKILL");const bots=readFileSync(join(f.owned.root,"bots.json"));
    const recovered=f.run("recover");expect(recovered.status,recovered.stderr).toBe(0);expect(readFileSync(join(f.owned.root,"bots.json")).equals(bots)).toBe(true);
    expect(JSON.parse(readFileSync(join(f.owned.root,"recovered.json"),"utf8")).bots).toBe(5);
    const replay=f.run("apply");expect(replay.status,replay.stderr).toBe(0);expect(JSON.parse(readFileSync(join(f.owned.root,"result.json"),"utf8")).result.status).toBe("committed");
  });
});
