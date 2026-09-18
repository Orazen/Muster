import { describe, expect, it } from "vitest";
import {
  ANNOYED_HOLD_MS,
  DIZZY_HOLD_MS,
  INITIAL_INTERACTION,
  POKES_TO_ANNOY,
  POKE_WINDOW_MS,
  SLAP_DIZZY_AFTER_MS,
  poke,
  resolveCharacter,
  slap,
  statusForBotActivity,
  statusLine,
  tickInteraction,
} from "./character";

const T0 = 1_000_000;

describe("statusLine", () => {
  it("always narrates non-idle statuses, never idle", () => {
    expect(statusLine("idle", "anything")).toBe("");
    expect(statusLine("working", undefined)).toBe("Working");
    expect(statusLine("working", "the deploy")).toBe("Working — the deploy");
    expect(statusLine("thinking", "the bug")).toBe("Thinking about the bug");
    expect(statusLine("uploading", "3 files")).toBe("Sending 3 files");
    expect(statusLine("finished", "the report")).toBe("Done — the report");
    expect(statusLine("error", "the parse")).toBe("Hit a problem — the parse");
  });
});

describe("resolveCharacter — the coexistence invariant", () => {
  it("an override borrows the face but never changes status, motion or label", () => {
    const base = resolveCharacter({ status: "working", face: "focused", override: null, task: "deploy" });
    const poked = resolveCharacter({ status: "working", face: "focused", override: "annoyed", task: "deploy" });
    const slapped = resolveCharacter({ status: "working", face: "focused", override: "slapped", task: "deploy" });
    const dizzy = resolveCharacter({ status: "working", face: "focused", override: "dizzy", task: "deploy" });
    for (const state of [poked, slapped, dizzy]) {
      expect(state.status).toBe("working");
      expect(state.motion).toBe(base.motion);
      expect(state.label).toBe(base.label);
    }
    expect(poked.face).toBe("mad");
    expect(slapped.face).toBe("scared");
    expect(dizzy.face).toBe("unsure");
    expect(base.face).toBe("focused");
  });

  it("idle + override still has an empty label — interactions are never status", () => {
    const state = resolveCharacter({ status: "idle", face: "idle", override: "dizzy" });
    expect(state.label).toBe("");
    expect(state.face).toBe("unsure");
  });

  it("calm is the off switch: no override face, still rendering", () => {
    const state = resolveCharacter({ status: "working", face: "focused", override: "annoyed", task: "x", calm: true });
    expect(state.face).toBe("focused");
    expect(state.still).toBe(true);
  });

  it("reduced motion forces still and drops the override too", () => {
    const state = resolveCharacter({ status: "idle", face: "idle", override: "slapped", reducedMotion: true });
    expect(state.still).toBe(true);
    expect(state.face).toBe("idle");
  });

  it("non-idle statuses map to the app's existing motion vocabulary", () => {
    expect(resolveCharacter({ status: "thinking", face: "idle" }).motion).toBe("thinking");
    expect(resolveCharacter({ status: "uploading", face: "idle" }).motion).toBe("working");
    expect(resolveCharacter({ status: "finished", face: "idle" }).motion).toBe("success");
    expect(resolveCharacter({ status: "error", face: "idle" }).motion).toBe("failure");
  });
});

describe("interaction machine — poke, annoy, slap, dizzy", () => {
  it("two pokes are harmless", () => {
    let s = poke(INITIAL_INTERACTION, T0);
    s = poke(s, T0 + 500);
    expect(s.override).toBeNull();
    expect(s.pokes).toHaveLength(2);
  });

  it(`${POKES_TO_ANNOY} pokes within the window annoy for ${ANNOYED_HOLD_MS}ms, then reset the counter`, () => {
    let s = poke(INITIAL_INTERACTION, T0);
    s = poke(s, T0 + 400);
    s = poke(s, T0 + 800);
    expect(s.override).toBe("annoyed");
    expect(s.overrideUntil).toBe(T0 + 800 + ANNOYED_HOLD_MS);
    expect(s.pokes).toHaveLength(0); // grudge resets after the beat
  });

  it("pokes outside the window are pruned — no long-memory grudge", () => {
    let s = poke(INITIAL_INTERACTION, T0);
    s = poke(s, T0 + POKE_WINDOW_MS + 1);
    s = poke(s, T0 + POKE_WINDOW_MS + 2);
    expect(s.override).toBeNull(); // only 2 within the window
  });

  it("a slap stuns, hands off to dizzy, and dizzy decays clean", () => {
    let s = slap(INITIAL_INTERACTION, T0);
    expect(s.override).toBe("slapped");
    expect(s.overrideUntil).toBe(T0 + SLAP_DIZZY_AFTER_MS);
    // mid-stun tick: still stunned
    s = tickInteraction(s, T0 + 1_000);
    expect(s.override).toBe("slapped");
    // stun over: dizzy takes over for its own hold
    s = tickInteraction(s, T0 + SLAP_DIZZY_AFTER_MS + 1);
    expect(s.override).toBe("dizzy");
    expect(s.overrideUntil).toBe(T0 + SLAP_DIZZY_AFTER_MS + 1 + DIZZY_HOLD_MS);
    // dizzy over: fully reset
    s = tickInteraction(s, T0 + SLAP_DIZZY_AFTER_MS + DIZZY_HOLD_MS + 10);
    expect(s).toEqual(INITIAL_INTERACTION);
  });

  it("annoyed decays without a dizzy hand-off", () => {
    let s = poke(INITIAL_INTERACTION, T0);
    s = poke(s, T0 + 10);
    s = poke(s, T0 + 20);
    s = tickInteraction(s, T0 + 20 + ANNOYED_HOLD_MS + 1);
    expect(s).toEqual(INITIAL_INTERACTION);
  });

  it("tick is a no-op while nothing is pending — no state churn", () => {
    let s = poke(INITIAL_INTERACTION, T0);
    s = poke(s, T0 + 10);
    const frozen = { ...s };
    expect(tickInteraction(s, T0 + 20)).toEqual(frozen);
  });
});

describe("statusForBotActivity", () => {
  it("derives from facts the store already has", () => {
    expect(statusForBotActivity({})).toBe("idle");
    expect(statusForBotActivity({ busy: true })).toBe("working");
    expect(statusForBotActivity({ busy: true }, true)).toBe("thinking");
    expect(statusForBotActivity({ unread: true })).toBe("finished");
    expect(statusForBotActivity({ lastToolFailed: true, busy: true })).toBe("error");
  });
});
