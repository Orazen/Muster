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
    expect(cc).toEqual({ useServerProxy: true, requestTimeoutSeconds: 180 });
  });

  it("defaults useServerProxy to true — required for the common Docker bridge-mode self-host setup", () => {
    // Found via a real live test against an actual self-hosted OpenSandbox
    // server (Docker bridge mode, the mode the project's own
    // docker-compose.example.yaml ships): without this, sandbox creation
    // fails with SandboxReadyTimeoutException because the SDK's health
    // check tries to reach the sandbox directly instead of proxying
    // through the server, which the SDK's own error message names as the
    // fix. Regression-guards that default.
    const cc = connectionConfig({ opensandbox: { apiKey: "sk-test" } });
    expect(cc.useServerProxy).toBe(true);
  });

  it("lets a deployment opt out of the server proxy if its network topology allows direct access", () => {
    const cc = connectionConfig({ opensandbox: { apiKey: "sk-test", useServerProxy: false } });
    expect(cc.useServerProxy).toBe(false);
  });

  it("refuses to create a sandbox with no key configured, without ever calling the SDK", async () => {
    delete process.env.OPEN_SANDBOX_API_KEY;
    await expect(createSandbox({} as AppConfig)).rejects.toThrow(/no OpenSandbox API key/);
  });
});

describe("opensandbox runCommand — matches server/box.ts's runCommand() shape exactly", () => {
  // Sandbox has a private constructor (SDK design, can't be instantiated
  // directly in a test) — a minimal duck-typed fake exercises the wrapper
  // logic (result shaping, ok-from-exitCode derivation) without needing a
  // live sandbox or the SDK's internal HTTP machinery.
  function fakeSandbox(execution: {
    logs: { stdout: Array<{ text: string; timestamp: number }>; stderr: Array<{ text: string; timestamp: number }> };
    exitCode?: number | null;
  }) {
    return {
      commands: {
        run: async () => execution,
      },
    } as unknown as import("@alibaba-group/opensandbox").Sandbox;
  }

  it("reports ok:true only when exitCode is exactly 0, same as box.ts", async () => {
    const { runCommand } = await import("./opensandbox.ts");
    const sandbox = fakeSandbox({
      logs: { stdout: [{ text: "hello", timestamp: 1 }], stderr: [] },
      exitCode: 0,
    });
    const result = await runCommand(sandbox, "echo hello");
    expect(result).toEqual({ ok: true, exitCode: 0, stdout: "hello", stderr: "" });
  });

  it("reports ok:false for a nonzero exit code", async () => {
    const { runCommand } = await import("./opensandbox.ts");
    const sandbox = fakeSandbox({
      logs: { stdout: [], stderr: [{ text: "not found", timestamp: 1 }] },
      exitCode: 127,
    });
    const result = await runCommand(sandbox, "nope");
    expect(result).toEqual({ ok: false, exitCode: 127, stdout: "", stderr: "not found" });
  });

  it("joins multiple timestamped output chunks in order", async () => {
    const { runCommand } = await import("./opensandbox.ts");
    const sandbox = fakeSandbox({
      logs: {
        stdout: [
          { text: "line 1\n", timestamp: 1 },
          { text: "line 2\n", timestamp: 2 },
        ],
        stderr: [],
      },
      exitCode: 0,
    });
    const result = await runCommand(sandbox, "printf 'line 1\\nline 2\\n'");
    expect(result.stdout).toBe("line 1\nline 2\n");
  });

  it("treats a missing exitCode as null, not 0 (never silently 'succeeds')", async () => {
    const { runCommand } = await import("./opensandbox.ts");
    const sandbox = fakeSandbox({ logs: { stdout: [], stderr: [] } });
    const result = await runCommand(sandbox, "echo");
    expect(result.exitCode).toBeNull();
    expect(result.ok).toBe(false);
  });
});
