// The durable adapter's own boundary: a real SQLite database, the real policy
// module, and no fake store anywhere in this file. What is under test is the
// wiring — that scope lives in SQL, that a swap is atomic, that a restart
// keeps a card, and that a row the account does not own is not reachable by
// forging what is inside it.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  followUpProposalSchema,
  proposeFollowUp,
  snoozeFollowUp,
  type FollowUpAuthority,
  type FollowUpProposal,
  type FollowUpProposalRequest,
} from "./follow-up-proposals.ts";
import { createFollowUpStore } from "./follow-up-store.ts";

const OWNER: FollowUpAuthority = { ownerId: "alice", workspaceId: "workspace-alice" };
const OTHER_OWNER: FollowUpAuthority = { ownerId: "bob", workspaceId: "workspace-bob" };
const NOW = Date.parse("2026-09-29T09:00:00Z");
const MEETING = {
  id: "event-a",
  summary: "Quarterly planning",
  start: "2026-09-29T14:00:00+02:00",
  end: "2026-09-29T15:00:00+02:00",
  allDay: false,
  busy: true,
};
const EXPLANATION = {
  title: "Prepare for the 14:00 meeting?",
  whyNow: "The meeting is two hours away and the matching task is still open.",
  proposedOutput: "A short brief: agenda, open questions, and what to decide.",
  missingFacts: ["Attendee list"],
  observedFacts: ["A busy 14:00 event exists on the selected calendar"],
  inferredFacts: ["The open task probably belongs to this meeting"],
};

function requestFor(authority: FollowUpAuthority = OWNER, now = NOW): FollowUpProposalRequest {
  return {
    authority,
    origin: { botId: "bot-1", threadId: "thread-1" },
    proposalType: "meeting-preparation",
    task: {
      taskId: "task-7",
      ownerId: authority.ownerId,
      workspaceId: authority.workspaceId,
      origin: { botId: "bot-1", threadId: "thread-1" },
      status: "active",
    },
    observation: {
      providerAccountId: "provider-account-1",
      calendarId: "primary",
      requestedDate: "2026-09-29",
      timeZone: "Europe/Rome",
      grantReference: "grant-ref-1",
      grantGeneration: 4,
      observedAt: now - 60_000,
      completeness: "complete",
      status: "active",
      events: [MEETING],
    },
    evidenceEventIds: ["event-a"],
    explanation: EXPLANATION,
    freshForMs: 4 * 60 * 60 * 1000,
    capability: "available",
    now,
  };
}

function proposed(authority: FollowUpAuthority = OWNER, now = NOW, handle: DatabaseSync = db): FollowUpProposal {
  const outcome = proposeFollowUp(createFollowUpStore(handle), requestFor(authority, now));
  expect(outcome.status).toBe("proposed");
  if (outcome.status !== "proposed") throw new Error("propose did not produce a card");
  return outcome.proposal;
}

let directory = "";
let db: DatabaseSync;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "omb-follow-up-store-"));
  db = new DatabaseSync(":memory:");
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE "user" (id TEXT PRIMARY KEY);
    INSERT INTO "user" VALUES ('alice'), ('bob');`);
});

afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("durable follow-up proposal store", () => {
  it("persists a card and reads it back through a fresh adapter", () => {
    const card = proposed();
    expect(createFollowUpStore(db).load(OWNER, card.proposalId)).toBe(JSON.stringify(card));
  });

  it("keeps scope in SQL: another account and another workspace cannot read it", () => {
    const card = proposed();
    const store = createFollowUpStore(db);
    expect(store.load(OTHER_OWNER, card.proposalId)).toBeNull();
    expect(store.load({ ...OWNER, workspaceId: "workspace-bob" }, card.proposalId)).toBeNull();
    expect(store.listForAuthority(OTHER_OWNER, {})).toEqual([]);
    expect(store.listForAuthority({ ...OWNER, workspaceId: "workspace-bob" }, {})).toEqual([]);
    expect(store.listForAuthority(OWNER, {})).toHaveLength(1);
  });

  it("refuses to store or swap a row whose own columns claim another account", () => {
    const store = createFollowUpStore(db);
    const card = proposed();
    // A serialized row that names someone else is not that caller's row. The
    // adapter refuses the write instead of trusting the columns in the body.
    const forged = JSON.stringify({ ...card, ownerId: "bob" });
    expect(store.insert(OWNER, forged)).toBe("rolled-back");
    expect(store.insert(OTHER_OWNER, forged)).toBe("rolled-back");
    // A swap may only advance the row it named, by exactly one revision.
    expect(store.compareAndSwap(OWNER, card.proposalId, card.revision, JSON.stringify({ ...card, revision: 5 })))
      .toBe("rolled-back");
    expect(store.compareAndSwap(OWNER, "someone-elses-card", card.revision, JSON.stringify({ ...card, revision: 2 })))
      .toBe("rolled-back");
    expect(store.load(OWNER, card.proposalId)).toBe(JSON.stringify(card));
  });

  it("advances a revision exactly once and refuses a stale one", () => {
    const card = proposed();
    const store = createFollowUpStore(db);
    const first = snoozeFollowUp(store, {
      authority: OWNER, proposalId: card.proposalId, expectedRevision: card.revision,
      snoozeForMs: 30 * 60_000, now: NOW,
    });
    expect(first.status).toBe("snoozed");
    // A second writer holding the revision it read is told the row moved.
    const stale = snoozeFollowUp(store, {
      authority: OWNER, proposalId: card.proposalId, expectedRevision: card.revision,
      snoozeForMs: 15 * 60_000, now: NOW,
    });
    expect(stale).toEqual({ status: "rejected", reason: "revision-conflict" });
    const stored = followUpProposalSchema.parse(JSON.parse(store.load(OWNER, card.proposalId) ?? ""));
    expect(stored.revision).toBe(2);
    expect(stored.control.status).toBe("snoozed");
    expect(stored.control.snoozedUntil).toBe(NOW + 30 * 60_000);
  });

  it("lets one of two competing swaps win and reports the other as a conflict", () => {
    const card = proposed();
    const store = createFollowUpStore(db);
    const results = [
      store.compareAndSwap(OWNER, card.proposalId, 1, JSON.stringify({
        ...card, revision: 2, control: { ...card.control, status: "dismissed", dismissedAt: NOW },
      })),
      store.compareAndSwap(OWNER, card.proposalId, 1, JSON.stringify({
        ...card, revision: 2, control: { ...card.control, status: "snoozed", snoozedUntil: NOW + 60_000 },
      })),
    ].sort();
    expect(results).toEqual(["committed", "rolled-back"]);
    const stored = followUpProposalSchema.parse(JSON.parse(store.load(OWNER, card.proposalId) ?? ""));
    expect(stored.revision).toBe(2);
  });

  it("scopes the same source to two accounts without either seeing the other", () => {
    const mine = proposed(OWNER);
    const theirs = proposed(OTHER_OWNER);
    // Dedupe identity is authority-scoped, so one source is one card per
    // account: two rows, two ids, and no shared row to argue over.
    expect(theirs.proposalId).not.toBe(mine.proposalId);
    const store = createFollowUpStore(db);
    expect(store.listForAuthority(OWNER, {}).map(row => followUpProposalSchema.parse(JSON.parse(row)).ownerId))
      .toEqual(["alice"]);
    expect(store.listForAuthority(OTHER_OWNER, {}).map(row => followUpProposalSchema.parse(JSON.parse(row)).ownerId))
      .toEqual(["bob"]);
    expect(store.load(OWNER, theirs.proposalId)).toBeNull();
    expect(store.load(OTHER_OWNER, mine.proposalId)).toBeNull();
  });

  it("narrows a list by source and proposal type without hiding a live card", () => {
    const card = proposed();
    const store = createFollowUpStore(db);
    expect(store.listForAuthority(OWNER, { sourceKey: card.evidence.sourceKey })).toHaveLength(1);
    expect(store.listForAuthority(OWNER, { sourceKey: "some-other-source" })).toEqual([]);
    expect(store.listForAuthority(OWNER, { proposalType: "meeting-preparation" })).toHaveLength(1);
    expect(store.listForAuthority(OWNER, { sourceKey: card.evidence.sourceKey, proposalType: "meeting-preparation" }))
      .toHaveLength(1);
  });

  it("does not duplicate a card when the module replays the same request", () => {
    const card = proposed();
    const replay = proposeFollowUp(createFollowUpStore(db), requestFor(OWNER, NOW));
    expect(replay.status).toBe("duplicate");
    if (replay.status !== "duplicate") throw new Error("replay was not a duplicate");
    expect(replay.proposal.proposalId).toBe(card.proposalId);
    expect(createFollowUpStore(db).listForAuthority(OWNER, {})).toHaveLength(1);
  });

  it("returns null and an empty list for an account that has no scope to state", () => {
    const store = createFollowUpStore(db);
    proposed();
    expect(store.load({ ownerId: "", workspaceId: "" }, "fup_anything")).toBeNull();
    expect(store.listForAuthority({ ownerId: "", workspaceId: "" }, {})).toEqual([]);
  });

  it("refuses a row it cannot read back, rather than storing an unindexable one", () => {
    const store = createFollowUpStore(db);
    expect(store.insert(OWNER, "{not json")).toBe("rolled-back");
    expect(store.insert(OWNER, JSON.stringify({ proposalId: "fup_x" }))).toBe("rolled-back");
    expect(store.insert(OWNER, JSON.stringify({ ...proposed(), evidence: {} }))).toBe("rolled-back");
    expect(createFollowUpStore(db).listForAuthority(OWNER, {})).toHaveLength(1);
  });

  it("survives a restart: a new handle over the same file sees the durable card", () => {
    const path = join(directory, "auth.db");
    const first = new DatabaseSync(path);
    first.exec(`CREATE TABLE "user" (id TEXT PRIMARY KEY); INSERT INTO "user" VALUES ('alice'), ('bob');`);
    const card = proposed(OWNER, NOW, first);
    const snoozed = snoozeFollowUp(createFollowUpStore(first), {
      authority: OWNER, proposalId: card.proposalId, expectedRevision: card.revision,
      snoozeForMs: 30 * 60_000, now: NOW,
    });
    expect(snoozed.status).toBe("snoozed");
    first.close();

    const reopened = new DatabaseSync(path);
    try {
      const store = createFollowUpStore(reopened);
      const stored = followUpProposalSchema.parse(JSON.parse(store.load(OWNER, card.proposalId) ?? ""));
      expect(stored.control.status).toBe("snoozed");
      expect(stored.revision).toBe(2);
      expect(store.load(OTHER_OWNER, card.proposalId)).toBeNull();
    } finally {
      reopened.close();
    }
  });

  it("drops a card when its account is deleted", () => {
    const card = proposed();
    db.exec(`DELETE FROM "user" WHERE id = 'alice'`);
    expect(createFollowUpStore(db).load(OWNER, card.proposalId)).toBeNull();
  });
});
