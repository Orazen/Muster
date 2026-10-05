import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOwnedOfflineRecoveryRoot, assertOwnedOfflineRecoveryRoot, acquireOfflineRecoveryLease,
  beginRecoveryOperation, loadRecoveryOperation, absentRecoveryDirectories, writeFreshRecoveryTarget,
  compensateRecoveryFiles, recoveryByteHash, type OwnedOfflineRecoveryRoot, type RecoveryJournal } from "./drive-visible-account-restore-journal.ts";
let owned:OwnedOfflineRecoveryRoot;
beforeEach(()=>owned=createOwnedOfflineRecoveryRoot());afterEach(()=>rmSync(owned.root,{recursive:true,force:true}));
function journal():RecoveryJournal{return {version:1,operationId:"owned-operation",sourceDigest:"a".repeat(64),archiveHash:recoveryByteHash("owned-encrypted-fixture"),account:{userId:"alice",workspaceId:"org",googleSub:"google"},mapping:{bot:{old:"fresh"},group:{},thread:{},plan:{}},changes:[{path:"bots.json",before:"ORIGINAL",after:"NEW",mode:0o600},{path:"workspaces/fresh/MEMORY.md",before:null,after:"Memory",mode:0o600}],threadPayload:"[]",inertHistory:"inert",createdDirs:[]};}
describe("owned offline restore journal",()=>{
  it("verifies actual root identity and refuses caller-only authority",()=>{
    expect(()=>assertOwnedOfflineRecoveryRoot({...owned,nonce:"different"})).toThrow();
    expect(()=>assertOwnedOfflineRecoveryRoot({root:join(owned.root,".."),nonce:owned.nonce})).toThrow();
  });
  it("never steals a live same-process lock, even in recovery mode",()=>{
    const lease=acquireOfflineRecoveryLease(owned);expect(()=>acquireOfflineRecoveryLease(owned,true)).toThrow(/occupied/);lease.release();
  });
  it("binds immutable bytes and archive hash to a private phase receipt",()=>{
    writeFileSync(join(owned.root,"bots.json"),"ORIGINAL");const lease=acquireOfflineRecoveryLease(owned),j=journal();j.createdDirs=absentRecoveryDirectories(owned,j.changes);beginRecoveryOperation(lease,j,Buffer.from("owned-encrypted-fixture"));expect(loadRecoveryOperation(lease,j.operationId)?.journal).toEqual(j);
    writeFileSync(join(owned.root,"account-recovery-journal",j.operationId,"archive.bin"),"tampered");expect(()=>loadRecoveryOperation(lease,j.operationId)).toThrow(/integrity/);lease.release();
  });
  it("compensates exact postimages/new paths while preserving unrelated files",()=>{
    writeFileSync(join(owned.root,"bots.json"),"ORIGINAL");writeFileSync(join(owned.root,"foreign.txt"),"FOREIGN");
    const lease=acquireOfflineRecoveryLease(owned),j=journal();j.createdDirs=absentRecoveryDirectories(owned,j.changes);
    for(const change of j.changes)writeFreshRecoveryTarget(lease,change);
    compensateRecoveryFiles(lease,j,()=>{});expect(readFileSync(join(owned.root,"bots.json"),"utf8")).toBe("ORIGINAL");expect(existsSync(join(owned.root,"workspaces"))).toBe(false);expect(readFileSync(join(owned.root,"foreign.txt"),"utf8")).toBe("FOREIGN");lease.release();
  });
  it("preflights every rollback target before invoking SQL compensation",()=>{
    writeFileSync(join(owned.root,"bots.json"),"NEWER");const lease=acquireOfflineRecoveryLease(owned);let called=false;
    expect(()=>compensateRecoveryFiles(lease,journal(),()=>{called=true;})).toThrow(/changed/);expect(called).toBe(false);expect(readFileSync(join(owned.root,"bots.json"),"utf8")).toBe("NEWER");lease.release();
  });
  it("refuses symlink parent and target without touching borrowed files",()=>{
    const foreign=createOwnedOfflineRecoveryRoot();try{writeFileSync(join(foreign.root,"MEMORY.md"),"FOREIGN");symlinkSync(foreign.root,join(owned.root,"workspaces"),"dir");const lease=acquireOfflineRecoveryLease(owned);expect(()=>writeFreshRecoveryTarget(lease,journal().changes[1])).toThrow(/parent/);expect(readFileSync(join(foreign.root,"MEMORY.md"),"utf8")).toBe("FOREIGN");lease.release();}finally{rmSync(foreign.root,{recursive:true,force:true});}
  });
});
