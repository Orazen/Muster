// The route family's own boundary, over real HTTP, against the real durable
// adapter and the real policy module. What is under test is the wiring, not
// the policy: that a session is required even on loopback, that another
// account's card is indistinguishable from a card that never existed, that a
// deleted or orphaned plan is unavailable rather than authorized, that a
// browser cannot supply the source evidence, and that a read writes nothing.
//
// The source reader is a seam by design: a guarded Calendar read is a later
// slice. It is supplied here so the propose path can be exercised for real,
// and its absence is itself asserted.

import { DatabaseSync } from "node:sqlite";
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  followUpProposalSchema,
  type FollowUpObservation,
} from "./follow-up-proposals.ts";
import { handleFollowUpRoute, type FollowUpRouteContext, type FollowUpSourceRequest } from "./follow-up-routes.ts";
import type { JsonValue } from "./schema.ts";

const NOW = Date.parse("2026-09-29T09:00:00Z");
const SELECTION = { calendarId: "primary", date: "2026-09-29", timeZone: "Europe/Rome" };
const EVENT = {
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

let db: DatabaseSync;
let server: Server;
let origin: string;
let ctx: FollowUpRouteContext;
let session: { userId: string; sessionId: string } | null = { userId: "alice", sessionId: "alice-session" };
let readSource: FollowUpRouteContext["readSource"];
let sourceCalls: FollowUpSourceRequest[] = [];
/** The route's write budget is a fixed window on the server clock, so each
 * test starts a fresh window instead of inheriting the previous one's count. */
let clock = NOW;
let testOrdinal = 0;

function observation(overrides: Partial<FollowUpObservation> = {}): FollowUpObservation {
  return {
    providerAccountId: "provider-account-1",
    calendarId: SELECTION.calendarId,
    requestedDate: SELECTION.date,
    timeZone: SELECTION.timeZone,
    grantReference: "grant-ref-1",
    grantGeneration: 4,
    observedAt: NOW - 60_000,
    completeness: "complete",
    status: "active",
    events: [EVENT],
    ...overrides,
  };
}

beforeEach(async () => {
  db = new DatabaseSync(":memory:");
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE "user" (id TEXT PRIMARY KEY);
    CREATE TABLE "session" (id TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "activeOrganizationId" TEXT);
    CREATE TABLE "member" (id TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL, "userId" TEXT NOT NULL, "createdAt" TEXT NOT NULL);
    INSERT INTO "user" VALUES ('alice'), ('bob');
    INSERT INTO "session" VALUES ('alice-session', 'alice', 'org-alice'), ('bob-session', 'bob', 'org-bob');
    INSERT INTO "member" VALUES
      ('m1', 'org-alice', 'alice', '2026-01-01'), ('m2', 'org-bob', 'bob', '2026-01-01');`);
  session = { userId: "alice", sessionId: "alice-session" };
  clock = NOW + testOrdinal++ * 10 * 60_000;
  sourceCalls = [];
  readSource = async (request) => {
    sourceCalls.push(request);
    return { observation: observation(), explanation: EXPLANATION, capability: "unsupported" };
  };
  ctx = {
    db: () => db,
    session: async () => session,
    origin: "",
    now: () => clock,
    operator: () => "alice",
    readSource: (request) => readSource?.(request) ?? Promise.resolve(null),
    lookups: {
      plan: (id) => plans.get(id) ?? null,
      bot: (id) => bots.get(id) ?? null,
      taskByThread: (botId, threadId) => (threads.get(botId)?.has(threadId) ? { threadId } : null),
    },
  };
  server = createServer((req, res) => {
    void handleFollowUpRoute(req, res, req.method ?? "GET", new URL(req.url!, origin).pathname, ctx)
      .catch(() => { res.writeHead(500); res.end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = z.object({ port: z.number() }).parse(server.address());
  origin = `http://127.0.0.1:${address.port}`;
  ctx.origin = origin;
  ctx.readSource = (request) => readSource?.(request) ?? Promise.resolve(null);
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});

/** The fake host store: which plans, bots and threads still exist. Deleting
 * one is how the orphaned-plan cases are staged, and adding a second account's
 * records is how cross-account cases are staged. */
const plans = new Map<string, { id: string; botId: string; ownerId?: string; threadId?: string; status: string }>();
const bots = new Map<string, { id: string; ownerId?: string }>();
const threads = new Map<string, Set<string>>();

function ownPlan(planId: string, botId: string, threadId: string, ownerId: string): void {
  plans.set(planId, { id: planId, botId, ownerId, threadId, status: "running" });
  bots.set(botId, { id: botId, ownerId });
  const existing = threads.get(botId) ?? new Set<string>();
  existing.add(threadId);
  threads.set(botId, existing);
}

beforeEach(() => {
  plans.clear();
  bots.clear();
  threads.clear();
  ownPlan("plan-1", "bot-1", "thread-1", "alice");
});

const headersSchema = z.record(z.string(), z.string());
type TestHeaders = z.infer<typeof headersSchema>;

/** A request body as this suite builds it. The forged-evidence case nests a
 * whole observation in it, which is the point: the route must ignore that. */
type TestBody = Record<string, JsonValue>;

/** Round-trip a value through JSON so it is plain wire data, the shape a
 * browser would actually put on the wire. */
function asJson(value: FollowUpObservation | typeof EXPLANATION): JsonValue {
  return JSON.parse(JSON.stringify(value));
}

function requestHeaders(extra: TestHeaders = {}): TestHeaders {
  return { origin, "content-type": "application/json", ...extra };
}

function post(path: string, body: TestBody, extra: TestHeaders = {}) {
  return fetch(`${origin}${path}`, { method: "POST", headers: requestHeaders(extra), body: JSON.stringify(body) });
}

function propose(extra: Record<string, string> = {}) {
  return post("/api/follow-ups", { planId: "plan-1", ...SELECTION, evidenceEventIds: ["event-a"] }, extra);
}

async function createCard(): Promise<{ proposalId: string; revision: number }> {
  const response = await propose();
  expect(response.status).toBe(201);
  const body = z.object({ proposalId: z.string(), revision: z.number() })
    .parse(await response.json());
  return body;
}

/** Row count and the total change count SQLite has seen, so a read can be
 * shown to have written nothing at all. */
function changes(): number {
  return z.object({ total: z.number() }).parse(
    db.prepare("SELECT total_changes() AS total").get(),
  ).total;
}

describe("follow-up proposal HTTP family", () => {
  it("requires a real session even on a local server, and writes nothing", async () => {
    const before = changes();
    session = null;
    for (const response of await Promise.all([
      fetch(`${origin}/api/follow-ups`),
      fetch(`${origin}/api/follow-ups/fup_abcdefghijklmnop`),
      propose(),
    ])) {
      expect(response.status).toBe(401);
    }
    expect(changes()).toBe(before);
    expect(db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name = 'follow_up_proposals'").get())
      .toEqual({ count: 0 });
  });

  it("advertises its capability without a session and without leaking a card", async () => {
    const before = changes();
    session = null;
    const response = await fetch(`${origin}/api/follow-ups/status`);
    expect(await response.json()).toEqual({ available: true, requiresSignIn: true });
    expect(changes()).toBe(before);
  });

  it("refuses a mutation that is not an explicit same-origin request", async () => {
    const before = changes();
    for (const extra of [{}, { origin: "https://foreign.example" }]) {
      const response = await fetch(`${origin}/api/follow-ups`, {
        method: "POST", headers: extra, body: JSON.stringify({ planId: "plan-1" }),
      });
      expect(response.status).toBe(403);
    }
    expect(sourceCalls).toEqual([]);
    expect(changes()).toBe(before);
  });

  it("round trips a card through the real adapter, and a read writes nothing", async () => {
    const card = await createCard();
    // The card is durable, under this account's own workspace, and named by
    // the identity the server resolved rather than by the request.
    const stored = db.prepare("SELECT ownerId, workspaceId, proposalId FROM follow_up_proposals").all();
    expect(stored).toEqual([{ ownerId: "alice", workspaceId: "org-alice", proposalId: card.proposalId }]);
    const before = changes();
    const listed = z.object({ proposals: z.array(z.object({ proposalId: z.string(), effectiveStatus: z.string() })) })
      .parse(await (await fetch(`${origin}/api/follow-ups`)).json());
    expect(listed.proposals).toEqual([{ proposalId: card.proposalId, effectiveStatus: "proposed" }]);
    const read = z.object({ proposalId: z.string(), effectiveStatus: z.string() })
      .parse(await (await fetch(`${origin}/api/follow-ups/${card.proposalId}`)).json());
    expect(read).toEqual({ proposalId: card.proposalId, effectiveStatus: "proposed" });
    expect(changes()).toBe(before);
  });

  it("controls a card, and a second writer on the old revision is told it moved", async () => {
    const card = await createCard();
    const snoozed = await post(`/api/follow-ups/${card.proposalId}/snooze`, {
      expectedRevision: card.revision, snoozeForMs: 30 * 60_000,
    });
    expect(snoozed.status).toBe(200);
    const afterSnooze = z.object({ revision: z.number(), effectiveStatus: z.string(), proposal: z.unknown() })
      .parse(await snoozed.json());
    expect(afterSnooze.effectiveStatus).toBe("snoozed");
    expect(afterSnooze.revision).toBe(card.revision + 1);

    const stale = await post(`/api/follow-ups/${card.proposalId}/dismiss`, {
      expectedRevision: card.revision,
    });
    expect(stale.status).toBe(409);
    expect(z.object({ reason: z.string() }).parse(await stale.json()).reason).toBe("revision-conflict");

    const dismissed = await post(`/api/follow-ups/${card.proposalId}/dismiss`, {
      expectedRevision: afterSnooze.revision,
    });
    expect(dismissed.status).toBe(200);
    const row = z.object({ row: z.string() })
      .parse(db.prepare("SELECT row FROM follow_up_proposals WHERE proposalId = ?").get(card.proposalId));
    expect(followUpProposalSchema.parse(JSON.parse(row.row)).control.status).toBe("dismissed");
  });

  it("withdraws the source of a card the account owns, without being told a source", async () => {
    const card = await createCard();
    const response = await post(`/api/follow-ups/${card.proposalId}/withdraw`, {});
    expect(response.status).toBe(200);
    expect(z.object({ withdrawn: z.array(z.string()) }).parse(await response.json()).withdrawn)
      .toEqual([card.proposalId]);
    const read = z.object({ effectiveStatus: z.string() })
      .parse(await (await fetch(`${origin}/api/follow-ups/${card.proposalId}`)).json());
    expect(read.effectiveStatus).toBe("withdrawn");
  });

  it("gives another account the same answer for a card it does not own", async () => {
    const card = await createCard();
    const before = changes();
    session = { userId: "bob", sessionId: "bob-session" };
    expect((await fetch(`${origin}/api/follow-ups/${card.proposalId}`)).status).toBe(404);
    expect((await fetch(`${origin}/api/follow-ups`)).status).toBe(200);
    expect(await (await fetch(`${origin}/api/follow-ups`)).json()).toEqual({ proposals: [] });
    expect((await post(`/api/follow-ups/${card.proposalId}/dismiss`, { expectedRevision: card.revision })).status)
      .toBe(404);
    expect((await post(`/api/follow-ups/${card.proposalId}/snooze`, {
      expectedRevision: card.revision, snoozeForMs: 60_000,
    })).status).toBe(404);
    expect((await post(`/api/follow-ups/${card.proposalId}/withdraw`, {})).status).toBe(404);
    // A guessed or colliding id is answered exactly as an id that never existed.
    expect((await fetch(`${origin}/api/follow-ups/${card.proposalId}x`)).status).toBe(404);
    expect((await fetch(`${origin}/api/follow-ups/fup_0000000000000000`)).status).toBe(404);
    // Nothing of Alice's moved while Bob was asking.
    expect(changes()).toBe(before);
    const row = z.object({ row: z.string() })
      .parse(db.prepare("SELECT row FROM follow_up_proposals WHERE proposalId = ?").get(card.proposalId));
    expect(followUpProposalSchema.parse(JSON.parse(row.row)).control.status).toBe("proposed");
  });

  it("treats a deleted, orphaned or foreign plan as no such task", async () => {
    const before = changes();
    // The plan is gone.
    plans.delete("plan-1");
    expect((await propose()).status).toBe(404);
    ownPlan("plan-1", "bot-1", "thread-1", "alice");
    // The plan survives but its bot does not. This is the case index.ts's
    // ownsPlan calls owned; here it is the absence of the subject.
    bots.delete("bot-1");
    expect((await propose()).status).toBe(404);
    bots.set("bot-1", { id: "bot-1", ownerId: "alice" });
    // The plan's original thread is no longer a task of that bot.
    threads.set("bot-1", new Set());
    expect((await propose()).status).toBe(404);
    threads.set("bot-1", new Set(["thread-1"]));
    // A plan the caller does not own at all.
    expect((await post("/api/follow-ups", {
      planId: "plan-2", ...SELECTION, evidenceEventIds: ["event-a"],
    })).status).toBe(404);
    // A plan whose bot belongs to another account.
    ownPlan("plan-3", "bot-9", "thread-9", "bob");
    expect((await post("/api/follow-ups", {
      planId: "plan-3", ...SELECTION, evidenceEventIds: ["event-a"],
    })).status).toBe(404);
    // A plan that records an owner other than its bot's.
    plans.set("plan-4", { id: "plan-4", botId: "bot-1", ownerId: "bob", threadId: "thread-1", status: "running" });
    expect((await post("/api/follow-ups", {
      planId: "plan-4", ...SELECTION, evidenceEventIds: ["event-a"],
    })).status).toBe(404);
    expect(sourceCalls).toEqual([]);
    expect(changes()).toBe(before);
  });

  it("refuses a cancelled, succeeded or unrecognized plan state", async () => {
    const before = changes();
    for (const status of ["cancelled", "succeeded", "something-new"]) {
      ctx.lookups = {
        ...ctx.lookups,
        plan: (id) => (id === "plan-1"
          ? { id, botId: "bot-1", ownerId: "alice", threadId: "thread-1", status }
          : null),
      };
      expect((await propose()).status).toBe(404);
    }
    expect(sourceCalls).toEqual([]);
    expect(changes()).toBe(before);
  });

  it("maps the workspace from the account's own current membership, not the session claim", async () => {
    // Carol is a member of org-carol, but her session row names org-alice.
    // The deliberate mapping is her own organization: the session's claim is
    // not taken at face value, and no client may state the workspace.
    db.exec(`INSERT INTO "user" VALUES ('carol'), ('dave');
      INSERT INTO "session" VALUES ('carol-session', 'carol', 'org-alice'), ('dave-session', 'dave', 'org-dave');
      INSERT INTO "member" VALUES ('m3', 'org-carol', 'carol', '2026-01-01');`);
    ownPlan("plan-c", "bot-c", "thread-c", "carol");
    session = { userId: "carol", sessionId: "carol-session" };
    expect((await post("/api/follow-ups", {
      planId: "plan-c", ...SELECTION, evidenceEventIds: ["event-a"],
    })).status).toBe(201);
    expect(db.prepare("SELECT ownerId, workspaceId FROM follow_up_proposals").all())
      .toEqual([{ ownerId: "carol", workspaceId: "org-carol" }]);
    // Dave has no membership row at all, so there is nothing to scope to.
    session = { userId: "dave", sessionId: "dave-session" };
    expect((await fetch(`${origin}/api/follow-ups`)).status).toBe(404);
    // A membership that is removed stops being a workspace immediately.
    session = { userId: "alice", sessionId: "alice-session" };
    expect((await fetch(`${origin}/api/follow-ups`)).status).toBe(200);
    db.exec(`DELETE FROM "member" WHERE "userId" = 'alice'`);
    expect((await fetch(`${origin}/api/follow-ups`)).status).toBe(404);
  });

  it("never takes the source evidence from the request body", async () => {
    const before = changes();
    // A body that states its own observation, grant and explanation is not a
    // proposal: the reader owns every one of those fields.
    const forged = await post("/api/follow-ups", {
      planId: "plan-1", ...SELECTION, evidenceEventIds: ["event-a"],
      observation: asJson(observation({ grantGeneration: 99 })),
      explanation: asJson(EXPLANATION),
      capability: "available",
    });
    expect(forged.status).toBe(400);
    expect(sourceCalls).toEqual([]);
    expect(changes()).toBe(before);
  });

  it("reads the day that was asked for, and refuses a reader that read another", async () => {
    readSource = async (request) => {
      sourceCalls.push(request);
      return {
        observation: observation({ requestedDate: "2026-09-30" }),
        explanation: EXPLANATION,
        capability: "unsupported",
      };
    };
    ctx.readSource = (request) => readSource?.(request) ?? Promise.resolve(null);
    const before = changes();
    expect((await propose()).status).toBe(409);
    expect(sourceCalls).toHaveLength(1);
    expect(sourceCalls[0]?.task.origin).toEqual({ botId: "bot-1", threadId: "thread-1" });
    expect(changes()).toBe(before);
  });

  it("keeps the card inert: no accept route, and a card the owner cannot act on", async () => {
    const card = await createCard();
    expect((await post(`/api/follow-ups/${card.proposalId}/accept`, { expectedRevision: 1 })).status).toBe(404);
    expect((await post(`/api/follow-ups/${card.proposalId}/refresh`, { expectedRevision: 1 })).status).toBe(404);
    // Nothing in the card claims a runner acknowledged anything.
    const read = z.object({ proposal: z.object({ control: z.object({ capability: z.string(), intentId: z.null() }) }) })
      .parse(await (await fetch(`${origin}/api/follow-ups/${card.proposalId}`)).json());
    expect(read.proposal.control).toEqual({ capability: "unsupported", intentId: null });
  });

  it("does not write a card when no source reader is configured on this host", async () => {
    ctx.readSource = undefined;
    const before = changes();
    expect((await fetch(`${origin}/api/follow-ups/status`)).status).toBe(200);
    expect(await (await fetch(`${origin}/api/follow-ups/status`)).json())
      .toEqual({ available: false, requiresSignIn: true });
    expect((await propose()).status).toBe(503);
    expect(changes()).toBe(before);
  });

  it("re-checks the session across the source read and writes nothing when it changed", async () => {
    readSource = async (request) => {
      sourceCalls.push(request);
      // The account logs out, or another account takes over, while the
      // provider read is still in flight.
      session = { userId: "bob", sessionId: "bob-session" };
      return { observation: observation(), explanation: EXPLANATION, capability: "unsupported" };
    };
    ctx.readSource = (request) => readSource?.(request) ?? Promise.resolve(null);
    const before = changes();
    expect((await propose()).status).toBe(401);
    expect(changes()).toBe(before);
    // Nothing was stored, not even a table to store it in.
    expect(db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name = 'follow_up_proposals'").get())
      .toEqual({ count: 0 });
  });

  it("re-checks the session across a control body and writes nothing when it changed", async () => {
    const card = await createCard();
    let calls = 0;
    // The gate resolves Alice; the re-check after the body was read answers
    // Bob, because the account changed while the request was in flight.
    ctx.session = async () => {
      calls++;
      return calls === 1 ? { userId: "alice", sessionId: "alice-session" }
        : { userId: "bob", sessionId: "bob-session" };
    };
    const before = changes();
    const response = await post(`/api/follow-ups/${card.proposalId}/dismiss`, { expectedRevision: card.revision });
    expect(response.status).toBe(401);
    expect(changes()).toBe(before);
  });

  it("bounds a malformed or oversized body without touching the store", async () => {
    const before = changes();
    expect((await post("/api/follow-ups", { planId: "plan-1" })).status).toBe(400);
    expect((await post("/api/follow-ups", { planId: "plan-1", ...SELECTION, evidenceEventIds: [] })).status).toBe(400);
    expect((await post("/api/follow-ups", { planId: "plan-1", ...SELECTION, evidenceEventIds: ["e"], extra: 1 })).status)
      .toBe(400);
    expect((await post("/api/follow-ups/fup_abcdefghijklmnop/snooze", { expectedRevision: 1, snoozeForMs: 5 })).status)
      .toBe(404);
    const card = await createCard();
    expect((await post(`/api/follow-ups/${card.proposalId}/snooze`, {
      expectedRevision: card.revision, snoozeForMs: 30 * 24 * 60 * 60 * 1000,
    })).status).toBe(400);
    expect((await post(`/api/follow-ups/${card.proposalId}/dismiss`, { expectedRevision: 0 })).status).toBe(400);
    expect((await fetch(`${origin}/api/follow-ups/${card.proposalId}/accept`, { method: "DELETE" })).status).toBe(405);
    expect(changes()).toBe(before + 1);
  });

  it("caps how many changes one account may make in a window", async () => {
    const card = await createCard();
    let limited = 0;
    for (let attempt = 0; attempt < 40; attempt++) {
      const response = await post(`/api/follow-ups/${card.proposalId}/dismiss`, {
        expectedRevision: card.revision,
      });
      if (response.status === 429) {
        limited++;
        continue;
      }
      expect([200, 409]).toContain(response.status);
    }
    expect(limited).toBeGreaterThan(0);
  });
});
