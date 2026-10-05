#!/bin/sh
# Self-hosted Docker deploys have no reliable way to inject a runtime secret
# through some hosting panels (env-var mutations that don't propagate to the
# running service). BETTER_AUTH_SECRET is required — better-auth refuses to
# start with the default secret — so generate one on first boot and persist
# it to the /data volume, which survives restarts/redeploys. An explicit
# BETTER_AUTH_SECRET env var, if the platform *does* manage to set one,
# always wins.
set -e

# Refuse before ANY protected write when the data directory carries a
# restore-exclusivity claim marker — live, stale, torn, zero-byte, corrupt or
# linked. Launchers are not recovery tools; the server's own boot guard
# (server/data-dir-exclusivity.ts, assertNoLiveExclusiveRestoreClaim) owns
# recovery, and it refuses after touching anything. This check mirrors
# scripts/data-dir-claim-check.mjs and the marker-path rule of
# exclusiveClaimPath byte for byte; it is inlined because the runtime image
# ships only this entrypoint, not the scripts/ tree. Exit 2 = a claim exists,
# exit 3 = the check itself could not decide; set -e turns either into a
# refusal before the secret below is written or read.
node -e '
const { lstatSync, openSync, readSync, closeSync, fstatSync, constants } = require("node:fs");
const { basename, dirname, join, resolve } = require("node:path");
const root = resolve(String(process.argv[1] || ""));
const marker = join(dirname(root), `.muster-restore-exclusivity.${basename(root)}.json`);
let stat;
try { stat = lstatSync(marker); } catch (error) {
  if (error && error.code === "ENOENT") process.exit(0);
  console.error(`Restore-exclusivity claim check could not inspect ${marker} (${(error && error.code) || error}); refusing to start is the only safe action. See docs/plans/restore-reconciliation-runbook.md.`);
  process.exit(3);
}
if (stat.isSymbolicLink() || !stat.isFile()) {
  console.error(`${marker} exists but is ${stat.isSymbolicLink() ? "a symbolic link" : "not a plain file"}; launchers never follow links or recover. Reconcile it manually (see docs/plans/restore-reconciliation-runbook.md) before starting anything that writes this data directory.`);
  process.exit(2);
}
let detail = " (marker bytes could not be read; its owner cannot be proven)";
try {
  const fd = openSync(marker, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const live = fstatSync(fd);
    if (live.dev === stat.dev && live.ino === stat.ino) {
      const bytes = Buffer.alloc(Math.min(stat.size, 4096));
      let length = 0;
      while (length < bytes.length) { const n = readSync(fd, bytes, length, bytes.length - length, null); if (n === 0) break; length += n; }
      let record = null;
      try { record = JSON.parse(bytes.subarray(0, length).toString("utf8")); } catch (error) { record = null; }
      if (length === 0) detail = " (empty marker: a claim write torn by a crash; its owner cannot be proven)";
      else if (record === null || typeof record !== "object") detail = " (unreadable or corrupt marker bytes; its owner cannot be proven)";
      else {
        const pid = typeof record.pid === "number" && Number.isInteger(record.pid) && record.pid > 0 ? record.pid : null;
        let liveness = "";
        if (pid !== null) {
          let alive;
          try { process.kill(pid, 0); alive = true; }
          catch (error) { alive = !(error && error.code === "ESRCH"); }
          liveness = alive ? ", live" : ", owner process gone";
        }
        const reason = typeof record.reason === "string" && record.reason.length > 0 ? JSON.stringify(record.reason) : "reason not stated";
        const backup = record.backupPath && typeof record.backupPath === "string" ? `, backup recorded at ${record.backupPath}` : "";
        detail = ` (claim${pid === null ? "" : ` by pid ${pid}${liveness}`}: ${reason}${backup})`;
      }
    }
  } finally { closeSync(fd); }
} catch (error) { /* the message stays generic; the refusal does not change */ }
console.error(`A restore-exclusivity claim exists at ${marker}${detail}; the data directory it guards must not be touched until it is reconciled manually (see docs/plans/restore-reconciliation-runbook.md).`);
process.exit(2);
' "${OMB_DATA_DIR:-/data}"

SECRET_FILE="${OMB_DATA_DIR:-/data}/.better-auth-secret"

if [ -z "$BETTER_AUTH_SECRET" ]; then
  if [ -f "$SECRET_FILE" ]; then
    BETTER_AUTH_SECRET="$(cat "$SECRET_FILE")"
  else
    BETTER_AUTH_SECRET="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")"
    mkdir -p "$(dirname "$SECRET_FILE")"
    printf '%s' "$BETTER_AUTH_SECRET" > "$SECRET_FILE"
    chmod 600 "$SECRET_FILE"
  fi
  export BETTER_AUTH_SECRET
fi

# Stay in the foreground as PID 1 instead of exec'ing the server: PID 1 must
# reap orphans, and chromium spawns crashpad handlers and zygote/GPU helpers
# that outlive their parents when a browser-panel session ends — reparented
# to PID 1 and never wait()ed they pile up as zombies until the container
# restarts. wait -n reaps one child at a time while the server runs; TERM is
# forwarded so docker stop still reaches node's graceful shutdown.
"$@" &
NODE_PID=$!
trap 'kill -TERM "$NODE_PID" 2>/dev/null' TERM INT
while kill -0 "$NODE_PID" 2>/dev/null; do
  wait -n 2>/dev/null || sleep 2
done
wait "$NODE_PID"
exit $?
