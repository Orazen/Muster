import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canEnterStep,
  canSendFirstTask,
  clampOnboardingStep,
  clearOnboardingDraft,
  FIRST_TASK_TEMPLATES,
  ONBOARDING_NEED_OPTIONS,
  ONBOARDING_NEEDS_MAX,
  ONBOARDING_STAGES,
  ONBOARDING_STEPS,
  readOnboardingDraft,
  resolveFirstTaskTemplate,
  resolveInitialTaskDraft,
  sanitizeNeeds,
  saveOnboardingDraft,
  stageForStep,
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
  version: 2,
  step: "first-task",
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
  it.each(ONBOARDING_STEPS)("round-trips the $id step with exact late-step input", ({ id }) => {
    const storage = new MemoryDraftStorage();
    const current: OnboardingDraft = {
      ...draft, step: id, name: "  Sam  ", email: "sam@", suggestion: "  Option\n", customTask: "  e\u0301 brief\n\t",
    };
    saveOnboardingDraft("account-a", current, storage);
    expect(readOnboardingDraft("account-a", storage)).toEqual(current);
    expect(JSON.parse(storage.getItem("muster:onboarding-draft:v2:account-a") ?? "null")).toEqual(current);
  });

  it("round-trips a draft through storage per account", () => {
    const storage = new MemoryDraftStorage();
    saveOnboardingDraft("account-a", draft, storage);
    expect(readOnboardingDraft("account-a", storage)).toEqual(draft);
    // account isolation: another account reads nothing
    expect(readOnboardingDraft("account-b", storage)).toBeNull();
  });

  it("treats corrupt, wrong-version, and oversized payloads as no draft", () => {
    const storage = new MemoryDraftStorage();
    storage.setItem("muster:onboarding-draft:v2:account-a", "{not json");
    expect(readOnboardingDraft("account-a", storage)).toBeNull();
    storage.setItem(
      "muster:onboarding-draft:v2:account-a",
      JSON.stringify({ ...draft, version: 3 }),
    );
    expect(readOnboardingDraft("account-a", storage)).toBeNull();
    storage.setItem(
      "muster:onboarding-draft:v2:account-a",
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
    saveOnboardingDraft("account-a", { ...draft, customTask: "x".repeat(4001) }, storage);
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
    storage.setItem("muster:onboarding-draft:v2:account-a", JSON.stringify({ ...draft, ...welcome }));
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

  it("tolerates denied reads, writes and removals and uses a tombstone when removal is blocked", () => {
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
    expect(readOnboardingDraft("account-a", storage)).toBeNull();
    expect(storage.getItem("muster:onboarding-draft:v2:account-a")).toBe("null");
  });
});

describe("onboarding draft migration", () => {
  const legacyKey = "muster:onboarding-draft:v1:account-a";
  const currentKey = "muster:onboarding-draft:v2:account-a";
  const legacy = { ...draft, version: 1, step: 4, customTask: "  Preserve my\nexact answer\t" };

  it.each([0, 1, 2, 3, 4])("preserves v1 fields at ambiguous index %i but reopens Welcome", (step) => {
    const storage = new MemoryDraftStorage();
    storage.setItem(legacyKey, JSON.stringify({ ...legacy, step }));
    const expected = { ...legacy, version: 2, step: "welcome" };
    expect(readOnboardingDraft("account-a", storage)).toEqual(expected);
    expect(JSON.parse(storage.getItem(currentKey) ?? "null")).toEqual(expected);
    expect(storage.getItem(legacyKey)).toBeNull();
    expect(readOnboardingDraft("account-a", storage)).toEqual(expected);
  });

  it("keeps cleared fields and optional omissions during migration instead of applying a URL template", () => {
    const storage = new MemoryDraftStorage();
    storage.setItem(legacyKey, JSON.stringify({ ...legacy, suggestion: "", customTask: "" }));
    const restored = readOnboardingDraft("account-a", storage);
    expect(restored).not.toHaveProperty("name");
    expect(restored).not.toHaveProperty("email");
    expect(resolveInitialTaskDraft(restored, "weekly-priorities")).toEqual({ suggestion: "", customTask: "" });
  });

  it.each(["", "{invalid", "null", JSON.stringify({ ...draft, step: "future-step" }), JSON.stringify({ ...draft, version: 3 })])(
    "does not revive v1 beneath malformed or cleared v2: %s", (saved) => {
      const storage = new MemoryDraftStorage();
      storage.setItem(legacyKey, JSON.stringify(legacy));
      storage.setItem(currentKey, saved);
      expect(readOnboardingDraft("account-a", storage)).toBeNull();
      expect(storage.getItem(currentKey)).toBe(saved);
      expect(storage.getItem(legacyKey)).toBe(JSON.stringify(legacy));
    },
  );

  it("prefers current exact fields over legacy fields", () => {
    const storage = new MemoryDraftStorage();
    storage.setItem(legacyKey, JSON.stringify(legacy));
    storage.setItem(currentKey, JSON.stringify(draft));
    expect(readOnboardingDraft("account-a", storage)).toEqual(draft);
  });

  it.each([-1, 1.5, 5, 6])("rejects invalid v1 step %i instead of inventing a legacy layout", (step) => {
    const storage = new MemoryDraftStorage();
    const raw = JSON.stringify({ ...legacy, step });
    storage.setItem(legacyKey, raw);
    expect(readOnboardingDraft("account-a", storage)).toBeNull();
    expect(storage.getItem(currentKey)).toBeNull();
    expect(storage.getItem(legacyKey)).toBe(raw);
  });

  it("keeps the only legacy copy when migration storage fails and retries on the next read", () => {
    const storage = new MemoryDraftStorage();
    storage.setItem(legacyKey, JSON.stringify(legacy));
    const removeItem = vi.fn(storage.removeItem.bind(storage));
    const blocked: OnboardingStorage = {
      getItem: storage.getItem.bind(storage),
      setItem() { throw new Error("quota exceeded"); },
      removeItem,
    };
    expect(readOnboardingDraft("account-a", blocked)).toEqual({ ...legacy, version: 2, step: "welcome" });
    expect(removeItem).not.toHaveBeenCalled();
    expect(storage.getItem(legacyKey)).toBe(JSON.stringify(legacy));
    expect(storage.getItem(currentKey)).toBeNull();
    expect(readOnboardingDraft("account-a", storage)?.step).toBe("welcome");
    expect(storage.getItem(legacyKey)).toBeNull();
  });

  it("keeps v2 authoritative when old-key removal fails after a successful migration or save", () => {
    const storage = new MemoryDraftStorage();
    storage.setItem(legacyKey, JSON.stringify(legacy));
    const blocked: OnboardingStorage = {
      getItem: storage.getItem.bind(storage), setItem: storage.setItem.bind(storage),
      removeItem() { throw new Error("removal denied"); },
    };
    expect(readOnboardingDraft("account-a", blocked)?.step).toBe("welcome");
    expect(storage.getItem(legacyKey)).toBe(JSON.stringify(legacy));
    saveOnboardingDraft("account-a", draft, blocked);
    expect(readOnboardingDraft("account-a", storage)).toEqual(draft);
  });

  it("migrates and clears only the selected account, with encoded account keys", () => {
    const storage = new MemoryDraftStorage();
    for (const accountId of ["account-a", "account/a", "account%2Fa"]) {
      storage.setItem(`muster:onboarding-draft:v1:${encodeURIComponent(accountId)}`, JSON.stringify({ ...legacy, botName: accountId }));
    }
    expect(readOnboardingDraft("account/a", storage)?.botName).toBe("account/a");
    expect(readOnboardingDraft("account%2Fa", storage)?.botName).toBe("account%2Fa");
    clearOnboardingDraft("account/a", storage);
    expect(readOnboardingDraft("account/a", storage)).toBeNull();
    expect(readOnboardingDraft("account%2Fa", storage)?.botName).toBe("account%2Fa");
    expect(storage.getItem(legacyKey)).not.toBeNull();
    expect(storage.getItem(currentKey)).toBeNull();
  });

  it("clears both versions when both exist", () => {
    const storage = new MemoryDraftStorage();
    storage.setItem(legacyKey, JSON.stringify(legacy));
    storage.setItem(currentKey, JSON.stringify(draft));
    clearOnboardingDraft("account-a", storage);
    expect(storage.values.size).toBe(0);
    expect(readOnboardingDraft("account-a", storage)).toBeNull();
  });

  it("tombstones v2 when legacy removal fails so clearing cannot expose the old task", () => {
    const storage = new MemoryDraftStorage();
    storage.setItem(legacyKey, JSON.stringify(legacy));
    storage.setItem(currentKey, JSON.stringify(draft));
    const blocked: OnboardingStorage = {
      getItem: storage.getItem.bind(storage), setItem: storage.setItem.bind(storage),
      removeItem(key) { if (key === legacyKey) throw new Error("legacy denied"); storage.removeItem(key); },
    };
    clearOnboardingDraft("account-a", blocked);
    expect(storage.getItem(legacyKey)).not.toBeNull();
    expect(storage.getItem(currentKey)).toBe("null");
    expect(readOnboardingDraft("account-a", storage)).toBeNull();
    saveOnboardingDraft("account-a", draft, storage);
    expect(readOnboardingDraft("account-a", storage)).toEqual(draft);
    expect(storage.getItem(legacyKey)).toBeNull();
  });

  it("keeps current v2 if legacy removal and tombstone writing both fail", () => {
    const storage = new MemoryDraftStorage();
    storage.setItem(legacyKey, JSON.stringify(legacy));
    storage.setItem(currentKey, JSON.stringify(draft));
    const blocked: OnboardingStorage = {
      getItem: storage.getItem.bind(storage),
      setItem() { throw new Error("write denied"); },
      removeItem() { throw new Error("removal denied"); },
    };
    clearOnboardingDraft("account-a", blocked);
    expect(readOnboardingDraft("account-a", storage)).toEqual(draft);
  });

  it("removes legacy even if current removal fails", () => {
    const storage = new MemoryDraftStorage();
    storage.setItem(legacyKey, JSON.stringify(legacy));
    storage.setItem(currentKey, JSON.stringify(draft));
    const blocked: OnboardingStorage = {
      getItem: storage.getItem.bind(storage), setItem: storage.setItem.bind(storage),
      removeItem(key) { if (key === currentKey) throw new Error("current denied"); storage.removeItem(key); },
    };
    clearOnboardingDraft("account-a", blocked);
    expect(storage.getItem(legacyKey)).toBeNull();
    expect(readOnboardingDraft("account-a", storage)).toEqual(draft);
  });

  it("preserves the existing 4000-unit task cap in both formats", () => {
    const storage = new MemoryDraftStorage();
    const maximum = "\ud83c\udf38".repeat(2000);
    saveOnboardingDraft("account-a", { ...draft, customTask: maximum }, storage);
    expect(readOnboardingDraft("account-a", storage)?.customTask).toBe(maximum);
    saveOnboardingDraft("account-a", { ...draft, customTask: `${maximum}x` }, storage);
    expect(readOnboardingDraft("account-a", storage)?.customTask).toBe(maximum);
    storage.removeItem(currentKey);
    storage.setItem(legacyKey, JSON.stringify({ ...legacy, customTask: `${maximum}x` }));
    expect(readOnboardingDraft("account-a", storage)).toBeNull();
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
    storage.setItem("muster:onboarding-draft:v2:account-a", JSON.stringify({ ...draft, axes: { companion: -1 } }));
    const stored = readOnboardingDraft("account-a", storage);
    expect(stored).toBeNull();
    expect(resolveInitialTaskDraft(stored, "notes-to-draft")).toEqual({ suggestion: "", customTask: FIRST_TASK_TEMPLATES["notes-to-draft"] });
  });
});

describe("presentation stage mapping", () => {
  it("maps every step onto the five-phase arc in order", () => {
    expect(ONBOARDING_STEPS.map((entry) => stageForStep(entry.id))).toEqual([
      "intro", "intro", "connect", "needs", "needs", "acks", "handoff",
    ]);
  });

  it("only emits stages the arc declares", () => {
    for (const entry of ONBOARDING_STEPS) {
      expect(ONBOARDING_STAGES).toContain(stageForStep(entry.id));
    }
  });
});

describe("first-task gate helpers", () => {
  const handoffIndex = ONBOARDING_STEPS.findIndex((entry) => entry.id === "first-task");
  const permissionsIndex = ONBOARDING_STEPS.findIndex((entry) => entry.id === "permissions");

  it("gates exactly the handoff step, closed and open", () => {
    expect(ONBOARDING_STEPS.map((_, index) => canEnterStep(index, false))).toEqual([
      true, true, true, true, true, true, false,
    ]);
    expect(ONBOARDING_STEPS.map((_, index) => canEnterStep(index, true))).toEqual([
      true, true, true, true, true, true, true,
    ]);
  });

  it("parks a gated handoff step on Permissions and releases it untouched", () => {
    expect(clampOnboardingStep(handoffIndex, false)).toBe(permissionsIndex);
    expect(ONBOARDING_STEPS[permissionsIndex].id).toBe("permissions");
    expect(clampOnboardingStep(handoffIndex, true)).toBe(handoffIndex);
    expect(clampOnboardingStep(permissionsIndex, false)).toBe(permissionsIndex);
    expect(clampOnboardingStep(0, false)).toBe(0);
  });

  it("allows sending a first task only from the handoff step with an engine", () => {
    expect(canSendFirstTask(handoffIndex, true)).toBe(true);
    expect(canSendFirstTask(handoffIndex, false)).toBe(false);
    expect(canSendFirstTask(permissionsIndex, true)).toBe(false);
    expect(canSendFirstTask(0, true)).toBe(false);
  });
});

describe("needs multi-select draft fields", () => {
  const known = ONBOARDING_NEED_OPTIONS.map((option) => option.id);

  it("round-trips picks and free text, and drops the keys when cleared", () => {
    const storage = new MemoryDraftStorage();
    const withNeeds: OnboardingDraft = {
      ...draft,
      needs: known.slice(0, ONBOARDING_NEEDS_MAX),
      otherNeed: "The weekly ops report",
    };
    saveOnboardingDraft("account-a", withNeeds, storage);
    expect(readOnboardingDraft("account-a", storage)).toEqual(withNeeds);
    saveOnboardingDraft("account-a", draft, storage);
    const cleared = readOnboardingDraft("account-a", storage);
    expect(cleared).toEqual(draft);
    expect(cleared).not.toHaveProperty("needs");
    expect(cleared).not.toHaveProperty("otherNeed");
  });

  it("rejects more ids than the lenient restore cap, oversized ids, and oversized free text", () => {
    const storage = new MemoryDraftStorage();
    saveOnboardingDraft("account-a", { ...draft, needs: [...known, "ninth"] }, storage);
    expect(storage.values.size).toBe(0);
    saveOnboardingDraft("account-a", { ...draft, needs: ["x".repeat(65)] }, storage);
    expect(storage.values.size).toBe(0);
    saveOnboardingDraft("account-a", { ...draft, otherNeed: "x".repeat(201) }, storage);
    expect(storage.values.size).toBe(0);
  });

  it("measures free text in UTF-16 units so emoji cannot overflow the cap", () => {
    const storage = new MemoryDraftStorage();
    const maximum = "🙂".repeat(100); // 200 UTF-16 units
    saveOnboardingDraft("account-a", { ...draft, otherNeed: maximum }, storage);
    expect(readOnboardingDraft("account-a", storage)?.otherNeed).toBe(maximum);
    // A refused save must never overwrite a valid draft — prove the cap by
    // showing nothing lands in storage (same contract as other rejections).
    const overflow = new MemoryDraftStorage();
    saveOnboardingDraft("account-a", { ...draft, otherNeed: "🙂".repeat(101) }, overflow);
    expect(overflow.values.size).toBe(0);
  });

  it("sanitizes restored picks down to live known ids at the UI cap", () => {
    const atCap = known.slice(0, ONBOARDING_NEEDS_MAX);
    expect(sanitizeNeeds(undefined)).toEqual([]);
    expect(sanitizeNeeds(["ghost", ...atCap])).toEqual(atCap);
    expect(sanitizeNeeds(known)).toEqual(atCap);
  });
});
