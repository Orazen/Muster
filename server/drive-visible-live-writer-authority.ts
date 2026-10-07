// Root-identity handle for owned, cooperating live-restore preparation.
//
// A read-only directory descriptor proves only that this path still names
// the captured directory. It grants no write exclusivity: same-UID processes,
// pre-opened file descriptors, SQLite connections and unregistered writers
// remain able to change child files. Claim absence and the journal lock only
// fence the corresponding cooperating restore machinery. They do not turn
// this handle into production host writer authority.
//
// The adapter's no-await frame prevents scheduled writes in the same isolate
// from interleaving. Image checks detect some conflicts, but cannot exclude a
// foreign write between a byte check and replacement. Production registration
// therefore remains unavailable, including when an enablement flag is set.
// A separately reviewed host lifetime/confinement mechanism must cover the
// actual writer surfaces and previously issued references before activation.
// Do not adapt the whole-tree permission barrier to this additive path.
import { closeSync, constants, fstatSync, lstatSync, openSync } from "node:fs";
import { resolve } from "node:path";
import { inspectExclusiveRestoreClaim } from "./data-dir-exclusivity.ts";

export interface RestoreRootIdentity {
  readonly kind: "root-identity-only";
  /** Re-proves root identity/claim absence only, never writer exclusion. */
  assertReady(): void;
  /** Permanently retire this identity handle. */
  release(): void;
}

/** Capture the root used by an owned cooperating runtime. Not a production
 * host writer authority; holding a directory does not lock its contents. */
export function holdRestoreRootIdentity(dataDir: string): RestoreRootIdentity {
  const root = resolve(dataDir);
  const captured = lstatSync(root);
  if (!captured.isDirectory() || captured.isSymbolicLink()) {
    throw new Error("Restore root identity requires a real, non-symlink data directory");
  }
  const fd = openSync(root, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const held = fstatSync(fd);
  if (held.dev !== captured.dev || held.ino !== captured.ino) {
    closeSync(fd);
    throw new Error("Restore root identity captured a directory identity that changed under it");
  }
  let released = false;
  const refuse = (reason: string): never => {
    throw new Error(`Restore root identity is not held: ${reason}`);
  };
  return {
    kind: "root-identity-only",
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
