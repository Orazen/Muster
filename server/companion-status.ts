// Loop199 — the companion receipt: one read-only document that tells a
// paired phone and watch what the computer's local-first machinery is
// actually doing, instead of leaving them to re-derive it from two
// endpoints or (worse) to say "not reported" forever.
//
// This is the shape the iOS slice asked for (Loop198's cross-zone
// request), built as a PURE function over state the server already keeps:
//
//   storageDestination — the same capability booleans the
//     /api/workspace/google/status route advertises, with the same
//     precedence: a connected account Drive outranks the installation
//     backup flag, which outranks plain-computer storage, and an install
//     that can do none of it is "unavailable" rather than a guess.
//   backup — the snapshot runner's own bookkeeping: last attempt, last
//     success, the run outcome, and the verified point SEPARATELY, because
//     a successful upload and a completed download-and-verify round trip
//     are different facts (the phone's model already insists on this).
//   conversationSync — the per-account push/pull stamps sync-state.ts
//     writes after a transport confirms. P4 (Loop197) now drives those
//     stamps for per-thread objects, so this is the first wire the phone
//     can read conversation sync from.
//
// What this document deliberately cannot carry: paths, provider ids or
// names, tokens, passphrases or passphrase existence, raw error text,
// policy, history, or anything per-message. It is a status line, not a
// backup surface — the companion allowlist admits this one GET and keeps
// every mutation verb closed.
import type { SyncState } from "./sync-state.ts";

/** Provider-neutral, matching the phone's vocabulary exactly. */
export const STORAGE_DESTINATIONS = [
  "computer",
  "google-drive-computer",
  "google-drive-account",
  "unavailable",
  "unknown",
] as const;
export type StorageDestination = (typeof STORAGE_DESTINATIONS)[number];

export const SYNC_OUTCOMES = ["success", "failed", "skipped", "unknown"] as const;
export type SyncOutcome = (typeof SYNC_OUTCOMES)[number];

/** The capability facts the existing status route already computes; the
 * receipt takes them as input so both documents cannot disagree. */
export interface CompanionCapabilityInput {
  workspaceBackupAvailable: boolean;
  installationDriveReady: boolean;
  accountDriveAvailable: boolean;
  accountDriveConnected: boolean;
}

export interface CompanionStatus {
  version: 1;
  storageDestination: StorageDestination;
  backup: {
    lastAttemptAt: number;
    lastSuccessAt: number;
    lastOutcome: SyncOutcome;
    lastVerifiedAt: number;
  };
  conversationSync: {
    lastPushAt: number;
    lastPullAt: number;
    lastOutcome: SyncOutcome;
  };
}

/** The snapshot runner's bookkeeping, reduced to the four facts the phone
 * shows. `null` means "never happened", which the document reports as 0 /
 * "unknown" — never as an epoch or a fabricated success. */
export interface CompanionSnapshotInput {
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastOutcome: "success" | "failed" | "skipped" | null;
  verifiedAt: number | null;
}

export interface CompanionStatusInput {
  capability: CompanionCapabilityInput;
  snapshot: CompanionSnapshotInput;
  sync: SyncState;
}

/** "Never happened" and "nonsense" both read as 0. The inputs arrive from
 * state the server parses (nulls included), so this is absence and
 * arithmetic validity — not a representation guess. */
const stamp = (value: number | null | undefined): number =>
  value !== null && value !== undefined && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;

/** Precedence: account Drive (the user's own storage home) → installation
 * backup → plain computer → unavailable. `accountDriveAvailable` without a
 * connection is NOT a destination: the phone would render a connect
 * button's target as if the data already lived there. */
export function storageDestinationOf(capability: CompanionCapabilityInput): StorageDestination {
  if (capability.accountDriveConnected) return "google-drive-account";
  if (capability.installationDriveReady) return "google-drive-computer";
  if (capability.workspaceBackupAvailable) return "computer";
  return "unavailable";
}

export function companionStatus(input: CompanionStatusInput): CompanionStatus {
  const { capability, snapshot, sync } = input;
  return {
    version: 1,
    storageDestination: storageDestinationOf(capability),
    backup: {
      lastAttemptAt: stamp(snapshot.lastAttemptAt),
      lastSuccessAt: stamp(snapshot.lastSuccessAt),
      lastOutcome: snapshot.lastOutcome ?? "unknown",
      // Verified is its own fact: an upload that landed is not a verify
      // round trip that opened it again.
      lastVerifiedAt: stamp(snapshot.verifiedAt),
    },
    conversationSync: {
      lastPushAt: stamp(sync.lastPush?.at),
      lastPullAt: stamp(sync.lastPull?.at),
      // The stamps exist only after a transport confirmed, so an un-stamped
      // install is "unknown" — never "failed" (nothing recorded a failure)
      // and never "success" (nothing confirmed one).
      lastOutcome: sync.lastPush !== null || sync.lastPull !== null ? "success" : "unknown",
    },
  };
}
