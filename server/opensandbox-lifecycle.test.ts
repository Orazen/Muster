import { describe, expect, it } from "vitest";
import type { AppConfig } from "./config.ts";

describe("opensandbox-lifecycle config gating", () => {
  it("opensandboxConfigured mirrors server/opensandbox.ts's configured()", async () => {
    const { opensandboxConfigured } = await import("./opensandbox-lifecycle.ts");
    expect(opensandboxConfigured({})).toBe(false);
    expect(opensandboxConfigured({ opensandbox: { apiKey: "sk-test" } })).toBe(true);
  });

  it("findSandbox returns null without ever calling the SDK when unconfigured", async () => {
    const { findSandbox } = await import("./opensandbox-lifecycle.ts");
    const result = await findSandbox({} as AppConfig, "some-bot-id");
    expect(result).toBeNull();
  });

  it("provisionSandbox refuses with a clear message when unconfigured", async () => {
    const { provisionSandbox } = await import("./opensandbox-lifecycle.ts");
    await expect(provisionSandbox({} as AppConfig, "bot-1", "Test Bot")).rejects.toThrow(
      /OpenSandbox not enabled/,
    );
  });

  it("reattachSandbox refuses when no sandbox exists for the bot", async () => {
    const { reattachSandbox } = await import("./opensandbox-lifecycle.ts");
    await expect(reattachSandbox({} as AppConfig, "no-such-bot")).rejects.toThrow(/no computer yet/);
  });
});
