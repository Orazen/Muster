import { describe, expect, it } from "vitest";
import { ConnectorCapabilities, installationAppsAllowed } from "./connector-capabilities.ts";
import { PeerCapabilities } from "./peer-capabilities.ts";

const context = { botId: "bot", threadId: "thread", ownerId: "primary" };
const instance = "provider";
const event = (type: string, turnId?: string, providerInstanceId = instance, threadId = context.threadId) =>
  ({ type, turnId, providerInstanceId, threadId });
const header = (token: string) => `Bearer ${token}`;

describe("installationAppsAllowed", () => {
  it.each([undefined, null, ""])("fails closed when hosted primary is %s", (primary) => {
    expect(installationAppsAllowed(true, primary, "alice")).toBe(false);
    expect(installationAppsAllowed(true, primary, primary)).toBe(false);
  });
  it("allows local installations regardless of owner metadata", () => {
    expect(installationAppsAllowed(false, undefined, undefined)).toBe(true);
    expect(installationAppsAllowed(false, "primary", "alice")).toBe(true);
  });
  it("allows the hosted primary and legacy owner only, never another tenant", () => {
    expect(installationAppsAllowed(true, "primary", "primary")).toBe(true);
    expect(installationAppsAllowed(true, "primary", undefined)).toBe(true);
    expect(installationAppsAllowed(true, "primary", null)).toBe(true);
    expect(installationAppsAllowed(true, "primary", "")).toBe(true);
    expect(installationAppsAllowed(true, "primary", "alice")).toBe(false);
  });
});

describe("ConnectorCapabilities", () => {
  it("issues immutable identity and expires at the absolute deadline", () => {
    let now = 100;
    const caps = new ConnectorCapabilities(() => now, 1000);
    const source = { ...context };
    const { lease, token } = caps.issue(source, instance);
    source.ownerId = "alice";
    expect(Object.isFrozen(lease)).toBe(true);
    expect(lease).toMatchObject({ ...context, taskId: context.threadId, depth: 0, expiresAt: 1100 });
    now = 1099;
    expect(caps.resolve(header(token))).toBe(lease);
    now = 1100;
    expect(caps.resolve(header(token))).toBeUndefined();
    expect(caps.current(lease)).toBe(false);
  });
  it("rotates credentials and stale lease revocation cannot remove the replacement", () => {
    const caps = new ConnectorCapabilities();
    const old = caps.issue(context, instance);
    const next = caps.issue(context, instance);
    expect(next.token).not.toBe(old.token);
    expect(caps.resolve(header(old.token))).toBeUndefined();
    caps.revoke(old.lease);
    expect(caps.resolve(header(next.token))).toBe(next.lease);
  });
  it("cannot redeem peer credentials or connector credentials across registries", () => {
    const peers = new PeerCapabilities();
    const caps = new ConnectorCapabilities();
    const peerLease = peers.begin({ ...context, taskId: "task", depth: 0 });
    const peerToken = peers.activate(peerLease, instance, true)!;
    const app = caps.issue(context, instance);
    expect(caps.resolve(header(peerToken))).toBeUndefined();
    expect(peers.resolve(header(app.token))).toBeUndefined();
    expect(new ConnectorCapabilities().resolve(header(app.token))).toBeUndefined();
    caps.clear();
    expect(peers.resolve(header(peerToken))).toBe(peerLease);
  });
  it.each(["turn.completed", "session.exited"])("requires exact provider, thread and bound turn for %s", (terminal) => {
    const caps = new ConnectorCapabilities();
    const app = caps.issue(context, instance);
    caps.onEvent(event(terminal, "turn"));
    caps.onEvent(event("turn.started", "turn"));
    caps.onEvent(event(terminal, "turn", "other"));
    caps.onEvent(event(terminal, "turn", instance, "other"));
    caps.onEvent(event(terminal, "old"));
    caps.onEvent(event(terminal));
    caps.onEvent({ type: terminal, threadId: context.threadId, turnId: "turn" });
    expect(caps.resolve(header(app.token))).toBe(app.lease);
    expect(caps.onEvent(event(terminal, "turn"))).toBe(app.lease);
    expect(caps.resolve(header(app.token))).toBeUndefined();
  });
  it("ignores stale terminal and start events after replacement turn is bound", () => {
    const caps = new ConnectorCapabilities();
    caps.issue(context, instance);
    caps.onEvent(event("turn.started", "old"));
    const next = caps.issue(context, instance);
    caps.onEvent(event("turn.started", "new"));
    caps.onEvent(event("turn.started", "old"));
    caps.onEvent(event("turn.completed", "old"));
    caps.onEvent(event("session.exited", "old"));
    caps.revokeThread(context.threadId, "old");
    expect(caps.resolve(header(next.token))).toBe(next.lease);
    caps.revokeThread(context.threadId, "new");
    expect(caps.resolve(header(next.token))).toBeUndefined();
  });
  it("binds the returned turn only for the active provider and lease", () => {
    const caps = new ConnectorCapabilities();
    const app = caps.issue(context, instance);
    caps.bindTurn(app.lease, "wrong-provider", "wrong-turn");
    caps.bindTurn(app.lease, instance, undefined);
    caps.bindTurn(app.lease, instance, "returned-turn");
    caps.onEvent(event("turn.completed", "wrong-turn"));
    expect(caps.current(app.lease)).toBe(true);
    caps.onEvent(event("turn.completed", "returned-turn"));
    expect(caps.current(app.lease)).toBe(false);
  });
  it("revokes only the selected bot or thread and clears all remaining capabilities", () => {
    const caps = new ConnectorCapabilities();
    const a = caps.issue(context, instance);
    const b = caps.issue({ ...context, botId: "other", threadId: "other-thread" }, "other-provider");
    caps.revokeThread(context.threadId);
    expect(caps.resolve(header(a.token))).toBeUndefined();
    expect(caps.resolve(header(b.token))).toBe(b.lease);
    caps.revokeBot("other");
    expect(caps.current(b.lease)).toBe(false);
    const c = caps.issue(context, instance);
    caps.clear();
    expect(caps.resolve(header(c.token))).toBeUndefined();
  });
  it("rejects missing, malformed and multiple authorization values", () => {
    const caps = new ConnectorCapabilities();
    const app = caps.issue(context, instance);
    for (const value of [undefined, "", app.token, `bearer ${app.token}`, [header(app.token)]]) {
      expect(caps.resolve(value)).toBeUndefined();
    }
    expect(caps.resolve(header(app.token))).toBe(app.lease);
  });
});
