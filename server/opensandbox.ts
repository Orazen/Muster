// OpenSandbox integration — a self-hostable alternative to the box.ascii.dev
// cloud computer for operators who don't want a third-party vendor
// dependency for this feature. Uses @alibaba-group/opensandbox's official
// SDK (real, published, Apache-2.0; API shape confirmed against its actual
// shipped .d.ts during integration — Sandbox.create/.commands.run/.kill).
//
// Live-verified end-to-end against a real self-hosted OpenSandbox
// deployment: sandbox creation, command execution, and — the harder
// question — actually running server/remote-computer.ts's
// remoteComputerBootstrapCommand()/ensureRemoteCuaCommand() scripts
// (the same ones Box already trusts) on the same trycua/xfce-cua image
// Local VM uses, ending with a genuinely running cua-driver daemon
// (verified via `cua-driver status`). Two real deployment bugs found and
// fixed on the way: sandboxes must share the server's own Docker network
// (not the default bridge — they're isolated networks otherwise) via
// `network_mode`, and OpenSandbox's own example `drop_capabilities` list
// (SYS_PTRACE, SYS_ADMIN) blocks desktop-automation tooling and needs
// relaxing for this specific use case — a real security/functionality
// tradeoff, not a bug, so it's a per-deployment config choice, not
// hardcoded here.
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
  // Live-tested finding: the common self-host setup (Docker bridge mode,
  // the mode docker-compose.example.yaml in the OpenSandbox repo itself
  // ships) puts sandboxes on a network this Node process can't reach
  // directly — the SDK's own health check fails with READY_TIMEOUT and
  // explicitly suggests this fix in its error message. Routing exec
  // through the sandbox server instead of dialing the sandbox directly
  // is the correct default for a self-hosted deployment; set
  // useServerProxy: false explicitly if a deployment's network topology
  // genuinely allows direct sandbox access (e.g. host networking mode).
  const config: ConnectionConfigOptions = {
    useServerProxy: cfg.opensandbox?.useServerProxy ?? true,
    // Same live-tested reasoning as createSandbox()'s readyTimeoutSeconds:
    // the SDK's own default (30s) is real-world too short for this class
    // of deployment (proxied through the server, real image pulls, a
    // shared VPS with variable docker-socket latency observed directly
    // this session). 90s matches what's actually been reliable.
    // 140s was observed for a genuinely cold create() this session
    // (opensandbox-lifecycle.ts's own live verification); give real
    // margin above that rather than re-tuning on every flake.
    requestTimeoutSeconds: 180,
  };
  if (domain) config.domain = domain;
  if (apiKey) config.apiKey = apiKey;
  return config;
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
  opts?: { image?: string; readyTimeoutSeconds?: number },
): Promise<OpenSandboxHandle> {
  if (!configured(cfg)) {
    throw new Error("no OpenSandbox API key — add it in Settings, or set OPEN_SANDBOX_API_KEY");
  }
  const createOpts: Parameters<typeof Sandbox.create>[0] = {
    connectionConfig: connectionConfig(cfg),
    // The SDK's own default (30s) is real-world too short for a first-ever
    // sandbox with an uncached or large image — live-tested this session:
    // a real image pull + first-boot health check routinely takes 60-140s.
    // 120s is the value already proven reliable end to end.
    readyTimeoutSeconds: opts?.readyTimeoutSeconds ?? 170,
  };
  if (opts?.image) createOpts.image = opts.image;
  const sandbox = await Sandbox.create(createOpts);
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
