// Which Drive transport the recovery card restores from.
//
// The card's whole job is getting a backup back, and it called the
// installation-scoped `/api/workspace/v2/drive/pull` unconditionally. That
// route reads `cfg.driveSync.refreshToken`, so on a host that never configured
// an installation-wide Drive it answers "Google Drive is not connected yet" —
// to a user who signed in, connected their OWN Google account, and pushed a
// backup from another machine. The backup exists. The card just could not reach
// it.
//
// The decision is a one-line ternary in a component that fetches in an effect,
// which has no seam, so it is exported and pinned here.

import { describe, expect, it } from "vitest";
import { driveRestoreRoute } from "./RecoveryCard";

describe("driveRestoreRoute", () => {
  it("uses the account's own grant when the account is connected", () => {
    // THE fix: this is the route that can actually find their backup.
    expect(driveRestoreRoute(true)).toBe("/api/workspace/google/pull");
  });

  it("falls back to the installation connection when the account is not", () => {
    // Also correct, and necessary: on a desktop with only the installation-wide
    // Drive configured, the account route would find nothing.
    expect(driveRestoreRoute(false)).toBe("/api/workspace/v2/drive/pull");
  });

  it("has a definite answer for the unknown state rather than guessing", () => {
    // Before the capability answers there is no evidence either way. The card
    // renders the button disabled in that window, so the value is never acted
    // on — but it must still be total, because a `undefined` route reaching
    // fetch would be a worse bug than the one being fixed.
    expect(driveRestoreRoute(null)).toBe("/api/workspace/v2/drive/pull");
  });

  it("only ever names a path the server actually serves", () => {
    // Both spellings exist in server/workspace-backup-routes.ts. A typo here is
    // a 404 the user reads as "your backup is gone", so the DISTINCT set is
    // pinned — two routes across three inputs, since false and null agree.
    const distinct = new Set([driveRestoreRoute(true), driveRestoreRoute(false), driveRestoreRoute(null)]);
    expect([...distinct].sort()).toEqual([
      "/api/workspace/google/pull",
      "/api/workspace/v2/drive/pull",
    ]);
  });
});
