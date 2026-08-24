// BYO Linux VPS as a bot computer, reached over the user's own SSH config.
//
// The design borrows Docker's native ssh:// transport instead of shelling
// out to ssh ourselves: every docker CLI call runs with DOCKER_HOST pointed
// at `ssh://<alias>`, so image builds, container lifecycle and exec all
// happen on the remote daemon with zero Muster-side plumbing. The alias is
// resolved by ssh(1) from ~/.ssh/config — Muster stores no keys, passwords
// or hosts. Only "docker" is supported remotely: podman's --connection and
// Apple's container CLI have different remote semantics.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { isValidSshAlias } from "./config.ts";
import {
  containerComputerAction,
  containerComputerStatus,
  type CommandRunner,
  type LocalVmTarget,
} from "./container-computer.ts";

const run = promisify(execFile);

export function vpsDockerHost(alias: string): string {
  if (!isValidSshAlias(alias)) throw new Error("invalid VPS SSH config alias");
  return `ssh://${alias}`;
}

/** A CommandRunner whose docker/podman/container calls execute against the
 * remote daemon via DOCKER_HOST. Non-container commands are rejected — this
 * runner exists solely for the container-computer stack. */
export function vpsSh(alias: string): CommandRunner {
  const dockerHost = vpsDockerHost(alias);
  return async (command, args, timeout = 8000) => {
    // SAFETY: argv-array exec only; the alias reaches the child as an env
    // URL fragment built above from a charset-validated string.
    const res = await run(command, args, {
      timeout,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, DOCKER_HOST: dockerHost },
    });
    return { stdout: res.stdout };
  };
}

export interface VpsComputerStatus {
  configured: boolean;
  sshAlias: string | null;
  ready: boolean;
  problem: string | null;
  /** Mirrors containerComputerStatus fields the UI reads. */
  daemonUp: boolean;
  image: boolean;
  container: "running" | "stopped" | "missing";
  runtime: string | null;
}

const PROBLEM_PREFIX = "VPS computer:";

function vpsProblem(detail: string): string {
  return `${PROBLEM_PREFIX} ${detail}`;
}

/** Remote status: same managed-image checks as the Local VM, executed
 * against the VPS daemon. The runtime is forced to docker — anything else
 * detected over DOCKER_HOST is a misconfiguration worth naming. */
export async function vpsComputerStatus(alias: string, target: LocalVmTarget): Promise<VpsComputerStatus> {
  const base = await containerComputerStatus(vpsSh(alias), "linux", target);
  const runtime = base.runtime === "podman" || base.runtime === "container" ? null : base.runtime;
  const wrongRuntime = base.daemonUp && !runtime;
  let problem = base.problem ? vpsProblem(base.problem.replace(/^No container runtime is installed$/i, "no Docker daemon reachable over SSH")) : null;
  if (wrongRuntime) problem = vpsProblem("the remote host must run Docker — podman/container engines are not supported over ssh://");
  return {
    configured: true,
    sshAlias: alias,
    daemonUp: Boolean(runtime),
    image: base.image,
    container: base.container,
    // SAFETY: narrowed by the check directly above.
    runtime,
    ready: Boolean(runtime && base.ready),
    problem,
  };
}

/** Provision-or-start the bot's desktop on the VPS, mirroring the Local VM
 * branch in index.ts but with every call riding the remote runner. */
export async function vpsEnsureDesktop(alias: string, target: LocalVmTarget): Promise<VpsComputerStatus> {
  let status = await vpsComputerStatus(alias, target);
  if (!status.daemonUp || !status.runtime) {
    throw new Error(status.problem ?? vpsProblem("Docker is not reachable on the VPS"));
  }
  if (!status.image) {
    // Pull + build the pinned derivative on the remote host. "pull" fetches
    // the pinned base; the derivative build runs inside containerComputerAction
    // with the same prepare path as local setup. The 10-minute budgets absorb
    // WAN latency.
    status = await containerComputerAction("pull", vpsSh(alias), "linux", target)
      .then(() => vpsComputerStatus(alias, target));
  }
  if (status.container !== "running") {
    await containerComputerAction("run", vpsSh(alias), "linux", target);
    status = await vpsComputerStatus(alias, target);
  }
  return status;
}

/** Connectivity probe for the Settings card — a cheap daemon ping that never
 * throws, so the UI can show reachability without a full desktop check. */
export async function vpsReachable(alias: string): Promise<boolean> {
  try {
    await run("docker", ["info", "--format", "{{.ServerVersion}}"], {
      timeout: 10_000,
      env: { ...process.env, DOCKER_HOST: vpsDockerHost(alias) },
    });
    return true;
  } catch {
    return false;
  }
}
