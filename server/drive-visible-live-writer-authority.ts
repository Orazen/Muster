// Host writer authority for the ADDITIVE account live restore.
//
// PR #98's adapter (server/drive-visible-live-restore.ts) requires a
// `LiveRestoreRuntime.assertReady()` capability — never request metadata, a
// boolean or a marker the requester can invent — and re-proves it at every
// synchronous boundary from authority acquisition through commit and
// compensation (`bound()` / `current()` / phase checks).
//
// The whole-tree writer barrier (`runWithWriterBarrier`,
// server/data-dir-exclusivity.ts) CANNOT serve this additive path and is not
// adapted here. It freezes the data-directory ROOT to 0o555 and swaps the
// whole tree by rename, while the additive restore writes in place: the
// bots.json / groups.json / task-plans.json postimages are atomic replaces
// whose temp files are created directly inside that frozen root, and the
// durable target copy is written inside account-live-restore-journal/.
// Freezing the root would therefore block the restore's own writes; every
// one of those target files stays individually writable, so no freeze level
// between "root" and "nothing" exists that keeps the additive writes alive.
// data-dir-exclusivity.ts is only ever CALLED here, never bent.
//
// What remains genuinely exclusive, and why each leg is provable rather than
// declared:
//  1. In-process, inside the frame: the adapter runs its whole
//     commit/compensation sequence with NO await, so the JavaScript runtime
//     itself excludes every in-process writer surface (store roster saves and
//     message persistence, task-engine plan/intent persists, message-db SQL
//     writes, workspace memory writes, and the sync producers wired in
//     server/index.ts) for the duration of the frame.
//  2. In-process, between async windows (engine snapshot, Drive download):
//     every boundary re-reads the recorded before-image on disk, in SQLite
//     and in the live caches and refuses, with a journal-visible rollback, on
//     any foreign byte. That leg is DETECTION-based exclusion; the residual
//     gap it leaves open is named in the runtime factory, not hidden here.
//  3. Cross-process: the store's one-process-per-data-directory single-writer
//     convention, the exclusive-restore claim machinery (refusing concurrent
//     whole-tree restores), and the account journal's O_EXCL writer.lock,
//     which serializes concurrent live-restore operations across processes.
//
// What this capability itself contributes beyond those conventions: a held
// OS handle plus captured directory identity that the restore re-proves at
// EVERY boundary. It 
//   - cannot be satisfied from request data (the identity is captured once,
//     at server construction, from the filesystem),
//   - cannot survive a whole-tree swap (device/inode identity changes →
//     refuse),
//   - cannot outlive this process (an fd dies with it), and
//   - refuses outright while any exclusive-restore claim (live, stale or
//     abandoned) exists, so the additive path never runs concurrently with
//     whole-tree restore machinery — the same closed-evidence posture
//     openLiveJournal already enforces at journal open.
import { closeSync, constants, fstatSync, lstatSync, openSync } from "node:fs";
import { resolve } from "node:path";
import { inspectExclusiveRestoreClaim } from "./data-dir-exclusivity.ts";

export interface RestoreWriterAuthority {
  /** Re-proves the hold on every call. Throws when the capability is gone;
   * never returns a verdict the caller could have supplied itself. */
  assertReady(): void;
  /** Retire the handle. Nothing adopts it afterwards; the restore re-proving
   * `assertReady()` at its next boundary stops. */
  release(): void;
}

/** Hold the writer authority for the running server's data directory.
 * Call once at server construction, with the same root the Store and the
 * task engine were built against. */
export function holdRestoreWriterAuthority(dataDir: string): RestoreWriterAuthority {
  const root = resolve(dataDir);
  const captured = lstatSync(root);
  if (!captured.isDirectory() || captured.isSymbolicLink()) {
    throw new Error("Restore writer authority requires a real, non-symlink data directory");
  }
  const fd = openSync(root, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const held = fstatSync(fd);
  if (held.dev !== captured.dev || held.ino !== captured.ino) {
    closeSync(fd);
    throw new Error("Restore writer authority captured a directory identity that changed under it");
  }
  let released = false;
  const refuse = (reason: string): never => {
    throw new Error(`Restore writer authority is not held: ${reason}`);
  };
  return {
    assertReady(): void {
      if (released) refuse("the capability was released");
      // The held descriptor must still name the same directory identity that
      // was captured at hold time. A whole-tree swap replaces the directory's
      // inode, so this is where an additive restore racing a tree swap dies.
      const nowHeld = fstatSync(fd);
      if (nowHeld.dev !== captured.dev || nowHeld.ino !== captured.ino) refuse("the held directory descriptor identity changed");
      const current = lstatSync(root);
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== held.dev || current.ino !== held.ino) {
        refuse("the configured data directory is no longer the real directory this capability holds");
      }
      // Any exclusive-restore claim — live, stale or abandoned — means
      // whole-tree restore machinery exists at this root's marker slot. The
      // additive path refuses rather than race it; the journal does the same
      // check at open, so both doors agree.
      const claim = inspectExclusiveRestoreClaim(root);
      if (claim.status !== "absent") {
        refuse(`an exclusive-restore claim is present (${claim.status}); whole-tree restore evidence exists at this root`);
      }
    },
    release(): void {
      if (released) return;
      released = true;
      try { closeSync(fd); } catch { /* the fd is dying with the process anyway */ }
    },
  };
}
