import { describe, expect, it } from "vitest";
import { classifyJsonRpcError } from "./core.ts";

describe("classifyJsonRpcError (shared floor under per-support classifiers)", () => {
  it("reads the HTTP status out of droid's data envelope", () => {
    expect(
      classifyJsonRpcError({
        message: 'Internal error: Agent error: 402 {"detail":"No active subscription found."}',
      }),
    ).toBe("inactive_subscription");
    expect(classifyJsonRpcError({ message: "upstream said 401 unauthorized" })).toBe("invalid_credentials");
    expect(classifyJsonRpcError({ message: "gateway 403 for key" })).toBe("invalid_credentials");
    expect(classifyJsonRpcError({ message: "HTTP429 quota exceeded" })).toBe("quota_or_region_restriction");
  });

  it("falls back to human phrases when no status code is present", () => {
    expect(classifyJsonRpcError({ message: "Payment Required" })).toBe("inactive_subscription");
    expect(classifyJsonRpcError({ message: "no active subscription for this account" })).toBe("inactive_subscription");
    expect(classifyJsonRpcError({ message: "invalid api key supplied" })).toBe("invalid_credentials");
  });

  it("has no opinion on ordinary failures", () => {
    expect(classifyJsonRpcError({ message: "Model not recognized: bogus" })).toBeUndefined();
    expect(classifyJsonRpcError({ message: "method not found" })).toBeUndefined();
    expect(classifyJsonRpcError({})).toBeUndefined();
  });
});
