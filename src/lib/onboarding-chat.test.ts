// Pins for the conversational onboarding beats engine. No I/O.
import { describe, expect, it } from "vitest";

import { beatAt, beatCount, ONBOARDING_CHAT_BEATS, planCrew, type Turn } from "./onboarding-chat";

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
});
