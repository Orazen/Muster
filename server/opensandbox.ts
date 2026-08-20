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
    // Live-tested finding: the common self-host setup (Docker bridge mode,
    // the mode docker-compose.example.yaml in the OpenSandbox repo itself
    // ships) puts sandboxes on a network this Node process can't reach
    // directly — the SDK's own health check fails with READY_TIMEOUT and
    // explicitly suggests this fix in its error message. Routing exec
    // through the sandbox server instead of dialing the sandbox directly
    // is the correct default for a self-hosted deployment; set
    // useServerProxy: false explicitly if a deployment's network topology
    // genuinely allows direct sandbox access (e.g. host networking mode).
    useServerProxy: cfg.opensandbox?.useServerProxy ?? true,
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
      return runOn(sandbox, command, runOpts);
    },
    async kill() {
      await sandbox.kill();
    },
  };
}

async function runOn(
  sandbox: Sandbox,
  command: string,
  runOpts?: { workingDirectory?: string; timeoutSeconds?: number },
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const result = await sandbox.commands.run(command, {
    workingDirectory: runOpts?.workingDirectory,
    timeoutSeconds: runOpts?.timeoutSeconds,
  });
  // Execution.logs is a list of timestamped OutputMessage chunks, not a
  // flat string — join them in order, same as every other driver in this
  // codebase accumulates streamed text.
  return {
    stdout: result.logs.stdout.map((m) => m.text).join(""),
    stderr: result.logs.stderr.map((m) => m.text).join(""),
    exitCode: result.exitCode ?? null,
  };
}

/**
 * Same shape as server/box.ts's runCommand(cfg, boxId, command) —
 * {ok, exitCode, stdout, stderr} — deliberately, so the exact same
 * backend-agnostic bootstrap scripts remoteComputerBootstrapCommand() and
 * ensureRemoteCuaCommand() already generate (server/remote-computer.ts) can
 * run unmodified against an OpenSandbox sandbox instead of a Box VM. This is
 * the concrete seam a future "computer" backend switch would use — creating
 * the sandbox once, then calling this repeatedly, is the caller's job (not
 * this function's), same division of responsibility server/box.ts already
 * has between box creation and runCommand.
 */
export async function runCommand(
  sandbox: Sandbox,
  command: string,
  opts: { timeoutMs?: number } = {},
): Promise<{ ok: boolean; exitCode: number | null; stdout: string; stderr: string }> {
  const { stdout, stderr, exitCode } = await runOn(sandbox, command, {
    timeoutSeconds: opts.timeoutMs ? Math.ceil(opts.timeoutMs / 1000) : undefined,
  });
  return { ok: exitCode === 0, exitCode, stdout, stderr };
}
