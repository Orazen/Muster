// Launcher-side claim-check behavior: every marker state refuses, a clear
// directory passes, and the docker entrypoint refuses before its first
// protected write. The live claims are REAL claims from the server's own
// exclusivity module on owned temporary directories — the launcher is tested
// against exactly the bytes the server writes, not a lookalike fixture.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { afterAll, describe, expect, it } from "vitest";

import { acquireDataDirExclusivity, exclusiveClaimPath, type ExclusiveClaimRecord } from "../server/data-dir-exclusivity.ts";
import { evaluateDataDirClaim, exclusiveClaimMarkerPath, EXIT_CLAIMED, EXIT_CLEAR, EXIT_INDETERMINATE } from "./data-dir-claim-check.mjs";

const claimCheck = fileURLToPath(new URL("./data-dir-claim-check.mjs", import.meta.url));
const entrypoint = fileURLToPath(new URL("./docker-entrypoint.sh", import.meta.url));

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
const staleRecord = (dataDir: string): ExclusiveClaimRecord => ({
  version: 1, kind: "data-dir-exclusivity", pid: deadPid(), nonce: "2f0e6d5a-9b1c-4a2e-8d3f-0a1b2c3d4e5f",
  reason: "owned stale fixture", acquiredAt: new Date().toISOString(),
  dataDir: realpathSync(dataDir), dataDirDev: 0, dataDirIno: 0, originalMode: 0o755,
});

interface ClaimVerdict {
  exitCode: number;
  message: string;
  markerPath: string;
}
const expectClaimed = (verdict: ReturnType<typeof evaluateDataDirClaim>): ClaimVerdict => {
  expect(verdict.clear).toBe(false);
  expect(verdict.outcome).toBe("claimed");
  if (verdict.clear) throw new Error("unreachable: the verdict was expected to be a refusal");
  return { exitCode: verdict.exitCode, message: verdict.message, markerPath: verdict.markerPath };
};

const runCli = (dataDir: string) => spawnSync(process.execPath, [claimCheck, dataDir], { encoding: "utf8" });
const runEntrypoint = (dataDir: string) => spawnSync("sh", [entrypoint, "node", "-e", "process.exit(7)"], {
  encoding: "utf8", timeout: 30_000,
  env: { ...process.env, OMB_DATA_DIR: dataDir, BETTER_AUTH_SECRET: "" },
});

afterAll(() => {
  for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
});

describe("data-dir claim check", () => {
  describe("as an importable evaluation", () => {
    it("clears a directory with no marker, including one that does not exist yet", () => {
      const first = temporary("muster-claim-clear-");
      expect(evaluateDataDirClaim(join(first, "data"))).toMatchObject({ clear: true, exitCode: EXIT_CLEAR });
      // First boot: the data directory itself is absent and so is any marker.
      expect(evaluateDataDirClaim(join(first, "not-created-yet"))).toMatchObject({ clear: true });
    });

    it("refuses a live claim held by this very process", () => {
      const data = join(temporary("muster-claim-live-"), "data");
      mkdirSync(data);
      const claim = acquireDataDirExclusivity(data, "owned live-claim fixture");
      try {
        const verdict = expectClaimed(evaluateDataDirClaim(data));
        expect(verdict.exitCode).toBe(EXIT_CLAIMED);
        expect(verdict.message).toContain(`pid ${process.pid}`);
        expect(verdict.message).toContain(", live");
      } finally { claim.release(); }
    });

    it("refuses a stale claim from a provably dead owner", () => {
      const data = join(temporary("muster-claim-stale-"), "data");
      mkdirSync(data);
      writeFileSync(exclusiveClaimPath(data), JSON.stringify(staleRecord(data)));
      const verdict = expectClaimed(evaluateDataDirClaim(data));
      expect(verdict.message).toContain("owner process gone");
    });

    it("refuses a torn zero-byte marker as unprovable, not recoverable", () => {
      const data = join(temporary("muster-claim-torn-"), "data");
      mkdirSync(data);
      writeFileSync(exclusiveClaimPath(data), "");
      const verdict = expectClaimed(evaluateDataDirClaim(data));
      expect(verdict.message).toContain("torn by a crash");
    });

    it("refuses corrupt and oversized marker bytes", () => {
      const corrupt = join(temporary("muster-claim-corrupt-"), "data");
      mkdirSync(corrupt);
      writeFileSync(exclusiveClaimPath(corrupt), "{not json at all");
      expect(expectClaimed(evaluateDataDirClaim(corrupt)).message).toContain("corrupt");
      const oversized = join(temporary("muster-claim-oversized-"), "data");
      mkdirSync(oversized);
      writeFileSync(exclusiveClaimPath(oversized), "x".repeat(4097));
      expect(expectClaimed(evaluateDataDirClaim(oversized)).message).toContain("corrupt");
    });

    it("refuses a symlinked marker instead of following it", () => {
      const parent = temporary("muster-claim-symlink-");
      const data = join(parent, "data");
      mkdirSync(data);
      const realFile = join(parent, "real-marker.json");
      writeFileSync(realFile, "{}");
      symlinkSync(realFile, exclusiveClaimPath(data));
      const verdict = expectClaimed(evaluateDataDirClaim(data));
      expect(verdict.message).toContain("symbolic link");
    });

    it("refuses a marker that is not a plain file", () => {
      const data = join(temporary("muster-claim-dir-"), "data");
      mkdirSync(data);
      mkdirSync(exclusiveClaimPath(data));
      const verdict = expectClaimed(evaluateDataDirClaim(data));
      expect(verdict.message).toContain("not a plain file");
    });

    it("refuses indeterminately when the marker cannot be inspected", () => {
      // Mode bits cannot exclude root, so the fixture is meaningless there.
      if (process.getuid?.() === 0) return;
      const parent = temporary("muster-claim-noperm-");
      const data = join(parent, "data");
      mkdirSync(data);
      chmodSync(parent, 0o000);
      try {
        const verdict = evaluateDataDirClaim(data);
        expect(verdict).toMatchObject({ clear: false, exitCode: EXIT_INDETERMINATE, outcome: "indeterminate" });
      } finally { chmodSync(parent, 0o755); }
    });

    it("computes the marker path exactly as the server's exclusiveClaimPath does", () => {
      expect(exclusiveClaimMarkerPath("/srv/muster-data")).toBe("/srv/.muster-restore-exclusivity.muster-data.json");
      expect(exclusiveClaimMarkerPath("/srv/muster-data/")).toBe("/srv/.muster-restore-exclusivity.muster-data.json");
      expect(exclusiveClaimMarkerPath("relative/dir")).toBe(exclusiveClaimPath("relative/dir"));
    });
  });

  describe("as a CLI", () => {
    it("exits 0 on a clear directory and prints nothing", () => {
      const data = join(temporary("muster-claim-cli-clear-"), "data");
      mkdirSync(data);
      const run = runCli(data);
      expect(run.status).toBe(EXIT_CLEAR);
      expect(run.stderr).toBe("");
    });

    it("exits 2 with a reconcile message for any marker", () => {
      const data = join(temporary("muster-claim-cli-claimed-"), "data");
      mkdirSync(data);
      writeFileSync(exclusiveClaimPath(data), JSON.stringify(staleRecord(data)));
      const run = runCli(data);
      expect(run.status).toBe(EXIT_CLAIMED);
      expect(run.stderr).toContain(exclusiveClaimPath(data));
      expect(run.stderr).toContain("docs/plans/restore-reconciliation-runbook.md");
    });
  });

  describe("docker entrypoint integration", () => {
    it("refuses before writing the better-auth secret when a live claim exists", () => {
      const data = join(temporary("muster-claim-entrypoint-"), "data");
      mkdirSync(data);
      const claim = acquireDataDirExclusivity(data, "owned entrypoint fixture");
      try {
        const run = runEntrypoint(data);
        expect(run.status).toBe(EXIT_CLAIMED);
        expect(run.stderr).toContain("restore-exclusivity claim exists");
        // The refusal happened before any protected write.
        expect(existsSync(join(data, ".better-auth-secret"))).toBe(false);
      } finally { claim.release(); }
    });

    it("preserves the entrypoint's existing behavior on a clear directory", () => {
      const data = join(temporary("muster-claim-entrypoint-clear-"), "data");
      mkdirSync(data);
      const run = runEntrypoint(data);
      // The stub command's own exit code propagates through the entrypoint.
      expect(run.status).toBe(7);
      expect(existsSync(join(data, ".better-auth-secret"))).toBe(true);
    });
  });
});
