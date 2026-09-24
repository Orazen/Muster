// Loop199 — the companion receipt's pure mapping. The route that serves it
// is exercised through its own family tests; what is pinned HERE is the
// decision table, because every clause is a promise the phone will render
// to a human:
//   - the destination precedence (a connected account Drive outranks the
//     installation backup flag, which outranks plain-computer storage);
//   - "available" is not a destination — an unconnected account Drive must
//     never render as if the data already lives there;
//   - an install that can do none of it says "unavailable", never a guess;
//   - a verified snapshot is NOT a successful upload: the two timestamps
//     stay separate facts;
//   - "never happened" is 0 / "unknown", never an epoch and never a
//     fabricated success; and conversation sync can only say "success" when
//     a transport actually stamped one, because nothing records failures.
import { describe, expect, it } from "vitest";

import { companionStatus, storageDestinationOf, type CompanionCapabilityInput } from "./companion-status.ts";

const T0 = 1_760_000_000_000;

const capability = (overrides: Partial<CompanionCapabilityInput> = {}): CompanionCapabilityInput => ({
  workspaceBackupAvailable: true,
  installationDriveReady: false,
  accountDriveAvailable: false,
  accountDriveConnected: false,
  ...overrides,
});

const noSnapshot = { lastAttemptAt: null, lastSuccessAt: null, lastOutcome: null, verifiedAt: null };
const noSync = { lastPush: null, lastPull: null };

describe("storageDestinationOf", () => {
  it("prefers a connected account Drive over everything else", () => {
    expect(
      storageDestinationOf(
        capability({ accountDriveConnected: true, accountDriveAvailable: true, installationDriveReady: true }),
      ),
    ).toBe("google-drive-account");
  });

  it("falls to the installation backup when no account Drive is connected", () => {
    expect(storageDestinationOf(capability({ installationDriveReady: true }))).toBe("google-drive-computer");
  });

  it("is plain computer storage when backups work but no Drive is ready", () => {
    expect(storageDestinationOf(capability())).toBe("computer");
  });

  it("treats an AVAILABLE-but-unconnected account Drive as not a destination", () => {
    expect(storageDestinationOf(capability({ accountDriveAvailable: true }))).toBe("computer");
  });

  it("says unavailable rather than guessing when the install can do nothing", () => {
    expect(storageDestinationOf(capability({ workspaceBackupAvailable: false }))).toBe("unavailable");
  });
});

describe("companionStatus backup facts", () => {
  it("reports a never-run snapshot as unknown with zeroed stamps", () => {
    const status = companionStatus({ capability: capability(), snapshot: noSnapshot, sync: noSync });
    expect(status.backup).toEqual({
      lastAttemptAt: 0,
      lastSuccessAt: 0,
      lastOutcome: "unknown",
      lastVerifiedAt: 0,
    });
  });

  it("keeps verified and successful as separate facts", () => {
    const status = companionStatus({
      capability: capability(),
      snapshot: { lastAttemptAt: T0 + 20, lastSuccessAt: T0 + 20, lastOutcome: "success", verifiedAt: T0 + 25 },
      sync: noSync,
    });
    expect(status.backup.lastSuccessAt).toBe(T0 + 20);
    expect(status.backup.lastVerifiedAt).toBe(T0 + 25);
    expect(status.backup.lastVerifiedAt).not.toBe(status.backup.lastSuccessAt);
  });

  it("passes a failed or skipped attempt through without inventing a success", () => {
    const failed = companionStatus({
      capability: capability(),
      snapshot: { lastAttemptAt: T0, lastSuccessAt: null, lastOutcome: "failed", verifiedAt: null },
      sync: noSync,
    });
    expect(failed.backup).toMatchObject({ lastOutcome: "failed", lastSuccessAt: 0, lastVerifiedAt: 0 });
    const skipped = companionStatus({
      capability: capability(),
      snapshot: { lastAttemptAt: T0, lastSuccessAt: T0 - 1, lastOutcome: "skipped", verifiedAt: null },
      sync: noSync,
    });
    expect(skipped.backup.lastOutcome).toBe("skipped");
  });

  it("refuses nonsense stamps instead of echoing them", () => {
    const status = companionStatus({
      capability: capability(),
      snapshot: { lastAttemptAt: -5, lastSuccessAt: Number.NaN, lastOutcome: "success", verifiedAt: 1.9 },
      sync: noSync,
    });
    expect(status.backup).toMatchObject({ lastAttemptAt: 0, lastSuccessAt: 0, lastVerifiedAt: 1 });
  });
});

describe("companionStatus conversation-sync facts", () => {
  it("is unknown until a transport actually stamped something", () => {
    const status = companionStatus({ capability: capability(), snapshot: noSnapshot, sync: noSync });
    expect(status.conversationSync).toEqual({ lastPushAt: 0, lastPullAt: 0, lastOutcome: "unknown" });
  });

  it("reports success from a push stamp alone, and from a pull stamp alone", () => {
    const pushed = companionStatus({
      capability: capability(),
      snapshot: noSnapshot,
      sync: { lastPush: { at: T0, channel: "google-drive" }, lastPull: null },
    });
    expect(pushed.conversationSync).toEqual({ lastPushAt: T0, lastPullAt: 0, lastOutcome: "success" });
    const pulled = companionStatus({
      capability: capability(),
      snapshot: noSnapshot,
      sync: { lastPush: null, lastPull: { at: T0 + 1, channel: "telegram" } },
    });
    expect(pulled.conversationSync).toEqual({ lastPushAt: 0, lastPullAt: T0 + 1, lastOutcome: "success" });
  });
});

describe("the receipt cannot carry anything sensitive", () => {
  it("exposes only the documented fields", () => {
    const status = companionStatus({
      capability: capability(),
      snapshot: { lastAttemptAt: T0, lastSuccessAt: T0, lastOutcome: "success", verifiedAt: T0 },
      sync: { lastPush: { at: T0, channel: "google-drive" }, lastPull: { at: T0, channel: "google-drive" } },
    });
    expect(Object.keys(status).sort()).toEqual(["backup", "conversationSync", "storageDestination", "version"]);
    expect(Object.keys(status.backup).sort()).toEqual([
      "lastAttemptAt",
      "lastOutcome",
      "lastSuccessAt",
      "lastVerifiedAt",
    ]);
    expect(Object.keys(status.conversationSync).sort()).toEqual(["lastOutcome", "lastPullAt", "lastPushAt"]);
    // A drive channel name is deliberately NOT part of the document: which
    // provider carried a push is the computer's business, not the phone's.
    expect(JSON.stringify(status)).not.toContain("google-drive");
  });
});
