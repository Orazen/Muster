import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearOnboardingDraft,
  FIRST_TASK_TEMPLATES,
  readOnboardingDraft,
  resolveFirstTaskTemplate,
  resolveInitialTaskDraft,
  saveOnboardingDraft,
  type OnboardingDraft,
  type OnboardingStorage,
} from "./onboarding-draft";

class MemoryDraftStorage implements OnboardingStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

const draft: OnboardingDraft = {
  version: 1,
  step: 4,
  botName: "Scout",
  botRole: "Research",
  botColor: "orange",
  botCharacter: "star",
  suggestion: "",
  customTask: "Draft the launch brief",
  showPersonality: true,
  axes: { companion: 62, tone: 50, independence: 40, depth: 55, honesty: 60 },
};

afterEach(() => vi.unstubAllGlobals());

describe("onboarding draft persistence", () => {
  it("round-trips a draft through storage per account", () => {
    const storage = new MemoryDraftStorage();
    saveOnboardingDraft("account-a", draft, storage);
    expect(readOnboardingDraft("account-a", storage)).toEqual(draft);
    // account isolation: another account reads nothing
    expect(readOnboardingDraft("account-b", storage)).toBeNull();
  });

  it("treats corrupt, wrong-version, and oversized payloads as no draft", () => {
    const storage = new MemoryDraftStorage();
    storage.setItem("muster:onboarding-draft:v1:account-a", "{not json");
    expect(readOnboardingDraft("account-a", storage)).toBeNull();
    storage.setItem(
      "muster:onboarding-draft:v1:account-a",
      JSON.stringify({ ...draft, version: 2 }),
    );
    expect(readOnboardingDraft("account-a", storage)).toBeNull();
    storage.setItem(
      "muster:onboarding-draft:v1:account-a",
      JSON.stringify({ ...draft, botName: "x".repeat(101) }),
    );
    expect(readOnboardingDraft("account-a", storage)).toBeNull();
  });

  it("clears on success and no-ops without an account or storage", () => {
    const storage = new MemoryDraftStorage();
    saveOnboardingDraft("account-a", draft, storage);
    clearOnboardingDraft("account-a", storage);
    expect(readOnboardingDraft("account-a", storage)).toBeNull();
    expect(() => saveOnboardingDraft(undefined, draft, storage)).not.toThrow();
    expect(() => saveOnboardingDraft("account-a", draft, null)).not.toThrow();
    expect(readOnboardingDraft(undefined, storage)).toBeNull();
  });

  it("refuses to save a draft that violates the schema", () => {
    const storage = new MemoryDraftStorage();
    saveOnboardingDraft("account-a", { ...draft, step: 9 }, storage);
    expect(storage.values.size).toBe(0);
  });

  it.each([
    { name: "Sam Rivera", email: "sam@" },
    { name: "", email: "" },
  ])("preserves optional welcome fields, including unfinished or cleared input: %j", (welcome) => {
    const storage = new MemoryDraftStorage();
    saveOnboardingDraft("account-a", { ...draft, ...welcome }, storage);
    expect(readOnboardingDraft("account-a", storage)).toEqual({ ...draft, ...welcome });
  });

  it.each([
    { name: "n".repeat(101) },
    { email: "e".repeat(321) },
  ])("rejects oversized welcome fields without overwriting a valid saved draft", (welcome) => {
    const storage = new MemoryDraftStorage();
    saveOnboardingDraft("account-a", draft, storage);
    saveOnboardingDraft("account-a", { ...draft, ...welcome }, storage);
    expect(readOnboardingDraft("account-a", storage)).toEqual(draft);
    storage.setItem("muster:onboarding-draft:v1:account-a", JSON.stringify({ ...draft, ...welcome }));
    expect(readOnboardingDraft("account-a", storage)).toBeNull();
  });

  it("tolerates blocked storage getters and an absent browser", () => {
    vi.stubGlobal("window", { get sessionStorage() { throw new Error("storage denied"); } });
    expect(readOnboardingDraft("account-a")).toBeNull();
    expect(() => saveOnboardingDraft("account-a", draft)).not.toThrow();
    expect(() => clearOnboardingDraft("account-a")).not.toThrow();
    vi.stubGlobal("window", undefined);
    expect(readOnboardingDraft("account-a")).toBeNull();
    expect(() => saveOnboardingDraft("account-a", draft)).not.toThrow();
    expect(() => clearOnboardingDraft("account-a")).not.toThrow();
  });

  it("tolerates denied reads, writes and removals without claiming the old draft was cleared", () => {
    const blocked: OnboardingStorage = {
      getItem() { throw new Error("read denied"); },
      setItem() { throw new Error("quota exceeded"); },
      removeItem() { throw new Error("removal denied"); },
    };
    expect(readOnboardingDraft("account-a", blocked)).toBeNull();
    expect(() => saveOnboardingDraft("account-a", draft, blocked)).not.toThrow();
    expect(() => clearOnboardingDraft("account-a", blocked)).not.toThrow();
    const storage = new MemoryDraftStorage();
    saveOnboardingDraft("account-a", draft, storage);
    const deniedRemoval = { getItem: storage.getItem.bind(storage), setItem: storage.setItem.bind(storage), removeItem: blocked.removeItem };
    clearOnboardingDraft("account-a", deniedRemoval);
    expect(readOnboardingDraft("account-a", storage)).toEqual(draft);
  });
});

describe("first-task template allowlist", () => {
  it("resolves allowlisted ids to their prompts", () => {
    for (const [id, prompt] of Object.entries(FIRST_TASK_TEMPLATES)) {
      expect(resolveFirstTaskTemplate(id)).toBe(prompt);
    }
  });

  it("ignores unknown or missing ids", () => {
    expect(resolveFirstTaskTemplate("drop-tables")).toBe("");
    expect(resolveFirstTaskTemplate("")).toBe("");
    expect(resolveFirstTaskTemplate(null)).toBe("");
    expect(resolveFirstTaskTemplate(undefined)).toBe("");
  });

  it.each(["__proto__", "constructor", "toString"])("rejects inherited object property %s", (id) => {
    expect(resolveFirstTaskTemplate(id)).toBe("");
  });
});

describe("first-task restoration precedence", () => {
  it("uses an allowlisted template only when there is no saved or live task draft", () => {
    expect(resolveInitialTaskDraft(null, "weekly-priorities")).toEqual({
      suggestion: "", customTask: FIRST_TASK_TEMPLATES["weekly-priorities"],
    });
    expect(resolveInitialTaskDraft(null, "constructor")).toEqual({ suggestion: "", customTask: "" });
  });

  it.each([
    { suggestion: "", customTask: "My edited brief" },
    { suggestion: FIRST_TASK_TEMPLATES["field-brief"], customTask: "" },
    { suggestion: "", customTask: "" },
  ])("restores saved task fields before the URL, including an explicit clear: %j", (stored) => {
    expect(resolveInitialTaskDraft(stored, "weekly-priorities")).toEqual(stored);
  });

  it.each([
    { suggestion: "My live choice", customTask: "" },
    { suggestion: "", customTask: "My live draft" },
    { suggestion: "", customTask: "" },
  ])("preserves explicit live edits before storage and URL: %j", (live) => {
    expect(resolveInitialTaskDraft(draft, "weekly-priorities", live)).toEqual(live);
  });

  it("falls back to the template when stored draft validation fails", () => {
    const storage = new MemoryDraftStorage();
    storage.setItem("muster:onboarding-draft:v1:account-a", JSON.stringify({ ...draft, axes: { companion: -1 } }));
    const stored = readOnboardingDraft("account-a", storage);
    expect(stored).toBeNull();
    expect(resolveInitialTaskDraft(stored, "notes-to-draft")).toEqual({ suggestion: "", customTask: FIRST_TASK_TEMPLATES["notes-to-draft"] });
  });
});
