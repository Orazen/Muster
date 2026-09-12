import { describe, expect, it } from "vitest";

import { PeerCapabilities, type PeerLease, type PeerLeaseContext } from "./peer-capabilities.ts";

const SOURCE: PeerLeaseContext = {
  botId: "bot-a", threadId: "detached-task-thread", taskId: "task-a", ownerId: "owner-a", depth: 0,
};
const INSTANCE = "owned-instance";

function rig() {
  let now = 10_000;
  const expired: PeerLease[] = [];
  const capabilities = new PeerCapabilities(() => now, 1_000, (lease) => { expired.push(lease); });
  return { capabilities, expired, advance: (ms: number) => { now += ms; } };
}

function activate(capabilities: PeerCapabilities, lease: PeerLease) {
  const token = capabilities.activate(lease, INSTANCE, true);
  if (!token) throw new Error("Expected a peer-enabled dispatch token");
  return `Bearer ${token}`;
}

function event(type: string, turnId?: string, threadId = SOURCE.threadId, providerInstanceId = INSTANCE) {
  return { type, threadId, providerInstanceId, turnId };
}

describe("PeerCapabilities", () => {
  it("captures an immutable detached-task identity without issuing a preparing token", () => {
    const { capabilities } = rig();
    const context = { ...SOURCE };
    const lease = capabilities.begin(context);
    context.threadId = "newly-displayed-thread";
    context.ownerId = "different-owner";
    expect(lease).toMatchObject(SOURCE);
    expect(Object.isFrozen(lease)).toBe(true);
    expect(capabilities.current(lease)).toBe(true);
    expect(capabilities.forBot(SOURCE.botId)).toBe(lease);
    expect(capabilities.resolve(`Bearer ${"a".repeat(64)}`)).toBeUndefined();
    capabilities.onEvent(event("turn.started", "not-yet-dispatched"));
    capabilities.onEvent(event("turn.completed", "not-yet-dispatched"));
    expect(capabilities.current(lease)).toBe(true);
  });

  it("activates one token for the captured identity and refuses repeat activation", () => {
    const { capabilities } = rig();
    const lease = capabilities.begin(SOURCE);
    const header = activate(capabilities, lease);
    expect(header).toMatch(/^Bearer [a-f0-9]{64}$/);
    expect(capabilities.resolve(header)).toBe(lease);
    expect(() => capabilities.activate(lease, "replacement-instance", true)).toThrow("already activated");
    expect(capabilities.resolve(header)).toBe(lease);
  });

  it("tracks a depth-denied dispatch without issuing a token or later upgrading it", () => {
    const { capabilities } = rig();
    const lease = capabilities.begin({ ...SOURCE, depth: 1 });
    expect(capabilities.activate(lease, INSTANCE, false)).toBeUndefined();
    expect(capabilities.current(lease)).toBe(true);
    expect(() => capabilities.activate(lease, INSTANCE, true)).toThrow("already activated");
    capabilities.onEvent(event("turn.started", "depth-one-turn"));
    capabilities.onEvent(event("turn.completed", "depth-one-turn"));
    expect(capabilities.forBot(SOURCE.botId)).toBeUndefined();
  });

  it("does not issue a depth-one token even if the integration caller enables peers", () => {
    const { capabilities } = rig();
    const lease = capabilities.begin({ ...SOURCE, depth: 1 });
    expect(capabilities.activate(lease, INSTANCE, true)).toBeUndefined();
    expect(capabilities.current(lease)).toBe(true);
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])("rejects invalid dispatch depth %s without replacing an existing lease", (depth) => {
    const { capabilities } = rig();
    const current = capabilities.begin(SOURCE);
    const header = activate(capabilities, current);
    expect(() => capabilities.begin({ ...SOURCE, depth })).toThrow();
    expect(capabilities.resolve(header)).toBe(current);
  });

  it("replaces the bot lease across task selection and invalidates its old token", () => {
    const { capabilities } = rig();
    const old = capabilities.begin(SOURCE);
    const oldHeader = activate(capabilities, old);
    const newer = capabilities.begin({ ...SOURCE, threadId: "other-task-thread", taskId: "other-task" });
    const newerHeader = activate(capabilities, newer);
    expect(newer.id).not.toBe(old.id);
    expect(newerHeader).not.toBe(oldHeader);
    expect(capabilities.resolve(oldHeader)).toBeUndefined();
    expect(capabilities.current(old)).toBe(false);
    expect(capabilities.forBot(SOURCE.botId)).toBe(newer);
    capabilities.revokeThread(SOURCE.threadId);
    expect(capabilities.resolve(newerHeader)).toBe(newer);
  });

  it("cannot resurrect a replaced preparing lease by activating it late", () => {
    const { capabilities } = rig();
    const old = capabilities.begin(SOURCE);
    const newer = capabilities.begin(SOURCE);
    expect(() => capabilities.activate(old, INSTANCE, true)).toThrow("no longer current");
    expect(capabilities.forBot(SOURCE.botId)).toBe(newer);
  });

  it("keeps other bots active when one lease is replaced or revoked", () => {
    const { capabilities } = rig();
    const first = capabilities.begin(SOURCE);
    const firstHeader = activate(capabilities, first);
    const other = capabilities.begin({ ...SOURCE, botId: "bot-b", threadId: "thread-b", taskId: "task-b" });
    const otherHeader = activate(capabilities, other);
    capabilities.begin(SOURCE);
    capabilities.revokeBot(SOURCE.botId);
    expect(capabilities.resolve(firstHeader)).toBeUndefined();
    expect(capabilities.resolve(otherHeader)).toBe(other);
  });

  it("expires at the exact deadline without sliding expiry on token use", () => {
    const { capabilities, advance } = rig();
    const lease = capabilities.begin(SOURCE);
    const header = activate(capabilities, lease);
    advance(999);
    expect(capabilities.resolve(header)).toBe(lease);
    advance(1);
    expect(capabilities.resolve(header)).toBeUndefined();
    expect(capabilities.current(lease)).toBe(false);
    expect(capabilities.forBot(SOURCE.botId)).toBeUndefined();
    expect(() => capabilities.activate(lease, INSTANCE, true)).toThrow("no longer current");
  });

  it("expires preparing leases before they can be activated", () => {
    const { capabilities, advance } = rig();
    const lease = capabilities.begin(SOURCE);
    advance(1_000);
    expect(() => capabilities.activate(lease, INSTANCE, true)).toThrow("no longer current");
    expect(capabilities.forBot(SOURCE.botId)).toBeUndefined();
  });

  it("an old expiry check cannot remove a newer bot lease", () => {
    const { capabilities, advance } = rig();
    const old = capabilities.begin(SOURCE);
    const oldHeader = activate(capabilities, old);
    advance(500);
    const newer = capabilities.begin(SOURCE);
    const newerHeader = activate(capabilities, newer);
    advance(500);
    expect(capabilities.current(old)).toBe(false);
    expect(capabilities.resolve(oldHeader)).toBeUndefined();
    expect(capabilities.resolve(newerHeader)).toBe(newer);
  });

  it.each(["turn.completed", "session.exited"])("synchronous started then %s revokes the exact token before dispatch return", (terminal) => {
    const { capabilities } = rig();
    const lease = capabilities.begin(SOURCE);
    const header = activate(capabilities, lease);
    capabilities.onEvent(event("turn.started", "turn-a"));
    expect(capabilities.onEvent(event(terminal, "turn-a"))).toBe(lease);
    expect(capabilities.resolve(header)).toBeUndefined();
    expect(capabilities.onEvent(event(terminal, "turn-a"))).toBeUndefined();
    // The adapter can return its turn ID after already publishing completion.
    capabilities.bindTurn(lease, INSTANCE, "turn-a");
    expect(capabilities.current(lease)).toBe(false);
    expect(capabilities.forBot(SOURCE.botId)).toBeUndefined();
  });

  it.each([false, true])("expired completion never authorizes queue drain and reports expiry once (resolved first: %s)", (resolveFirst) => {
    const { capabilities, expired, advance } = rig();
    const lease = capabilities.begin(SOURCE);
    const header = activate(capabilities, lease);
    capabilities.onEvent(event("turn.started", "expiring-turn"));
    advance(1_000);
    if (resolveFirst) expect(capabilities.resolve(header)).toBeUndefined();
    expect(capabilities.onEvent(event("turn.completed", "expiring-turn"))).toBeUndefined();
    expect(expired).toEqual([lease]);
    expect(capabilities.resolve(header)).toBeUndefined();
    expect(capabilities.current(lease)).toBe(false);
    expect(capabilities.onEvent(event("session.exited", "expiring-turn"))).toBeUndefined();
    expect(expired).toEqual([lease]);
  });

  it("normal completion, explicit retirement and replacement do not report lease expiry", () => {
    const { capabilities, expired } = rig();
    const completed = capabilities.begin(SOURCE);
    activate(capabilities, completed);
    capabilities.onEvent(event("turn.started", "completed-turn"));
    expect(capabilities.onEvent(event("turn.completed", "completed-turn"))).toBe(completed);
    capabilities.revoke(capabilities.begin(SOURCE));
    capabilities.begin(SOURCE);
    capabilities.begin(SOURCE);
    capabilities.clear();
    expect(expired).toEqual([]);
  });

  it("late old callbacks cannot revoke or bind over a replacement on the same thread", () => {
    const { capabilities } = rig();
    const old = capabilities.begin(SOURCE);
    activate(capabilities, old);
    capabilities.onEvent(event("turn.started", "turn-old"));
    capabilities.onEvent(event("turn.completed", "turn-old"));
    const newer = capabilities.begin(SOURCE);
    const newerHeader = activate(capabilities, newer);
    capabilities.onEvent(event("turn.started", "turn-new"));
    capabilities.bindTurn(old, INSTANCE, "turn-old");
    capabilities.revoke(old);
    capabilities.revokeThread(SOURCE.threadId, "turn-old");
    capabilities.onEvent(event("turn.started", "turn-old"));
    capabilities.onEvent(event("turn.completed", "turn-old"));
    capabilities.onEvent(event("session.exited", "turn-old"));
    expect(capabilities.resolve(newerHeader)).toBe(newer);
    capabilities.onEvent(event("turn.completed", "turn-new"));
    expect(capabilities.resolve(newerHeader)).toBeUndefined();
  });

  it.each(["turn.completed", "session.exited"])("ignores absent or different turn IDs on %s", (terminal) => {
    const { capabilities } = rig();
    const lease = capabilities.begin(SOURCE);
    const header = activate(capabilities, lease);
    // A terminal event alone cannot establish the identity it is revoking.
    capabilities.onEvent(event(terminal, "turn-old"));
    capabilities.onEvent(event("turn.started", "turn-new"));
    capabilities.onEvent(event(terminal));
    capabilities.onEvent(event(terminal, ""));
    capabilities.onEvent(event(terminal, "turn-old"));
    expect(capabilities.resolve(header)).toBe(lease);
  });

  it("ignores wrong instance, absent instance and wrong thread events", () => {
    const { capabilities } = rig();
    const lease = capabilities.begin(SOURCE);
    const header = activate(capabilities, lease);
    capabilities.bindTurn(lease, "other-instance", "other-turn");
    capabilities.onEvent(event("turn.started", "other-turn", SOURCE.threadId, "other-instance"));
    capabilities.onEvent({ type: "turn.started", threadId: SOURCE.threadId, turnId: "other-turn" });
    capabilities.onEvent(event("turn.completed", "other-turn"));
    expect(capabilities.resolve(header)).toBe(lease);
    capabilities.onEvent(event("turn.started", "current-turn"));
    capabilities.onEvent(event("turn.completed", "current-turn", SOURCE.threadId, "other-instance"));
    capabilities.onEvent(event("session.exited", "current-turn", "other-thread"));
    capabilities.onEvent({ type: "turn.completed", threadId: SOURCE.threadId, turnId: "current-turn" });
    expect(capabilities.resolve(header)).toBe(lease);
    capabilities.onEvent(event("turn.completed", "current-turn"));
    expect(capabilities.resolve(header)).toBeUndefined();
  });

  it("ignores unrelated events and never overwrites an already-bound turn", () => {
    const { capabilities } = rig();
    const lease = capabilities.begin(SOURCE);
    const header = activate(capabilities, lease);
    capabilities.bindTurn(lease, INSTANCE, undefined);
    capabilities.bindTurn(lease, INSTANCE, "current-turn");
    capabilities.bindTurn(lease, INSTANCE, "different-turn");
    capabilities.onEvent(event("request.resolved", "current-turn"));
    capabilities.onEvent(event("content.delta", "current-turn"));
    capabilities.onEvent(event("turn.completed", "different-turn"));
    expect(capabilities.resolve(header)).toBe(lease);
    capabilities.onEvent(event("turn.completed", "current-turn"));
    expect(capabilities.resolve(header)).toBeUndefined();
  });

  it("revocation is idempotent and cannot re-enable a retired capability", () => {
    const { capabilities } = rig();
    const lease = capabilities.begin(SOURCE);
    const header = activate(capabilities, lease);
    capabilities.revoke(lease);
    capabilities.revoke(lease);
    capabilities.revokeBot(SOURCE.botId);
    capabilities.revokeThread(SOURCE.threadId);
    capabilities.onEvent(event("turn.started", "late-turn"));
    expect(capabilities.resolve(header)).toBeUndefined();
    expect(() => capabilities.activate(lease, INSTANCE, true)).toThrow("no longer current");
  });

  it("clear retires preparing and active leases without affecting a later dispatch", () => {
    const { capabilities } = rig();
    const old = capabilities.begin(SOURCE);
    const header = activate(capabilities, old);
    const preparing = capabilities.begin({ ...SOURCE, botId: "bot-b", threadId: "thread-b" });
    capabilities.clear();
    capabilities.clear();
    expect(capabilities.resolve(header)).toBeUndefined();
    expect(capabilities.current(preparing)).toBe(false);
    const replacement = capabilities.begin(SOURCE);
    const replacementHeader = activate(capabilities, replacement);
    capabilities.onEvent(event("turn.started", "new-turn"));
    capabilities.revoke(old);
    capabilities.bindTurn(old, INSTANCE, "old-turn");
    capabilities.onEvent(event("turn.completed", "old-turn"));
    expect(capabilities.resolve(replacementHeader)).toBe(replacement);
  });

  it("a fresh process registry never accepts a previous registry's credential", () => {
    const previous = new PeerCapabilities();
    const lease = previous.begin(SOURCE);
    const header = activate(previous, lease);
    const next = new PeerCapabilities();
    expect(next.resolve(header)).toBeUndefined();
    expect(next.forBot(SOURCE.botId)).toBeUndefined();
  });

  it("requires the actual lease object for captured control operations", () => {
    const { capabilities } = rig();
    const lease = capabilities.begin(SOURCE);
    const header = activate(capabilities, lease);
    const reconstructed = { ...lease };
    expect(capabilities.current(reconstructed)).toBe(false);
    capabilities.revoke(reconstructed);
    expect(() => capabilities.activate(reconstructed, INSTANCE, true)).toThrow("no longer current");
    expect(capabilities.resolve(header)).toBe(lease);
  });

  const malformed: Array<{ name: string; alter: (header: string) => string | string[] | undefined }> = [
    { name: "absent", alter: () => undefined },
    { name: "empty", alter: () => "" },
    { name: "multiple values", alter: (header) => [header] },
    { name: "boot-sized token", alter: (header) => header.slice(0, 55) },
    { name: "wrong scheme case", alter: (header) => header.replace("Bearer", "bearer") },
    { name: "leading whitespace", alter: (header) => ` ${header}` },
    { name: "trailing whitespace", alter: (header) => `${header} ` },
    { name: "extra separator", alter: (header) => header.replace("Bearer ", "Bearer  ") },
    { name: "non-hex token", alter: () => `Bearer ${"z".repeat(64)}` },
    { name: "upper-case hex", alter: () => `Bearer ${"A".repeat(64)}` },
    { name: "overlong token", alter: (header) => `${header}a` },
  ];
  it.each(malformed)("rejects $name header without retiring the current dispatch", ({ alter }) => {
    const { capabilities } = rig();
    const lease = capabilities.begin(SOURCE);
    const goodHeader = activate(capabilities, lease);
    expect(capabilities.resolve(alter(goodHeader))).toBeUndefined();
    expect(capabilities.resolve(goodHeader)).toBe(lease);
  });
});
