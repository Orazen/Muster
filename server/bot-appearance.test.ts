import { readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { AGENT_CHARACTERS, Store } from "./store.ts";
import { type AgentCharacter, AGENT_CHARACTERS as CHARACTER_CONTRACT } from "./agent-character.ts";

// The suite's existing setup owns this throwaway DATA_DIR and closes SQLite after each case.
const selection = (): ModelSelection => ({ instanceId: "configured-provider", model: "saved-model", effort: "high" });
const crew = ["designer", "researcher", "developer", "coordinator"] as const;

describe("opt-in crew appearance persistence", () => {
  beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));

  it.each(crew)("persists %s on creation and appearance-only patch without replacing conversation or permissions", character => {
    const store = new Store(selection);
    const created = store.createBot({ character, color: "purple", ownerId: "owner-a" }, { seedMessages: false });
    const existing = store.createBot({ name: "Keep my name", character: "flower", color: "teal", ownerId: "owner-b", mascotExpression: "curious" }, { seedMessages: false });
    store.patchBot(existing.id, { autoApprove: false, browser: false, computer: "off", alwaysAllow: ["Read"], notifications: false, resumeCursors: { "saved-engine": "saved-cursor" } });
    store.appendMessage(existing.threadId, { role: "user", kind: "text", text: "Keep this conversation" });
    const before = structuredClone(store.bot(existing.id)!);
    const transcript = structuredClone(store.messagesFor(existing.threadId));
    store.patchBot(existing.id, { character });
    expect(store.bot(existing.id)).toEqual({ ...before, character });
    const restored = new Store(() => { throw new Error("Appearance reload must not select a provider"); });
    expect(restored.bot(created.id)).toMatchObject({ character, color: "purple", ownerId: "owner-a" });
    expect(restored.bot(existing.id)).toMatchObject({ ...before, character });
    expect(restored.messagesFor(existing.threadId)).toEqual(transcript);
    const bytes = readFileSync(join(DATA_DIR, "bots.json"));
    const inode = statSync(join(DATA_DIR, "bots.json")).ino;
    new Store(selection);
    expect(readFileSync(join(DATA_DIR, "bots.json"))).toEqual(bytes);
    expect(statSync(join(DATA_DIR, "bots.json")).ino).toBe(inode);
  });

  it.each(["flower", "star", "blob", "lottie"] as const satisfies readonly AgentCharacter[])("keeps saved %s choices and color when crew becomes available", character => {
    const store = new Store(selection);
    const saved = store.createBot({ character, color: "cyan", mascotExpression: "shy" }, { seedMessages: false });
    expect(new Store(selection).bot(saved.id)).toMatchObject({ character, color: "cyan", mascotExpression: "shy" });
    expect(new Store(selection).createBot({}, { seedMessages: false })).toMatchObject({ character: "star", color: "orange" });
  });

  it("keeps the existing PATCH/import vocabulary as the single append-only character contract", () => {
    expect(AGENT_CHARACTERS).toBe(CHARACTER_CONTRACT);
    expect(AGENT_CHARACTERS.slice(0, 16)).toEqual([
      "flower", "star", "blob", "cursor", "hexagon", "triangle", "egg", "drop", "heart",
      "pebble", "squircle", "capsule", "cloud", "ball", "sparkle", "circle",
    ]);
    expect(AGENT_CHARACTERS.slice(16)).toEqual(crew);
    expect(AGENT_CHARACTERS).not.toContain("lottie");
    expect(AGENT_CHARACTERS).not.toContain("thinking-dots");
    expect(AGENT_CHARACTERS).not.toContain("unknown-character");
  });
});
