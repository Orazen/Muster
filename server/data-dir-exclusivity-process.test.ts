// Cross-process proofs for the exclusive-restore boundary. Everything here
// runs real processes: a boot that must refuse while a foreign claim is live,
// a boot that must refuse during the rename window even though the data
// directory is missing, real SIGKILL crash states recovered by the boot guard,
// and a non-cooperating writer child that knows nothing about claims and must
// still be defeated by the barrier. Child entries are generated once into an
// owned artifacts directory and spawned as fixed script files (no inline
// interpreter payloads); their only runtime input is data paths via env.
// Owned fixtures only; every child is cleaned up.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  acquireDataDirExclusivity, assertNoLiveExclusiveRestoreClaim, exclusiveClaimPath,
  runWithWriterBarrier, writerBarrierSupported,
} from "./data-dir-exclusivity.ts";

const roots: string[] = [];
const children: ChildProcess[] = [];
const repo = resolve(".");
const modulePath = join(repo, "server", "data-dir-exclusivity.ts");
const bootModulePath = join(repo, "server", "data-dir-exclusivity-boot.ts");
let artifacts = "";
const temporary = (label: string): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), label)));
  roots.push(root);
  return root;
};
const fixtureData = (parent: string): string => {
  const data = join(parent, "data");
  mkdirSync(data, { mode: 0o755 });
  writeFileSync(join(data, "bots.json"), '{"fixture":true}');
  return data;
};
const childEnv = (extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({ PATH: process.env.PATH ?? "", ...extra });
async function settle(child: ChildProcess, timeoutMs = 15_000): Promise<{ code: number | null; output: string }> {
  children.push(child);
  let output = "", timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
  child.stdout?.on("data", bytes => { output += bytes.toString(); });
  child.stderr?.on("data", bytes => { output += bytes.toString(); });
  const code = await new Promise<number | null>(done => { child.once("close", done); }).finally(() => clearTimeout(timer));
  expect(timedOut, output).toBe(false);
  return { code, output };
}
beforeAll(() => {
  expect(writerBarrierSupported(), "cross-process barrier proofs require POSIX mode bits and a non-root process").toBe(true);
  artifacts = temporary("muster-excl-artifacts-");
  symlinkSync(join(repo, "node_modules"), join(artifacts, "node_modules"), "dir");
  // Boot entry: imports the real boot guard with the real DATA_DIR resolution.
  writeFileSync(join(artifacts, "boot-child.mjs"), `try {
  await import(${JSON.stringify(bootModulePath)});
  console.log("BOOT_OK");
} catch (error) {
  console.log("BOOT_REFUSED:" + error.message);
  process.exit(1);
}
process.exit(0);
`);
  // Crash while the tree is frozen (claim held, mode 0o555, then SIGKILL).
  writeFileSync(join(artifacts, "crash-frozen-child.mjs"), `const m = await import(${JSON.stringify(modulePath)});
const fs = await import("node:fs");
const claim = m.acquireDataDirExclusivity(process.env.OMB_DATA_DIR, "owned crash while frozen");
fs.chmodSync(process.env.OMB_DATA_DIR, 0o555);
claim.markFrozen();
process.kill(process.pid, "SIGKILL");
`);
  // Crash between the two swap renames (old tree moved to the recorded backup).
  writeFileSync(join(artifacts, "crash-away-child.mjs"), `const m = await import(${JSON.stringify(modulePath)});
const fs = await import("node:fs");
const claim = m.acquireDataDirExclusivity(process.env.OMB_DATA_DIR, "owned crash between renames");
claim.recordBackupPath(process.env.OMB_BACKUP_PATH);
fs.renameSync(process.env.OMB_DATA_DIR, process.env.OMB_BACKUP_PATH);
process.kill(process.pid, "SIGKILL");
`);
  // The rival: a plain writer that imports nothing from the repository and
  // checks nothing. It appends to a file inside the data directory as fast as
  // it can and reports the errno that stops it, if anything ever does.
  writeFileSync(join(artifacts, "rival-writer.mjs"), `const fs = await import("node:fs");
let n = 0;
const tick = () => {
  try { fs.appendFileSync(process.env.OMB_DATA_DIR + "/probe.log", "W" + process.pid + ":" + (n++) + "\\n"); }
  catch (error) { console.log("RIVAL_STOPPED:" + error.code); process.exit(0); }
};
setInterval(tick, 5);
`);
});
afterAll(() => {
  for (const child of children) { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
  // Frozen fixtures must be thawed before their trees can be removed.
  const thaw = (root: string): void => {
    try { chmodSync(root, 0o755); } catch { /* already writable */ }
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory()) { try { chmodSync(join(root, entry.name), 0o755); } catch { /* gone */ } }
      }
    } catch { /* gone */ }
  };
  for (const root of roots.reverse()) { thaw(root); rmSync(root, { recursive: true, force: true }); }
});

describe("cross-process exclusive restore boundary", () => {
  it("a real boot refuses while a foreign claim is live and starts after release", async () => {
    const parent = temporary("muster-excl-proc-live-"), data = fixtureData(parent);
    const claim = acquireDataDirExclusivity(data, "owned cross-process holder");
    const refused = await settle(spawn(process.execPath, ["--experimental-strip-types", join(artifacts, "boot-child.mjs")],
      { cwd: repo, env: childEnv({ OMB_DATA_DIR: data }), stdio: ["ignore", "pipe", "pipe"] }));
    expect(refused.code).toBe(1);
    expect(refused.output).toContain("Exclusive restore is in progress by pid");
    expect(refused.output).toContain("server startup refused before initialization");
    claim.release();
    const allowed = await settle(spawn(process.execPath, ["--experimental-strip-types", join(artifacts, "boot-child.mjs")],
      { cwd: repo, env: childEnv({ OMB_DATA_DIR: data }), stdio: ["ignore", "pipe", "pipe"] }));
    expect(allowed.code).toBe(0);
    expect(allowed.output).toContain("BOOT_OK");
  }, 30_000);

  it("a real boot refuses during the rename window even with the directory missing", async () => {
    const parent = temporary("muster-excl-proc-window-"), data = fixtureData(parent);
    const claim = acquireDataDirExclusivity(data, "rename window holder");
    const staging = join(parent, "staging"), backup = join(parent, "backup");
    mkdirSync(staging);
    writeFileSync(join(staging, "bots.json"), '{"staged":true}');
    try {
      await runWithWriterBarrier(data, claim, async swap => {
        swap.beginSwap(backup);
        expect(existsSync(data)).toBe(false);
        const duringWindow = await settle(spawn(process.execPath, ["--experimental-strip-types", join(artifacts, "boot-child.mjs")],
          { cwd: repo, env: childEnv({ OMB_DATA_DIR: data }), stdio: ["ignore", "pipe", "pipe"] }));
        expect(duringWindow.code).toBe(1);
        expect(duringWindow.output).toContain("Exclusive restore is in progress by pid");
        swap.completeSwap(staging);
      });
    } finally { claim.release(); }
    expect(readFileSync(join(data, "bots.json"), "utf8")).toBe('{"staged":true}');
  }, 40_000);

  it("recovers a real SIGKILL crash while the tree was frozen", async () => {
    const parent = temporary("muster-excl-proc-frozen-"), data = fixtureData(parent);
    const crashed = await settle(spawn(process.execPath, ["--experimental-strip-types", join(artifacts, "crash-frozen-child.mjs")],
      { cwd: repo, env: childEnv({ OMB_DATA_DIR: data }), stdio: ["ignore", "pipe", "pipe"] }));
    expect(crashed.code).toBeNull(); // SIGKILL leaves a signal, not an exit code.
    expect(() => assertNoLiveExclusiveRestoreClaim(data)).toThrow(/interrupted while the data directory was frozen/);
    expect(readFileSync(join(data, "bots.json"), "utf8")).toBe('{"fixture":true}');
    expect(statSync(data).mode & 0o777).toBe(0o755);
    expect(existsSync(exclusiveClaimPath(data))).toBe(false);
    const allowed = await settle(spawn(process.execPath, ["--experimental-strip-types", join(artifacts, "boot-child.mjs")],
      { cwd: repo, env: childEnv({ OMB_DATA_DIR: data }), stdio: ["ignore", "pipe", "pipe"] }));
    expect(allowed.code).toBe(0);
    expect(allowed.output).toContain("BOOT_OK");
  }, 30_000);

  it("recovers a real SIGKILL crash between the two swap renames", async () => {
    const parent = temporary("muster-excl-proc-away-"), data = fixtureData(parent);
    const backup = join(parent, "data.backup");
    const crashed = await settle(spawn(process.execPath, ["--experimental-strip-types", join(artifacts, "crash-away-child.mjs")],
      { cwd: repo, env: childEnv({ OMB_DATA_DIR: data, OMB_BACKUP_PATH: backup }), stdio: ["ignore", "pipe", "pipe"] }));
    expect(crashed.code).toBeNull();
    expect(existsSync(data)).toBe(false);
    expect(() => assertNoLiveExclusiveRestoreClaim(data)).toThrow(/interrupted between its swap steps/);
    expect(existsSync(data)).toBe(true);
    expect(readFileSync(join(data, "bots.json"), "utf8")).toBe('{"fixture":true}');
    expect(existsSync(backup)).toBe(false);
    expect(existsSync(exclusiveClaimPath(data))).toBe(false);
    const allowed = await settle(spawn(process.execPath, ["--experimental-strip-types", join(artifacts, "boot-child.mjs")],
      { cwd: repo, env: childEnv({ OMB_DATA_DIR: data }), stdio: ["ignore", "pipe", "pipe"] }));
    expect(allowed.code).toBe(0);
    expect(allowed.output).toContain("BOOT_OK");
  }, 30_000);

  it("defeats a non-cooperating writer that knows nothing about claims", async () => {
    const parent = temporary("muster-excl-proc-rival-"), data = fixtureData(parent);
    const rival = spawn(process.execPath, [join(artifacts, "rival-writer.mjs")],
      { cwd: repo, env: childEnv({ OMB_DATA_DIR: data }), stdio: ["ignore", "pipe", "pipe"] });
    let rivalLine = "";
    rival.stdout.on("data", bytes => { rivalLine += bytes.toString(); });
    children.push(rival);
    const deadline = Date.now() + 5_000;
    while (!existsSync(join(data, "probe.log")) && Date.now() < deadline) {
      await new Promise(done => setTimeout(done, 20));
    }
    expect(existsSync(join(data, "probe.log")), "rival writer never produced output").toBe(true);
    const preSwapLines = readFileSync(join(data, "probe.log"), "utf8").split("\n").filter(Boolean).length;

    const claim = acquireDataDirExclusivity(data, "rival exclusion proof");
    const staging = join(parent, "staging"), backup = join(parent, "backup");
    mkdirSync(staging);
    writeFileSync(join(staging, "probe.log"), "STAGED\n");
    try {
      await runWithWriterBarrier(data, claim, async swap => {
        swap.beginSwap(backup);
        // Give the rival a real window to attempt writes into a tree that is
        // either frozen or already renamed away.
        await new Promise(done => setTimeout(done, 60));
        swap.completeSwap(staging);
      });
    } finally { claim.release(); }

    // The live tree carries exactly the staged bytes: nothing the rival wrote
    // after the swap began can appear here, whatever it tried.
    expect(readFileSync(join(data, "probe.log"), "utf8")).toBe("STAGED\n");
    // Its pre-swap writes stayed on the detached old tree.
    expect(readFileSync(join(backup, "probe.log"), "utf8").split("\n").filter(Boolean).length)
      .toBeGreaterThanOrEqual(preSwapLines);
    process.stdout.write(JSON.stringify({ rivalOutcome: rivalLine.trim() || "still-running-at-cleanup" }) + "\n");
  }, 40_000);

  it("keeps a clean boot passing after every proof", async () => {
    const parent = temporary("muster-excl-proc-clean-"), data = fixtureData(parent);
    const allowed = await settle(spawn(process.execPath, ["--experimental-strip-types", join(artifacts, "boot-child.mjs")],
      { cwd: repo, env: childEnv({ OMB_DATA_DIR: data }), stdio: ["ignore", "pipe", "pipe"] }));
    expect(allowed.code).toBe(0);
    expect(allowed.output).toContain("BOOT_OK");
    expect(existsSync(exclusiveClaimPath(data))).toBe(false);
  }, 30_000);
});
