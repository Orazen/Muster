import { describe, expect, it } from "vitest";

import { isSameOrigin, needsSameOriginMutationCheck } from "./origin-gate.ts";

describe("isSameOrigin", () => {
  it("matches when Origin host equals the Host header", () => {
    expect(isSameOrigin("http://127.0.0.1:8799", "127.0.0.1:8799")).toBe(true);
    expect(isSameOrigin("http://localhost:5173", "localhost:5173")).toBe(true);
  });

  it("rejects a cross-origin loopback context (different port)", () => {
    expect(isSameOrigin("http://localhost:5173", "127.0.0.1:8799")).toBe(false);
    expect(isSameOrigin("http://localhost:5173", "localhost:8799")).toBe(false);
  });

  it("rejects a remote origin and garbage", () => {
    expect(isSameOrigin("https://evil.example.com", "127.0.0.1:8799")).toBe(false);
    expect(isSameOrigin("not a url", "127.0.0.1:8799")).toBe(false);
  });

  it("returns false when Host is missing", () => {
    expect(isSameOrigin("http://127.0.0.1:8799", undefined)).toBe(false);
  });
});

describe("needsSameOriginMutationCheck", () => {
  const base = { selfHosted: false, method: "POST", hasOrigin: true, hasAuthorization: false };

  it("applies to mutating browser requests on desktop", () => {
    expect(needsSameOriginMutationCheck(base)).toBe(true);
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      expect(needsSameOriginMutationCheck({ ...base, method })).toBe(true);
    }
  });

  it("skips GET, non-browser and token-authenticated callers", () => {
    expect(needsSameOriginMutationCheck({ ...base, method: "GET" })).toBe(false);
    expect(needsSameOriginMutationCheck({ ...base, hasOrigin: false })).toBe(false);
    expect(needsSameOriginMutationCheck({ ...base, hasAuthorization: true })).toBe(false);
  });

  it("skips self-hosted deployments (proxy rewrites Host; sessions gate)", () => {
    expect(needsSameOriginMutationCheck({ ...base, selfHosted: true })).toBe(false);
  });
});
