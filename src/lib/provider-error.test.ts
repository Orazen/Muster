// Tests for the provider-error bubble humanizer: whole-message envelopes
// only, conservative detection, human copy out, raw bytes preserved for copy.
import { describe, expect, it } from "vitest";
import { describeProviderError, providerErrorView } from "./provider-error";

describe("providerErrorView", () => {
  it("recognizes the exact shape seen live: Error: 402 <json envelope>", () => {
    const raw =
      'Error: 402 {"detail":"No active subscription found.\\nSubscribe to start using Droid.","status":402,"title":"Payment Required","displayToUser":true,"error":{"detail":"No active subscription found.\\nSubscribe to start using Droid.","status":402,"title":"Payment Required","displayToUser":true},"requestId":"fra1::84pvn"}';
    expect(providerErrorView(raw)).toEqual({
      status: 402,
      detail: "No active subscription found. Subscribe to start using Droid.",
      title: "Payment Required",
    });
  });

  it("accepts a bare envelope without prefix or status", () => {
    const raw = '{"error":{"message":"quota exceeded for account"}}';
    expect(providerErrorView(raw)).toEqual({ status: undefined, detail: "quota exceeded for account", title: undefined });
  });

  it("falls back to title when no detail exists", () => {
    expect(providerErrorView('{"title":"Payment Required","status":402}')).toEqual({
      status: 402,
      detail: "",
      title: "Payment Required",
    });
  });

  it("returns null for ordinary sentences and markdown", () => {
    expect(providerErrorView("Hello! Here is your answer.")).toBeNull();
    expect(providerErrorView('Here is the data: {"detail":"x"}')).toBeNull();
    expect(providerErrorView("")).toBeNull();
  });

  it("returns null for model-authored JSON that is not an error envelope", () => {
    const raw = '{"summary":"quarterly results","revenue":[1,2,3],"note":"status is fine"}';
    expect(providerErrorView(raw)).toBeNull();
  });

  it("returns null for malformed JSON or wrong shapes", () => {
    expect(providerErrorView("{detail: broken")).toBeNull();
    expect(providerErrorView('["detail","array"]')).toBeNull();
    expect(providerErrorView("null")).toBeNull();
    expect(providerErrorView('{"detail":""}')).toBeNull();
  });

  it("maps 402 to subscription copy when only a title is present", () => {
    const view = providerErrorView('{"status":402,"title":"Payment Required"}');
    expect(view).not.toBeNull();
    expect(describeProviderError(view!)).toContain("subscription");
  });

  it("describeProviderError prefers the provider's own sentence", () => {
    const view = providerErrorView('{"detail":"No active subscription found.","status":402}');
    expect(describeProviderError(view!)).toBe("No active subscription found.");
    expect(describeProviderError({ status: 402, detail: "No active subscription found.", title: undefined })).toBe("No active subscription found.");
  });

  it("describeProviderError covers credential and rate-limit statuses", () => {
    expect(describeProviderError({ status: 401, detail: "", title: undefined })).toContain("credentials");
    expect(describeProviderError({ status: 429, detail: "", title: undefined })).toContain("rate");
    expect(describeProviderError({ status: 503, detail: "", title: undefined })).toContain("server problem");
    expect(describeProviderError({ status: undefined, detail: "", title: undefined })).toContain("reported a problem");
  });
});
