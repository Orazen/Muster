import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareAccountRecoveryImport, isAccountRecoveryPlanCurrent, recoveryDestinationDigest,
  type RecoveryIdMap, type RecoveryDestination } from "./drive-visible-account-import-plan.ts";
import { captureAccountRecoveryState, recoveryStateDigest, type AccountRecoveryState, type AccountRecoverySourceInput } from "./drive-visible-account-state.ts";
import { type BotRecord, type GroupRecord, type Message } from "./store.ts";
import { type TaskPlanRecord } from "./contracts.ts";
const oldAccount = { userId: "old-user", workspaceId: "old-org", sessionId: "old-session", isPrimary: false };
const authority = { account: { userId: "current-user", workspaceId: "current-org", sessionId: "current-session", isPrimary: false }, googleSub: "verified-google-sub" };
const oldAuthority = { account: oldAccount, googleSub: authority.googleSub };
let directory: string; let state: AccountRecoveryState; let destination: RecoveryDestination; let source: AccountRecoverySourceInput;
const bot = (id: string): BotRecord => ({ id, ownerId: oldAccount.userId, threadId: `${id}-thread`, name: id, title: "Title", description: "Persona", color: "green",
  unread: false, notifications: false, createdAt: 1, modelSelection: { instanceId: "PRIVATE-ENGINE", model: "test" }, resumeCursors: { secret: "PRIVATE-CURSOR" },
  tasks: [{ threadId: `${id}-thread`, title: "Task", titleSource: "user", createdAt: 1, resumeCursors: {}, usage: { input: 1, output: 2, costUsd: 0.3, turns: 4 } }],
  speakReplies: true, computer: "local", autoApprove: true, alwaysAllow: ["Bash"], chiefOfStaff: true, approvePeerComms: true, browser: true });
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "muster-account-import-plan-"));
  mkdirSync(join(directory, "workspaces", "own", "memory"), { recursive: true }); writeFileSync(join(directory, "workspaces", "own", "MEMORY.md"), "Actual memory");
  writeFileSync(join(directory, "workspaces", "own", "memory", "topic.md"), "Actual topic");
  const own = bot("own"); own.tasks!.push({ threadId: "old-task", title: "Previous task", createdAt: 0, resumeCursors: {} });
  const group: GroupRecord = { id: "room", ownerId: oldAccount.userId, threadId: "room-thread", name: "Room", memberIds: ["own", "peer"],
    defaultResponder: { kind: "member", botId: "peer" }, bulletin: "Bulletin", unread: true, createdAt: 1, dm: true };
  const rich: Message[] = [{ id: "root", role: "user", kind: "text", text: "Original row", at: 1, parentId: null },
    { id: "selected", role: "bot", kind: "options", at: 2, parentId: "root", from: { botId: "peer", name: "Peer", color: "blue" },
      comm: { groupId: "room", withBotId: "peer", withName: "Peer", withColor: "blue" }, reactions: [{ emoji: "👍", by: "peer" }, { emoji: "✅", by: "user" }],
      card: { title: "Ask", subtitle: "Historical", options: ["Yes", "No"], answered: "Yes", requestId: "PRIVATE-ASK", allowKey: "Bash" },
      connector: { slug: "google", label: "Google", description: "Historic connector", status: "connected", resumeKey: "PRIVATE-RESUME" },
      tool: { name: "Historic tool", ok: false, setup: true }, queued: true },
    { id: "new-fork", role: "bot", kind: "screen", parentId: "root", at: 3, png: "AA==", mime: "image/png" }];
  const plan: TaskPlanRecord = { id: "plan", ownerId: oldAccount.userId, botId: "own", threadId: "old-task", title: "Active original plan", status: "waiting_approval",
    steps: [{ n: 1, title: "Gate", kind: "approval", status: "active", startedAt: 5 }], currentStep: 1, attempts: 1, maxAttempts: 3,
    inputAnswers: [{ name: "answer", value: true, at: 4 }], approvalRequest: { title: "Approve", step: 1, askedAt: 5 },
    lease: { holder: "PRIVATE-LEASE", expiresAt: 1000 }, context: { executionHost: "PRIVATE-HOST" }, delivery: { intentId: "PRIVATE-INTENT", acceptedAt: 5 }, createdAt: 1, updatedAt: 5 };
  source = { account: oldAccount, dataDir: directory, settingsSnapshot: { userId: oldAccount.userId, workspaceId: oldAccount.workspaceId, values: { theme: "dark" } },
    store: { bots: [own, bot("peer")], groups: [group], snapshotThread: id => ({ status: "ready", source: "sqlite", messages: id === "own-thread" ? structuredClone(rich) : [], activeLeafId: id === "own-thread" ? "selected" : null }) },
    plans: { listPlans: () => [structuredClone(plan)], transitionsFor: () => [{ planId: "plan", botId: "own", from: "running", to: "waiting_approval", action: "request-approval", at: 5, step: 1 }] } };
  const captured = captureAccountRecoveryState({ source, resolveAccount: () => oldAuthority }); if (captured.status !== "ready") throw new Error(JSON.stringify(captured)); state = captured.state;
  destination = { userId: authority.account.userId, workspaceId: authority.account.workspaceId, revision: "actual-host-revision-1",
    botIds: ["existing-user-bot", "foreign-user-bot"], groupIds: ["existing-room"], threadIds: ["existing-thread"], planIds: ["existing-plan"] };
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
const prepare = (overrides: Partial<Parameters<typeof prepareAccountRecoveryImport>[0]> = {}) => prepareAccountRecoveryImport({ state, resolveAccount: () => authority,
  readDestination: () => destination, freshId: (kind, id) => `fresh-${kind}-${id}`, ...overrides });
const ready = () => { const result = prepare(); if (result.status !== "ready") throw new Error(JSON.stringify(result)); return result.plan; };

describe("pure additive account recovery plan", () => {
  it("maps every ID domain including fresh rooms while preserving complete rows, selected heads and relationships", () => {
    const plan = ready(); expect(plan).toMatchObject({ mode: "additive-preparation", writesNothing: true, apply: "unsupported", account: authority.account });
    expect(plan.mapping).toEqual({ bot: { own: "fresh-bot-own", peer: "fresh-bot-peer" }, group: { room: "fresh-group-room" },
      thread: { "old-task": "fresh-thread-old-task", "own-thread": "fresh-thread-own-thread", "peer-thread": "fresh-thread-peer-thread", "room-thread": "fresh-thread-room-thread" }, plan: { plan: "fresh-plan-plan" } });
    expect(plan.groups[0]).toMatchObject({ id: "fresh-group-room", ownerId: "current-user", threadId: "fresh-thread-room-thread", memberIds: ["fresh-bot-own", "fresh-bot-peer"], defaultResponder: { kind: "member", botId: "fresh-bot-peer" }, dm: true });
    const thread = plan.threads.find(thread => thread.threadId === "fresh-thread-own-thread")!;
    expect(thread.activeLeafId).toBe("selected"); expect(thread.rows.map(row => row.message.id)).toEqual(["root", "selected", "new-fork"]);
    expect(thread.rows[1]!.message).toMatchObject({ parentId: "root", from: { botId: "fresh-bot-peer" }, comm: { groupId: "fresh-group-room", withBotId: "fresh-bot-peer" }, reactions: [{ by: "fresh-bot-peer" }, { by: "user" }] });
    expect(plan.bots[0]!.tasks.map(task => task.threadId)).toEqual(["fresh-thread-own-thread", "fresh-thread-old-task"]);
    expect(plan.bots[0]!.tasks[0]!.usage).toEqual({ input: 1, output: 2, costUsd: 0.3, turns: 4 });
    expect(plan.plans[0]).toMatchObject({ id: "fresh-plan-plan", botId: "fresh-bot-own", threadId: "fresh-thread-old-task", ownerId: "current-user", attempts: 1 });
    expect(plan.transitions[0]).toMatchObject({ planId: "fresh-plan-plan", botId: "fresh-bot-own", mode: "inert-history" });
    expect(plan.memory.find(memory => memory.botId === "fresh-bot-own")).toMatchObject({ text: "Actual memory", topics: [{ name: "topic.md", text: "Actual topic" }] });
    expect(plan.preferences).toEqual({ userId: "current-user", workspaceId: "current-org", mode: "capture-only", values: { theme: "dark" } });
  });
  it("does not restore approvals, queued work, engines, computers, connectors or old dispatch leases", () => {
    const plan = ready(); expect(plan.bots[0]).toMatchObject({ engineSelection: null, execution: "requires-explicit-engine-selection", autoApprove: false,
      alwaysAllow: [], approvePeerComms: false, chiefOfStaff: false, computer: "off", browser: false, composio: false, speakReplies: false, resumeCursors: {} });
    const row = plan.threads.find(thread => thread.threadId === "fresh-thread-own-thread")!.rows[1]!;
    expect(row.message).not.toHaveProperty("card"); expect(row.message).not.toHaveProperty("connector"); expect(row.message).not.toHaveProperty("queued");
    expect(row.message.tool).not.toHaveProperty("setup"); expect(row.actionHistory).toMatchObject({ mode: "inert-history", card: { options: ["Yes", "No"], answered: "Yes" }, connector: { status: "connected" } });
    expect(plan.plans[0]).toMatchObject({ status: "paused", execution: "requires-explicit-reconsent", steps: [{ status: "pending" }], history: { originalStatus: "waiting_approval", originalSteps: [{ status: "active" }], approvalRequest: { title: "Approve" } } });
    expect(plan.plans[0]!.approvalRequest).toBeUndefined(); expect(plan.plans[0]!.inputRequest).toBeUndefined(); expect(plan.plans[0]).not.toHaveProperty("lease");
    for (const secret of ["PRIVATE-ENGINE", "PRIVATE-CURSOR", "PRIVATE-ASK", "PRIVATE-RESUME", "PRIVATE-LEASE", "PRIVATE-HOST", "PRIVATE-INTENT"]) expect(JSON.stringify(plan)).not.toContain(secret);
  });
  it.each(["succeeded", "failed", "cancelled"] as const)("preserves %s terminal task history without requeuing it", status => {
    state.plans[0]!.status = status; state.plans[0]!.steps[0]!.status = status === "failed" ? "failed" : "done"; state.plans[0]!.currentStep = null;
    state.sourceDigest = recoveryStateDigest(state);
    const result = prepare(); if (result.status !== "ready") throw new Error(JSON.stringify(result));
    expect(result.plan.plans[0]).toMatchObject({ status, history: { originalStatus: status }, execution: "requires-explicit-reconsent" });
  });
  it("reuses an exact frozen ID map for retry instead of allocating new identities", () => {
    const first = ready(); const freshId = vi.fn(() => "must-not-call"); const repeat = prepare({ mapping: first.mapping, freshId });
    expect(repeat.status).toBe("ready"); if (repeat.status !== "ready") throw new Error("No repeat");
    expect(repeat.plan).toEqual(first); expect(freshId).not.toHaveBeenCalled();
  });
  it("allocates real unique IDs when a host does not supply a mapping", () => {
    const result = prepare({ freshId: undefined }); if (result.status !== "ready") throw new Error("No plan");
    const outputs = Object.values(result.plan.mapping).flatMap(mapping => Object.values(mapping)); expect(new Set(outputs).size).toBe(outputs.length);
    expect(outputs.every(id => /^[a-f0-9-]{36}$/.test(id))).toBe(true);
  });
  it.each(["existing-user-bot", "foreign-user-bot", "existing-room", "existing-thread", "existing-plan", "own", "room", "own-thread", "plan", "../traversal", ""])
    ("rejects allocation collision or unsafe ID %s", collision => {
      expect(prepare({ freshId: () => collision })).toEqual({ status: "unavailable", reason: "mapping-invalid" });
    });
  it.each(["missing", "extra", "duplicate", "source-reuse", "target-reuse", "malformed"])("rejects %s offered retry mapping", mutation => {
    const mapping: RecoveryIdMap = structuredClone(ready().mapping);
    if (mutation === "missing") delete mapping.bot.own;
    if (mutation === "extra") mapping.bot.unknown = "fresh-unknown";
    if (mutation === "duplicate") mapping.group.room = mapping.bot.own!;
    if (mutation === "source-reuse") mapping.group.room = "room";
    if (mutation === "target-reuse") mapping.group.room = "foreign-user-bot";
    if (mutation === "malformed") mapping.group.room = "../bad";
    expect(prepare({ mapping })).toEqual({ status: "unavailable", reason: "mapping-invalid" });
  });
  it("rejects current account/source-subject mismatches without importing into another user", () => {
    expect(prepare({ resolveAccount: () => null })).toEqual({ status: "unavailable", reason: "account-unavailable" });
    expect(prepare({ resolveAccount: () => ({ ...authority, googleSub: "another-google-sub" }) })).toEqual({ status: "unavailable", reason: "state-invalid" });
    expect(prepare({ readDestination: () => ({ ...destination, userId: "foreign-user" }) })).toEqual({ status: "unavailable", reason: "destination-unavailable" });
    expect(prepare({ readDestination: () => ({ ...destination, workspaceId: "foreign-org" }) })).toEqual({ status: "unavailable", reason: "destination-unavailable" });
    expect(prepare({ readDestination: () => null })).toEqual({ status: "unavailable", reason: "destination-unavailable" });
  });
  it("refuses changed authority and target inventory while preparing and on later freshness checks", () => {
    expect(prepare({ resolveAccount: vi.fn().mockReturnValueOnce(authority).mockReturnValue(null) })).toEqual({ status: "unavailable", reason: "account-changed" });
    expect(prepare({ readDestination: vi.fn().mockReturnValueOnce(destination).mockReturnValue({ ...destination, revision: "actual-host-revision-2" }) })).toEqual({ status: "unavailable", reason: "destination-changed" });
    const plan = ready(); expect(isAccountRecoveryPlanCurrent({ plan, resolveAccount: () => authority, readDestination: () => destination })).toBe(true);
    destination.botIds.push("new-existing-id"); expect(isAccountRecoveryPlanCurrent({ plan, resolveAccount: () => authority, readDestination: () => destination })).toBe(false);
    expect(isAccountRecoveryPlanCurrent({ plan, resolveAccount: () => ({ ...authority, account: { ...authority.account, sessionId: "new-session" } }), readDestination: () => destination })).toBe(false);
  });
  it("revalidates typed-looking bytes, graph, credential keys and parser before making any remap", () => {
    const invalid = structuredClone(state); invalid.threads.find(thread => thread.threadId === "own-thread")!.messages[0]!.parentId = "selected";
    invalid.sourceDigest = recoveryStateDigest(invalid); expect(prepare({ state: invalid })).toEqual({ status: "unavailable", reason: "state-invalid" });
    const credential = structuredClone(state); credential.threads[0]!.messages.push(JSON.parse('{"id":"unsafe","parentId":null,"role":"bot","kind":"activity","at":1,"tool":{"API_KEY":"SYNTHETIC"}}'));
    credential.sourceDigest = recoveryStateDigest(credential); expect(prepare({ state: credential }).status).toBe("unavailable");
    expect(prepare({ state: { status: "ready", state } }).status).toBe("unavailable");
  });
  it("denies malformed target inventories and treats thrown host readers as unavailable", () => {
    expect(prepare({ readDestination: () => ({ ...destination, botIds: ["duplicate", "duplicate"] }) }).status).toBe("unavailable");
    expect(prepare({ readDestination: () => { throw new Error("SYNTHETIC-PRIVATE"); } })).toEqual({ status: "unavailable", reason: "destination-unavailable" });
    expect(prepare({ freshId: () => { throw new Error("SYNTHETIC-PRIVATE"); } })).toEqual({ status: "unavailable", reason: "mapping-invalid" });
  });
  it("returns defensive, deterministic no-write preparation with preserved source and existing destination records", () => {
    const before = JSON.stringify({ state, destination, bots: source.store.bots, groups: source.store.groups });
    const memory = join(directory, "workspaces", "own", "MEMORY.md"); const bytes = readFileSync(memory); const stat = statSync(memory), names = readdirSync(directory);
    const plan = ready(); plan.bots[0]!.name = "Mutated output"; plan.groups[0]!.memberIds.push("Mutated output");
    expect(JSON.stringify({ state, destination, bots: source.store.bots, groups: source.store.groups })).toBe(before);
    expect(readFileSync(memory)).toEqual(bytes); expect(statSync(memory).ino).toBe(stat.ino); expect(statSync(memory).mtimeMs).toBe(stat.mtimeMs); expect(readdirSync(directory)).toEqual(names);
    expect(recoveryDestinationDigest({ ...destination, botIds: [...destination.botIds].reverse() })).toBe(recoveryDestinationDigest(destination));
  });
});
