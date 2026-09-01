import { describe, expect, it } from "vitest";
import {
  describeFreeBestChain,
  pickFreeBest,
  recordFreeBestFailure,
  type FreeCandidate,
} from "./free-best.ts";

const T0 = 1_000_000;

function cand(overrides: Partial<FreeCandidate> & { instanceId: string }): FreeCandidate {
  return { access: "free", state: "available", models: 10, lastFailureAt: null, ...overrides };
}

describe("pickFreeBest", () => {
  it("only serves available instances", () => {
    const pick = pickFreeBest([
      cand({ instanceId: "dead", state: "unavailable", models: 99 }),
      cand({ instanceId: "alive" }),
    ]);
    expect(pick?.instanceId).toBe("alive");
  });

  it("skips candidates inside the cooldown window", () => {
    const pick = pickFreeBest(
      [
        cand({ instanceId: "hot", lastFailureAt: T0 - 5 * 60_000 }),
        cand({ instanceId: "cool", models: 1 }),
      ],
      { now: T0 },
    );
    expect(pick?.instanceId).toBe("cool");
  });

  it("allows candidates back once the cooldown lapses (default 10 min)", () => {
    const fleet = [cand({ instanceId: "hot", lastFailureAt: T0 - 9 * 60_000, models: 50 })];
    expect(pickFreeBest(fleet, { now: T0 })).toBeNull();
    expect(pickFreeBest(fleet, { now: T0 + 60_001 })?.instanceId).toBe("hot");
  });

  it("honors a custom cooldownMs", () => {
    const fleet = [cand({ instanceId: "hot", lastFailureAt: T0 - 30_000 })];
    expect(pickFreeBest(fleet, { now: T0, cooldownMs: 60_000 })).toBeNull();
    expect(pickFreeBest(fleet, { now: T0, cooldownMs: 10_000 })?.instanceId).toBe("hot");
  });

  it("ranks free above subscription, and subscription above metered", () => {
    const fleet = [
      cand({ instanceId: "metered", access: "metered", models: 99 }),
      cand({ instanceId: "sub", access: "subscription", models: 50 }),
      cand({ instanceId: "free", models: 1 }),
    ];
    expect(pickFreeBest(fleet, { now: T0 })?.instanceId).toBe("free");
  });

  it("breaks access ties by most models", () => {
    const fleet = [
      cand({ instanceId: "narrow", models: 3 }),
      cand({ instanceId: "wide", models: 42 }),
    ];
    expect(pickFreeBest(fleet, { now: T0 })?.instanceId).toBe("wide");
  });

  it("breaks model ties by least-recent failure", () => {
    const fleet = [
      cand({ instanceId: "tripped", lastFailureAt: T0 - 9 * 60_000 }),
      cand({ instanceId: "pristine", lastFailureAt: null }),
    ];
    expect(pickFreeBest(fleet, { now: T0 })?.instanceId).toBe("pristine");
  });

  it("returns null when nothing qualifies", () => {
    expect(pickFreeBest([], { now: T0 })).toBeNull();
    expect(
      pickFreeBest([cand({ instanceId: "down", state: "unavailable" })], { now: T0 }),
    ).toBeNull();
    expect(
      pickFreeBest([cand({ instanceId: "hot", lastFailureAt: T0 - 1 })], { now: T0 }),
    ).toBeNull();
  });
});

describe("recordFreeBestFailure", () => {
  it("stamps the failure time into the caller's map", () => {
    const failures = new Map<string, number>();
    recordFreeBestFailure("a", failures, T0);
    expect(failures.get("a")).toBe(T0);
  });

  it("stays bounded at 256 entries, evicting oldest", () => {
    const failures = new Map<string, number>();
    for (let i = 0; i < 300; i++) {
      recordFreeBestFailure(`i${i}`, failures, T0 + i);
    }
    expect(failures.size).toBe(256);
    expect(failures.has("i0")).toBe(false);
    expect(failures.has("i299")).toBe(true);
  });

  it("evicts expired cooldown entries before evicting live ones", () => {
    const failures = new Map<string, number>();
    // seed 256 ancient failures, all long past the 10-minute cooldown
    for (let i = 0; i < 256; i++) {
      recordFreeBestFailure(`old${i}`, failures, T0 - 60 * 60_000);
    }
    recordFreeBestFailure("fresh", failures, T0);
    expect(failures.has("fresh")).toBe(true);
    expect(failures.has("old0")).toBe(false); // expired entry swept, not "fresh"
  });
});

describe("describeFreeBestChain", () => {
  it("renders the full cascade order", () => {
    const fleet = [
      cand({ instanceId: "sub", access: "subscription", models: 90 }),
      cand({ instanceId: "freeBig", models: 30 }),
      cand({ instanceId: "freeSmall", models: 5 }),
      cand({ instanceId: "down", state: "unavailable" }),
    ];
    // access tier dominates model count: freeSmall (5 models) still beats sub (90)
    expect(describeFreeBestChain(fleet, { now: T0 })).toEqual(["freeBig", "freeSmall", "sub"]);
  });

  it("matches the pick — head of the chain is what pickFreeBest returns", () => {
    const fleet = [
      cand({ instanceId: "b", models: 2 }),
      cand({ instanceId: "a", models: 9 }),
    ];
    const chain = describeFreeBestChain(fleet, { now: T0 });
    expect(chain[0]).toBe(pickFreeBest(fleet, { now: T0 })?.instanceId);
  });

  it("drops cooled-down instances from the displayed chain", () => {
    const fleet = [
      cand({ instanceId: "hot", lastFailureAt: T0 - 60_000 }),
      cand({ instanceId: "ok" }),
    ];
    expect(describeFreeBestChain(fleet, { now: T0 })).toEqual(["ok"]);
  });
});
