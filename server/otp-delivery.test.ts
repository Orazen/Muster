// The delivery-outcome slot's own invariants, on an injected clock.
//
// This module is the one piece of A1 with no reader of its own: the sign-in
// send policy is its only consumer, and it consumes-and-clears. So its failure
// modes are quiet — an entry nobody reads (a slow leak) or an entry read by
// the wrong request (a false delivery verdict). Neither shows up as a failure
// anywhere else, which is why they are pinned here directly.
//
// The regression that motivated the cap: better-auth invokes the same sender
// for `email-verification` and `forget-password` codes, on routes the send
// policy never sees. Recording those left a verdict with no reader, which then
// survived until its TTL to be misread by the next sign-in send for that
// mailbox. `sendLoginCodeEmail` now records only the sign-in type; the cap
// below is the second line of defence, so a future caller that forgets cannot
// leak silently either.
import { afterEach, describe, expect, it } from "vitest";

import {
  clearDelivery,
  clearDeliveryFor,
  deliveryKey,
  deliveryOutcome,
  deliveryOutcomeFor,
  deliverySlotCount,
  mailTransportFailing,
  recordDelivery,
  recordDeliveryFor,
  resetDeliveries,
  shouldRecordDelivery,
} from "./otp-delivery.ts";

const MAX_TRACKED = 1_000;

afterEach(() => resetDeliveries());

describe("which code kinds are recorded", () => {
  it("records only the kind the send policy comes back for", () => {
    // The rule, stated once. The send policy wraps only the sign-in send, so
    // every other kind the plugin can request writes a verdict nobody reads.
    // Two of those routes (/request-password-reset, /request-email-change) sit
    // outside the wrapper entirely and need no configuration, so this is not a
    // theoretical path.
    expect(shouldRecordDelivery("sign-in")).toBe(true);
    expect(shouldRecordDelivery("email-verification")).toBe(false);
    expect(shouldRecordDelivery("forget-password")).toBe(false);
    expect(shouldRecordDelivery("change-email")).toBe(false);
  });

  it("leaves nothing behind when a non-reconciled kind is not recorded", () => {
    // The leak itself: past the cap the map is bounded (asserted below), but
    // the honest fix is to never write. Simulated here the way the sender
    // does it, so the invariant is pinned without standing up a mailer.
    recordDelivery("leaky@example.test", { ok: true });
    expect(deliverySlotCount()).toBe(1);
    clearDelivery("leaky@example.test");
    expect(deliverySlotCount()).toBe(0);
  });
});

describe("delivery outcome slot", () => {
  it("normalizes the mailbox so both sides agree on the key", () => {
    // The plugin lowercases the address and the send policy trims it, so the
    // key has to absorb both or the reader misses the writer's verdict.
    expect(deliveryKey("  User@Example.TEST ")).toBe("user@example.test");
    recordDelivery(" User@Example.TEST ", { ok: false, reason: "rejected", status: 422 });
    expect(deliveryOutcome("user@example.test")).toEqual({ ok: false, reason: "rejected", status: 422 });
  });

  it("reports absent rather than inventing a verdict", () => {
    expect(deliveryOutcome("never-seen@example.test")).toBeUndefined();
  });

  it("keeps a verdict readable until it is explicitly cleared", () => {
    // Reading must not consume: the policy reads once and then clears, and a
    // send refused twice has to report the same reason both times.
    recordDelivery("a@example.test", { ok: false, reason: "transport" });
    expect(deliveryOutcome("a@example.test")).toEqual({ ok: false, reason: "transport" });
    expect(deliveryOutcome("a@example.test")).toEqual({ ok: false, reason: "transport" });
    expect(deliverySlotCount()).toBe(1);
    clearDelivery("a@example.test");
    expect(deliveryOutcome("a@example.test")).toBeUndefined();
    expect(deliverySlotCount()).toBe(0);
  });

  it("lets the newest verdict for one mailbox win", () => {
    // One mailbox has one send in flight, so the last word is the current one.
    recordDelivery("a@example.test", { ok: false, reason: "rejected", status: 500 });
    recordDelivery("a@example.test", { ok: true });
    expect(deliveryOutcome("a@example.test")).toEqual({ ok: true });
    expect(deliverySlotCount()).toBe(1);
  });

  it("bounds what it retains, dropping the oldest first", () => {
    // A leak here is invisible everywhere else, so the ceiling is asserted
    // directly: past the cap the oldest write goes, never the newest.
    for (let i = 0; i < MAX_TRACKED + 50; i += 1) {
      recordDelivery(`bulk-${i}@example.test`, { ok: true });
    }
    expect(deliverySlotCount()).toBe(MAX_TRACKED);
    expect(deliveryOutcome("bulk-0@example.test")).toBeUndefined();
    expect(deliveryOutcome("bulk-49@example.test")).toBeUndefined();
    // The most recent writes are the ones retained.
    expect(deliveryOutcome(`bulk-${MAX_TRACKED + 49}@example.test`)).toEqual({ ok: true });
  });

  it("keeps a password-reset verdict out of the sign-in slot", () => {
    // The reset wrapper and the sign-in send policy both read-and-clear by
    // mailbox. A shared bare key would let one route's answer decide the
    // other's — the exact cross-contamination the retention gate above was
    // written for, seen from the other side.
    recordDeliveryFor("password-reset", "a@example.test", { ok: false, reason: "rejected", status: 422 });
    expect(deliveryOutcome("a@example.test")).toBeUndefined();
    expect(deliveryOutcomeFor("password-reset", "a@example.test")).toEqual({ ok: false, reason: "rejected", status: 422 });
    clearDeliveryFor("password-reset", "a@example.test");
    expect(deliveryOutcomeFor("password-reset", "a@example.test")).toBeUndefined();
  });
});

describe("deployment transport verdict", () => {
  it("is address-free, so a refusal cannot be read back as a fact about one", () => {
    // The reason this is not stored per mailbox. The password-reset route
    // learns a send failed only by attempting one, and better-auth attempts
    // none for an address with no account — so a per-mailbox verdict would
    // give a different status to a registered address than to an unregistered
    // one, which is the account-existence oracle
    // src/pages/ForgotPasswordPage.tsx is written to refuse. Keyed on nothing,
    // every address reads the same transport state.
    expect(mailTransportFailing()).toBe(false);
    recordDeliveryFor("password-reset", "someone@example.test", { ok: false, reason: "transport" });
    expect(mailTransportFailing()).toBe(true);
  });

  it("clears on the first send that goes out", () => {
    // Otherwise the failure latches: every later request is refused and the
    // one attempt that could prove recovery is itself never made.
    recordDeliveryFor("password-reset", "a@example.test", { ok: false, reason: "transport" });
    expect(mailTransportFailing()).toBe(true);
    recordDeliveryFor("password-reset", "b@example.test", { ok: true });
    expect(mailTransportFailing()).toBe(false);
  });

  it("is set by a failure on either channel, since both share the transport", () => {
    recordDelivery("a@example.test", { ok: true });
    expect(mailTransportFailing()).toBe(false);
    recordDelivery("a@example.test", { ok: false, reason: "rejected", status: 500 });
    expect(mailTransportFailing()).toBe(true);
  });

  it("expires like a mailbox verdict rather than latching forever", () => {
    recordDeliveryFor("password-reset", "a@example.test", { ok: false, reason: "transport" });
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 60_001;
      expect(mailTransportFailing()).toBe(false);
    } finally {
      Date.now = realNow;
    }
  });

  it("expires a verdict rather than letting it outlive its usefulness", () => {
    // The TTL is what stops a verdict recorded for a request that died
    // between storing the code and recording the outcome from being read by an
    // unrelated later send. Asserted through the public read, with the clock
    // moved past OUTCOME_TTL_MS (60s).
    recordDelivery("a@example.test", { ok: true });
    expect(deliveryOutcome("a@example.test")).toEqual({ ok: true });
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 60_001;
      expect(deliveryOutcome("a@example.test")).toBeUndefined();
      // An expired read also drops the entry rather than leaving it to be
      // re-checked forever.
      expect(deliverySlotCount()).toBe(0);
    } finally {
      Date.now = realNow;
    }
  });
});
