// The boot order that a whole restore feature silently depends on.
//
// A staged v2 restore commits BEFORE the Store reads bots.json/groups.json and
// before the message database opens. Get it backwards — construct the Store
// first — and the freshly-restored fleet is read into memory, then the live
// process overwrites what the swap just wrote, with no error anywhere. The
// restore receipt still says "committed".
//
// That ordering lived as a bare statement in server/index.ts, guarded only by a
// comment. It could not be tested there because importing the module starts the
// server. This module exists so the invariant is executable: the sequence is
// named, and a test can prove the store factory is not reached until the
// restore has already been applied.
import { applyPendingRestore } from "./restore-apply.ts";

/** What a boot produced. Named because the boot site destructures it and the
 *  test asserts both fields — an inline type would be an anonymous shape
 *  duplicated at each use. */
export interface BootOutcome<T> {
  store: T;
  /** Whether a staged restore actually committed during this boot. */
  restored: boolean;
}

/** Apply any staged restore, then build the store.
 *
 *  The restore result is returned alongside so a caller can log or surface it;
 *  the boot site itself only needs the store. */
export function bootWithRestoreFirst<T>(dataDir: string, createStore: () => T): BootOutcome<T> {
  const receipt = applyPendingRestore(dataDir);
  // The store is constructed on the next line, unconditionally after the apply.
  // There is deliberately no early return and no conditional here: making the
  // order visible is the entire point, and a branch would be a place for it to
  // be reintroduced.
  const store = createStore();
  return { store, restored: receipt?.status === "committed" };
}
