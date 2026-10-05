# Restore-reconciliation runbook

Manual reconciliation for the ambiguous states of the exclusive-restore
boundary. This is the runbook every refusal in that boundary points at.

Sources of truth (this document only restates what those modules do; when
they disagree with this document, the modules win):

- `server/data-dir-exclusivity.ts` — the claim marker, the writer barrier,
  the boot guard (`assertNoLiveExclusiveRestoreClaim`), and every message
  quoted below.
- `server/data-dir-exclusivity-boot.ts` — binds the boot guard to the real
  `DATA_DIR` at import time, before any writer (auth database, store, message
  database) is constructed.
- `scripts/data-dir-claim-check.mjs` — the launcher-side pre-flight (exit 0 =
  no marker, exit 2 = any marker, exit 3 = cannot decide). Wired into
  `scripts/docker-entrypoint.sh` (inline mirror), `cli/muster.mjs`
  (`serverEnv`, before the `auth.secret` write) and `electron/main.mjs`
  (before the parent's one protected write).
- `server/restore-apply.ts` — `pending-restore.json` / `last-restore.json`
  receipts for the boot-time staged restore.
- `server/restore-authority.ts` — running-server authority adoption inside
  the exclusive window (session/account/workspace/binding re-validation).

## The golden rules

1. **No destructive shortcut, ever.** Deleting the claim marker to "just get
   the server up" is the one action that can turn recoverable evidence into
   unrecoverable data loss. The marker is the only record of what a crashed
   restore was doing; it is deleted by the boot guard when deletion is
   provable, and by a human only after the evidence steps below.
2. **Launchers refuse; they never recover.** `docker-entrypoint.sh`, the CLI
   and the desktop parent exit (2 or 3) on any marker. Recovery belongs to the
   server's own boot guard and, beyond it, to a human following this page.
3. **Preserve before touching.** Copy the marker bytes, the dev/ino identity
   of every tree, and a recursive `ls -laR` of the data directory and any
   sibling backup/staging trees to a location OUTSIDE the data directory
   before moving, renaming or deleting anything.
4. **Never execute anything inside a disputed tree.** Inspection is
   read-only: `stat`, `ls`, reading JSON with your eyes or a parser. Running
   the server against a candidate tree IS the decision — do not do it as a
   probe.

## The marker

The claim marker is a sibling of the data directory, named after it (so it
survives the rename window and sibling data directories never share a slot):

```
<parent-of-data-dir>/.muster-restore-exclusivity.<basename-of-data-dir>.json
```

For `OMB_DATA_DIR=/data` that is `/.muster-restore-exclusivity.data.json`; for
`~/.muster/data` it is `~/.muster/.muster-restore-exclusivity.data.json`.

A well-formed marker is one JSON object: `{version, kind:
"data-dir-exclusivity", pid, nonce, reason, acquiredAt, dataDir, dataDirDev,
dataDirIno, originalMode, backupPath?}`. `backupPath` is written into the
marker (same inode, fsynced) BEFORE the old tree is renamed away, so a crash
between the two swap renames leaves the backup's location on disk. Never
assume the backup location; read it from the marker.

First commands (all read-only):

```sh
DATA=<your OMB_DATA_DIR>
MARKER="$(dirname "$DATA")/.muster-restore-exclusivity.$(basename "$DATA").json"
# Evidence bundle — copy OUTSIDE the data directory:
cp "$MARKER" /tmp/marker-evidence.json 2>/dev/null && cat /tmp/marker-evidence.json
stat -c 'dev=%d ino=%i mode=%a mtime=%y size=%s' "$DATA" "$MARKER"
ls -la "$(dirname "$DATA")"          # siblings: backups, staging trees
ls -laR "$DATA" > /tmp/tree-listing.txt 2>&1
node -e 'const s=require("fs").lstatSync(process.argv[1]);console.log(JSON.stringify({dev:s.dev,ino:s.ino,mode:s.mode&0o777,size:s.size,mtime:s.mtime}))' "$DATA"
ps -p "<pid from the marker>" -o pid,command   # is the recorded owner alive?
```

The record's `dataDir`/`dataDirDev`/`dataDirIno` are the identity binding:
the marker only speaks for the directory whose resolved path equals
`record.dataDir` AND whose `lstat` dev/ino match `dataDirDev`/`dataDirIno`
(`recordClaimsDirectory`). A dev/ino mismatch means the marker is evidence
about a PREVIOUS incarnation of this path, or about a different directory
entirely — its crash evidence is never adopted or removed by this
directory's boot ("Restore-exclusivity marker records a previous incarnation
of <path> (device/inode mismatch)" / "Restore-exclusivity marker at this
path names <other>, not <root>").

---

## State 1 — torn / zero-byte marker

**Looks like:** the marker exists but is 0 bytes (`size=0`). This is the
crash window between the marker's `O_CREAT` and its content write: the owner
died after creating the slot but before claiming anything.

**The boot guard already does:** `inspectExclusiveRestoreClaim` reports the
marker as `abandoned` with `record: null`. With the data directory ABSENT,
deletion is provable (nothing was claimed yet) and the guard removes the
marker silently — the boot proceeds. With the data directory PRESENT, the
guard falls through the stale/abandoned branch below (state 3 if the tree is
still frozen, otherwise it removes the marker and boots).

**The launcher does:** exit 2, message "(empty marker: a claim write torn by
a crash; its owner cannot be proven)".

**Preserve first:** the (empty) marker's dev/ino, the directory listing, and
`ps -p <pid>` — although a zero-byte marker names no pid, so the pid cannot
be recovered; note that fact in your evidence.

**Manual reconciliation:** with the data directory present, the next server
boot clears the marker by itself; if you must clear it by hand (e.g. a
launcher-only machine), verify the size is exactly 0 and then remove ONLY
the marker:

```sh
[ -s "$MARKER" ] && echo "NOT zero-byte — stop, use the other sections" || rm "$MARKER"
```

**Never:** delete the data directory because the marker "looks empty"; a
torn marker says nothing about the tree's contents.

## State 2 — live claim on boot

**Looks like:** the marker parses, and `ps -p <pid>` shows the owner process
still running. Message from the boot guard: "Exclusive restore is in
progress by pid <pid> (<reason>); server startup refused before
initialization."

A variant: the marker parses but names a DIFFERENT directory or a previous
incarnation of this one — "…reconcile manually. Server startup refused
before initialization." That marker is foreign evidence; it protects a slot,
and the directory it names owns its recovery.

**The boot guard already does:** nothing but refuse. A live owner may be
mid-swap; touching the tree or the marker would break the writer barrier's
guarantees.

**The launcher does:** exit 2, message "(claim by pid <pid>, live:
"<reason>"…)".

**Preserve first:** the full marker JSON, the process's command line
(`ps -p <pid> -o pid,ppid,command`), and the marker's mtime.

**Manual reconciliation:** the owner releases the claim itself on success
(`release()` unfreezes and removes the marker). Either wait for the owner to
finish, or stop it in an orderly way (SIGTERM) and let its own error paths
roll back — then continue with state 3/4/5 as the remaining marker dictates.
If the pid is alive but is provably NOT the restore that wrote the marker
(pid reuse — compare the process start time against `record.acquiredAt`, the
command line, and the marker's mtime), document that determination in the
evidence bundle before treating the marker as stale (state 3+).

**Never:** `rm` the marker while its recorded pid is alive and plausibly the
owner; never start a second restore to "overwrite" the first.

## State 3 — frozen tree with dead owner

**Looks like:** the marker parses, the pid is dead, the data directory is
present but unwritable (`test -w "$DATA"` fails) — the owner died between
the mode freeze (`chmod 0555`) and the unfreeze.

**The boot guard already does:** restores the mode from
`record.originalMode` (falling back to 0755), removes the marker, and
refuses this boot exactly once: "A previous exclusive restore was
interrupted while the data directory was frozen; the directory was restored
and the stale claim removed. Server startup refused once; restart to
continue." The NEXT boot proceeds normally.

**The launcher does:** exit 2 with "owner process gone".

**Preserve first:** the marker JSON (especially `originalMode` and
`dataDirDev`/`dataDirIno`), `stat` of the data directory (its current mode),
and the tree listing.

**Manual reconciliation:** normally none — restart the server and confirm
the second boot is clean. By hand: `chmod <originalMode from the marker>
"$DATA"`, verify `test -w "$DATA"`, then remove the marker.

**Never:** chmod the tree to 0777 "to get unstuck"; never remove the marker
before the mode is restored — a crash after the unlink but before a needed
mode restore would leave the directory unwritable with no claim left to
explain it (the exact ordering `release()` defends).

## State 4 — missing directory with a recorded backupPath

**Looks like:** the marker parses, the pid is dead, the data directory is
GONE, and `record.backupPath` names an existing sibling. This is the crash
between the two swap renames: old tree moved to `backupPath`, new tree not
yet moved in.

**The boot guard already does:** renames `record.backupPath` back to the
data directory path, restores `record.originalMode`, removes the marker, and
refuses this boot once: "A previous exclusive restore was interrupted
between its swap steps; the previous data directory was restored from its
recorded backup path. Server startup refused once; restart to continue."

**The launcher does:** exit 2 with "owner process gone" (the launcher cannot
verify the backup exists; the boot guard owns the move).

**Preserve first:** the marker JSON (`backupPath`, `originalMode`, dev/ino),
`stat` of the backup tree, and a listing of the parent directory.

**Manual reconciliation:** normally none — the boot guard performs the exact
rename the crashed restore was going to perform. By hand (only if the boot
guard's precondition cannot hold, e.g. you need the machine up without the
server): `mv "$BACKUP" "$DATA"` using the marker's recorded path, chmod the
tree to `record.originalMode`, then remove the marker.

**Never:** rename anything except the exact recorded `backupPath`; never
"reconstruct" a missing tree from scratch; never point a fresh server at an
empty directory while this state stands — that would silently fork the fleet
onto a new tree.

## State 5 — both trees present

**Looks like:** the marker parses, the pid is dead, the data directory is
present AND `record.backupPath` also exists. The restore completed its swap
(or partially applied one) but crashed before `release()`. Ambiguous by
construction: which tree is "the data" is not provable by the boot guard.

**The boot guard already does:** refuses, permanently, with
"Restore-exclusivity claim from dead pid <pid> has both its data directory
and its recorded backup path present; reconcile manually. Server startup
refused before initialization." It moves and deletes nothing — every
possible automatic choice could destroy the newer data.

**The launcher does:** exit 2 with "owner process gone".

**Preserve first:** everything — the marker JSON, dev/ino and recursive
listings of BOTH trees, and any receipts (below). Do not differentiate the
trees in place.

**Identify the correct tree (read-only):**

1. `record.dataDirDev`/`record.dataDirIno` identify the tree the CLAIM
   guarded: `lstat` the data directory path — a matching dev/ino means that
   path still holds the claimed incarnation; a mismatch means the tree at
   the data path is a different (e.g. fresh) directory.
2. Compare mtimes WITHOUT executing: `stat` the top-level files
   (`bots.json`, `groups.json`, `task-plans.json`) in both trees. The tree
   whose substantive files are newer usually carries the later state — but
   mtime is evidence, not proof; a restore in flight writes the NEW tree
   while the OLD tree's mtimes stop at the freeze.
3. Read the receipts that exist alongside:
   - `<data>/.restore-backups/` — the per-restore safety copies the v2
     commit flow writes inside the data directory.
   - `<data>/last-restore.json` — the boot-time apply's receipt; `status:
     "committed"` means a staged restore DID commit at some boot.
   - `<data>/pending-restore.json` — a staged restore still waiting for a
     boot-time commit (its `stagingDir` names a `<data>.restore-staging`
     sibling).
4. Decision rule: prefer the tree that the receipts and mtimes jointly
   support, and when the evidence disagrees, prefer the OLDER, known-good
   tree (the recorded backup) — a lost newer write is recoverable from
   users; a silently lost pre-restore baseline may not be.

**Manual reconciliation:** with both trees still in place, move the loser
aside (rename, do not delete) — e.g. `<path>.reconciled-<date>` — put the
winner at the data directory path, `chmod` it to `record.originalMode`, and
only then remove the marker. Keep the loser tree until the server has been
verified healthy against the winner.

**Never:** delete either tree during reconciliation; never run the server
against a candidate "to see if it works"; never merge the trees.

## State 6 — rollback-failed

**Looks like:** a restore failed and its rollback ALSO failed.
`runWithWriterBarrier` reports exactly this as a `changed` error: "Exclusive
restore failed and rollback also failed (<rollback error>); manual
reconciliation required". The marker SURVIVES on disk (release() was never
reached) with `backupPath` recorded, so the on-disk state is one of the
states above — usually state 4 (old tree still at the backup path) or state
5 (partially moved back), sometimes state 3 (frozen).

**The boot guard already does:** whatever the resulting on-disk state maps
to — see states 3, 4 and 5. The `changed` code exists precisely so a
silently half-restored tree can never look like a success.

**The launcher does:** exit 2 (the marker is present).

**Preserve first:** the marker JSON, the restore's own log/receipt output
(`last-restore.json`, the failing process's stderr), and listings of the
data directory, the recorded `backupPath`, and any `<data>.restore-staging`
sibling.

**Manual reconciliation:** identify the resulting state with the evidence,
then follow that state's section. The rollback error text tells you which
step failed (`rename` vs `chmod`); the tree listing confirms which step
landed.

**Never:** re-run the restore on top of an un-reconciled tree; never treat
the restore's "failed" receipt as "rolled back" — only `status:
"rolled-back"` in the receipt means the previous tree was provably restored.

---

## What must NEVER be deleted

- The claim marker, until its state has been reconciled per the sections
  above (and then only with the evidence bundle preserved).
- The recorded `backupPath` tree, ever — it is the pre-restore baseline.
- Any `<data>.restore-staging` or `.restore-backups/` material before the
  winner tree has been verified healthy by a real boot.
- Receipts and journals: `pending-restore.json`, `last-restore.json`, and
  any account-recovery journal material (`immutable.json`, `receipt.json`,
  `archive.bin`, `.account-recovery-owner.json`). The startup-refusal guard
  (`server/drive-visible-startup-refusal.ts`) refuses the boot while
  recovery evidence is un-reconciled — that is a feature; do not "fix" it by
  deleting the evidence.

## How to verify which tree is newer — without executing it

- `stat` (not run) every candidate's substantive files: `bots.json`,
  `groups.json`, `task-plans.json`, and the message-database files if
  present. Newer mtime = later writes, with the state-5 caveat about which
  tree was being written during the restore.
- `record.dataDirDev`/`dataDirIno` + `lstat`: proves WHICH tree the claim
  was guarding, independent of time.
- Receipts: `last-restore.json` (status + timestamps), the marker's
  `acquiredAt`/`backupPath`, and the staging manifest if a
  `<data>.restore-staging` sibling exists.
- Reading JSON with a parser is inspection. Booting the server against a
  tree is execution — it mutates, it decides, and it is the last step, taken
  only after the tree is in its final reconciled place.

## When to stop and escalate

If the evidence contradicts the states above — a marker whose recorded
dev/ino matches no existing tree, a `backupPath` that never existed, trees
whose mtimes are identical — stop. Preserve the bundle, leave every byte in
place, and hand the case to the owner with the evidence. The boundary is
designed so that "no one can prove what happened" stays a refusal with
everything intact; a plausible guess is the one outcome it cannot protect
against.
