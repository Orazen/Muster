import { describe, expect, it } from "vitest";
import { fallbackEligible, markAttempted, pickAlternate } from "./provider-fallback.ts";

describe("fallbackEligible", () => {
  it("accepts confident rate-limit errors", () => {
    expect(fallbackEligible("t1", "OpenCode Zen (API) HTTP 429: {…}")).toBe(true);
    expect(fallbackEligible("t2", "rate limit exceeded")).toBe(true);
    expect(fallbackEligible("t3", "insufficient credit")).toBe(true);
  });

  it("refuses everything else — auth errors, setup deaths, typos", () => {
    expect(fallbackEligible("t4", "HTTP 401 unauthorized")).toBe(false);
    expect(fallbackEligible("t5", "Install a supported container runtime first")).toBe(false);
    expect(fallbackEligible("t6", "")).toBe(false);
    expect(fallbackEligible("t7", "insufficient permissions to read balance")).toBe(false);
    expect(fallbackEligible("t8", "HTTP 403 quota API access denied")).toBe(false);
  });

  it("one attempt per thread per cooldown", () => {
    const t0 = 1_000_000;
    expect(fallbackEligible("cool", "HTTP 429", t0)).toBe(true);
    markAttempted("cool", t0);
    expect(fallbackEligible("cool", "HTTP 429", t0 + 60_000)).toBe(false);
    expect(fallbackEligible("cool", "HTTP 429", t0 + 10 * 60_000)).toBe(true);
  });
});

describe("pickAlternate", () => {
  const fleet = [
    { instanceId: "opencodeApi:u1", state: "available" },
    { instanceId: "openrouterApi:u1", state: "available" },
    { instanceId: "deepseekApi:u1", state: "unavailable" },
    { instanceId: "opencodeApi", state: "available" }, // operator global
    { instanceId: "openrouterApi:other", state: "available" }, // someone else's key
  ];

  it("prefers a different provider family owned by the same user", () => {
    expect(pickAlternate("opencodeApi:u1", "u1", fleet)).toBe("openrouterApi:u1");
  });

  it("never points at another user's key", () => {
    const onlyForeign = [
      { instanceId: "opencodeApi:u1", state: "available" },
      { instanceId: "openrouterApi:other", state: "available" },
    ];
    expect(pickAlternate("opencodeApi:u1", "u1", onlyForeign)).toBeNull();
  });

  it("ownerless bots stay on operator-global instances", () => {
    const globals = [
      { instanceId: "opencodeApi", state: "available" },
      { instanceId: "groqApi", state: "available" },
    ];
    expect(pickAlternate("opencodeApi", null, globals)).toBe("groqApi");
  });

  it("falls back to same-family when it is all the owner has", () => {
    const sameFamily = [
      { instanceId: "openrouterApi:u1", state: "available" },
      { instanceId: "opencodeApi:u1", state: "available" },
    ];
    expect(pickAlternate("openrouterApi:u1", "u1", sameFamily)).toBe("opencodeApi:u1");
  });
});
