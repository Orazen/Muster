import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CalendarEnrollmentRegistry, CALENDAR_ENROLLMENT_TTL_MS, type CalendarEnrollmentBinding } from "./calendar-enrollment.ts";
import type { CallScope } from "./foreground-call.ts";
import type { IssuedCalendarDeviceGrant } from "./calendar-device-grants.ts";

const scope: CallScope = { ownerId: "alice", botId: "bot", token: "a".repeat(64) };
const issued = (): IssuedCalendarDeviceGrant => ({ token: "b".repeat(64), grant: { id: randomUUID(), label: "Watch", calendarId: "selected", expiresAt: 90_000 } });
function fixture(ownerId = "alice") {
  const localScope = { ...scope, ownerId };
  let now = 1000;
  let active = true;
  let permissionActive = true;
  const binding: CalendarEnrollmentBinding = { ownerId, botId: "bot", threadId: "thread", callId: randomUUID(), callInstanceId: randomUUID(), callTokenHash: createHash("sha256").update(scope.token).digest("hex") };
  let currentInstance = binding.callInstanceId;
  const revoked: Array<{ owner: string; id: string }> = [];
  const registry = new CalendarEnrollmentRegistry({ now: () => now,
    assertCallCurrent: (value) => { if (!active || value.callInstanceId !== currentInstance) throw new Error("private call detail"); },
    revoke: (owner, id) => { revoked.push({ owner, id }); },
    isPermissionCurrent: () => permissionActive,
  });
  return { registry, binding, scope: localScope, revoked, start: (id = randomUUID()) => registry.start(localScope, binding, id),
    revokePermission: () => { permissionActive = false; },
    end: () => { active = false; }, replaceCall: () => { currentInstance = randomUUID(); return { ...binding, callInstanceId: currentInstance }; },
    advance: (ms: number) => { now += ms; } };
}
function deferred() {
  let resolve!: (value: IssuedCalendarDeviceGrant) => void;
  const promise = new Promise<IssuedCalendarDeviceGrant>(done => { resolve = done; });
  return { promise, resolve };
}

describe("Calendar call-bound enrollment", () => {
  it("issues an eight-character code, idempotent identical request and one pending enrollment per call", () => {
    const f = fixture(); const id = randomUUID(); const first = f.start(id);
    expect(first.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(first.id).toBe(id); expect(first.expiresAt).toBe(1000 + CALENDAR_ENROLLMENT_TTL_MS);
    expect(f.start(id)).toEqual(first);
    expect(() => f.start()).toThrow("already pending");
    expect(() => f.registry.start(f.scope, { ...f.binding, threadId: "other" }, id)).toThrow("already used");
    expect(JSON.stringify(f.registry)).not.toContain(scope.token);
  });
  it("browser inspect and approval return no grant token, hash, or raw call capability", async () => {
    const f = fixture(); const enrollment = f.start();
    const inspected = f.registry.inspect(enrollment.code, "alice");
    expect(Object.keys(inspected).sort()).toEqual(["botId", "callId", "expiresAt", "id", "state", "threadId"]);
    const grant = issued(); const approved = await f.registry.approve(enrollment.code, "alice", async () => grant);
    expect(approved.state).toBe("ready"); expect(JSON.stringify(approved)).not.toContain(grant.token);
    expect(f.registry.inspect(enrollment.code, "alice").state).toBe("ready");
    const delivery = f.registry.take(f.scope, enrollment.id, f.binding.callId);
    expect(delivery).toEqual({ enrollment: { ...approved, state: "consumed" }, issued: grant });
    expect(() => f.registry.take(f.scope, enrollment.id, f.binding.callId)).toThrow("no longer active");
    expect(f.revoked).toEqual([]);
  });
  it("requires the exact owner and call capability without burning a valid enrollment", () => {
    const f = fixture(); const enrollment = f.start();
    expect(() => f.registry.inspect(enrollment.code, "bob")).toThrow("not found");
    expect(() => f.registry.inspect("ZZZZZZZZ", "alice")).toThrow("not found");
    expect(() => f.registry.take({ ...f.scope, token: "c".repeat(64) }, enrollment.id, f.binding.callId)).toThrow("not found");
    expect(() => f.registry.cancel({ ...f.scope, ownerId: "bob" }, enrollment.id, f.binding.callId)).toThrow("not found");
    expect(f.registry.inspect(enrollment.code, "alice").state).toBe("waiting");
  });
  it("only literal local ownership allows an explicit different signed-in approving account", async () => {
    const f = fixture("local"); const enrollment = f.start(); const grant = issued();
    await f.registry.approve(enrollment.code, "signed-in-account", async () => grant);
    f.registry.cancel(f.scope, enrollment.id, f.binding.callId);
    expect(f.revoked).toEqual([{ owner: "signed-in-account", id: grant.grant.id }]);
    expect(() => f.registry.start({ ...f.scope, ownerId: null }, { ...f.binding, ownerId: null }, randomUUID())).toThrow("Invalid");
  });
  it("claims approval before awaiting and refuses duplicate or competing approvals", async () => {
    const f = fixture("local"); const enrollment = f.start(); const gate = deferred(); let count = 0;
    const pending = f.registry.approve(enrollment.code, "alice", () => { count++; return gate.promise; });
    await expect(f.registry.approve(enrollment.code, "bob", async () => issued())).rejects.toThrow("being approved");
    gate.resolve(issued()); await pending; expect(count).toBe(1);
    await expect(f.registry.approve(enrollment.code, "alice", async () => issued())).rejects.toThrow("already approved");
  });
  it.each(["cancel", "expire", "end", "replace"])("revokes exact newly issued permission after %s during approval", async action => {
    const f = fixture(); const enrollment = f.start(); const gate = deferred(); const grant = issued();
    const pending = f.registry.approve(enrollment.code, "alice", () => gate.promise);
    if (action === "cancel") f.registry.cancel(f.scope, enrollment.id, f.binding.callId);
    else if (action === "expire") { f.advance(CALENDAR_ENROLLMENT_TTL_MS); f.registry.sweep(); }
    else if (action === "replace") f.replaceCall();
    else f.end();
    gate.resolve(grant); await expect(pending).rejects.toThrow();
    expect(f.revoked).toEqual([{ owner: "alice", id: grant.grant.id }]);
    expect(() => f.registry.take(f.scope, enrollment.id, f.binding.callId)).toThrow();
  });
  it("expiry cleans unconsumed grants, but never revokes already delivered permission", async () => {
    const f = fixture(); const first = f.start(); const grant = issued();
    await f.registry.approve(first.code, "alice", async () => grant);
    f.advance(CALENDAR_ENROLLMENT_TTL_MS); f.registry.sweep();
    expect(f.revoked).toEqual([{ owner: "alice", id: grant.grant.id }]);
    const second = f.start(); const delivered = issued(); await f.registry.approve(second.code, "alice", async () => delivered);
    f.registry.take(f.scope, second.id, f.binding.callId); f.advance(CALENDAR_ENROLLMENT_TTL_MS); f.registry.sweep();
    expect(f.revoked).toHaveLength(1);
  });
  it("same call id and token cannot attach an enrollment from a previous call instance", async () => {
    const f = fixture(); const enrollment = f.start(); const grant = issued();
    await f.registry.approve(enrollment.code, "alice", async () => grant);
    const replacement = f.replaceCall();
    expect(() => f.registry.take(f.scope, enrollment.id, f.binding.callId)).toThrow("no longer current");
    expect(f.revoked).toEqual([{ owner: "alice", id: grant.grant.id }]);
    expect(() => f.registry.start(f.scope, replacement, enrollment.id)).toThrow("already used");
    expect(f.registry.start(f.scope, replacement, randomUUID()).state).toBe("waiting");
  });
  it("bounds failed code guesses per account and resets only after the window", () => {
    const f = fixture(); const enrollment = f.start();
    for (let i = 0; i < 20; i++) expect(() => f.registry.inspect("ZZZZZZZZ", "alice")).toThrow("not found");
    expect(() => f.registry.inspect(enrollment.code, "alice")).toThrow("Too many");
    f.advance(60_000); expect(f.registry.inspect(enrollment.code, "alice").state).toBe("waiting");
  });
  it("bounds global guesses even when attackers rotate account identifiers", () => {
    const f = fixture(); const enrollment = f.start();
    for (let i = 0; i < 100; i++) expect(() => f.registry.inspect("ZZZZZZZZ", `account-${i}`)).toThrow("not found");
    expect(() => f.registry.inspect(enrollment.code, "alice")).toThrow("Too many");
  });
  it("rejects capacity overflow without evicting a live enrollment", () => {
    const registry = new CalendarEnrollmentRegistry({ now: () => 1000, assertCallCurrent: () => {}, revoke: () => {}, isPermissionCurrent: () => true });
    const f = fixture(); let first;
    for (let i = 0; i < 1000; i++) {
      const result = registry.start(f.scope, { ...f.binding, callId: randomUUID(), callInstanceId: randomUUID() }, randomUUID());
      if (i === 0) first = result;
    }
    expect(() => registry.start(f.scope, { ...f.binding, callId: randomUUID() }, randomUUID())).toThrow("Too many");
    expect(registry.inspect(first!.code, "alice").state).toBe("waiting");
  });
  it("sanitizes issuance failure and does not replay approval automatically", async () => {
    const f = fixture(); const enrollment = f.start(); let count = 0;
    await expect(f.registry.approve(enrollment.code, "alice", async () => { count++; throw new Error("secret transport"); })).rejects.toThrow("permission could not be issued");
    await expect(f.registry.approve(enrollment.code, "alice", async () => issued())).rejects.toThrow("no longer active");
    expect(count).toBe(1);
  });
});

it("requires the path call identity even when bot owner and capability are reused", async () => {
  const f = fixture(); const enrollment = f.start(); const grant = issued();
  await f.registry.approve(enrollment.code, "alice", async () => grant);
  expect(() => f.registry.take(f.scope, enrollment.id, randomUUID())).toThrow("not found");
  expect(() => f.registry.cancel(f.scope, enrollment.id, randomUUID())).toThrow("not found");
  expect(f.revoked).toEqual([]);
  expect(f.registry.take(f.scope, enrollment.id, f.binding.callId).issued).toEqual(grant);
});

it("revoked permission after approval cannot be delivered as connected", async () => {
  const f = fixture(); const enrollment = f.start(); const grant = issued();
  await f.registry.approve(enrollment.code, "alice", async () => grant);
  f.revokePermission();
  expect(() => f.registry.take(f.scope, enrollment.id, f.binding.callId)).toThrow("permission changed");
  expect(f.revoked).toEqual([{ owner: "alice", id: grant.grant.id }]);
  expect(() => f.registry.take(f.scope, enrollment.id, f.binding.callId)).toThrow("no longer active");
});
it("permission revoked during issuance is cleaned up before ready is published", async () => {
  const f = fixture(); const enrollment = f.start(); const gate = deferred(); const grant = issued();
  const approval = f.registry.approve(enrollment.code, "alice", () => gate.promise);
  f.revokePermission(); gate.resolve(grant);
  await expect(approval).rejects.toThrow("permission changed");
  expect(f.revoked).toEqual([{ owner: "alice", id: grant.grant.id }]);
  expect(() => f.registry.take(f.scope, enrollment.id, f.binding.callId)).toThrow("no longer active");
});

it("retries failed cancellation cleanup on the next sweep before expiry without delivering permission", async () => {
  const f = fixture();
  const grant = issued();
  let attempts = 0;
  const registry = new CalendarEnrollmentRegistry({
    now: () => 1000,
    assertCallCurrent: () => {},
    isPermissionCurrent: () => true,
    revoke(accountId, grantId) {
      expect(accountId).toBe("alice");
      expect(grantId).toBe(grant.grant.id);
      if (++attempts === 1) throw new Error("temporary cleanup failure");
    },
  });
  const enrollment = registry.start(f.scope, f.binding, randomUUID());
  await registry.approve(enrollment.code, "alice", async () => grant);
  expect(() => registry.cancel(f.scope, enrollment.id, f.binding.callId)).toThrow("could not be cleaned up");
  expect(attempts).toBe(1);
  expect(() => registry.take(f.scope, enrollment.id, f.binding.callId)).toThrow("no longer active");
  registry.sweep();
  expect(attempts).toBe(2);
  expect(() => registry.take(f.scope, enrollment.id, f.binding.callId)).toThrow("no longer active");
  registry.sweep();
  expect(attempts).toBe(2);
});
