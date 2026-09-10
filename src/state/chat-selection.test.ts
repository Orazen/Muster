import { afterEach, describe, expect, it, vi } from "vitest";
import { readChatSelection, saveChatSelection, type SelectionStorage } from "./chat-selection";
import { initialState, reducer, type Bot, type Group } from "./store";

class MemorySelectionStorage implements SelectionStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

const basil: Bot = {
  id: "basil", threadId: "basil-thread", name: "Basil", title: "", description: "",
  notifications: true, color: "green", unread: false, messages: [],
  modelSelection: { instanceId: "codex", model: "default" },
};
const noodle: Bot = { ...basil, id: "noodle", threadId: "noodle-thread", name: "Noodle" };
const room: Group = {
  id: "ops", threadId: "ops-thread", name: "Ops", memberIds: [basil.id, noodle.id],
  defaultResponder: { kind: "everyone" }, bulletin: "", unread: false, createdAt: 1, messages: [],
};

afterEach(() => vi.unstubAllGlobals());

describe("chat selection restoration", () => {
  it.each([noodle.id, room.id])("restores non-first selection %s after reload with a prepended bot", (selectedId) => {
    const storage = new MemorySelectionStorage();
    saveChatSelection("account-a", selectedId, storage);
    const reloaded = reducer({ ...initialState, selectedId: readChatSelection("account-a", storage) }, {
      type: "hydrate", bots: [basil, noodle], groups: [room],
    });
    expect(reloaded.selectedId).toBe(selectedId);
  });

  it("preserves a live choice over saved selection when hydration arrives late, including reconnect", () => {
    const storage = new MemorySelectionStorage();
    saveChatSelection("account-a", noodle.id, storage);
    const seeded = reducer({ ...initialState, selectedId: readChatSelection("account-a", storage) }, {
      type: "hydrate", bots: [basil, noodle], groups: [room],
    });
    const chosen = reducer(seeded, { type: "select", id: room.id });
    const late = reducer(chosen, { type: "hydrate", bots: [basil, noodle], groups: [room] });
    expect(late.selectedId).toBe(room.id);
    const reconnected = reducer(late, { type: "hydrate", bots: [noodle, basil], groups: [room] });
    expect(reconnected.selectedId).toBe(room.id);
    saveChatSelection("account-a", reconnected.selectedId, storage);
    expect(readChatSelection("account-a", storage)).toBe(room.id);
  });

  it.each(["deleted-bot", basil.id])("falls back from stale or hidden selection %s to the first visible bot", (selectedId) => {
    const restored = reducer({ ...initialState, selectedId }, {
      type: "hydrate", bots: [{ ...basil, hidden: true }, noodle], groups: [room],
    });
    expect(restored.selectedId).toBe(noodle.id);
  });

  it("falls back to a group when every bot is hidden and clears selection when no chats remain", () => {
    const restored = reducer({ ...initialState, selectedId: "removed-room" }, {
      type: "hydrate", bots: [{ ...basil, hidden: true }], groups: [room],
    });
    expect(restored.selectedId).toBe(room.id);
    expect(reducer(restored, { type: "hydrate", bots: [{ ...basil, hidden: true }], groups: [] }).selectedId).toBe("");
  });

  it("isolates account selections even when the accounts have the same roster", () => {
    const storage = new MemorySelectionStorage();
    saveChatSelection("account-a", noodle.id, storage);
    expect(readChatSelection("account-b", storage)).toBe("");
    saveChatSelection("account-b", basil.id, storage);
    expect(readChatSelection("account-a", storage)).toBe(noodle.id);
    expect(readChatSelection("account-b", storage)).toBe(basil.id);
    saveChatSelection("account-b", "", storage);
    expect(readChatSelection("account-b", storage)).toBe("");
    expect(readChatSelection("account-a", storage)).toBe(noodle.id);
  });

  it("uses the current tab's sessionStorage without changing another tab", () => {
    const firstTab = new MemorySelectionStorage();
    const secondTab = new MemorySelectionStorage();
    vi.stubGlobal("window", { sessionStorage: firstTab });
    saveChatSelection("account-a", noodle.id);
    vi.stubGlobal("window", { sessionStorage: secondTab });
    expect(readChatSelection("account-a")).toBe("");
    saveChatSelection("account-a", room.id);
    expect(readChatSelection("account-a", firstTab)).toBe(noodle.id);
    expect(readChatSelection("account-a", secondTab)).toBe(room.id);
  });

  it.each(["not-json", "null", '{"version":2,"selectedId":"noodle"}', '{"version":1,"selectedId":5}'])
    ("ignores corrupt or unsupported storage: %s", (saved) => {
      const storage = new MemorySelectionStorage();
      saveChatSelection("account-a", noodle.id, storage);
      for (const key of storage.values.keys()) storage.setItem(key, saved);
      expect(readChatSelection("account-a", storage)).toBe("");
    });

  it("does not crash when storage access, reads or writes are denied", () => {
    vi.stubGlobal("window", { get sessionStorage() { throw new Error("storage unavailable"); } });
    expect(readChatSelection("account-a")).toBe("");
    expect(() => saveChatSelection("account-a", noodle.id)).not.toThrow();
    const blocked: SelectionStorage = {
      getItem() { throw new Error("read denied"); },
      setItem() { throw new Error("quota exceeded"); },
      removeItem() { throw new Error("delete denied"); },
    };
    expect(readChatSelection("account-a", blocked)).toBe("");
    expect(() => saveChatSelection("account-a", noodle.id, blocked)).not.toThrow();
    expect(() => saveChatSelection("account-a", "", blocked)).not.toThrow();
  });

  it("does not create an unscoped record without an account identity", () => {
    const storage = new MemorySelectionStorage();
    saveChatSelection("", noodle.id, storage);
    expect(storage.values.size).toBe(0);
    expect(readChatSelection("", storage)).toBe("");
  });
});
