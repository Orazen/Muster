// Ownership, crash-state and barrier mechanics of the exclusive-restore claim,
// against real temporary directories. The cross-process proofs (live boot
// refusal, real SIGKILL recovery, non-cooperator exclusion) live in
// data-dir-exclusivity-process.test.ts; this file keeps the API-level
// contracts tight without spawning.
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  renameSync, rmSync, statSync, symlinkSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DataDirExclusivityError, ExclusiveRestoreClaim, acquireDataDirExclusivity,
  assertNoLiveExclusiveRestoreClaim, exclusiveClaimPath,
  runWithWriterBarrier, writerBarrierSupported, type ExclusiveClaimRecord,
} from "./data-dir-exclusivity.ts";

const roots: string[] = [];
const temporary = (label: string): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), label)));
  roots.push(root);
  return root;
};
// A pid that is provably gone, found by probing rather than by spawning:
// process.kill(pid, 0) throws ESRCH exactly when no process owns the pid.
const deadPid = (): number => {
  for (let candidate = 4_000_000; candidate < 4_200_000; candidate += 1) {
    try { process.kill(candidate, 0); }
    catch (error) { if (z.object({ code: z.literal("ESRCH") }).safeParse(error).success) return candidate; }
  }
  throw new Error("No provably dead pid found for the owned fixture");
};
const statMode = (path: string): number => statSync(path).mode & 0o777;
const writeMarker = (dataDir: string, record: ExclusiveClaimRecord): void => {
  writeFileSync(exclusiveClaimPath(dataDir), JSON.stringify(record));
};
const staleRecord = (dataDir: string, pid: number, extra: Partial<ExclusiveClaimRecord> = {}): ExclusiveClaimRecord => ({
  version: 1, kind: "data-dir-exclusivity", pid, nonce: "2f0e6d5a-9b1c-4a2e-8d3f-0a1b2c3d4e5f",
  reason: "owned stale fixture", acquiredAt: new Date().toISOString(),
  dataDir: resolve(dataDir), dataDirDev: 1, dataDirIno: 1, originalMode: 0o755, ...extra,
});
beforeAll(() => { expect(writerBarrierSupported(), "writer-barrier tests require POSIX mode bits and a non-root process").toBe(true); });
afterAll(() => {
  // A failed mid-barrier assertion can leave frozen trees behind; thaw every
  // directory under each fixture root before removal.
  const thaw = (root: string): void => {
    const walk = (path: string): void => {
      let stat;
      try { stat = statSync(path); } catch { return; }
      if (!stat.isDirectory()) return;
      try { chmodSync(path, 0o755); } catch { /* gone or unaffected */ }
      let entries;
      try { entries = readdirSync(path); } catch { return; }
      for (const entry of entries) walk(join(path, entry));
    };
    walk(root);
  };
  for (const root of roots.reverse()) { thaw(root); rmSync(root, { recursive: true, force: true }); }
});

describe("exclusive restore claim ownership", () => {
  it("acquires at the parent level, records the real directory, and releases", () => {
    const parent = temporary("muster-excl-own-"), data = join(parent, "data");
    mkdirSync(data, { mode: 0o755 });
    const claim = acquireDataDirExclusivity(data, "owned unit acquire");
    expect(claim.path).toBe(join(parent, ".muster-restore-exclusivity.json"));
    expect(claim.record.pid).toBe(process.pid);
    expect(claim.record.dataDir).toBe(resolve(data));
    expect(existsSync(claim.path)).toBe(true);
    expect(() => claim.assert()).not.toThrow();
    claim.release();
    expect(existsSync(claim.path)).toBe(false);
  });
  it("refuses a second claim while the first holder is alive", () => {
    const parent = temporary("muster-excl-occup-"), data = join(parent, "data");
    mkdirSync(data);
    const claim = acquireDataDirExclusivity(data, "first holder");
    try {
      try { acquireDataDirExclusivity(data, "second holder"); }
      catch (error) {
        expect(error).toBeInstanceOf(DataDirExclusivityError);
        // SAFETY: the instanceof check above proves the narrowed shape.
        const occupancy = error as DataDirExclusivityError;
        expect(occupancy.code).toBe("occupied");
        expect(occupancy.owner?.pid).toBe(process.pid);
      }
      expect(() => acquireDataDirExclusivity(data, "second holder")).toThrow(DataDirExclusivityError);
    } finally { claim.release(); }
  });
  it("refuses a stale claim unless recovery is requested, then adopts it", () => {
    const parent = temporary("muster-excl-stale-"), data = join(parent, "data");
    mkdirSync(data);
    writeMarker(data, staleRecord(data, deadPid()));
    expect(() => acquireDataDirExclusivity(data, "no recovery")).toThrow(/recovery was not requested/);
    const claim = acquireDataDirExclusivity(data, "with recovery", { recoverDeadOwner: true });
    expect(claim.record.pid).toBe(process.pid);
    claim.release();
  });
  it("treats a zero-byte marker as abandoned and adopts it only on recovery", () => {
    const parent = temporary("muster-excl-aband-"), data = join(parent, "data");
    mkdirSync(data);
    writeFileSync(exclusiveClaimPath(data), "");
    expect(() => acquireDataDirExclusivity(data, "no recovery")).toThrow(/Abandoned empty/);
    const claim = acquireDataDirExclusivity(data, "with recovery", { recoverDeadOwner: true });
    claim.release();
  });
  it("fails closed on an unparseable or non-plain marker instead of adopting it", () => {
    const parent = temporary("muster-excl-corrupt-"), data = join(parent, "data");
    mkdirSync(data);
    writeFileSync(exclusiveClaimPath(data), '{"version":1,"kind":"half-written"');
    expect(() => acquireDataDirExclusivity(data, "any", { recoverDeadOwner: true })).toThrow(/unparseable/);
    expect(() => assertNoLiveExclusiveRestoreClaim(data)).toThrow(/unreadable/);
    // A symlinked marker is refuse material, never follow material.
    const target = join(parent, "elsewhere.json");
    writeFileSync(target, "{}");
    unlinkSync(exclusiveClaimPath(data));
    symlinkSync(target, exclusiveClaimPath(data));
    expect(() => acquireDataDirExclusivity(data, "any", { recoverDeadOwner: true })).toThrow(/not a plain file/);
  });
  it("refuses a symlinked data directory", () => {
    const parent = temporary("muster-excl-symlink-"), real = join(parent, "real");
    mkdirSync(real);
    const link = join(parent, "link");
    symlinkSync(real, link);
    expect(() => acquireDataDirExclusivity(link, "symlinked")).toThrow(/non-symlink/);
  });
  it("detects marker deletion and replacement through assert()", () => {
    const parent = temporary("muster-excl-assert-"), data = join(parent, "data");
    mkdirSync(data);
    const claim = acquireDataDirExclusivity(data, "assert probe");
    unlinkSync(claim.path);
    expect(() => claim.assert()).toThrow(/removed or replaced/);
    // Replacement with different bytes (same path) must also fail.
    writeMarker(data, staleRecord(data, process.pid));
    expect(() => claim.assert()).toThrow(/removed or replaced/);
  });
  it("records swap evidence in place so assert() keeps working", () => {
    const parent = temporary("muster-excl-backup-"), data = join(parent, "data");
    mkdirSync(data);
    const claim = acquireDataDirExclusivity(data, "backup evidence");
    const backup = join(parent, "data.backup");
    claim.recordBackupPath(backup);
    expect(claim.record.backupPath).toBe(resolve(backup));
    expect(() => claim.assert()).not.toThrow();
    const onDisk = JSON.parse(readFileSync(claim.path, "utf8"));
    expect(onDisk.backupPath).toBe(resolve(backup));
    claim.release();
  });
});

describe("boot guard recovery states", () => {
  it("passes a clean directory and a live claim refuses with the owner named", () => {
    const parent = temporary("muster-excl-boot-live-"), data = join(parent, "data");
    mkdirSync(data);
    expect(() => assertNoLiveExclusiveRestoreClaim(data)).not.toThrow();
    const claim = acquireDataDirExclusivity(data, "live holder");
    try {
      expect(() => assertNoLiveExclusiveRestoreClaim(data)).toThrow(/Exclusive restore is in progress by pid/);
    } finally { claim.release(); }
    expect(() => assertNoLiveExclusiveRestoreClaim(data)).not.toThrow();
  });
  it("recovers a frozen directory from a dead owner, refuses once, then passes", () => {
    const parent = temporary("muster-excl-boot-frozen-"), data = join(parent, "data");
    mkdirSync(data, { mode: 0o755 });
    writeFileSync(join(data, "bots.json"), "{}");
    writeMarker(data, staleRecord(data, deadPid()));
    chmodSync(data, 0o555);
    expect(() => assertNoLiveExclusiveRestoreClaim(data)).toThrow(/interrupted while the data directory was frozen/);
    expect(readFileSync(join(data, "bots.json"), "utf8"), "frozen recovery must keep the tree bytes").toBe("{}");
    expect(statMode(data)).toBe(0o755);
    expect(existsSync(exclusiveClaimPath(data))).toBe(false);
    expect(() => assertNoLiveExclusiveRestoreClaim(data)).not.toThrow();
  });
  it("restores the tree recorded at backupPath when the directory is missing", () => {
    const parent = temporary("muster-excl-boot-away-"), data = join(parent, "data");
    mkdirSync(data);
    writeFileSync(join(data, "groups.json"), '{"old":true}');
    const backup = join(parent, "data.backup");
    renameSync(data, backup);
    writeMarker(data, staleRecord(data, deadPid(), { backupPath: resolve(backup) }));
    expect(() => assertNoLiveExclusiveRestoreClaim(data)).toThrow(/interrupted between its swap steps/);
    expect(readFileSync(join(data, "groups.json"), "utf8")).toBe('{"old":true}');
    expect(existsSync(backup)).toBe(false);
    expect(existsSync(exclusiveClaimPath(data))).toBe(false);
    expect(() => assertNoLiveExclusiveRestoreClaim(data)).not.toThrow();
  });
  it("refuses the ambiguous both-trees-present state instead of choosing", () => {
    const parent = temporary("muster-excl-boot-ambig-"), data = join(parent, "data");
    mkdirSync(data);
    const backup = join(parent, "data.backup");
    mkdirSync(backup);
    writeMarker(data, staleRecord(data, deadPid(), { backupPath: resolve(backup) }));
    expect(() => assertNoLiveExclusiveRestoreClaim(data)).toThrow(/reconcile manually/);
  });
  it("refuses a missing directory with a stale claim and no recoverable backup", () => {
    const parent = temporary("muster-excl-boot-missing-"), data = join(parent, "data");
    writeMarker(data, staleRecord(data, deadPid()));
    expect(() => assertNoLiveExclusiveRestoreClaim(data)).toThrow(/missing without a recoverable backup path/);
  });
  it("clears an abandoned marker left by a first-boot crash with no directory", () => {
    const parent = temporary("muster-excl-boot-first-"), data = join(parent, "data");
    writeFileSync(exclusiveClaimPath(data), "");
    expect(() => assertNoLiveExclusiveRestoreClaim(data)).not.toThrow();
    expect(existsSync(exclusiveClaimPath(data))).toBe(false);
  });
});

describe("writer barrier", () => {
  it("freezes the tree, defeats in-process writers, swaps, and restores the mode", async () => {
    const parent = temporary("muster-excl-barrier-ok-"), data = join(parent, "data");
    mkdirSync(data, { mode: 0o755 });
    writeFileSync(join(data, "bots.json"), '{"old":true}');
    const claim = acquireDataDirExclusivity(data, "barrier success");
    const staging = join(parent, "staging"), backup = join(parent, "backup");
    mkdirSync(staging);
    writeFileSync(join(staging, "bots.json"), '{"staged":true}');
    await runWithWriterBarrier(data, claim, async swap => {
      // The freeze excludes this very process: writes into the frozen tree
      // fail closed instead of interleaving with the swap.
      expect(() => appendFileSync(join(data, "probe.log"), "mid-freeze\n")).toThrow();
      swap.beginSwap(backup);
      expect(existsSync(data)).toBe(false);
      expect(() => appendFileSync(join(data, "probe.log"), "mid-swap\n")).toThrow();
      swap.completeSwap(staging);
      expect(readFileSync(join(data, "bots.json"), "utf8")).toBe('{"staged":true}');
    });
    expect(statMode(data)).toBe(0o755);
    expect(existsSync(backup)).toBe(true);
    expect(existsSync(join(data, "probe.log"))).toBe(false);
    claim.release();
    expect(existsSync(exclusiveClaimPath(data))).toBe(false);
  });
  it("holds the freeze across awaits inside perform", async () => {
    const parent = temporary("muster-excl-barrier-await-"), data = join(parent, "data");
    mkdirSync(data);
    mkdirSync(join(parent, "staging-tree"));
    const claim = acquireDataDirExclusivity(data, "barrier awaits");
    await runWithWriterBarrier(data, claim, async swap => {
      await new Promise(done => setTimeout(done, 20));
      swap.beginSwap(join(parent, "backup"));
      await new Promise(done => setTimeout(done, 20));
      swap.completeSwap(join(parent, "staging-tree"));
    });
    claim.release();
  });
  it("restores the previous tree when perform fails and rethrows the original error", async () => {
    const parent = temporary("muster-excl-barrier-rollback-"), data = join(parent, "data");
    mkdirSync(data, { mode: 0o755 });
    writeFileSync(join(data, "bots.json"), '{"precious":true}');
    const claim = acquireDataDirExclusivity(data, "barrier rollback");
    await expect(runWithWriterBarrier(data, claim, async swap => {
      swap.beginSwap(join(parent, "backup"));
      throw new Error("staged verification failed");
    })).rejects.toThrow(/staged verification failed/);
    expect(readFileSync(join(data, "bots.json"), "utf8")).toBe('{"precious":true}');
    expect(statMode(data)).toBe(0o755);
    claim.release();
  });
  it("refuses to unfreeze a half-driven swap as if it had completed", async () => {
    const parent = temporary("muster-excl-barrier-half-"), data = join(parent, "data");
    mkdirSync(data);
    const claim = acquireDataDirExclusivity(data, "barrier half");
    await expect(runWithWriterBarrier(data, claim, swap => { swap.beginSwap(join(parent, "backup")); }))
      .rejects.toThrow(/Swap stopped after beginSwap/);
    // The rollback already restored the tree, so the claim is still sound.
    expect(existsSync(data)).toBe(true);
    claim.release();
  });
  it("refuses backup and staging paths inside the data directory", async () => {
    const parent = temporary("muster-excl-barrier-paths-"), data = join(parent, "data");
    mkdirSync(data);
    const claim = acquireDataDirExclusivity(data, "path validation");
    await expect(runWithWriterBarrier(data, claim, swap => { swap.beginSwap(join(data, "inside")); }))
      .rejects.toThrow(/outside the data directory/);
    await expect(runWithWriterBarrier(data, claim, async swap => {
      swap.beginSwap(join(parent, "backup"));
      swap.completeSwap(join(data, "inside"));
    })).rejects.toThrow(/outside the data directory/);
    claim.release();
  });
  it("refuses a claim that belongs to a different data directory", async () => {
    const parent = temporary("muster-excl-barrier-mismatch-"), one = join(parent, "one"), two = join(parent, "two");
    mkdirSync(one); mkdirSync(two);
    const claim = acquireDataDirExclusivity(one, "mismatch probe");
    await expect(runWithWriterBarrier(two, claim, () => {})).rejects.toThrow(/does not belong/);
    claim.release();
  });
  it("keeps the claim unusable after a failed barrier until released", async () => {
    const parent = temporary("muster-excl-barrier-stuck-"), data = join(parent, "data");
    mkdirSync(data);
    const claim: ExclusiveRestoreClaim = acquireDataDirExclusivity(data, "stuck probe");
    await expect(runWithWriterBarrier(data, claim, () => { throw new Error("boom"); })).rejects.toThrow(/boom/);
    expect(() => claim.assert()).not.toThrow();
    claim.release();
    expect(existsSync(exclusiveClaimPath(data))).toBe(false);
  });
});
