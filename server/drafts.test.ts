import { afterEach, describe, expect, it, vi } from "vitest";

import {
  appendDraft,
  seedDraft,
  subscribeDraft,
  getDraft,
  getDraftAttachments,
  setDraft,
  setDraftAttachments,
} from "../src/lib/drafts.ts";
import { fileAttachment, pasteAttachment } from "../src/lib/composer-attachments.ts";

function memoryStore() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("composer drafts", () => {
  it("notifies only subscribers to the changed store and conversation, and unsubscribes", () => {
    const store = memoryStore();
    const other = memoryStore();
    const received: string[] = [];
    const stop = subscribeDraft(store, "bot:one", () => received.push(getDraft(store, "bot:one")));
    const stopOther = subscribeDraft(other, "bot:one", () => received.push("wrong store"));
    const stopRoom = subscribeDraft(store, "group:two", () => received.push("wrong conversation"));
    setDraft(store, "bot:one", "typing");
    stop();
    setDraft(store, "bot:one", "later");
    expect(received).toEqual(["typing"]);
    stopOther();
    stopRoom();
  });

  it("appends to text typed while preparation was pending and preserves attachments", () => {
    const store = memoryStore();
    vi.stubGlobal("localStorage", store);
    const attachments = [pasteAttachment("notes"), fileAttachment("notes.txt", "/tmp/notes.txt", 12)];
    seedDraft("bot:one", "initial text");
    setDraftAttachments(store, "bot:one", attachments);
    setDraft(store, "bot:one", "initial text plus later typing");
    appendDraft("bot:one", "prepared plan");
    expect(getDraft(store, "bot:one")).toBe("initial text plus later typing\n\nprepared plan");
    expect(getDraftAttachments(store, "bot:one")).toEqual(attachments);
    expect(getDraft(store, "bot:two")).toBe("");
    seedDraft("bot:one", "replacement");
    expect(getDraft(store, "bot:one")).toBe("replacement");
  });

  it("keeps quota-failed typing current for append, reads and notifications", () => {
    const persisted = memoryStore();
    setDraft(persisted, "bot:one", "old persisted value");
    const store = { getItem: persisted.getItem, setItem: () => { throw new Error("quota"); } };
    vi.stubGlobal("localStorage", store);
    const received: string[] = [];
    const stop = subscribeDraft(store, "bot:one", () => received.push(getDraft(store, "bot:one")));
    setDraft(store, "bot:one", "latest typing");
    appendDraft("bot:one", "plan");
    expect(getDraft(store, "bot:one")).toBe("latest typing\n\nplan");
    expect(received).toEqual(["latest typing", "latest typing\n\nplan"]);
    stop();
  });

  it("uses replacement storage contents after successful writes", () => {
    const store = memoryStore();
    vi.stubGlobal("localStorage", store);
    seedDraft("bot:one", "previous session");
    store.setItem("omb-drafts", "{}");
    appendDraft("bot:one", "fresh plan");
    expect(getDraft(store, "bot:one")).toBe("fresh plan");
  });

  it("recovers persistence after quota failure and can clear the draft", () => {
    const persisted = memoryStore();
    let blocked = true;
    const store = { getItem: persisted.getItem, setItem: (key: string, value: string) => {
      if (blocked) throw new Error("quota");
      persisted.setItem(key, value);
    } };
    setDraft(store, "bot:one", "unsaved");
    blocked = false;
    setDraft(store, "bot:one", "saved");
    expect(getDraft(persisted, "bot:one")).toBe("saved");
    setDraft(store, "bot:one", "");
    expect(getDraft(store, "bot:one")).toBe("");
  });

  it("keeps text and attachments isolated per bot or room", () => {
    const store = memoryStore();
    const paste = pasteAttachment("bot paste");
    const file = fileAttachment("notes.txt", "/tmp/notes.txt", 12);
    setDraft(store, "bot:one", "hello");
    setDraftAttachments(store, "bot:one", [paste, file]);
    setDraft(store, "group:two", "room text");

    expect(getDraft(store, "bot:one")).toBe("hello");
    expect(getDraftAttachments(store, "bot:one")).toEqual([paste, file]);
    expect(getDraft(store, "group:two")).toBe("room text");
    expect(getDraftAttachments(store, "group:two")).toEqual([]);
  });

  it("clears empty entries and ignores malformed stored attachments", () => {
    const store = memoryStore();
    setDraft(store, "bot:one", "hello");
    setDraft(store, "bot:one", "");
    store.setItem(
      "omb-draft-attachments",
      JSON.stringify({ "bot:one": [{ kind: "paste", id: "broken" }] }),
    );

    expect(getDraft(store, "bot:one")).toBe("");
    expect(getDraftAttachments(store, "bot:one")).toEqual([]);
  });
});
