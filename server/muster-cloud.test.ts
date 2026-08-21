// Muster Cloud identity bridge — unit tests for the pure config-reading
// helpers. verifyAgainstMusterCloud() itself is exercised live against
// real running server instances (three independent desktop-shaped
// instances sharing one identity, plus a wrong-password rejection case),
// not mocked here — see the session notes for that verification; a fetch
// mock would only prove the mock is self-consistent, not that Better
// Auth's own CSRF/Origin behavior is handled correctly, which is exactly
// the bug this module's design comment describes finding live.
import { describe, expect, it } from "vitest";
import { musterCloudEnabled, musterCloudUrl } from "./muster-cloud.ts";

describe("muster cloud config", () => {
  it("is disabled with neither a config url nor the env var set", () => {
    delete process.env.OMB_MUSTER_CLOUD_URL;
    expect(musterCloudUrl({})).toBeNull();
    expect(musterCloudEnabled({})).toBe(false);
  });

  it("reads the config url when set", () => {
    delete process.env.OMB_MUSTER_CLOUD_URL;
    expect(musterCloudUrl({ musterCloud: { url: "https://cloud.example.com" } })).toBe(
      "https://cloud.example.com",
    );
    expect(musterCloudEnabled({ musterCloud: { url: "https://cloud.example.com" } })).toBe(true);
  });

  it("falls back to the env var when config has none", () => {
    process.env.OMB_MUSTER_CLOUD_URL = "https://cloud-env.example.com";
    expect(musterCloudUrl({})).toBe("https://cloud-env.example.com");
    delete process.env.OMB_MUSTER_CLOUD_URL;
  });

  it("config url wins over the env var when both are set", () => {
    process.env.OMB_MUSTER_CLOUD_URL = "https://cloud-env.example.com";
    expect(musterCloudUrl({ musterCloud: { url: "https://cloud-config.example.com" } })).toBe(
      "https://cloud-config.example.com",
    );
    delete process.env.OMB_MUSTER_CLOUD_URL;
  });

  it("strips a trailing slash", () => {
    expect(musterCloudUrl({ musterCloud: { url: "https://cloud.example.com/" } })).toBe(
      "https://cloud.example.com",
    );
  });

  it("treats a blank config url as unset", () => {
    delete process.env.OMB_MUSTER_CLOUD_URL;
    expect(musterCloudUrl({ musterCloud: { url: "  " } })).toBeNull();
    expect(musterCloudEnabled({ musterCloud: { url: "" } })).toBe(false);
  });
});
