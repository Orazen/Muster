import { describe, expect, it } from "vitest";
import { countWaitingOnYou, resolveTrayView, trayStatusFor, type TrayBotInput } from "./tray-state";
import { statusForBotActivity } from "./character";

function bot(overrides: Partial<TrayBotInput> = {}): TrayBotInput {
  return { id: "b1", name: "Mimi", color: "orange", ...overrides };
}

describe("trayStatusFor — stays in sync with the web statusForBotActivity", () => {
  const facts: Array<Partial<TrayBotInput>> = [
    {},
    { busy: true },
    { busy: true, streaming: "partial words" },
    { unread: true },
    { lastToolFailed: true },
    { lastToolFailed: true, busy: true },
  ];
  for (const fact of facts) {
    it(`maps ${JSON.stringify(fact)} identically on web and tray`, () => {
      expect(trayStatusFor(bot(fact))).toBe(statusForBotActivity(fact, Boolean(fact.streaming)));
    });
  }
});

describe("resolveTrayView — one bot in focus, the rest in sight", () => {
  it("a waiting bot wins focus and the attention mood", () => {
    const { bots, mood } = resolveTrayView([
      bot({ id: "a", busy: true, lastToolFailed: true }),
      bot({ id: "b", activity: "waiting-on-you", unread: true }),
      bot({ id: "c" }),
    ]);
    expect(mood).toBe("attention");
    expect(bots.find((view) => view.id === "b")?.focus).toBe(true);
    expect(bots.filter((view) => view.focus)).toHaveLength(1);
  });

  it("without waiting, the highest-ranked working bot is in focus", () => {
    const { bots, mood } = resolveTrayView([
      bot({ id: "a" }),
      bot({ id: "b", busy: true }),
      bot({ id: "c", unread: true }),
    ]);
    expect(mood).toBe("working");
    expect(bots.find((view) => view.id === "b")?.focus).toBe(true);
  });

  it("settled mood when only unread bots remain, idle when quiet", () => {
    const settled = resolveTrayView([bot({ id: "a", unread: true }), bot({ id: "b" })]);
    expect(settled.mood).toBe("settled");
    const quiet = resolveTrayView([bot({ id: "a" }), bot({ id: "b" })]);
    expect(quiet.mood).toBe("idle");
    expect(quiet.bots.every((view) => !view.focus)).toBe(true);
  });

  it("every non-idle bot carries a non-empty narrated line", () => {
    const { bots } = resolveTrayView([
      bot({ id: "a", busy: true }),
      bot({ id: "b", unread: true }),
      bot({ id: "c" }),
    ]);
    for (const view of bots) {
      if (view.status === "idle") expect(view.line).toBe("");
      else expect(view.line.length).toBeGreaterThan(0);
    }
  });
});

describe("countWaitingOnYou — the badge line's number", () => {
  it("counts every waiting bot and nothing else", () => {
    expect(
      countWaitingOnYou([
        bot({ id: "a", activity: "waiting-on-you" }),
        bot({ id: "b", busy: true }),
        bot({ id: "c", activity: "waiting-on-you" }),
        bot({ id: "d" }),
      ]),
    ).toBe(2);
    expect(countWaitingOnYou([])).toBe(0);
  });

  it("matches resolveTrayView's attention mood: waiting ⇒ count ≥ 1", () => {
    const waiting = resolveTrayView([bot({ id: "a" }), bot({ id: "b", activity: "waiting-on-you" })]);
    expect(waiting.mood).toBe("attention");
    expect(countWaitingOnYou([bot({ id: "a" }), bot({ id: "b", activity: "waiting-on-you" })])).toBe(1);
    const quiet = resolveTrayView([bot({ id: "a" })]);
    expect(quiet.mood).not.toBe("attention");
    expect(countWaitingOnYou([bot({ id: "a" })])).toBe(0);
  });
});
