// OpenSandbox integration — a self-hostable alternative to the box.ascii.dev
// cloud computer for operators who don't want a third-party vendor
// dependency for this feature. Uses @alibaba-group/opensandbox's official
// SDK (real, published, Apache-2.0; API shape confirmed against its actual
// shipped .d.ts during integration — Sandbox.create/.commands.run/.kill).
//
// Honesty note: this module has not been exercised against a live
// OpenSandbox server (no test account was available during integration).
// The connection-config shaping and on/off wiring below are tested; sandbox
// creation and command execution against a real server are not yet
// confirmed end-to-end — same caveat class as the Cohere driver.
import { Sandbox, type ConnectionConfigOptions } from "@alibaba-group/opensandbox";
import type { AppConfig } from "./config.ts";

export function configured(cfg: AppConfig): boolean {
  return Boolean(cfg.opensandbox?.apiKey);
}

/** Build the SDK's connection config from app config + env fallback, same
 * precedence every other credential in this codebase uses (explicit config
 * wins, env var is the fallback). */
export function connectionConfig(cfg: AppConfig): ConnectionConfigOptions {
  const apiKey = cfg.opensandbox?.apiKey || process.env.OPEN_SANDBOX_API_KEY || "";
  const domain = cfg.opensandbox?.url || process.env.OMB_OPENSANDBOX_URL || undefined;
  return {
    ...(domain ? { domain } : {}),
    ...(apiKey ? { apiKey } : {}),
  };
}

export interface OpenSandboxHandle {
  sandbox: Sandbox;
  run(command: string, opts?: { workingDirectory?: string; timeoutSeconds?: number }): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number | null;
  }>;
  kill(): Promise<void>;
}

/** Create a fresh sandbox and wrap it behind the narrow surface Muster's
 * computer-use tools actually need (run a command, tear it down) — not the
 * SDK's full surface (snapshots, credential vault, egress policy, etc.),
 * which stays available on .sandbox for anything that needs it directly. */
export async function createSandbox(
  cfg: AppConfig,
  opts?: { image?: string },
): Promise<OpenSandboxHandle> {
  if (!configured(cfg)) {
    throw new Error("no OpenSandbox API key — add it in Settings, or set OPEN_SANDBOX_API_KEY");
  }
  const sandbox = await Sandbox.create({
    connectionConfig: connectionConfig(cfg),
    ...(opts?.image ? { image: opts.image } : {}),
  });
  return {
    sandbox,
    async run(command, runOpts) {
      const result = await sandbox.commands.run(command, {
        workingDirectory: runOpts?.workingDirectory,
        timeoutSeconds: runOpts?.timeoutSeconds,
      });
      // Execution.logs is a list of timestamped OutputMessage chunks, not a
      // flat string — join them in order, same as every other driver in
      // this codebase accumulates streamed text.
      return {
        stdout: result.logs.stdout.map((m) => m.text).join(""),
        stderr: result.logs.stderr.map((m) => m.text).join(""),
        exitCode: result.exitCode ?? null,
      };
    },
    async kill() {
      await sandbox.kill();
    },
  };
}
