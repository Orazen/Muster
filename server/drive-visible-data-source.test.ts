import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readAccountVisibleSource, type AccountVisibleSourceInput, type DriveThreadSnapshot } from "./drive-visible-data-source.ts";
import { parseVisibleFiles } from "./drive-visible.ts";
import { Store, type BotRecord, type GroupRecord, type Message } from "./store.ts";
import { TaskPlanEngine } from "./task-engine.ts";
import { DATA_DIR } from "./config.ts";
import { closeMessageDb } from "./message-db.ts";
import type { TaskPlanRecord } from "./contracts.ts";

const alice = { userId: "alice", sessionId: "alice-session", workspaceId: "alice-org", isPrimary: false };
const bob = { userId: "bob", sessionId: "bob-session", workspaceId: "bob-org", isPrimary: false };
function bot(id: string, ownerId?: string): BotRecord {
  return { id, ownerId, threadId: `${id}-thread`, name: id, title: `${id} title`, description: `${id} description`,
    notifications: false, color: "green", unread: false, createdAt: 1, modelSelection: { instanceId: "offline", model: "test" },
    resumeCursors: { provider: "PRIVATE-CURSOR-NEVER-EXPORT" },
    tasks: [{ threadId: `${id}-thread`, title: `${id} task`, createdAt: 1, resumeCursors: { provider: "PRIVATE-TASK-CURSOR" } }],
  };
}
function group(id: string, memberIds: string[], ownerId = "alice"): GroupRecord {
  return { id, ownerId, memberIds, threadId: `${id}-thread`, name: id, defaultResponder: { kind: "mentions" },
    bulletin: "", unread: false, createdAt: 1 };
}
function plan(id: string, botId: string, ownerId = "alice"): TaskPlanRecord {
  return { id, botId, ownerId, title: `${id} plan`, status: "queued", steps: [], currentStep: null,
    attempts: 0, maxAttempts: 3, inputAnswers: [], createdAt: 1, updatedAt: 2 };
}
const message = (id: string, text = id): Message => ({ id, role: "user", kind: "text", at: 5, text, parentId: null });

describe("account-owned visible source", () => {
  let dataDir: string;
  let input: AccountVisibleSourceInput;
  let plans: TaskPlanRecord[];
  let snapshots: Map<string, DriveThreadSnapshot>;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "muster-drive-source-"));
    plans = [plan("alice-plan", "alice-bot"), plan("bob-plan", "bob-bot", "bob")];
    snapshots = new Map([
      ["alice-bot-thread", { status: "ready", source: "sqlite", messages: [message("alice-message", "Alice original content")], activeLeafId: "alice-message" }],
      ["bob-bot-thread", { status: "ready", source: "sqlite", messages: [message("bob-message", "BOB-PRIVATE")], activeLeafId: "bob-message" }],
      ["legacy-thread", { status: "ready", source: "legacy", messages: [], activeLeafId: null }],
    ]);
    input = {
      account: alice, dataDir, settingsSnapshot: { userId: "alice", workspaceId: "alice-org", values: { theme: "dark", density: "compact" } },
      store: { bots: [bot("alice-bot", "alice"), bot("bob-bot", "bob")], groups: [],
        snapshotThread: vi.fn((threadId: string): DriveThreadSnapshot => snapshots.get(threadId) ?? { status: "unavailable", reason: "source-unavailable" }),
      },
      plans: { listPlans: () => structuredClone(plans) },
    };
    for (const botId of ["alice-bot", "bob-bot"]) {
      mkdirSync(join(dataDir, "workspaces", botId, "memory"), { recursive: true });
      writeFileSync(join(dataDir, "workspaces", botId, "MEMORY.md"), `${botId} memory`);
      writeFileSync(join(dataDir, "workspaces", botId, "memory", "topic.md"), `${botId} topic`);
    }
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  it("projects all five files through the real parser without foreign content or credential fields", () => {
    const result = readAccountVisibleSource(input);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("Expected source readiness");
    expect(Object.keys(result.files).sort()).toEqual(["memory.json", "sessions.json", "settings.json", "soul.md", "tasks.json"]);
    expect(parseVisibleFiles(result.files)).toEqual(result.documents);
    expect(result.inventory).toEqual({ botIds: ["alice-bot"], groupIds: [], threadIds: ["alice-bot-thread"], taskIds: ["alice-bot-thread", "alice-plan"] });
    expect(result.documents.sessions.threads[0]?.messages[0]?.text).toBe("Alice original content");
    expect(result.documents.memory.bots[0]?.topics).toEqual([{ name: "topic.md", text: "alice-bot topic" }]);
    const bodies = Object.values(result.files).join("\n");
    expect(bodies).not.toContain("bob");
    expect(bodies).not.toContain("PRIVATE-CURSOR");
    expect(bodies).not.toContain("PRIVATE-TASK-CURSOR");
    expect(input.store.snapshotThread).toHaveBeenCalledExactlyOnceWith("alice-bot-thread");
  });

  it("selects another authenticated account independently", () => {
    const result = readAccountVisibleSource({ ...input, account: bob,
      settingsSnapshot: { userId: "bob", workspaceId: "bob-org", values: { theme: "light" } } });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("Expected source readiness");
    expect(result.inventory.botIds).toEqual(["bob-bot"]);
    expect(Object.values(result.files).join("\n")).not.toContain("alice");
  });

  it("permits unowned legacy records only for the primary account", () => {
    input.store.bots.push({ ...bot("legacy"), threadId: "legacy-thread", tasks: [] });
    const regular = readAccountVisibleSource(input);
    const primary = readAccountVisibleSource({ ...input, account: { ...alice, isPrimary: true } });
    expect(regular.status === "ready" && regular.inventory.botIds).toEqual(["alice-bot"]);
    expect(primary.status === "ready" && primary.inventory.botIds).toEqual(["alice-bot", "legacy"]);
  });

  it("includes a non-primary account's legacy ownerless plan through its real owned bot", () => {
    delete plans[0]!.ownerId;
    const result = readAccountVisibleSource(input);
    expect(result.status).toBe("ready");
    expect(result.status === "ready" && result.inventory.taskIds).toEqual(["alice-bot-thread", "alice-plan"]);
  });

  it("excludes a foreign bot's legacy ownerless plan without blocking the primary account", () => {
    delete plans[1]!.ownerId;
    const result = readAccountVisibleSource({ ...input, account: { ...alice, isPrimary: true } });
    expect(result.status).toBe("ready");
    expect(result.status === "ready" && result.inventory.taskIds).toEqual(["alice-bot-thread", "alice-plan"]);
  });

  it.each([null, { userId: "bob", workspaceId: "alice-org", values: {} },
    { userId: "alice", workspaceId: "other-org", values: {} }])("refuses missing or mismatched settings %j before source reads", settingsSnapshot => {
    expect(readAccountVisibleSource({ ...input, settingsSnapshot })).toEqual({ status: "unavailable", reason: "settings-unavailable" });
    expect(input.store.snapshotThread).not.toHaveBeenCalled();
  });

  it("refuses credential-shaped settings even if a producer would drop them", () => {
    expect(readAccountVisibleSource({ ...input, settingsSnapshot: { userId: "alice", workspaceId: "alice-org", values: { accessToken: "SYNTHETIC-PRIVATE" } } }).status).toBe("unavailable");
  });

  it("reports nonsecret omitted settings instead of using global config", () => {
    const result = readAccountVisibleSource({ ...input, settingsSnapshot: { userId: "alice", workspaceId: "alice-org", values: { theme: "dark", unknownPreference: true } } });
    expect(result.status === "ready" && result.droppedSettings).toEqual(["unknownPreference"]);
  });

  it("refuses a thread also referenced by another account before reading it", () => {
    input.store.bots[1]!.threadId = "alice-bot-thread";
    expect(readAccountVisibleSource(input)).toEqual({ status: "unavailable", reason: "ownership-conflict" });
    expect(input.store.snapshotThread).not.toHaveBeenCalled();
  });

  it.each([{ memberIds: ["bob-bot"] }, { memberIds: ["missing-bot"] }])("refuses groups with foreign or unavailable members $memberIds", ({ memberIds }) => {
    input.store.groups.push(group("alice-group", memberIds));
    expect(readAccountVisibleSource(input)).toEqual({ status: "unavailable", reason: "ownership-conflict" });
    expect(input.store.snapshotThread).not.toHaveBeenCalled();
  });

  it("includes the full owned group and archived task transcripts", () => {
    input.store.groups.push(group("alice-group", ["alice-bot"]));
    input.store.bots[0]!.tasks!.push({ threadId: "archived", title: "Old task", createdAt: 0, resumeCursors: {} });
    snapshots.set("archived", { status: "ready", source: "sqlite", messages: [message("old")], activeLeafId: "old" });
    snapshots.set("alice-group-thread", { status: "ready", source: "sqlite", messages: [message("group")], activeLeafId: "group" });
    const result = readAccountVisibleSource(input);
    expect(result.status === "ready" && result.inventory.threadIds).toEqual(["alice-bot-thread", "alice-group-thread", "archived"]);
  });

  it.each(["missing-bot", "bob-bot"])("refuses an owned plan attached to %s", botId => {
    plans[0]!.botId = botId;
    expect(readAccountVisibleSource(input)).toEqual({ status: "unavailable", reason: "ownership-conflict" });
    expect(input.store.snapshotThread).not.toHaveBeenCalled();
  });

  it("refuses an owned plan referencing a foreign thread", () => {
    plans[0]!.threadId = "bob-bot-thread";
    expect(readAccountVisibleSource(input)).toEqual({ status: "unavailable", reason: "ownership-conflict" });
  });

  it.each(["source-unavailable", "invalid-data", "pending-writes", "read-limit"] as const)("does not replace %s transcripts with empty output", reason => {
    snapshots.set("alice-bot-thread", { status: "unavailable", reason });
    expect(readAccountVisibleSource(input)).toEqual({ status: "unavailable", reason: reason === "read-limit" ? "read-limit" : "source-unavailable" });
  });

  it("rejects bad message bytes at the actual parser boundary", () => {
    snapshots.set("alice-bot-thread", { status: "ready", source: "sqlite", messages: [message("")], activeLeafId: null });
    expect(readAccountVisibleSource(input).status).toBe("unavailable");
  });

  it("detects owner changes during an injected reader call", () => {
    input.store.snapshotThread = () => {
      input.store.bots[0]!.ownerId = "bob";
      return { status: "ready", source: "sqlite", messages: [], activeLeafId: null };
    };
    expect(readAccountVisibleSource(input)).toEqual({ status: "unavailable", reason: "ownership-conflict" });
  });

  it("keeps body and authority binding in the digest", () => {
    const first = readAccountVisibleSource(input);
    const repeat = readAccountVisibleSource(input);
    snapshots.set("alice-bot-thread", { status: "ready", source: "sqlite", messages: [message("alice-message", "Changed body")], activeLeafId: "alice-message" });
    const changed = readAccountVisibleSource(input);
    const otherWorkspace = readAccountVisibleSource({ ...input, account: { ...alice, workspaceId: "new-org" },
      settingsSnapshot: { userId: "alice", workspaceId: "new-org", values: { theme: "dark", density: "compact" } } });
    expect(first.status === "ready" && repeat.status === "ready" && first.digest === repeat.digest).toBe(true);
    expect(first.status === "ready" && changed.status === "ready" && first.digest !== changed.digest).toBe(true);
    expect(changed.status === "ready" && otherWorkspace.status === "ready" && changed.digest !== otherWorkspace.digest).toBe(true);
  });

  it("returns defensive projection values without changing source bytes, inodes or directory entries", () => {
    const file = join(dataDir, "workspaces", "alice-bot", "MEMORY.md");
    const bytes = readFileSync(file); const before = statSync(file);
    const entries = readdirSync(dataDir);
    const result = readAccountVisibleSource(input);
    if (result.status !== "ready") throw new Error("Expected source readiness");
    result.documents.sessions.threads[0]!.messages[0]!.text = "mutated output";
    expect(snapshots.get("alice-bot-thread")).toMatchObject({ messages: [{ text: "Alice original content" }] });
    expect(readFileSync(file)).toEqual(bytes);
    expect(statSync(file).ino).toBe(before.ino);
    expect(statSync(file).mtimeMs).toBe(before.mtimeMs);
    expect(readdirSync(dataDir)).toEqual(entries);
  });

  it("treats genuinely absent never-created memory as empty without creating it", () => {
    rmSync(join(dataDir, "workspaces", "alice-bot"), { recursive: true });
    const result = readAccountVisibleSource(input);
    expect(result.status === "ready" && result.documents.memory.bots[0]).toEqual({ botId: "alice-bot", text: "", truncated: false, topics: [] });
    expect(readdirSync(join(dataDir, "workspaces"))).toEqual(["bob-bot"]);
  });

  it.each(["workspace", "memory-file", "topic-dir", "topic-file"])("refuses symbolic links at %s", place => {
    const root = join(dataDir, "workspaces", "alice-bot");
    const path = place === "workspace" ? root : place === "memory-file" ? join(root, "MEMORY.md")
      : place === "topic-dir" ? join(root, "memory") : join(root, "memory", "topic.md");
    const target = place === "workspace" ? join(dataDir, "workspaces", "bob-bot")
      : place === "memory-file" ? join(dataDir, "workspaces", "bob-bot", "MEMORY.md")
      : place === "topic-dir" ? join(dataDir, "workspaces", "bob-bot", "memory")
      : join(dataDir, "workspaces", "bob-bot", "memory", "topic.md");
    rmSync(path, { recursive: true }); symlinkSync(target, path);
    expect(readAccountVisibleSource(input)).toEqual({ status: "unavailable", reason: "source-unavailable" });
  });

  it("refuses invalid workspace IDs rather than permitting traversal", () => {
    input.store.bots[0]!.id = "../bob-bot";
    expect(readAccountVisibleSource(input).status).toBe("unavailable");
    expect(input.store.snapshotThread).not.toHaveBeenCalled();
  });

  it("refuses oversized or invalid UTF-8 memory without truncating export", () => {
    const file = join(dataDir, "workspaces", "alice-bot", "MEMORY.md");
    writeFileSync(file, Buffer.alloc(256 * 1024 + 1));
    expect(readAccountVisibleSource(input)).toEqual({ status: "unavailable", reason: "read-limit" });
    writeFileSync(file, Buffer.from([0xff, 0xfe]));
    expect(readAccountVisibleSource(input)).toEqual({ status: "unavailable", reason: "source-unavailable" });
  });

  it("allows an explicitly captured empty preference set, but requires the actual root", () => {
    const result = readAccountVisibleSource({ ...input, settingsSnapshot: { userId: "alice", workspaceId: "alice-org", values: {} } });
    expect(result.status).toBe("ready");
    rmSync(dataDir, { recursive: true });
    expect(readAccountVisibleSource(input).status).toBe("unavailable");
  });
});

describe("visible source against the real durable Store reader", () => {
  beforeEach(() => { closeMessageDb(); rmSync(DATA_DIR, { recursive: true, force: true }); });

  it("round-trips persisted rows after restart without legacy import, source edits or mutation of another account", () => {
    const initial = new Store(() => ({ instanceId: "offline", model: "test" }));
    const own = initial.createBot({ ownerId: "alice", name: "Own" }, { seedMessages: false });
    const foreign = initial.createBot({ ownerId: "bob", name: "Foreign" }, { seedMessages: false });
    initial.appendMessage(own.threadId, { role: "user", kind: "text", text: "Durable row after restart" });
    initial.appendMessage(foreign.threadId, { role: "user", kind: "text", text: "Foreign private durable row" });
    closeMessageDb();
    const store = new Store(() => ({ instanceId: "offline", model: "test" }));
    const plans = new TaskPlanEngine({ file: join(DATA_DIR, "task-plans.json") });
    const fileNames = readdirSync(DATA_DIR).sort();
    const before = fileNames.map(name => ({ name, body: readFileSync(join(DATA_DIR, name)), stat: statSync(join(DATA_DIR, name)) }));
    const result = readAccountVisibleSource({ account: alice, store, plans, dataDir: DATA_DIR,
      settingsSnapshot: { userId: "alice", workspaceId: "alice-org", values: { theme: "dark" } } });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("Expected real durable source readiness");
    expect(result.documents.sessions.threads).toHaveLength(1);
    expect(result.documents.sessions.threads[0]?.messages[0]?.text).toBe("Durable row after restart");
    expect(parseVisibleFiles(result.files)).toEqual(result.documents);
    expect(Object.values(result.files).join("\n")).not.toContain("Foreign private durable row");
    expect(readdirSync(DATA_DIR).sort()).toEqual(fileNames);
    for (const original of before) {
      expect(readFileSync(join(DATA_DIR, original.name))).toEqual(original.body);
      expect(statSync(join(DATA_DIR, original.name)).ino).toBe(original.stat.ino);
      expect(statSync(join(DATA_DIR, original.name)).mtimeMs).toBe(original.stat.mtimeMs);
    }
  });

  it("refuses the real closed reader instead of substituting cached messages", () => {
    const store = new Store(() => ({ instanceId: "offline", model: "test" }));
    const own = store.createBot({ ownerId: "alice", name: "Own" }, { seedMessages: false });
    store.appendMessage(own.threadId, { role: "user", kind: "text", text: "Cached but not readable" });
    const plans = new TaskPlanEngine({ file: join(DATA_DIR, "task-plans.json") });
    closeMessageDb();
    expect(readAccountVisibleSource({ account: alice, store, plans, dataDir: DATA_DIR,
      settingsSnapshot: { userId: "alice", workspaceId: "alice-org", values: {} } }))
      .toEqual({ status: "unavailable", reason: "source-unavailable" });
  });
});
