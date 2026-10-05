import { createHash } from "node:crypto";
import { closeSync, existsSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync,
  realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
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
