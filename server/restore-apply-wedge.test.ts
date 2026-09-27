// A restore that fails once must not be wedged forever.
//
// Sweep 4, item 2. The backup directory was named from the stamp alone, and the
// stamp is derived from `pending.createdAt` — so it is byte-identical on every
// boot. `commitRestoreV2` refuses when that directory already exists, and the
// pending file only clears on `committed`. So one attempt that died AFTER
// creating the directory — mid-write, a full disk, a killed process — left the
// next boot recomputing the same name and hitting the same refusal, forever.
// The operator's staged restore could never be applied, and the only way out was
// to discard a bundle they might no longer have.
//
// The property has to be tested across attempts, not within one: a single apply
// cannot see a wedge that only exists on the second boot. The existing suite
// applies once per case, which is how this survived.
//
// The second half of the finding is the operator's side: `PortableBackupCard`
// renders the receipt only when `!status?.pending`, so a staged-but-refused
// restore shows "a restore is waiting" and never the reason. That is recorded
// here rather than fixed, because the UI is not this lane's file and a fix
// there belongs with whoever owns the card.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyPendingRestore,
  backupsRootFor,
  PENDING_RESTORE_FORMAT,
  stagingPathFor,
  readPendingRestore,
  writePendingRestore,
  type PendingRestore,
} from "./restore-apply.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A data dir with a pending restore recorded, and nothing else staged. */
function dataDirWithPending(createdAt: number): string {
  const root = mkdtempSync(join(tmpdir(), "muster-restore-wedge-"));
  roots.push(root);
  const dataDir = join(root, "install");
  mkdirSync(dataDir, { recursive: true });
  const pending: PendingRestore = {
    version: 1,
    format: PENDING_RESTORE_FORMAT,
    // The conventional sibling path, left empty: the commit gets far enough to
    // create its backup directory and then finds nothing to commit, which is
    // the shape that used to wedge every later boot.
    stagingDir: stagingPathFor(dataDir),
    createdAt,
    source: "file",
    reconsentRequired: [],
  };
  writePendingRestore(dataDir, pending);
  return dataDir;
}

const stampFor = (createdAt: number): string => new Date(createdAt).toISOString().replace(/[:.]/g, "-");

describe("a failed restore does not wedge the next one", () => {
  it("still holds the pending file after a refusal, so nothing is silently lost", () => {
    const createdAt = 1_760_000_000_000;
    const dataDir = dataDirWithPending(createdAt);
    const applied = applyPendingRestore(dataDir);
    // It cannot commit — the staging directory is missing.
    expect(applied.status).not.toBe("committed");
    // The pending file survives, which is correct: the work is unfinished and
    // the operator still owns the decision.
    expect(readPendingRestore(dataDir)).not.toBeNull();
  });

  it("does not refuse forever once a previous attempt left a backup directory", () => {
    const createdAt = 1_760_000_111_000;
    const dataDir = dataDirWithPending(createdAt);
    const backups = backupsRootFor(dataDir);
    const stamp = stampFor(createdAt);

    // A first attempt that died after creating its backup directory. This is
    // the leftover that used to make every later boot refuse.
    mkdirSync(join(backups, stamp), { recursive: true });
    writeFileSync(join(backups, stamp, "leftover.txt"), "half-written", "utf8");
    expect(existsSync(join(backups, stamp))).toBe(true);

    const applied = applyPendingRestore(dataDir);

    // Before the fix this refused with "the backup directory already exists"
    // and the pending restore was wedged for good.
    const blocked = JSON.stringify(applied.commit?.blocked ?? []);
    expect(blocked, "the refusal must not be about an existing backup directory").not.toMatch(
      /backup directory already exists/,
    );
    // And whatever it did, the pending file is still there for the operator —
    // a refusal never silently discards a staged restore.
    expect(readPendingRestore(dataDir)).not.toBeNull();
  });

  it("never overwrites a backup an earlier attempt left behind", () => {
    const createdAt = 1_760_000_222_000;
    const dataDir = dataDirWithPending(createdAt);
    const backups = backupsRootFor(dataDir);
    const stamp = stampFor(createdAt);
    mkdirSync(join(backups, stamp), { recursive: true });
    writeFileSync(join(backups, stamp, "leftover.txt"), "half-written", "utf8");

    applyPendingRestore(dataDir);

    // The leftover is still exactly as it was: no cleanup on the operator's
    // behalf, and nothing written into the directory they may want to inspect.
    expect(readFileSync(join(backups, stamp, "leftover.txt"), "utf8")).toBe("half-written");
    // Any new directory the attempt needed is a SIBLING, not that one.
    const entries = existsSync(backups) ? readdirSync(backups) : [];
    for (const entry of entries) {
      if (entry === stamp) continue;
      expect(entry.startsWith(`${stamp}-`), `${entry} should sit beside the stamp, not replace it`).toBe(true);
    }
  });
});
