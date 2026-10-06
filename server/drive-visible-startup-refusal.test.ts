import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync,
  realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { assertLiveRestoreStartupReady, liveHash, openLiveJournal, recoverPendingLiveRestores } from "./drive-visible-live-journal.ts";
import { exclusiveClaimPath } from "./data-dir-exclusivity.ts";
import { assertAccountRecoveryStartupReady } from "./drive-visible-startup-refusal.ts";

const roots: string[] = [];
const digest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function fixture(status = "committed", phase = status === "rolled-back" ? "compensated" : "committed") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "muster-startup-evidence-"))); roots.push(root);
  const journal = join(root, "account-recovery-journal"), operation = join(journal, "operation");
  mkdirSync(operation, { recursive: true, mode: 0o700 });
  const archive = Buffer.from("Owned synthetic encrypted archive bytes");
  const immutable = { version: 1, operationId: "operation", sourceDigest: digest("source"), archiveHash: digest(archive),
    account: { userId: "alice", workspaceId: "org", googleSub: "alice-sub" },
    mapping: { bot: {}, group: {}, thread: {}, plan: {} }, changes: [], threadPayload: "[]", inertHistory: "{}", createdDirs: [] };
  const bytes = JSON.stringify(immutable);
  const receipt = { version: 1, operationId: "operation", immutableHash: digest(bytes), status, phase };
  writeFileSync(join(operation, "archive.bin"), archive); writeFileSync(join(operation, "immutable.json"), bytes);
  writeFileSync(join(operation, "receipt.json"), JSON.stringify(receipt)); writeFileSync(join(root, "preserved.bin"), "PRESERVED");
  return { root, journal, operation, immutable, receipt };
}
type EvidenceInventory = Record<string, string>;
function files(root: string) {
  const inventory: EvidenceInventory = {};
  const visit = (directory: string, prefix = "") => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name), name = prefix + entry.name;
      if (entry.isDirectory()) visit(path, name + "/");
      else if (entry.isFile()) inventory[name] = digest(readFileSync(path));
      else inventory[name] = "linked-or-other";
    }
  };
  visit(root); return inventory;
}
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

describe("read-only pre-initialization account recovery refusal", () => {
  it("does not create a missing data root or journal", () => {
    const f = fixture(), missingRoot = join(f.root, "absent");
    expect(() => assertAccountRecoveryStartupReady(missingRoot)).not.toThrow();
    expect(existsSync(missingRoot)).toBe(false);
  });
  it("leaves an existing no-journal root unchanged", () => {
    const f = fixture(); rmSync(f.journal, { recursive: true }); const before = files(f.root);
    expect(() => assertAccountRecoveryStartupReady(f.root)).not.toThrow(); expect(files(f.root)).toEqual(before);
  });
  it.each(["committed", "rolled-back"])("allows fully bound closed %s evidence without writes", status => {
    const f = fixture(status), before = files(f.root);
    expect(() => assertAccountRecoveryStartupReady(f.root)).not.toThrow(); expect(files(f.root)).toEqual(before);
  });
  it.each(["pending", "rollback-failed", "unknown"])("refuses %s while preserving evidence", status => {
    const f = fixture(status), before = files(f.root);
    expect(() => assertAccountRecoveryStartupReady(f.root)).toThrow(/startup refused/); expect(files(f.root)).toEqual(before);
  });
  it.each(["writer.lock", ".preparing-a5ff986a-49cd-47b7-a889-924bc34a9bd9", "unknown.entry"])("preserves and refuses ambiguous %s", name => {
    const f = fixture(); writeFileSync(join(f.journal, name), "UNCHANGED"); const before = files(f.root);
    expect(() => assertAccountRecoveryStartupReady(f.root)).toThrow(/startup refused/); expect(files(f.root)).toEqual(before);
  });
  it.each(["receipt.json", "immutable.json", "archive.bin"])("refuses absent %s", name => {
    const f = fixture(); rmSync(join(f.operation, name)); const before = files(f.root);
    expect(() => assertAccountRecoveryStartupReady(f.root)).toThrow(/startup refused/); expect(files(f.root)).toEqual(before);
  });
  it.each(["receipt.json", "immutable.json", "archive.bin"])("refuses damaged %s", name => {
    const f = fixture(); writeFileSync(join(f.operation, name), "DAMAGED"); const before = files(f.root);
    expect(() => assertAccountRecoveryStartupReady(f.root)).toThrow(/startup refused/); expect(files(f.root)).toEqual(before);
  });
  it("rejects unknown immutable fields even with recomputed digest", () => {
    const f = fixture(), bytes = JSON.stringify({ ...f.immutable, authority: "invented" });
    writeFileSync(join(f.operation, "immutable.json"), bytes);
    writeFileSync(join(f.operation, "receipt.json"), JSON.stringify({ ...f.receipt, immutableHash: digest(bytes) }));
    const before = files(f.root); expect(() => assertAccountRecoveryStartupReady(f.root)).toThrow(/startup refused/); expect(files(f.root)).toEqual(before);
  });
  it.each([{ operationId: "other" }, { version: 2 }, { phase: "readback" }, { status: "rolled-back", phase: "committed" }, { extra: true }])("refuses inconsistent receipt %j", patch => {
    const f = fixture(); writeFileSync(join(f.operation, "receipt.json"), JSON.stringify({ ...f.receipt, ...patch }));
    expect(() => assertAccountRecoveryStartupReady(f.root)).toThrow(/startup refused/);
  });
  it("rejects an unlinked-but-hardlinked file without changing either name", () => {
    const f = fixture(), outside = join(f.root, "receipt-copy.json"); linkSync(join(f.operation, "receipt.json"), outside);
    const before = files(f.root); expect(() => assertAccountRecoveryStartupReady(f.root)).toThrow(/startup refused/); expect(files(f.root)).toEqual(before);
  });
  it("rejects a linked operation and journal without following their content", () => {
    const f = fixture(), outside = join(f.root, "moved-journal");
    rmSync(f.journal, { recursive: true }); mkdirSync(outside); writeFileSync(join(outside, "receipt.json"), "PRESERVED");
    symlinkSync(outside, f.journal, "dir"); const before = files(f.root);
    expect(() => assertAccountRecoveryStartupReady(f.root)).toThrow(/startup refused/); expect(files(f.root)).toEqual(before);
  });
  it("rejects oversized immutable evidence before allocating its contents", () => {
    const f = fixture(), path = join(f.operation, "immutable.json");
    const fd = openSync(path, "w"); closeSync(fd); truncateSync(path, 96 * 1024 * 1024 + 1);
    expect(() => assertAccountRecoveryStartupReady(f.root)).toThrow(/startup refused/);
  });
  it("rejects excess directory inventory without reading files", () => {
    const f = fixture(); for (let index = 0; index < 1024; index++) writeFileSync(join(f.journal, `extra${index}`), "");
    expect(() => assertAccountRecoveryStartupReady(f.root)).toThrow(/startup refused/);
  });
});


function liveFixture(status: "pending" | "committed" | "rolled-back" = "pending") {
  const configuredRoot = mkdtempSync(join(tmpdir(), "muster-live-startup-"));
  const root = realpathSync(configuredRoot); roots.push(root);
  writeFileSync(join(root,"preserved.bin"),"UNCHANGED");
  const held = openLiveJournal(root), operationId = randomUUID(), target = Buffer.from("owned encrypted-copy envelope fixture");
  const receipt = held.begin({version:1,kind:"account-live-additive",operationId,userId:"alice",workspaceId:"org",googleSub:"alice-sub",
    archiveHash:liveHash("source"),sourceDigest:liveHash("state"),mapping:{bot:{},group:{},thread:{},plan:{}},changes:[],threads:[],inertHistory:"{}",createdDirs:[],
    targetCopy:{sha256:liveHash(target),sourceDigest:liveHash("target state"),keyMode:"provided-secret-as-passphrase"}},target);
  if(status!=="pending")held.mark(receipt,status,status==="committed"?"committed":"compensated");held.release();
  return {root,configuredRoot,operation:join(root,"account-live-restore-journal",operationId)};
}
describe("live account startup boundary without a production writer capability",()=>{
  it("observes pending evidence without boot-time mutation or lease creation",()=>{
    const f=liveFixture(),before=files(f.root);expect(()=>assertLiveRestoreStartupReady(f.root)).toThrow();expect(files(f.root)).toEqual(before);
  });
  it.each(["committed","rolled-back"] as const)("admits closed %s evidence with no writes",status=>{
    const f=liveFixture(status),before=files(f.root);expect(()=>assertLiveRestoreStartupReady(f.root)).not.toThrow();expect(files(f.root)).toEqual(before);
  });
  it.each(["intent.json","receipt.json","target-before.bin"])("refuses tampered %s and preserves evidence",name=>{
    const f=liveFixture("committed");writeFileSync(join(f.operation,name),"TAMPERED");const before=files(f.root);
    expect(()=>assertLiveRestoreStartupReady(f.root)).toThrow();expect(files(f.root)).toEqual(before);
  });
  it("refuses whole-installation exclusivity evidence BEFORE pending compensation touches any file",()=>{
    const f=liveFixture(),claim=exclusiveClaimPath(f.root);writeFileSync(claim,"CORRUPT-WHOLE-INSTALLATION-EVIDENCE");
    const before=files(f.root);try{expect(()=>recoverPendingLiveRestores(f.root)).toThrow(/Installation restore evidence/);expect(files(f.root)).toEqual(before);expect(readFileSync(claim,"utf8")).toBe("CORRUPT-WHOLE-INSTALLATION-EVIDENCE");}finally{rmSync(claim);}
  });
  it("allows a fresh configured temp-prefix root through the actual pre-import Node hook without creating data",()=>{
    const configuredRoot=mkdtempSync(join(tmpdir(),"muster-live-fresh-hook-"));roots.push(realpathSync(configuredRoot));
    const dataDir=join(configuredRoot,"data");
    const child=spawnSync(process.execPath,["--input-type=module","-e","await import(process.argv[1]);",pathToFileURL(join(process.cwd(),"server/drive-visible-startup-refusal.ts")).href],
      {env:{PATH:process.env.PATH,HOME:configuredRoot,USERPROFILE:configuredRoot,OMB_DATA_DIR:dataDir,SystemRoot:process.env.SystemRoot},encoding:"utf8",timeout:10_000,maxBuffer:1024*1024});
    expect(child.status,child.stderr).toBe(0);expect(existsSync(dataDir)).toBe(false);
  });
  it.each(["committed","rolled-back"] as const)("binds closed %s evidence to the same real root through a configured temp prefix",status=>{
    const f=liveFixture(status),before=files(f.root);expect(()=>assertLiveRestoreStartupReady(f.configuredRoot)).not.toThrow();
    expect(()=>recoverPendingLiveRestores(f.configuredRoot)).not.toThrow();expect(files(f.root)).toEqual(before);
  });
  it("refuses a dangling journal symlink without treating it as absent or changing evidence",()=>{
    const root=realpathSync(mkdtempSync(join(tmpdir(),"muster-live-dangling-")));roots.push(root);
    const journal=join(root,"account-live-restore-journal");symlinkSync(join(root,"absent-target"),journal,"dir");writeFileSync(join(root,"preserved.bin"),"UNCHANGED");
    const before=files(root);expect(()=>assertLiveRestoreStartupReady(root)).toThrow();expect(()=>recoverPendingLiveRestores(root)).toThrow();expect(files(root)).toEqual(before);
  });
  it.each(["dangling-parent","file-parent"])("refuses %s lookup ambiguity before boot or compensation writes",kind=>{
    const root=realpathSync(mkdtempSync(join(tmpdir(),"muster-live-parent-")));roots.push(root);const parent=join(root,"parent");
    if(kind==="dangling-parent")symlinkSync(join(root,"absent-target"),parent,"dir");else writeFileSync(parent,"UNCHANGED");
    const before=files(root);expect(()=>assertLiveRestoreStartupReady(parent)).toThrow();expect(()=>recoverPendingLiveRestores(parent)).toThrow();expect(files(root)).toEqual(before);
  });
  it("an owned pre-import harness compensates pending evidence then passes the read-only production guard",()=>{
    const f=liveFixture();recoverPendingLiveRestores(f.root);expect(()=>assertLiveRestoreStartupReady(f.root)).not.toThrow();expect(readFileSync(join(f.root,"preserved.bin"),"utf8")).toBe("UNCHANGED");
  });
});
