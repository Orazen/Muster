// Launcher-side pre-flight for the restore-exclusivity claim marker.
//
// The server's own boot guard (`assertNoLiveExclusiveRestoreClaim` in
// server/data-dir-exclusivity.ts) owns recovery: it can prove dead owners,
// complete interrupted swaps and clear what is provably clearable, and it
// refuses everything else. Launchers are NOT recovery tools. All they can
// honestly do is refuse to start anything that would mutate protected data
// while a claim marker exists — live, stale, torn, zero-byte, corrupt, or
// linked. A marker this launcher cannot prove anything about is still a
// marker, so every presence is a refusal with reconciliation instructions,
// and the only exit-0 path is a provably absent one.
//
// The marker path is computed EXACTLY as `exclusiveClaimPath` computes it:
// `<parent>/.muster-restore-exclusivity.<basename>.json` over the resolved
// data directory. The marker lives next to the data directory (named after
// it) so it survives the rename window and sibling data directories never
// share a slot; keep this rule byte-identical to the server's.
//
// Zero-dependency on purpose: cli/muster.mjs is esbuild-bundled into one
// standalone artifact whose verifier refuses anything but Node built-in
// imports, so this module may import node: built-ins only.
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Exit codes, named for the launcher wiring that branches on them. */
export const EXIT_CLEAR = 0;
export const EXIT_CLAIMED = 2;
export const EXIT_INDETERMINATE = 3;

/** The same bound the server's own claim reader enforces; a marker beyond it
 * is not a marker this build wrote. */
export const MAX_MARKER_BYTES = 4096;

/** Exactly the server's `exclusiveClaimPath` rule, mirrored byte for byte. */
export function exclusiveClaimMarkerPath(dataDir) {
  const root = resolve(dataDir);
  return join(dirname(root), `.muster-restore-exclusivity.${basename(root)}.json`);
}

/** Bounded no-follow read with open/inode identity, the same discipline the
 * server's claim reader uses: a concurrently replaced file is not described,
 * it just degrades the message. Never throws. */
function readMarkerBytes(markerPath, stat) {
  let fd;
  try {
    fd = openSync(markerPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const actual = fstatSync(fd);
    if (actual.dev !== stat.dev || actual.ino !== stat.ino) return null;
    const buffer = Buffer.alloc(Math.min(stat.size, MAX_MARKER_BYTES));
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    return buffer.subarray(0, length);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** A defensive, message-only reading of the marker bytes. Exit codes never
 * depend on this succeeding: an unparseable marker is still a refusal, it
 * just says so honestly instead of naming an owner it cannot prove. */
function describeMarker(markerPath, stat) {
  const bytes = readMarkerBytes(markerPath, stat);
  if (bytes === null) return " (marker bytes could not be read; its owner cannot be proven)";
  if (bytes.length === 0) return " (empty marker: a claim write torn by a crash; its owner cannot be proven)";
  let record = null;
  try { record = JSON.parse(bytes.toString("utf8")); } catch { record = null; }
  if (record === null || typeof record !== "object") {
    return " (unreadable or corrupt marker bytes; its owner cannot be proven)";
  }
  const pid = typeof record.pid === "number" && Number.isInteger(record.pid) && record.pid > 0 ? record.pid : null;
  let liveness = "";
  if (pid !== null) {
    let alive;
    try { process.kill(pid, 0); alive = true; }
    catch (error) { alive = !(error !== null && typeof error === "object" && error.code === "ESRCH"); }
    liveness = alive ? ", live" : ", owner process gone";
  }
  const reason = typeof record.reason === "string" && record.reason.length > 0
    ? JSON.stringify(record.reason)
    : "reason not stated";
  const backup = record.backupPath && typeof record.backupPath === "string"
    ? `, backup recorded at ${record.backupPath}`
    : "";
  return ` (claim${pid === null ? "" : ` by pid ${pid}${liveness}`}: ${reason}${backup})`;
}

/** Inspect one data directory. `clear: true` means the marker is provably
 * absent; every other outcome carries an exit code and an operator-facing
 * message. This never mutates anything and never follows symlinks. */
export function evaluateDataDirClaim(dataDir) {
  const markerPath = exclusiveClaimMarkerPath(dataDir);
  if (typeof dataDir !== "string" || dataDir.trim() === "") {
    return { clear: false, exitCode: EXIT_INDETERMINATE, outcome: "indeterminate", markerPath,
      message: "Restore-exclusivity claim check ran without a data directory; refusing is the only safe action." };
  }
  let stat;
  try { stat = lstatSync(markerPath); }
  catch (error) {
    if (error !== null && typeof error === "object" && error.code === "ENOENT") {
      return { clear: true, exitCode: EXIT_CLEAR, outcome: "clear", markerPath };
    }
    return { clear: false, exitCode: EXIT_INDETERMINATE, outcome: "indeterminate", markerPath,
      message: `Restore-exclusivity claim check could not inspect ${markerPath} (${error?.code ?? String(error)}); refusing to start is the only safe action. See docs/plans/restore-reconciliation-runbook.md.` };
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    return { clear: false, exitCode: EXIT_CLAIMED, outcome: "claimed", markerPath,
      message: `${markerPath} exists but is ${stat.isSymbolicLink() ? "a symbolic link" : "not a plain file"}; launchers never follow links or recover. Reconcile it manually (see docs/plans/restore-reconciliation-runbook.md) before starting anything that writes this data directory.` };
  }
  return { clear: false, exitCode: EXIT_CLAIMED, outcome: "claimed", markerPath,
    message: `A restore-exclusivity claim exists at ${markerPath}${describeMarker(markerPath, stat)}; the data directory it guards must not be touched until it is reconciled manually (see docs/plans/restore-reconciliation-runbook.md).` };
}

function runCli(argv) {
  const verdict = evaluateDataDirClaim(argv[2]);
  if (!verdict.clear && verdict.message) console.error(verdict.message);
  return verdict.clear ? EXIT_CLEAR : verdict.exitCode;
}

// CLI detection. Run only when THIS file is the entry, in one of two worlds:
// - a repo checkout (separate module files): argv[1] names this exact file;
// - the esbuild CLI bundle (scripts/build-cli.mjs inlines this module into
//   cli/muster.mjs's artifact): `import.meta.musterCliBuild` is defined there
//   and the entry is muster, never this check — an argv/import.meta.name
//   comparison would be trivially equal inside a single-file bundle, so the
//   build marker is what keeps the check inert in the bundled CLI.
if (typeof import.meta.musterCliBuild === "undefined"
  && basename(process.argv[1] ?? "") === basename(fileURLToPath(import.meta.url))) {
  process.exit(runCli(process.argv));
}
