import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureAccountRecoveryState, inspectAccountRecoveryState, recoveryStateDigest,
  MAX_RECOVERY_STATE_BYTES, type AccountRecoverySourceInput } from "./drive-visible-account-state.ts";
import { type BotRecord, type GroupRecord, type Message, Store } from "./store.ts";
import { type DriveThreadSnapshot } from "./drive-visible-data-source.ts";
import { type TaskPlanRecord, type TaskTransitionEvent } from "./contracts.ts";
import { TaskPlanEngine } from "./task-engine.ts";
import { captureAccountSettings, readAccountSettings } from "./drive-visible-settings.ts";
import { closeMessageDb } from "./message-db.ts";
import { DATA_DIR } from "./config.ts";

const account = { userId: "alice", workspaceId: "org", sessionId: "session", isPrimary: false };
const authority = { account, googleSub: "verified-google-sub" };
const bot = (id: string, ownerId = account.userId): BotRecord => ({ id, ownerId, threadId: `${id}-thread`, name: id,
  title: `${id} title`, description: "Persona", notifications: false, unread: false, color: "green", createdAt: 1,
  modelSelection: { instanceId: "old-engine", model: "old-model" }, resumeCursors: { private: "PRIVATE-CURSOR" },
  tasks: [{ threadId: `${id}-thread`, title: "Task", createdAt: 1, resumeCursors: { private: "PRIVATE-TASK-CURSOR" } }],
  autoApprove: true, computer: "local", browser: true, alwaysAllow: ["Bash"], chiefOfStaff: true });
const row = (id: string, parentId: string | null = null): Message => ({ id, parentId, role: "user", kind: "text", text: id, at: 2 });
let directory: string;
let source: AccountRecoverySourceInput;
let snapshots: Map<string, DriveThreadSnapshot>;
let plans: TaskPlanRecord[];
let transitions: TaskTransitionEvent[];
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "muster-account-state-"));
  const own = bot("own"), peer = bot("peer"), foreign = bot("foreign", "bob");
  own.tasks!.push({ threadId: "old-task", title: "Older task", createdAt: 0, resumeCursors: {} });
  const group: GroupRecord = { id: "room", ownerId: "alice", threadId: "room-thread", name: "Original room", memberIds: ["own", "peer"],
    defaultResponder: { kind: "member", botId: "peer" }, bulletin: "Shared instructions", unread: true, createdAt: 3, dm: true };
  const rich: Message = { ...row("branch-a", "root"), role: "bot", kind: "options",
    from: { botId: "peer", name: "Peer", color: "blue" }, comm: { groupId: "room", withBotId: "peer", withName: "Peer", withColor: "blue" },
    reactions: [{ emoji: "👍", by: "peer" }], queued: true, via: { instanceId: "OLD-PRIVATE-INSTANCE", model: "historical-model", effort: "high" },
    card: { title: "Historic ask", subtitle: "Display", options: ["Yes", "No"], answered: "Yes", requestId: "PRIVATE-REQUEST",
      allowKey: "Bash", purpose: "permission", seedAnswer: undefined } };
  snapshots = new Map([
    ["own-thread", { status: "ready", source: "sqlite", activeLeafId: "branch-a", messages: [row("root"), rich, row("branch-b", "root")] }],
    ["peer-thread", { status: "ready", source: "sqlite", activeLeafId: null, messages: [] }],
    ["old-task", { status: "ready", source: "sqlite", activeLeafId: "older", messages: [row("older")] }],
    ["room-thread", { status: "ready", source: "sqlite", activeLeafId: "room-row", messages: [{ ...row("room-row"), from: { botId: "own", name: "Own", color: "green" } }] }],
    ["foreign-thread", { status: "ready", source: "sqlite", activeLeafId: "FOREIGN", messages: [row("FOREIGN")] }],
  ]);
  plans = [{ id: "plan", botId: "own", ownerId: "alice", threadId: "old-task", title: "Durable plan", status: "waiting_approval",
    steps: [{ n: 1, title: "Step", kind: "approval", status: "active", startedAt: 10 }], currentStep: 1,
    attempts: 2, maxAttempts: 3, inputAnswers: [{ name: "answer", value: "historical", at: 4 }],
    approvalRequest: { title: "Allow", step: 1, askedAt: 11 }, lease: { holder: "PRIVATE-HOLDER", expiresAt: 500 },
    context: { executionHost: "PRIVATE-EXECUTOR" }, delivery: { intentId: "PRIVATE-INTENT", acceptedAt: 1 }, createdAt: 1, updatedAt: 11 }];
  transitions = [{ planId: "plan", botId: "own", from: "running", to: "waiting_approval", at: 11, action: "request-approval", step: 1, actorId: "PRIVATE-ACTOR" }];
  source = { account, dataDir: directory, settingsSnapshot: { userId: "alice", workspaceId: "org", values: { theme: "dark" } },
    store: { bots: [own, peer, foreign], groups: [group], snapshotThread: vi.fn(id => structuredClone(snapshots.get(id)!)) },
    plans: { listPlans: () => structuredClone(plans), transitionsFor: () => structuredClone(transitions) } };
  mkdirSync(join(directory, "workspaces", "own", "memory"), { recursive: true });
  writeFileSync(join(directory, "workspaces", "own", "MEMORY.md"), "Actual account memory");
  writeFileSync(join(directory, "workspaces", "own", "memory", "topic.md"), "Actual topic");
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
const capture = () => captureAccountRecoveryState({ source, resolveAccount: () => authority });
const ready = () => { const result = capture(); if (result.status !== "ready") throw new Error(JSON.stringify(result)); return result.state; };

describe("complete safe account state", () => {
  it("preserves original selected branch, every row, rich display, old tasks, memberships and task history", () => {
    const state = ready();
    expect(state.inventory).toEqual({ botIds: ["own", "peer"], groupIds: ["room"], threadIds: ["old-task", "own-thread", "peer-thread", "room-thread"], planIds: ["plan"] });
    expect(state.threads.find(thread => thread.threadId === "own-thread")).toMatchObject({ activeLeafId: "branch-a", messages: [{ id: "root" }, { id: "branch-a", card: { answered: "Yes" } }, { id: "branch-b" }] });
    expect(state.bots.find(bot => bot.id === "own")?.tasks.map(task => task.threadId)).toEqual(["own-thread", "old-task"]);
    expect(state.groups[0]).toMatchObject({ memberIds: ["own", "peer"], defaultResponder: { kind: "member", botId: "peer" }, dm: true });
    expect(state.plans[0]).toMatchObject({ status: "waiting_approval", currentStep: 1, attempts: 2, inputAnswers: [{ value: "historical" }] });
    expect(state.transitions[0]).toMatchObject({ action: "request-approval", step: 1 });
    expect(inspectAccountRecoveryState(state)).toEqual(state);
    const encoded = JSON.stringify(state);
    for (const omitted of ["FOREIGN", "PRIVATE-CURSOR", "PRIVATE-TASK-CURSOR", "OLD-PRIVATE-INSTANCE", "PRIVATE-REQUEST", "PRIVATE-HOLDER", "PRIVATE-EXECUTOR", "PRIVATE-INTENT", "PRIVATE-ACTOR"])
      expect(encoded).not.toContain(omitted);
    expect(encoded).not.toContain('"queued"'); expect(encoded).not.toContain('"modelSelection"');
  });
  it("returns detached state and never alters source files or records", () => {
    const memory = join(directory, "workspaces", "own", "MEMORY.md"); const before = readFileSync(memory); const stat = statSync(memory);
    const names = readdirSync(directory); const originals = JSON.stringify({ bots: source.store.bots, groups: source.store.groups, plans, transitions, snapshots: [...snapshots] });
    const state = ready(); state.bots[0]!.name = "Changed output"; state.threads[0]!.messages[0]!.text = "Changed output";
    expect(JSON.stringify({ bots: source.store.bots, groups: source.store.groups, plans, transitions, snapshots: [...snapshots] })).toBe(originals);
    expect(readFileSync(memory)).toEqual(before); expect(statSync(memory).ino).toBe(stat.ino); expect(statSync(memory).mtimeMs).toBe(stat.mtimeMs);
    expect(readdirSync(directory)).toEqual(names);
  });
  it("compares authority independent of account property order", () => {
    expect(captureAccountRecoveryState({ source, resolveAccount: () => ({ googleSub: authority.googleSub,
      account: { isPrimary: false, sessionId: "session", workspaceId: "org", userId: "alice" } }) }).status).toBe("ready");
  });
  it.each(["inventory", "missing-thread", "duplicate-row", "head", "missing-parent", "self-cycle", "multi-cycle", "group-member", "group-responder", "sender", "comm", "reaction", "task-thread", "plan-thread", "plan-step", "transition", "projection-body", "credential", "unexpected"])
    ("rejects %s even with a recomputed content digest", mutation => {
      const state = ready(); const thread = state.threads.find(thread => thread.threadId === "own-thread")!;
      if (mutation === "inventory") state.inventory.botIds.push("unknown");
      if (mutation === "missing-thread") state.threads.pop();
      if (mutation === "duplicate-row") thread.messages.push(thread.messages[0]!);
      if (mutation === "head") thread.activeLeafId = "missing";
      if (mutation === "missing-parent") thread.messages[0]!.parentId = "missing";
      if (mutation === "self-cycle") thread.messages[0]!.parentId = "root";
      if (mutation === "multi-cycle") thread.messages[0]!.parentId = "branch-a";
      if (mutation === "group-member") state.groups[0]!.memberIds.push("foreign");
      if (mutation === "group-responder") state.groups[0]!.defaultResponder = { kind: "member", botId: "unknown" };
      if (mutation === "sender") thread.messages[1]!.from!.botId = "foreign";
      if (mutation === "comm") thread.messages[1]!.comm!.groupId = "unknown";
      if (mutation === "reaction") thread.messages[1]!.reactions![0]!.by = "foreign";
      if (mutation === "task-thread") state.bots[0]!.tasks[0]!.threadId = "foreign-thread";
      if (mutation === "plan-thread") state.plans[0]!.threadId = "room-thread";
      if (mutation === "plan-step") state.plans[0]!.steps[0]!.n = 2;
      if (mutation === "transition") state.transitions[0]!.planId = "missing";
      if (mutation === "projection-body") state.files["settings.json"] = "not-json";
      if (mutation === "credential") thread.messages[1]!.card = JSON.parse('{"access_token":"SYNTHETIC-SECRET"}');
      if (mutation === "unexpected") Object.assign(state.bots[0]!, { autoApprove: true });
      state.sourceDigest = recoveryStateDigest(state);
      expect(inspectAccountRecoveryState(state)).toBeNull();
    });
  it("captures only closed source-backed rich display fields and preserves safe evidence", () => {
    const snapshot = snapshots.get("own-thread")!; if (snapshot.status !== "ready") throw new Error("No fixture");
    const row = snapshot.messages[1]!;
    row.card = JSON.parse(JSON.stringify({ ...row.card, driver: { env: { TOKEN: "SYNTHETIC-PRIVATE" }, proxy: { url: "http://synthetic.invalid" } },
      why: { source: "previous-run", runId: "prior-run", botId: "own", threadId: "own-thread", at: 1, intent: "Prior intent", decisions: ["Prior finding"], outcome: "done", hypothesis: "Hypothesis", findings: "Findings", driver: { env: { TOKEN: "SYNTHETIC-PRIVATE" } } },
      rehearsal: { plannedSteps: 2, matchedSteps: 1, matchedRuns: 1, reviewedRuns: 2, summary: "Rehearsal", proxy: { url: "http://synthetic.invalid" } },
      history: { total: 1, approved: 1, denied: 0, auto: 0, lastDecision: "approved", summary: "History", driver: {} } }));
    row.connector = JSON.parse('{"slug":"google","label":"Google","description":"History","status":"connected","resumeKey":"SYNTHETIC-PRIVATE","driver":{"env":{"TOKEN":"SYNTHETIC-PRIVATE"}}}');
    row.tool = JSON.parse('{"name":"Tool","ok":true,"spoken":"Read","setup":true,"env":{"TOKEN":"SYNTHETIC-PRIVATE"}}');
    row.compaction = JSON.parse('{"summary":"Summary","firstKeptId":"root","tokensBefore":5,"at":1,"driver":{}}');
    row.privacy = JSON.parse('{"secrets":1,"emails":2,"phones":3,"proxy":{}}');
    const state = ready(); const restored = state.threads.find(thread => thread.threadId === "own-thread")!.messages[1]!;
    expect(restored).toMatchObject({ card: { answered: "Yes", why: { findings: "Findings" }, rehearsal: { summary: "Rehearsal" }, history: { approved: 1 } },
      connector: { status: "connected" }, tool: { name: "Tool", spoken: "Read", setup: true }, compaction: { firstKeptId: "root" }, privacy: { secrets: 1, emails: 2, phones: 3 } });
    const text = JSON.stringify(state); expect(text).not.toContain("SYNTHETIC-PRIVATE"); expect(text).not.toContain("synthetic.invalid"); expect(text).not.toContain('"driver"'); expect(text).not.toContain('"proxy"');
  });
  it.each(["card", "connector", "tool", "compaction", "privacy", "why", "rehearsal", "history"] as const)
    ("refuses hidden structured custody in %s on import even after re-digest", field => {
      const state = ready(); const row = state.threads.find(thread => thread.threadId === "own-thread")!.messages[1]!;
      if (field === "why") row.card!.why = { source: "previous-run", runId: "run", botId: "own", threadId: "own-thread", at: 1, intent: "Intent", decisions: [], outcome: "done" };
      if (field === "rehearsal") row.card!.rehearsal = { plannedSteps: 1, matchedSteps: 1, matchedRuns: 1, reviewedRuns: 1, summary: "Summary" };
      if (field === "history") row.card!.history = { total: 1, approved: 1, denied: 0, auto: 0, lastDecision: "approved", summary: "Summary" };
      if (field === "connector") row.connector = { slug: "google", label: "Google", description: "History", status: "connected" };
      if (field === "tool") row.tool = { name: "Tool" };
      if (field === "compaction") row.compaction = { summary: "Summary", firstKeptId: "root", tokensBefore: 5, at: 1 };
      if (field === "privacy") row.privacy = { secrets: 1, emails: 2, phones: 3 };
      const nested = field === "why" || field === "rehearsal" || field === "history" ? row.card![field] : row[field];
      Object.assign(nested!, { driver: { env: { TOKEN: "SYNTHETIC-PRIVATE" }, proxy: { url: "http://synthetic.invalid" } } });
      state.sourceDigest = recoveryStateDigest(state); expect(inspectAccountRecoveryState(state)).toBeNull();
    });
  it("binds the digest to content and accepts equivalent object key order", () => {
    const state = ready(); state.bots[0]!.name = "Tampered"; expect(inspectAccountRecoveryState(state)).toBeNull();
    state.sourceDigest = recoveryStateDigest(state); expect(inspectAccountRecoveryState(state)).toEqual(state);
    const reversed = Object.fromEntries(Object.entries(state).reverse()); expect(inspectAccountRecoveryState(reversed)).toEqual(state);
  });
  it("bounds hostile JSON without recursive traversal or overflowing the stack", () => {
    const state = ready(); let nested = "{}";
    for (let index = 0; index < 30; index++) nested = '{"child":' + nested + '}';
    state.threads[0]!.messages[0]!.tool = JSON.parse(nested); expect(inspectAccountRecoveryState(state)).toBeNull();
    delete state.threads[0]!.messages[0]!.tool; state.files["soul.md"] = "x".repeat(MAX_RECOVERY_STATE_BYTES + 1);
    expect(inspectAccountRecoveryState(state)).toBeNull();
    interface Circular { self?: Circular }
    const circular: Circular = {}; circular.self = circular; expect(inspectAccountRecoveryState(circular)).toBeNull();
  });
  it("refuses missing real source/settings, a changing session or source during capture", () => {
    expect(captureAccountRecoveryState({ source: { ...source, settingsSnapshot: null }, resolveAccount: () => authority }).status).toBe("unavailable");
    const changed = vi.fn().mockReturnValueOnce(authority).mockReturnValue(null);
    expect(captureAccountRecoveryState({ source, resolveAccount: changed })).toEqual({ status: "unavailable", reason: "account-changed" });
    let calls = 0; source.store.snapshotThread = id => { const snapshot = structuredClone(snapshots.get(id)!); if (++calls > 4 && snapshot.status === "ready") snapshot.activeLeafId = null; return snapshot; };
    expect(capture().status).toBe("unavailable");
  });
});

describe("durable account state after real Store restart", () => {
  it("uses the real durable parser and actual captured account settings without changing source bytes", () => {
    closeMessageDb(); rmSync(DATA_DIR, { recursive: true, force: true });
    const initial = new Store(() => ({ instanceId: "offline", model: "test" }));
    const own = initial.createBot({ ownerId: "alice", name: "Own" }, { seedMessages: false });
    const foreign = initial.createBot({ ownerId: "bob", name: "Foreign" }, { seedMessages: false });
    initial.appendMessage(own.threadId, { role: "user", kind: "text", text: "Persisted own row" });
    initial.appendMessage(foreign.threadId, { role: "user", kind: "text", text: "PRIVATE-FOREIGN-ROW" });
    closeMessageDb(); const store = new Store(() => ({ instanceId: "offline", model: "test" }));
    const plans = new TaskPlanEngine({ file: join(DATA_DIR, "task-plans.json") });
    const settings = new DatabaseSync(":memory:");
    settings.exec("CREATE TABLE user(id TEXT PRIMARY KEY); CREATE TABLE organization(id TEXT PRIMARY KEY); INSERT INTO user VALUES('alice'); INSERT INTO organization VALUES('org');");
    captureAccountSettings(settings, account, { theme: "dark" }, 1);
    const names = readdirSync(DATA_DIR).sort(); const before = names.map(name => ({ name, bytes: readFileSync(join(DATA_DIR, name)), stat: statSync(join(DATA_DIR, name)) }));
    try {
      const result = captureAccountRecoveryState({ source: { account, store, plans, dataDir: DATA_DIR, settingsSnapshot: readAccountSettings(settings, account) }, resolveAccount: () => authority });
      if (result.status !== "ready") throw new Error(JSON.stringify(result));
      expect(JSON.stringify(result.state)).toContain("Persisted own row"); expect(JSON.stringify(result.state)).not.toContain("PRIVATE-FOREIGN-ROW");
      expect(result.state.threads[0]?.activeLeafId).toBe(result.state.threads[0]?.messages[0]?.id);
      expect(readdirSync(DATA_DIR).sort()).toEqual(names);
      for (const original of before) { expect(readFileSync(join(DATA_DIR, original.name))).toEqual(original.bytes);
        expect(statSync(join(DATA_DIR, original.name)).ino).toBe(original.stat.ino); expect(statSync(join(DATA_DIR, original.name)).mtimeMs).toBe(original.stat.mtimeMs); }
    } finally { settings.close(); closeMessageDb(); }
  });
});
