// Pins for the conversational onboarding beats engine. No I/O.
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  beatAdvancesOnPick,
  beatAt,
  beatCount,
  markOnboardingChatDone,
  ONBOARDING_CHAT_BEATS,
  ONBOARDING_CHAT_DONE_KEY,
  ONBOARDING_COMPLETION_KEY,
  onboardingChatDone,
  planCrew,
  readOnboardingCompletion,
  writeOnboardingCompletion,
  type Turn,
} from "./onboarding-chat";

describe("onboarding chat beats", () => {
  it("orders the flow and clamps the index", () => {
    expect(beatCount()).toBe(5);
    expect(beatAt(0).id).toBe("greet");
    expect(beatAt(4).id).toBe("done");
    expect(beatAt(99).id).toBe("done");
    expect(beatAt(-3).id).toBe("greet");
  });

  it("every beat with chips carries options; terminal beats do not", () => {
    for (const beat of ONBOARDING_CHAT_BEATS) {
      if (beat.kind === "none") expect(beat.options).toBeUndefined();
      else expect((beat.options ?? []).length).toBeGreaterThan(2);
    }
    const pains = ONBOARDING_CHAT_BEATS.find((b) => b.id === "pains")!;
    expect(pains.kind).toBe("multi");
    expect(pains.max).toBe(3);
  });

  it("plans a real crew with pain-sharpened descriptions", () => {
    const plan = planCrew("research-desk", ["research", "tracking"]);
    expect(plan?.key).toBe("research-desk");
    expect(plan?.members.length).toBeGreaterThan(1);
    const desc = plan!.members[0]!.description.toLowerCase();
    expect(desc).toContain("first focus");
    expect(desc).toContain("research");
  });

  it("returns null for the empty path and unknown ids", () => {
    expect(planCrew("empty", [])).toBeNull();
    expect(planCrew("nonexistent", [])).toBeNull();
  });

  it("turns type only ever speaks as assistant or user", () => {
    const turns: Turn[] = [
      { who: "assistant", text: "Hey!" },
      { who: "user", text: "Marketing" },
    ];
    expect(turns.every((t) => t.who === "assistant" || t.who === "user")).toBe(true);
  });

  it("does not auto-advance the crew beat — its Continue button runs the hire", () => {
    // Regression: the crew chip used to advance straight to the "done" beat,
    // which renders no interactive control. That stranded the user on a
    // screen that claimed the crew was hired while POST /api/bots never ran.
    const crew = beatAt(3);
    expect(crew.id).toBe("crew");
    expect(beatAdvancesOnPick(crew)).toBe(false);
    // role and pains still advance normally
    expect(beatAdvancesOnPick(beatAt(1))).toBe(true); // role
  });

  it("every single-select beat either advances or is the crew (the only safe hold)", () => {
    // If a future beat is added between crew and done, advancing on its pick
    // must not land on the non-interactive "done" beat.
    const singles = ONBOARDING_CHAT_BEATS.filter((b) => b.kind === "single");
    for (const beat of singles) {
      const next = ONBOARDING_CHAT_BEATS[ONBOARDING_CHAT_BEATS.indexOf(beat) + 1];
      const landsOnDone = next?.id === "done";
      expect(landsOnDone && beatAdvancesOnPick(beat)).toBe(false);
    }
  });
});

// Versioned completion record (openbot study §5, S1): additive `{version,
// completedAt, surface}` written beside the bare flag, never replacing it.
function stubStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  });
  return store;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("onboarding completion record", () => {
  it("returns null when nothing was completed", () => {
    stubStorage();
    expect(readOnboardingCompletion()).toBeNull();
  });

  it("reads a wizard record even without the chat flag (the flag is the chat surface's)", () => {
    stubStorage({
      [ONBOARDING_COMPLETION_KEY]: JSON.stringify({ version: 1, completedAt: 123, surface: "wizard" }),
    });
    expect(onboardingChatDone()).toBe(false);
    expect(readOnboardingCompletion()).toEqual({
      version: 1,
      completedAt: 123,
      surface: "wizard",
    });
  });

  it("treats a legacy bare flag as version 1 with unknown completedAt", () => {
    stubStorage({ [ONBOARDING_CHAT_DONE_KEY]: "1" });
    expect(onboardingChatDone()).toBe(true);
    expect(readOnboardingCompletion()).toEqual({
      version: 1,
      completedAt: null,
      surface: "chat",
    });
  });

  it("writes the record with the given surface, leaving the flag beside it untouched", () => {
    const store = stubStorage({ [ONBOARDING_CHAT_DONE_KEY]: "1" });
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    writeOnboardingCompletion("chat");
    expect(readOnboardingCompletion()).toEqual({
      version: 1,
      completedAt: 1_700_000_000_000,
      surface: "chat",
    });
    expect(store.get(ONBOARDING_CHAT_DONE_KEY)).toBe("1");
  });

  it("keeps the first stamp when written again (first write wins)", () => {
    const store = stubStorage();
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    writeOnboardingCompletion("chat");
    vi.setSystemTime(1_800_000_000_000);
    writeOnboardingCompletion("wizard");
    const record = store.get(ONBOARDING_COMPLETION_KEY)!;
    expect(record).toContain('"completedAt":1700000000000');
    expect(record).toContain('"surface":"chat"');
  });

  it("never lets a malformed record block the bare flag", () => {
    stubStorage({
      [ONBOARDING_CHAT_DONE_KEY]: "1",
      [ONBOARDING_COMPLETION_KEY]: "{not json",
    });
    expect(onboardingChatDone()).toBe(true);
    expect(readOnboardingCompletion()).toEqual({
      version: 1,
      completedAt: null,
      surface: "chat",
    });
  });

  it("repairs a malformed record in place on the next write, keeping the flag", () => {
    const store = stubStorage({
      [ONBOARDING_CHAT_DONE_KEY]: "1",
      [ONBOARDING_COMPLETION_KEY]: "{not json",
    });
    writeOnboardingCompletion("wizard");
    expect(readOnboardingCompletion()).toEqual({
      version: 1,
      completedAt: expect.any(Number),
      surface: "wizard",
    });
    expect(store.get(ONBOARDING_CHAT_DONE_KEY)).toBe("1");
  });

  it("never throws when storage is blocked (private mode)", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => {
          throw new Error("SecurityError");
        },
        setItem: () => {
          throw new Error("SecurityError");
        },
      },
    });
    expect(() => writeOnboardingCompletion("chat")).not.toThrow();
    expect(() => markOnboardingChatDone()).not.toThrow();
    expect(() => readOnboardingCompletion()).not.toThrow();
    expect(onboardingChatDone()).toBe(false);
    expect(readOnboardingCompletion()).toBeNull();
  });

  it("markOnboardingChatDone writes the flag first, then the chat record", () => {
    const store = stubStorage();
    markOnboardingChatDone();
    expect(store.get(ONBOARDING_CHAT_DONE_KEY)).toBe("1");
    expect(readOnboardingCompletion()).toMatchObject({ version: 1, surface: "chat" });
    expect(readOnboardingCompletion()?.completedAt).toBeTypeOf("number");
  });
});
