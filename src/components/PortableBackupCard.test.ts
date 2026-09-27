// Wording contracts for the pending-restore panel and the restore receipt.
//
// The defect these pin: the panel said "Quit and reopen Muster to apply it"
// for every staged restore, including one the server had already REFUSED —
// and the receipt explaining the refusal was rendered only when nothing was
// pending. A refusal leaves the staged file on disk (so the next launch
// retries the same doomed apply), so pending and receipt always coexisted and
// the operator was told to repeat a failing action while the reason sat
// invisible. The fix makes the two states say opposite things.

import { describe, expect, it } from "vitest";
import { pendingRestoreNotice, restoreRefusalReason } from "./PortableBackupCard";

type Receipt = Parameters<typeof restoreRefusalReason>[0];

const refusal: Receipt = {
  appliedAt: 1_757_000_000_000,
  status: "refused",
  source: "local",
  error: "teammate ada is no longer on this install",
  reconsentRequired: [],
};

const committed: Receipt = { ...refusal, status: "committed", error: undefined };
const blockedOnly: Receipt = {
  appliedAt: 1_757_000_000_000,
  status: "failed",
  source: "local",
  blocked: [{ path: "bots/ada/settings.json", detail: "owner account no longer exists" }],
  reconsentRequired: [],
};

const pending = (over: { receipt?: Receipt | null } = {}) => ({
  pending: { createdAt: 1_757_000_000_000, source: "google-drive", reconsentRequired: [] },
  receipt: "receipt" in over ? over.receipt! : null,
});

describe("restoreRefusalReason", () => {
  it("names the reason a committed restore did not need to", () => {
    // A successful restore is not a refusal; reporting one would scare the
    // operator out of a restore that worked.
    expect(restoreRefusalReason(committed)).toBeNull();
  });

  it("has no reason when there is no receipt yet", () => {
    expect(restoreRefusalReason(null)).toBeNull();
    expect(restoreRefusalReason(undefined)).toBeNull();
  });

  it("prefers the free-text error over the first blocked path", () => {
    expect(restoreRefusalReason({ ...blockedOnly, error: "policy gate refused the bundle" })).toBe(
      "policy gate refused the bundle",
    );
  });

  it("falls back to the first blocked path when there is no error", () => {
    expect(restoreRefusalReason(blockedOnly)).toBe("owner account no longer exists");
  });

  it("never renders an empty reason for a non-committed receipt", () => {
    // Both fields optional ⇒ the naive `receipt.error` read renders
    // "did not apply: ." and the operator learns nothing.
    const bare: Receipt = {
      appliedAt: 1_757_000_000_000,
      status: "refused",
      source: "local",
      reconsentRequired: [],
    };
    expect(restoreRefusalReason(bare)).toBe("no reason was recorded");
  });

  it("treats every non-committed status as a refusal, not just 'refused'", () => {
    for (const status of ["failed", "rolled-back", "refused"] as const) {
      expect(restoreRefusalReason({ ...blockedOnly, status })).toBe("owner account no longer exists");
    }
  });
});

describe("pendingRestoreNotice", () => {
  it("says reopening applies when nothing has been tried", () => {
    const n = pendingRestoreNotice(pending());
    expect(n.reopenApplies).toBe(true);
    expect(n.text).toMatch(/Quit and reopen Muster to apply it/);
  });

  it("does not promise that reopening applies when the last attempt was refused", () => {
    // THE regression. The pre-fix build took the first branch for every
    // pending restore, so this is the assertion that fails on it.
    const n = pendingRestoreNotice(pending({ receipt: refusal }));
    expect(n.reopenApplies).toBe(false);
    expect(n.text).not.toMatch(/Quit and reopen Muster to apply it/);
    expect(n.text).toMatch(/Reopening Muster will try the same thing again/);
  });

  it("carries the refusal reason into the panel the operator actually reads", () => {
    // The reason has to appear in the PROMINENT panel, not only in the small
    // receipt line — otherwise the fix is cosmetic.
    expect(pendingRestoreNotice(pending({ receipt: refusal })).text).toContain(
      "teammate ada is no longer on this install",
    );
    expect(pendingRestoreNotice(pending({ receipt: blockedOnly })).text).toContain(
      "owner account no longer exists",
    );
  });

  it("still offers the two ways out when refused", () => {
    const n = pendingRestoreNotice(pending({ receipt: refusal }));
    expect(n.text).toMatch(/stage a fresh bundle/);
    expect(n.text).toMatch(/discard this one/);
  });

  it("goes back to promising the reopen once a later attempt commits", () => {
    // Receipts outlive their restore: a committed one must not permanently
    // suppress the reassuring branch.
    const n = pendingRestoreNotice(pending({ receipt: committed }));
    expect(n.reopenApplies).toBe(true);
    expect(n.text).toMatch(/Quit and reopen Muster to apply it/);
  });

  it("names the source and time so the operator can tell two staged restores apart", () => {
    expect(pendingRestoreNotice(pending()).text).toContain("google-drive");
  });

  it("has nothing to say when nothing is staged", () => {
    expect(pendingRestoreNotice(null)).toEqual({ reopenApplies: false, text: "" });
    expect(pendingRestoreNotice({ pending: null, receipt: refusal })).toEqual({ reopenApplies: false, text: "" });
  });
});
