import { afterEach, describe, expect, it } from "vitest";
import { configured, connectionConfig, createSandbox } from "./opensandbox.ts";
import type { AppConfig } from "./config.ts";

describe("opensandbox config wiring", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("is unconfigured with no key anywhere", () => {
    delete process.env.OPEN_SANDBOX_API_KEY;
    expect(configured({})).toBe(false);
  });

  it("is configured once a key is saved in app config", () => {
    expect(configured({ opensandbox: { apiKey: "sk-test" } })).toBe(true);
  });

  it("is configured from the OPEN_SANDBOX_API_KEY env var too", () => {
    process.env.OPEN_SANDBOX_API_KEY = "sk-env";
    // connectionConfig, not configured(): configured() intentionally only
    // reflects the explicit app-config field (matches every other
    // "configured" flag in server/index.ts's configStatus(), all of which
    // report the saved-in-Settings state, not env-var fallbacks).
    const cc = connectionConfig({});
    expect(cc.apiKey).toBe("sk-env");
  });

  it("app config apiKey wins over the env var", () => {
    process.env.OPEN_SANDBOX_API_KEY = "sk-env";
    const cc = connectionConfig({ opensandbox: { apiKey: "sk-config" } });
    expect(cc.apiKey).toBe("sk-config");
  });

  it("passes a custom self-hosted server URL through as domain", () => {
    const cc = connectionConfig({ opensandbox: { apiKey: "sk-test", url: "my-server.internal:8080" } });
    expect(cc.domain).toBe("my-server.internal:8080");
  });

  it("omits domain/apiKey entirely when unset, letting the SDK use its own defaults", () => {
    delete process.env.OPEN_SANDBOX_API_KEY;
    delete process.env.OMB_OPENSANDBOX_URL;
    const cc = connectionConfig({});
    expect(cc).toEqual({});
  });

  it("refuses to create a sandbox with no key configured, without ever calling the SDK", async () => {
    delete process.env.OPEN_SANDBOX_API_KEY;
    await expect(createSandbox({} as AppConfig)).rejects.toThrow(/no OpenSandbox API key/);
  });
});
