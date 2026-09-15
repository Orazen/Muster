// Cua-backed Local VM lifecycle and health checks.
//
// Muster owns only the sandbox boundary: image preparation, container
// lifecycle, resource limits, loopback viewer, and the single-bot lease in the
// harness. Desktop automation itself is Cua Driver. Agents connect directly to
// `cua-driver mcp` inside the container; this module never reimplements clicks,
// typing, screenshots, accessibility, or window discovery.
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { augmentedPath } from "./env-path.ts";
import { DATA_DIR } from "./config.ts";
import { writeFileAtomic } from "./atomic.ts";
import { SPAWNED_PROXIES } from "./proxy-paths.ts";

const run = promisify(execFile);
const SCREENSHOT_STATUS_TTL_MS = 10_000;

export type CommandRunner = (
  command: string,
  args: string[],
  timeout?: number,
) => Promise<{ stdout: string }>;

export const CUA_DRIVER_VERSION = "0.20.0";
export const BASE_IMAGE_REPOSITORY = "docker.io/trycua/xfce-cua";
// Official multi-architecture Cua XFCE 0.1.0 manifest (amd64 + arm64).
export const BASE_IMAGE_DIGEST = "sha256:274eb636f5cf3fc58f705916ee72b7a701270b3877369d08533a385c5325be9b";
export const BASE_IMAGE = `${BASE_IMAGE_REPOSITORY}@${BASE_IMAGE_DIGEST}`;
// This tag is built locally from the pinned Cua base. Image and container
// labels below are the authoritative compatibility check, not the mutable tag.
export const IMAGE_REPOSITORY = "muster/cua-local-vm";
export const IMAGE_LAYER_VERSION = "3";
export const IMAGE_LAYER_LABEL = "com.muster.image-layer";
export const IMAGE = `${IMAGE_REPOSITORY}:driver-${CUA_DRIVER_VERSION}-v${IMAGE_LAYER_VERSION}`;
// The pre-scoping singleton name. Only kept to recognize (and replace) VMs
// an older Muster created; new containers never use it.
export const LEGACY_CONTAINER = "muster-computer";
// Two Muster instances on one machine — packaged app beside a dev server, or
// several rigs — used to fight over the one `muster-computer` name and the
// one 6080 viewer port, so only the first could ever run a Local VM. The
// install-scoped suffix is a digest of the resolved DATA_DIR: stable across
// restarts, no coordination state, unique per data directory.
const installDigest = createHash("sha256").update(resolve(DATA_DIR)).digest("hex");
export const CONTAINER = `${LEGACY_CONTAINER}-${installDigest.slice(0, 8)}`;
export const MANAGED_LABEL = "com.muster.local-vm";
export const DRIVER_LABEL = "com.muster.cua-driver";
export const BASE_IMAGE_LABEL = "com.muster.cua-base";
export const WORKSPACE_LABEL = "com.muster.workspace";
export const VM_WORKSPACE_DIR = join(DATA_DIR, "vm-home");
export const VM_WORKSPACE_GUEST = "/home/cua/workspace";
export const DISPLAY = ":1";
export const CUA_SOCKET = "/run/user/1000/muster-cua.sock";
export const CUA_EXECUTABLE = "/usr/local/libexec/muster/cua-driver";

const RUNTIMES = ["docker", "podman", "container"] as const;
export type Runtime = (typeof RUNTIMES)[number];
export type LifecycleAction = "pull" | "run" | "start" | "stop" | "remove" | "runtimeStart";

/** Set when a runtime refused --memory/--cpus outright and the container was
 * started without resource caps instead of failing the desktop entirely. */
export const LIMITS_LABEL = "com.muster.resource-limits";

const INTERNAL_VIEWER_PORT = 6901;
// Historical fixed host port for the pre-scoping singleton VM. New VMs get a
// per-install port so co-located instances don't collide.
export const LEGACY_HOST_VIEWER_PORT = 6080;
// Per-bot viewers fan out over 6081-6208; per-install shared viewers occupy
// a disjoint band above it (6209-6272). Digest-derived offsets need no
// allocation state and survive restarts. Two installs whose digests happen to
// share an offset still collide — with 64 slots that's rare, and the run
// error is mapped to a friendly port-in-use message if it happens.
const SHARED_VIEWER_PORT_BASE = 6209;
const SHARED_VIEWER_PORT_RANGE = 64;
const sharedViewerOffset = parseInt(installDigest.slice(20, 24), 16) % SHARED_VIEWER_PORT_RANGE;
const MEMORY_BYTES = 4 * 1024 * 1024 * 1024;
const NANO_CPUS = 2_000_000_000;
const PIDS_LIMIT = 512;

/** One addressable desktop instance: shared keeps the historical singleton,
 * per-bot targets carry their own container name, durable workspace and
 * loopback viewer port so bots never share a pointer or a filesystem. */
export interface LocalVmTarget {
  /** Stable, non-secret identity used for leases, idle timers and fences. */
  key: string;
  containerName: string;
  workspaceDir: string;
  viewerPort: number;
  label: string;
}

export const SHARED_LOCAL_VM_TARGET: LocalVmTarget = {
  key: "shared",
  containerName: CONTAINER,
  workspaceDir: VM_WORKSPACE_DIR,
  viewerPort: SHARED_VIEWER_PORT_BASE + sharedViewerOffset,
  label: "shared",
};

// Per-bot viewers fan out above the legacy shared port; a digest-derived
// offset needs no allocation state and survives server restarts.
export const PER_BOT_VIEWER_PORT_BASE = LEGACY_HOST_VIEWER_PORT + 1;
export const PER_BOT_VIEWER_PORT_RANGE = 128;

/** Derive a bot's desktop identities from a SHA-256 digest, never from its
 * display name or any caller-controlled path fragment. */
export function perBotLocalVmTarget(botId: string): LocalVmTarget {
  const digest = createHash("sha256").update(botId).digest("hex");
  const short = digest.slice(0, 16);
  // SAFETY: digest slices are fixed-width lowercase hex, so parseInt always
  // yields a non-negative integer well inside the modulo range.
  const offset = parseInt(digest.slice(24, 28), 16) % PER_BOT_VIEWER_PORT_RANGE;
  return {
    key: `bot:${digest}`,
    containerName: `${CONTAINER}-${short}`,
    workspaceDir: join(DATA_DIR, "vm-homes", short),
    viewerPort: PER_BOT_VIEWER_PORT_BASE + offset,
    label: digest,
  };
}

const LINUX_WHEELS = {
  x86_64: {
    url: "https://files.pythonhosted.org/packages/fa/d7/a43008a328a40c85e7bc706fc20235b9abedc75e28b413817655153157ff/cua_driver-0.20.0-py3-none-manylinux_2_31_x86_64.whl",
    sha256: "f60c35696a37f37ac954935e478ae4754f220856d022036625c9400d72185961",
  },
  aarch64: {
    url: "https://files.pythonhosted.org/packages/94/9d/1c1838b69067e83266c3d2aae02d74eef353a43dc8644884ccf03fe7f933/cua_driver-0.20.0-py3-none-manylinux_2_31_aarch64.whl",
    sha256: "48833bc5e4c60e701fc9eefb57dbac36ec77ef3990f816fbbe85b4e954af2c77",
  },
} as const;

/** Reproducible, multi-architecture derivative of Cua's sandbox desktop.
 * Both Linux wheels are exact-version and SHA-256 verified. Supervisor owns
 * the daemon so it starts, restarts, and stops with the desktop container. */
export function managedImageDockerfile(): string {
  return `FROM ${BASE_IMAGE}
USER root
RUN set -eux; \\
    arch="$(uname -m)"; \\
    case "$arch" in \\
      x86_64) wheel_url='${LINUX_WHEELS.x86_64.url}'; wheel_sha='${LINUX_WHEELS.x86_64.sha256}'; wheel_path='/tmp/cua_driver-${CUA_DRIVER_VERSION}-py3-none-manylinux_2_31_x86_64.whl' ;; \\
      aarch64|arm64) wheel_url='${LINUX_WHEELS.aarch64.url}'; wheel_sha='${LINUX_WHEELS.aarch64.sha256}'; wheel_path='/tmp/cua_driver-${CUA_DRIVER_VERSION}-py3-none-manylinux_2_31_aarch64.whl' ;; \\
      *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \\
    esac; \\
    curl -fsSL "$wheel_url" -o "$wheel_path"; \\
    echo "$wheel_sha  $wheel_path" | sha256sum -c -; \\
    /opt/venv/bin/python -m pip install --no-cache-dir --force-reinstall --no-deps "$wheel_path"; \\
    rm -f "$wheel_path"; \\
    driver_bin="$(find /opt/venv/lib -path '*/cua_driver/bin/cua-driver' -type f -print -quit)"; \\
    test -n "$driver_bin"; \\
    install -D -m 0755 "$driver_bin" ${CUA_EXECUTABLE}; \\
    install -d -o cua -g cua -m 0700 ${VM_WORKSPACE_GUEST}; \\
    test "$(${CUA_EXECUTABLE} --version)" = "cua-driver ${CUA_DRIVER_VERSION}"
RUN printf '%s\\n' \\
      '#!/bin/sh' \\
      'set -eu' \\
      'workspace=${VM_WORKSPACE_GUEST}' \\
      'profiles="$workspace/.browser-profiles"' \\
      'mkdir -p "$profiles/google-chrome" "$profiles/chromium" "$HOME/.config"' \\
      'chmod 0700 "$workspace" "$profiles" "$profiles/google-chrome" "$profiles/chromium"' \\
      'migrate_profile() {' \\
      '  name="$1"' \\
      '  source="$HOME/.config/$name"' \\
      '  target="$profiles/$name"' \\
      '  if [ -d "$source" ] && [ ! -L "$source" ] && [ -z "$(find "$target" -mindepth 1 -print -quit)" ]; then' \\
      '    cp -a "$source"/. "$target"/' \\
      '  fi' \\
      '  rm -rf "$source"' \\
      '  ln -s "$target" "$source"' \\
      '}' \\
      'migrate_profile google-chrome' \\
      'migrate_profile chromium' \\
      'find "$profiles" \\( -name SingletonLock -o -name SingletonSocket -o -name SingletonCookie -o -name .parentlock \\) -delete' \\
      > /usr/local/bin/prepare-muster-workspace.sh \\
    && chmod 0755 /usr/local/bin/prepare-muster-workspace.sh
RUN printf '%s\\n' \\
      '#!/bin/sh' \\
      '/usr/local/bin/prepare-muster-workspace.sh' \\
      'attempt=0' \\
      'until DISPLAY=:1 xset q >/dev/null 2>&1; do' \\
      '  attempt=$((attempt + 1))' \\
      '  if [ "$attempt" -ge 45 ]; then echo "X display :1 did not become ready within 45 seconds" >&2; exit 1; fi' \\
      '  sleep 1' \\
      'done' \\
      'exec env CUA_DRIVER_INSTALL_CHANNEL=python_package CUA_DRIVER_RS_TELEMETRY_ENABLED=0 ${CUA_EXECUTABLE} serve --socket ${CUA_SOCKET} --permission-mode standard' \\
      > /usr/local/bin/start-muster-cua-driver.sh \\
    && chmod 0755 /usr/local/bin/start-muster-cua-driver.sh
RUN printf '%s\\n' \\
      '' \\
      '[program:muster-cua-driver]' \\
      'command=/usr/local/bin/start-muster-cua-driver.sh' \\
      'user=cua' \\
      'environment=HOME="/home/cua",USER="cua",DISPLAY=":1"' \\
      'autorestart=true' \\
      'startsecs=2' \\
      'stdout_logfile=/var/log/supervisor/cua-driver.log' \\
      'stderr_logfile=/var/log/supervisor/cua-driver.error.log' \\
      'priority=30' \\
      >> /etc/supervisor/supervisord.conf
LABEL ${MANAGED_LABEL}="1" \\
      ${DRIVER_LABEL}="${CUA_DRIVER_VERSION}" \\
      ${BASE_IMAGE_LABEL}="${BASE_IMAGE_DIGEST}" \\
      ${IMAGE_LAYER_LABEL}="${IMAGE_LAYER_VERSION}"
`;
}

async function sh(cmd: string, args: string[], timeout = 8000): Promise<{ stdout: string }> {
  const { stdout } = await run(cmd, args, {
    timeout,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, PATH: augmentedPath() },
  });
  return { stdout };
}

async function installed(
  cmd: string,
  runner: CommandRunner,
  platform: NodeJS.Platform,
): Promise<boolean> {
  try {
    await runner(platform === "win32" ? "where.exe" : "/usr/bin/which", [cmd], 4000);
    return true;
  } catch {
    return false;
  }
}

export interface ContainerComputerStatus {
  platform: NodeJS.Platform;
  runtime: Runtime | null;
  available: Runtime[];
  daemonUp: boolean;
  image: boolean;
  imageMatches: boolean;
  managed: boolean;
  container: "running" | "stopped" | "missing";
  network: "loopback" | "unsafe" | "unknown";
  security: "hardened" | "unsafe" | "unknown";
  persistence: "durable" | "unsafe" | "unknown";
  desktopReady: boolean;
  /** True while a young container's Cua driver daemon is still booting —
   * distinct from desktop_error, which means the desktop genuinely failed. */
  desktop_starting: boolean;
  desktop_error: string | null;
  ready: boolean;
  problem: string | null;
  image_ref: string;
  image_id: string | null;
  base_image_ref: string;
  driver_version: string;
  container_name: string;
  workspace_path: string;
  workspace_guest_path: string;
  viewer_url: string;
}

function emptyStatus(platform: NodeJS.Platform, target: LocalVmTarget): ContainerComputerStatus {
  return {
    platform,
    runtime: null,
    available: [],
    daemonUp: false,
    image: false,
    imageMatches: false,
    managed: false,
    container: "missing",
    network: "unknown",
    security: "unknown",
    persistence: "unknown",
    desktopReady: false,
    desktop_starting: false,
    desktop_error: null,
    ready: false,
    problem: "Install a supported container runtime first",
    image_ref: IMAGE,
    image_id: null,
    base_image_ref: BASE_IMAGE,
    driver_version: CUA_DRIVER_VERSION,
    container_name: target.containerName,
    workspace_path: target.workspaceDir,
    workspace_guest_path: VM_WORKSPACE_GUEST,
    viewer_url: `http://127.0.0.1:${target.viewerPort}/vnc.html`,
  };
}

function statusProblem(status: ContainerComputerStatus): string | null {
  if (!status.runtime) return "Install a supported container runtime first";
  if (!status.daemonUp) return `Start ${status.runtime} first`;
  if (!status.image) return `Prepare the Cua desktop image with Driver ${CUA_DRIVER_VERSION}`;
  if (status.container === "missing") return "Create the Local VM";
  if (!status.imageMatches) return "The existing Local VM uses an older desktop or Cua Driver; recreate it";
  if (!status.managed) return "The existing container was not created by Muster; recreate it";
  if (status.network === "unsafe") return "The existing Local VM exposes its viewer publicly; recreate it";
  if (status.security === "unsafe") return "The existing Local VM is missing safety limits; recreate it";
  if (status.persistence === "unsafe") return "The existing Local VM is missing its durable workspace; recreate it";
  if (status.container === "stopped") return "The Local VM is stopped — start it again from the previous step";
  if (status.desktop_starting)
    return "Starting the Local VM desktop — Cua Driver boots with it and is usually ready within a few seconds";
  if (status.desktop_error) return `The Local VM desktop failed to start: ${status.desktop_error}`;
  if (!status.desktopReady) return "The Local VM started, but Cua Driver is not ready yet";
  return null;
}

function imageLabelsMatch(labels: Record<string, string> | undefined): boolean {
  return (
    labels?.[MANAGED_LABEL] === "1" &&
    labels?.[DRIVER_LABEL] === CUA_DRIVER_VERSION &&
    labels?.[BASE_IMAGE_LABEL] === BASE_IMAGE_DIGEST &&
    labels?.[IMAGE_LAYER_LABEL] === IMAGE_LAYER_VERSION
  );
}

function containerLabelsMatch(labels: Record<string, string> | undefined): boolean {
  return imageLabelsMatch(labels) && labels?.[WORKSPACE_LABEL] === "1";
}

function normalizeImageId(id: string | undefined): string | null {
  return id?.trim().replace(/^sha256:/, "") || null;
}

// Cua Driver starts with the desktop; for the first seconds of a young
// container "daemon is not running" is normal boot progress, not a failure.
const DESKTOP_BOOT_GRACE_MS = 90_000;
const DAEMON_STARTING = /daemon is not running|connection refused|could not connect|no such file or directory/i;

/** Keep engine output actionable and secret-free: execFile messages start
 * with "Command failed: <the full command>", which for Local VM commands
 * embeds the viewer password. Drop the echoed command line and redact. */
export function conciseProbeError(raw: string): string {
  const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
  const body = lines.length > 1 ? lines.slice(1).join(" ") : lines[0] ?? "";
  return (body || raw).replace(/VNC_PW=\S+/gi, "VNC_PW=•").replace(/\s+/g, " ").slice(0, 320);
}

/** Apple's `container inspect` reports the image either as a bare reference
 * string or as a descriptor object; this is the boundary that tells them apart. */
function imageIsBareName(
  image: string | { reference?: string; descriptor?: { digest?: string } } | undefined,
): image is string {
  return Object.prototype.toString.call(image) === "[object String]";
}

function inspectedImage(stdout: string) {
  // SAFETY: stdout is the engine's `image inspect` JSON array; unknown engines
  // omit fields, so every field stays optional and is coalesced below.
  const parsed = JSON.parse(stdout) as Array<{
    Id?: string;
    id?: string;
    Config?: { Labels?: Record<string, string> };
    config?: { Labels?: Record<string, string>; labels?: Record<string, string> };
    configuration?: { labels?: Record<string, string>; descriptor?: { digest?: string } };
  }>;
  const image = parsed[0];
  return {
    labels:
      image?.Config?.Labels ?? image?.config?.Labels ?? image?.config?.labels ?? image?.configuration?.labels,
    id: normalizeImageId(image?.Id ?? image?.id ?? image?.configuration?.descriptor?.digest),
  };
}

function viewerPassword(env: string[] | Record<string, string> | undefined): string | null {
  if (Array.isArray(env)) {
    return env.find((entry) => entry.startsWith("VNC_PW="))?.slice("VNC_PW=".length) || null;
  }
  return env?.VNC_PW || null;
}

function viewerUrl(password: string | null, hostPort: number): string {
  const base = `http://127.0.0.1:${hostPort}/vnc.html`;
  if (!password) return base;
  const fragment = new URLSearchParams({ autoconnect: "true", resize: "scale", password });
  return `${base}#${fragment.toString()}`;
}

function cuaExecArgs(args: string[], interactive = false, containerName: string = CONTAINER): string[] {
  return [
    "exec",
    ...(interactive ? ["-i"] : []),
    "-u",
    "cua",
    "-e",
    "HOME=/home/cua",
    "-e",
    `DISPLAY=${DISPLAY}`,
    "-e",
    "CUA_DRIVER_INSTALL_CHANNEL=python_package",
    "-e",
    "CUA_DRIVER_RS_TELEMETRY_ENABLED=0",
    containerName,
    CUA_EXECUTABLE,
    ...args,
  ];
}

export async function containerComputerStatus(
  runner: CommandRunner = sh,
  platform: NodeJS.Platform = process.platform,
  target: LocalVmTarget = SHARED_LOCAL_VM_TARGET,
): Promise<ContainerComputerStatus> {
  const status = emptyStatus(platform, target);
  // Apple's `container` CLI is macOS-only. Ignoring an unrelated executable
  // with that generic name off macOS avoids false detection.
  const candidates = RUNTIMES.filter((runtime) => runtime !== "container" || platform === "darwin");
  const present = await Promise.all(candidates.map((runtime) => installed(runtime, runner, platform)));
  status.available = candidates.filter((_, index) => present[index]);

  const healthy = await Promise.all(
    status.available.map(async (candidate) => {
      try {
        await runner(
          candidate,
          candidate === "container" ? ["system", "status"] : ["info", "--format", "{{.ServerVersion}}"],
          // A cold `podman info` right after a machine start opens an SSH
          // tunnel and rebuilds the inventory; 10s timed out on real Macs and
          // left the panel reading a healthy daemon as down. When nothing is
          // listening the call fails fast, so the longer budget only costs the
          // genuinely-starting case.
          20_000,
        );
        return true;
      } catch {
        return false;
      }
    }),
  );
  const healthyIndex = healthy.indexOf(true);
  status.runtime = healthyIndex >= 0 ? status.available[healthyIndex] : (status.available[0] ?? null);
  status.daemonUp = healthyIndex >= 0;
  if (!status.runtime || !status.daemonUp) {
    status.problem = statusProblem(status);
    return status;
  }

  try {
    const { stdout } = await runner(status.runtime, ["image", "inspect", IMAGE]);
    const image = inspectedImage(stdout);
    status.image = imageLabelsMatch(image.labels);
    status.image_id = image.id;
  } catch {
    // The prepared Muster derivative has not been built yet.
  }

  // Container start time powers the boot grace in the probe catch below;
  // engines that don't report it simply get no grace.
  let containerStartedAt: number | null = null;

  try {
    const { stdout } = await runner(status.runtime, ["inspect", target.containerName]);
    if (status.runtime === "container") {
      // SAFETY: stdout is the engine's `container inspect` JSON array; fields
      // absent on older engines stay optional and are defaulted below.
      const inspected = JSON.parse(stdout) as Array<{
        configuration?: {
          image?: string | { reference?: string; descriptor?: { digest?: string } };
          imageReference?: string;
          resources?: { cpus?: number; memoryInBytes?: number };
          publishedPorts?: Array<{ hostAddress?: string; containerPort?: number }>;
          environment?: string[] | Record<string, string>;
          labels?: Record<string, string>;
          mounts?: Array<{ source?: string; destination?: string; options?: string[] }>;
        };
        status?: { state?: string };
      }>;
      const detail = inspected[0];
      status.container = detail?.status?.state === "running" ? "running" : "stopped";
      status.network = applePortsAreLocal(detail?.configuration?.publishedPorts) ? "loopback" : "unsafe";
      const appleImage = imageIsBareName(detail?.configuration?.image)
        ? detail.configuration.image
        : detail?.configuration?.image?.reference ?? detail?.configuration?.imageReference;
      const appleImageId = imageIsBareName(detail?.configuration?.image)
        ? null
        : normalizeImageId(detail?.configuration?.image?.descriptor?.digest);
      status.imageMatches =
        appleImage === IMAGE && status.image_id !== null && appleImageId === status.image_id;
      status.managed = containerLabelsMatch(detail?.configuration?.labels);
      status.persistence = appleWorkspaceMountIsSafe(detail?.configuration?.mounts, platform, target)
        ? "durable"
        : "unsafe";
      const resources = detail?.configuration?.resources;
      // The limits label is the escape hatch for runtimes that reject
      // --memory/--cpus outright: caps dropped stays mandatory, but numeric
      // limits may be absent without marking the desktop unsafe.
      const limitsWaived = detail?.configuration?.labels?.[LIMITS_LABEL] === "none";
      status.security =
        ((resources?.memoryInBytes ?? 0) >= MEMORY_BYTES && resources?.cpus === 2) || limitsWaived
          ? "hardened"
          : "unsafe";
      status.viewer_url = viewerUrl(viewerPassword(detail?.configuration?.environment), target.viewerPort);
    } else {
      // SAFETY: stdout is the engine's `container inspect` JSON array; fields
      // absent on older engines stay optional and are defaulted below.
      const inspected = JSON.parse(stdout) as Array<{
        Config?: { Image?: string; Labels?: Record<string, string>; Env?: string[] };
        HostConfig?: {
          PortBindings?: Record<string, Array<{ HostIp?: string }> | null>;
          Memory?: number;
          MemorySwap?: number;
          NanoCpus?: number;
          PidsLimit?: number | null;
          CapDrop?: string[] | null;
          CapAdd?: string[] | null;
        };
        Mounts?: Array<{
          Type?: string;
          Source?: string;
          Destination?: string;
          RW?: boolean;
        }>;
        State?: { Running?: boolean; StartedAt?: string };
        Image?: string;
      }>;
      const detail = inspected[0];
      status.container = detail?.State?.Running ? "running" : "stopped";
      const startedAtMs = detail?.State?.StartedAt ? Date.parse(detail.State.StartedAt) : Number.NaN;
      containerStartedAt = Number.isFinite(startedAtMs) ? startedAtMs : null;
      status.network = dockerPortsAreLocal(detail?.HostConfig?.PortBindings) ? "loopback" : "unsafe";
      status.imageMatches =
        detail?.Config?.Image === IMAGE &&
        imageLabelsMatch(detail?.Config?.Labels) &&
        status.image_id !== null &&
        normalizeImageId(detail?.Image) === status.image_id;
      status.managed = containerLabelsMatch(detail?.Config?.Labels);
      status.persistence = dockerWorkspaceMountIsSafe(detail?.Mounts, platform, target) ? "durable" : "unsafe";
      status.security = dockerSecurityIsHardened(detail?.HostConfig, detail?.Config?.Labels) ? "hardened" : "unsafe";
      status.viewer_url = viewerUrl(viewerPassword(detail?.Config?.Env), target.viewerPort);
    }
  } catch {
    // No container with this name.
  }

  const canProbe =
    status.container === "running" &&
    status.imageMatches &&
    status.managed &&
    status.network === "loopback" &&
    status.security === "hardened" &&
    status.persistence === "durable";
  if (canProbe) {
    try {
      const expected = `cua-driver ${CUA_DRIVER_VERSION}`;
      const version = await runner(status.runtime, cuaExecArgs(["--version"], false, target.containerName), 8000);
      if (version.stdout.trim() !== expected) throw new Error(`expected ${expected}`);
      await runner(status.runtime, cuaExecArgs(["status", "--socket", CUA_SOCKET], false, target.containerName), 8000);
      const health = await runner(
        status.runtime,
        cuaExecArgs(["call", "health_report", "{}", "--socket", CUA_SOCKET], false, target.containerName),
        15_000,
      );
      // SAFETY: the cua-driver health_report contract; any missing field fails validation below.
      const report = JSON.parse(health.stdout) as { schema_version?: string; overall?: string; checks?: unknown[] };
      if (
        report.schema_version !== "1" ||
        !Array.isArray(report.checks) ||
        (report.overall !== "ok" && report.overall !== "degraded")
      ) {
        throw new Error(`Cua health report is ${report.overall ?? "invalid"}`);
      }
      const readinessShot = "/tmp/muster-readiness.png";
      await runner(
        status.runtime,
        cuaExecArgs(
          [
            "call",
            "get_desktop_state",
            "{}",
            "--socket",
            CUA_SOCKET,
            "--screenshot-out-file",
            readinessShot,
          ],
          false,
          target.containerName,
        ),
        20_000,
      );
      const captured = await runner(
        status.runtime,
        ["exec", target.containerName, "base64", "-w0", readinessShot],
        20_000,
      );
      if (!wholeScreenshot(Buffer.from(captured.stdout.trim(), "base64")).ok) {
        throw new Error("Cua Driver returned an incomplete readiness screenshot");
      }
      status.desktopReady = true;
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      // A young container whose driver daemon isn't answering yet is booting,
      // not broken — report it as progress instead of alarming the panel with
      // a raw engine error (whose first line echoes the command). Older
      // containers, or other failures, stay actionable: real startup failures
      // surface the supervisor log tail in the panel rather than looking like
      // an endless readiness wait.
      if (
        containerStartedAt !== null &&
        Date.now() - containerStartedAt < DESKTOP_BOOT_GRACE_MS &&
        DAEMON_STARTING.test(raw)
      ) {
        status.desktop_starting = true;
      } else {
        status.desktop_error = conciseProbeError(raw);
        try {
          const errorLog = await runner(
            status.runtime,
            ["exec", target.containerName, "tail", "-n", "4", "/var/log/supervisor/cua-driver.error.log"],
            4000,
          );
          status.desktop_error =
            errorLog.stdout.replace(/\s+/g, " ").trim().slice(0, 320) ||
            status.desktop_error;
        } catch {
          // The log may not exist during the first seconds of container boot.
        }
      }
    }
  }

  status.problem = statusProblem(status);
  status.ready = status.problem === null;
  return status;
}

function loopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "[::1]";
}

function dockerPortsAreLocal(
  bindings: Record<string, Array<{ HostIp?: string }> | null> | undefined,
): boolean {
  const viewer = bindings?.[`${INTERNAL_VIEWER_PORT}/tcp`] ?? [];
  const published = Object.values(bindings ?? {}).flatMap((entries) => entries ?? []);
  return viewer.length > 0 && published.length === viewer.length && published.every((entry) => loopback(entry.HostIp));
}

function applePortsAreLocal(
  bindings: Array<{ hostAddress?: string; containerPort?: number }> | undefined,
): boolean {
  return Boolean(
    bindings?.length === 1 &&
      bindings[0]?.containerPort === INTERNAL_VIEWER_PORT &&
      loopback(bindings[0]?.hostAddress),
  );
}

function sameWorkspaceSource(source: string | undefined, platform: NodeJS.Platform, expectedDir: string): boolean {
  if (!source) return false;
  const actual = resolve(source);
  const expected = resolve(expectedDir);
  return platform === "win32" ? actual.toLowerCase() === expected.toLowerCase() : actual === expected;
}

function dockerWorkspaceMountIsSafe(
  mounts:
    | Array<{ Type?: string; Source?: string; Destination?: string; RW?: boolean }>
    | undefined,
  platform: NodeJS.Platform,
  target: LocalVmTarget = SHARED_LOCAL_VM_TARGET,
): boolean {
  return Boolean(
    mounts?.length === 1 &&
      mounts[0]?.Type === "bind" &&
      sameWorkspaceSource(mounts[0]?.Source, platform, target.workspaceDir) &&
      mounts[0]?.Destination === VM_WORKSPACE_GUEST &&
      mounts[0]?.RW !== false,
  );
}

function appleWorkspaceMountIsSafe(
  mounts: Array<{ source?: string; destination?: string; options?: string[] }> | undefined,
  platform: NodeJS.Platform,
  target: LocalVmTarget = SHARED_LOCAL_VM_TARGET,
): boolean {
  const options = mounts?.[0]?.options ?? [];
  return Boolean(
    mounts?.length === 1 &&
      sameWorkspaceSource(mounts[0]?.source, platform, target.workspaceDir) &&
      mounts[0]?.destination === VM_WORKSPACE_GUEST &&
      !options.some((option) => option === "ro" || option === "readonly"),
  );
}

function dockerSecurityIsHardened(
  config:
    | {
        Memory?: number;
        MemorySwap?: number;
        NanoCpus?: number;
        PidsLimit?: number | null;
        CapDrop?: string[] | null;
        CapAdd?: string[] | null;
      }
    | undefined,
  labels: Record<string, string> | undefined,
): boolean {
  if (!config) return false;
  // Runtimes that reject --memory/--cpus outright record the waiver label at
  // run time; capability drops are never waived.
  if (labels?.[LIMITS_LABEL] !== "none") {
    if (
      (config.Memory ?? 0) < MEMORY_BYTES ||
      (config.MemorySwap ?? 0) !== MEMORY_BYTES ||
      (config.NanoCpus ?? 0) !== NANO_CPUS ||
      (config.PidsLimit ?? 0) <= 0 ||
      (config.PidsLimit ?? Infinity) > PIDS_LIMIT
    ) {
      return false;
    }
  }
  const capDrop = (config.CapDrop ?? []).map((cap) => cap.toLowerCase());
  const capAdd = (config.CapAdd ?? [])
    .map((cap) => cap.toLowerCase().replace(/^cap_/, ""))
    .sort();
  return capDrop.includes("all") && capAdd.join(",") === "setgid,setuid";
}

/** The viewer password for one Local VM target: generated once per VM
 * lifetime, persisted 0600 under DATA_DIR so (a) the real run command and
 * (b) the user-facing "Show command" panel always agree, instead of the
 * panel showing a CHANGE_ME placeholder while the actual container got a
 * random secret. Recreating the VM rotates the password. */
export function viewerPasswordFor(target: LocalVmTarget): string {
  const passwordPath = join(DATA_DIR, "vm-secrets", `${target.containerName}.vnc-pw`);
  try {
    const existing = readFileSync(passwordPath, "utf8").trim();
    if (existing) return existing;
  } catch {
    /* first generation for this target */
  }
  const password = randomBytes(9).toString("base64url");
  mkdirSync(join(DATA_DIR, "vm-secrets"), { recursive: true });
  writeFileAtomic(passwordPath, password, { mode: 0o600 });
  return password;
}

/** Rotate the stored password — called when a VM is recreated so the old
 * viewer credential dies with the old container. */
export function rotateViewerPassword(target: LocalVmTarget): void {
  try {
    rmSync(join(DATA_DIR, "vm-secrets", `${target.containerName}.vnc-pw`));
  } catch {
    /* nothing stored yet */
  }
}

export function containerRunArgs(
  runtime: Runtime,
  password = "CHANGE_ME",
  target: LocalVmTarget = SHARED_LOCAL_VM_TARGET,
  applyResourceLimits = true,
): string[] {
  const common = ["run", "-d", "--name", target.containerName];
  common.push(
    "--label",
    `${MANAGED_LABEL}=1`,
    "--label",
    `${DRIVER_LABEL}=${CUA_DRIVER_VERSION}`,
    "--label",
    `${BASE_IMAGE_LABEL}=${BASE_IMAGE_DIGEST}`,
    "--label",
    `${IMAGE_LAYER_LABEL}=${IMAGE_LAYER_VERSION}`,
    "--label",
    `${WORKSPACE_LABEL}=1`,
    // Recorded either way so a later status check can tell "limits were
    // deliberately waived by the runtime" from "someone stripped the caps".
    "--label",
    `${LIMITS_LABEL}=${applyResourceLimits ? "1" : "none"}`,
  );
  if (runtime === "container") {
    // Apple container already places each Linux container in a lightweight VM.
    common.push(...resourceFlags(runtime, applyResourceLimits));
  } else {
    common.push("--hostname", target.containerName, ...resourceFlags(runtime, applyResourceLimits));
  }
  common.push(
    "--mount",
    runtime === "podman"
      ? `type=bind,source=${target.workspaceDir},target=${VM_WORKSPACE_GUEST},relabel=private,U=true`
      : `type=bind,source=${target.workspaceDir},target=${VM_WORKSPACE_GUEST}`,
    "-e",
    `VNC_PW=${password}`,
    "-p",
    `127.0.0.1:${target.viewerPort}:${INTERNAL_VIEWER_PORT}`,
    IMAGE,
  );
  return common;
}

/** The 4 GB memory / 2 CPU ceiling every managed desktop runs under — the
 * same caps in shared and per-bot mode — plus runtime-specific hardening.
 * When a runtime rejects limits outright, only the numeric flags are
 * stripped; the capability drops stay in every variant. */
function resourceFlags(runtime: Runtime, applyResourceLimits: boolean): string[] {
  const caps = ["--cap-drop", "ALL", "--cap-add", "SETUID", "--cap-add", "SETGID"];
  if (!applyResourceLimits) {
    return runtime === "container" ? caps : [...caps, "--shm-size", "512m"];
  }
  if (runtime === "container") {
    return ["--memory", "4g", "--cpus", "2", ...caps, "--shm-size", "512m"];
  }
  return [
    "--memory",
    "4g",
    "--memory-swap",
    "4g",
    "--cpus",
    "2",
    "--pids-limit",
    String(PIDS_LIMIT),
    ...caps,
    "--shm-size",
    "512m",
  ];
}

async function ensureVmWorkspace(platform: NodeJS.Platform, workspaceDir: string): Promise<void> {
  await mkdir(workspaceDir, { recursive: true, mode: 0o700 });
  if (platform !== "win32") await chmod(workspaceDir, 0o700);
}

// Docker Desktop's VM (VirtioFS) can take a moment to notice a just-created
// host directory, so the first `docker run` against a brand-new vm-home
// intermittently fails with "bind source path does not exist" even though the
// folder exists on the host. Without a retry, the very first click of
// "Create Local VM" on a fresh install dies with a confusing 500 and only the
// second click works.
const BIND_SOURCE_NOT_VISIBLE = /bind source path does not exist/i;
const delay = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** Map raw engine failures on lifecycle actions to actionable, secret-free
 * messages. `execFile` prepends "Command failed: <full command>", which for
 * `run` embeds the viewer password — that string must never reach the UI. */
function friendlyContainerError(error: unknown, runtime: Runtime, target: LocalVmTarget): Error {
  const raw = error instanceof Error ? error.message : String(error);
  if (/port is already allocated|address already in use|bind for 127\.0\.0\.1/i.test(raw)) {
    return Object.assign(
      new Error(`The viewer port ${target.viewerPort} is already in use — close the app holding it, press Re-check, then try again`),
      { status: 409 },
    );
  }
  if (BIND_SOURCE_NOT_VISIBLE.test(raw)) {
    return Object.assign(
      new Error(`The container runtime could not see the durable workspace folder at ${target.workspaceDir} — check that folder's permissions and try again`),
      { status: 500 },
    );
  }
  const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
  const tail = ((lines.length > 1 ? lines.slice(1).join(" ") : lines[0] ?? "").replace(/VNC_PW=\S+/gi, "VNC_PW=•")).slice(0, 240);
  return Object.assign(
    new Error(`The ${runtime} command failed${tail ? `: ${tail}` : " for a reason the log did not explain"}`),
    { status: 502 },
  );
}

/** Replace the pre-scoping singleton VM when it belongs to THIS install —
 * proven by its durable workspace mount pointing at this DATA_DIR's vm-home.
 * A legacy VM owned by another install is left alone: new containers carry
 * install-scoped names and ports and can't collide with it. */
async function removeLegacyOwnedVm(
  runtime: Runtime,
  runner: CommandRunner,
  target: LocalVmTarget,
  platform: NodeJS.Platform,
): Promise<void> {
  let stdout: string;
  try {
    ({ stdout } = await runner(runtime, ["inspect", LEGACY_CONTAINER], 15_000));
  } catch {
    return; // no legacy VM — the normal case
  }
  try {
    // SAFETY: engine inspect output; the shape is validated field by field and
    // anything unparseable leaves the legacy container untouched.
    const parsed = JSON.parse(stdout) as Array<{
      Mounts?: Array<{ Source?: string }>;
      configuration?: { mounts?: Array<{ source?: string }> };
    }>;
    const sources = [
      ...(parsed[0]?.Mounts ?? []).map((mount) => mount.Source ?? ""),
      ...(parsed[0]?.configuration?.mounts ?? []).map((mount) => mount.source ?? ""),
    ];
    if (!sources.some((source) => source && sameWorkspaceSource(source, platform, target.workspaceDir))) return;
    await runner(runtime, ["rm", runtime === "container" ? "--force" : "-f", LEGACY_CONTAINER], 60_000);
  } catch {
    // Unparseable inspect or removal refused: leave the legacy VM alone.
  }
}

/** Total memory visible to the container daemon (the host, or its VM).
 * null when the probe is unavailable OR implausible (a runtime answering a
 * version string where bytes were expected must never look like a 29-byte
 * machine and block a working desktop) — the run guard stays silent in both
 * cases rather than blocking a setup it cannot actually read. */
async function hostMemoryBytes(runtime: Runtime, runner: CommandRunner): Promise<number | null> {
  try {
    const { stdout } = await runner(runtime, ["info", "--format", "{{.Host.MemTotal}}"]);
    const bytes = Number(stdout.trim());
    const SANE_MINIMUM = 256 * 1024 * 1024; // no real daemon VM is smaller
    return Number.isSafeInteger(bytes) && bytes >= SANE_MINIMUM ? bytes : null;
  } catch {
    return null;
  }
}

async function prepareManagedImage(runtime: Runtime, runner: CommandRunner): Promise<void> {
  await runner(runtime, ["pull", BASE_IMAGE], 10 * 60_000);
  const context = await mkdtemp(join(tmpdir(), "muster-cua-image-"));
  try {
    await writeFile(join(context, "Dockerfile"), managedImageDockerfile(), { mode: 0o600 });
    await runner(runtime, ["build", "-t", IMAGE, context], 10 * 60_000);
  } finally {
    await rm(context, { recursive: true, force: true });
  }
}

export async function containerComputerAction(
  action: LifecycleAction,
  runner: CommandRunner = sh,
  platform: NodeJS.Platform = process.platform,
  target: LocalVmTarget = SHARED_LOCAL_VM_TARGET,
): Promise<ContainerComputerStatus> {
  if (runner === sh && platform === process.platform) screenshotStatusCache = null;
  const before = await containerComputerStatus(runner, platform, target);
  const runtime = before.runtime;
  if (!runtime) throw Object.assign(new Error(before.problem ?? "No container runtime is installed"), { status: 409 });

  // The one action that runs BEFORE the daemon is up — that is the whole
  // point of it, so it has to be checked ahead of the daemonUp gate below,
  // not after it.
  if (action === "runtimeStart") {
    if (before.daemonUp) return before;
    await startContainerRuntime(runtime, platform, runner);
    return containerComputerStatus(runner, platform, target);
  }

  if (!before.daemonUp) throw Object.assign(new Error(before.problem ?? `${runtime} is not running`), { status: 409 });

  // The desktop runs under a 4 GiB ceiling, but a podman/docker VM created
  // with the old 2 GiB default can't even honor `--memory 4g` — the container
  // starts and the desktop OOMs, which surfaces as a mysterious "failed to
  // start". Fail early with the exact resize command instead. Skipped when
  // the probe is unavailable (a runtime that rejects the format key).
  if (action === "run") {
    const hostMem = await hostMemoryBytes(runtime, runner);
    if (hostMem !== null && hostMem < MEMORY_BYTES) {
      const gib = Math.round(hostMem / 1024 ** 3);
      const fix =
        runtime === "podman"
          ? "podman machine stop && podman machine set --memory 8192 && podman machine start"
          : "raise the Docker/colima VM memory to at least 8 GiB (Docker Desktop: Settings → Resources, or colima start --memory 8)";
      throw Object.assign(
        new Error(`The ${runtime} machine has about ${gib} GiB of memory, but the desktop needs at least 4 GiB — ${fix}`),
        { status: 409 },
      );
    }
  }

  if (action === "run" && before.container !== "missing") {
    // The classic trap: a previous container still holds the viewer port
    // (6080), so `docker run` dies with "port is already allocated". If
    // the existing container is ours, merely stopped, and fully matching
    // (managed + current image + safe network/security/persistence),
    // recycle it — remove, then run fresh with the current stored viewer
    // secret. Anything unsafe still refuses (stop it first or recreate).
    const recyclable =
      before.container === "stopped" &&
      before.managed &&
      before.imageMatches &&
      before.network === "loopback" &&
      before.security === "hardened" &&
      before.persistence === "durable";
    if (recyclable) {
      await runner(runtime, ["rm", runtime === "container" ? "--force" : "-f", target.containerName], 60_000);
    } else {
      throw Object.assign(new Error("A Local VM already exists; remove it before creating a replacement"), { status: 409 });
    }
  }
  if (action === "run" && !before.image) {
    throw Object.assign(new Error("Prepare the Cua desktop image before creating the Local VM"), { status: 409 });
  }
  if (action === "start" && before.container === "missing") {
    throw Object.assign(new Error("No Local VM exists yet — create one first"), { status: 409 });
  }
  if (action === "stop" && before.container !== "running") {
    throw Object.assign(new Error("The Local VM is not running"), { status: 409 });
  }
  if (action === "remove" && before.container === "missing") return before;
  if (action === "remove") rotateViewerPassword(target);

  if (action === "pull") {
    await prepareManagedImage(runtime, runner);
  } else {
    if (action === "run") {
      await ensureVmWorkspace(platform, target.workspaceDir);
      if (target.key === SHARED_LOCAL_VM_TARGET.key) {
        await removeLegacyOwnedVm(runtime, runner, target, platform);
      }
    }
    const args =
      action === "run"
        ? containerRunArgs(runtime, viewerPasswordFor(target), target)
        : action === "remove"
          ? ["rm", runtime === "container" ? "--force" : "-f", target.containerName]
          : [action, target.containerName];
    let attempts = 0;
    for (;;) {
      attempts += 1;
      try {
        await runner(runtime, args, 2 * 60_000);
        break;
      } catch (error) {
        if (
          action === "run" &&
          attempts <= 3 &&
          BIND_SOURCE_NOT_VISIBLE.test(error instanceof Error ? error.message : String(error))
        ) {
          // The fresh folder isn't visible to the VM yet: let VirtioFS
          // sync, re-ensure, and retry — a single click must not fail.
          // Field observation: lazy share enumeration can take several
          // seconds, so the budget goes up to ~9s (desktop boot itself
          // takes ~30s — the user waits either way).
          await delay(attempts * 1_500);
          await ensureVmWorkspace(platform, target.workspaceDir);
          continue;
        }
        // Guard for runtimes that reject --memory/--cpus outright (some podman
        // roots and old docker builds): recreate once without numeric caps so a
        // desktop still comes up. Only errors that actually mention a resource
        // flag qualify — a port collision retried unbounded just fails twice.
        // Capability drops are kept in every retry, and the original failure
        // is surfaced when even the unbounded run refuses.
        const rawError = error instanceof Error ? error.message : String(error);
        const limitsRejected =
          action === "run" && args.includes("--memory") && /memory|cpus|pids/i.test(rawError);
        if (!limitsRejected) throw friendlyContainerError(error, runtime, target);
        try {
          await containerComputerStatus(runner, platform, target).then(async (after) => {
            if (after.container !== "missing") {
              await runner(runtime, ["rm", runtime === "container" ? "--force" : "-f", target.containerName], 60_000);
            }
          });
          await runner(runtime, containerRunArgs(runtime, viewerPasswordFor(target), target, false), 2 * 60_000);
          break;
        } catch {
          throw friendlyContainerError(error, runtime, target);
        }
      }
    }
  }
  return containerComputerStatus(runner, platform, target);
}

type ScreenshotCheck = { ok: boolean; mime: "image/png" | "image/jpeg" };

function wholeScreenshot(bytes: Buffer): ScreenshotCheck {
  if (bytes.length < 512) return { ok: false, mime: "image/png" };
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (png) {
    return {
      ok: bytes.subarray(Math.max(0, bytes.length - 12)).includes(Buffer.from("IEND", "ascii")),
      mime: "image/png",
    };
  }
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  return {
    ok: jpeg && bytes.subarray(Math.max(0, bytes.length - 32)).includes(Buffer.from([0xff, 0xd9])),
    mime: "image/jpeg",
  };
}

export async function containerComputerScreenshot(
  runner: CommandRunner = sh,
  platform: NodeJS.Platform = process.platform,
  target: LocalVmTarget = SHARED_LOCAL_VM_TARGET,
): Promise<string> {
  const cacheable = runner === sh && platform === process.platform && target.key === SHARED_LOCAL_VM_TARGET.key;
  const now = Date.now();
  const status =
    cacheable && screenshotStatusCache && screenshotStatusCache.expiresAt > now
      ? screenshotStatusCache.status
      : await containerComputerStatus(runner, platform, target);
  if (!status.ready || !status.runtime) {
    if (cacheable) screenshotStatusCache = null;
    throw Object.assign(new Error(status.problem ?? "The Local VM is not ready"), { status: 409 });
  }
  if (cacheable) screenshotStatusCache = { status, expiresAt: now + SCREENSHOT_STATUS_TTL_MS };
  try {
    const screenshot = "/tmp/muster-preview.png";
    await runner(
      status.runtime,
      cuaExecArgs(
        [
          "call",
          "get_desktop_state",
          "{}",
          "--socket",
          CUA_SOCKET,
          "--screenshot-out-file",
          screenshot,
        ],
        false,
        target.containerName,
      ),
      30_000,
    );
    const { stdout } = await runner(status.runtime, ["exec", target.containerName, "base64", "-w0", screenshot], 30_000);
    const data = stdout.trim();
    const checked = wholeScreenshot(Buffer.from(data, "base64"));
    if (!checked.ok) {
      throw Object.assign(new Error("Cua Driver returned an incomplete screenshot"), { status: 502 });
    }
    return `data:${checked.mime};base64,${data}`;
  } catch (error) {
    if (cacheable) screenshotStatusCache = null;
    throw error;
  }
}

let screenshotStatusCache: { status: ContainerComputerStatus; expiresAt: number } | null = null;

const containerMcpPath = SPAWNED_PROXIES.containerMcp;

/** Spawn contract handed directly to agent runtimes. The tiny host wrapper
 * only preserves stdio through the container CLI; Cua Driver owns the MCP
 * protocol and every computer tool. */
type ContainerMcpLaunch = {
  command: string;
  args: string[];
  env: Record<string, string>;
};

export function containerComputerMcp(
  runtime: Runtime,
  target: LocalVmTarget = SHARED_LOCAL_VM_TARGET,
  extraEnv: Record<string, string> = {},
): ContainerMcpLaunch {
  return {
    command: process.execPath,
    args: [containerMcpPath, runtime, target.containerName, CUA_SOCKET],
    env: { ELECTRON_RUN_AS_NODE: "1", ...extraEnv },
  };
}

/** Cheap existence probe used by the per-bot desktop cap. It deliberately
 * checks the container only — an inspect hit means the desktop still occupies
 * a slot whether or not it is currently running. */
export async function desktopExists(
  runtime: Runtime,
  target: LocalVmTarget,
  runner: CommandRunner = sh,
): Promise<boolean> {
  try {
    await runner(runtime, ["inspect", target.containerName], 8000);
    return true;
  } catch {
    return false;
  }
}

/** How many of these desktops already exist on this machine. Distinct targets
 * only — two bots resolving to one target count once. */
export async function countExistingDesktops(
  runtime: Runtime,
  targets: LocalVmTarget[],
  runner: CommandRunner = sh,
): Promise<number> {
  const unique = [...new Map(targets.map((target) => [target.key, target])).values()];
  const existing = await Promise.all(unique.map((target) => desktopExists(runtime, target, runner)));
  return existing.filter(Boolean).length;
}

/** Commands shown as a transparent fallback. Normal setup builds the pinned
 * derivative through the API, so users do not need to author a Dockerfile. */
export function setupCommands(
  runtime: Runtime | null,
  platform: NodeJS.Platform = process.platform,
  target: LocalVmTarget = SHARED_LOCAL_VM_TARGET,
) {
  const install =
    platform === "darwin"
      ? "brew install podman; podman machine init; podman machine start"
      : platform === "win32"
        ? "winget install -e --id RedHat.Podman-Desktop"
        : null;
  const runtimeStart =
    runtime === "container"
      ? "container system start"
      : runtime === "podman" && platform !== "linux"
        ? "podman machine init; podman machine start"
        : runtime === "docker" && platform === "darwin"
          ? "colima start || open -a Docker"
          : runtime === "docker" && platform === "linux"
            ? "sudo systemctl start docker"
            : null;

  if (!runtime) {
    return {
      install,
      runtimeStart: null,
      pull: null,
      run: null,
      start: null,
      stop: null,
      remove: null,
      view: `http://127.0.0.1:${target.viewerPort}/vnc.html`,
    };
  }
  const command = (args: string[]) => [runtime, ...args].join(" ");
  return {
    install,
    runtimeStart,
    // This is the inspectable base download. The normal Prepare button also
    // builds the checksum-pinned 0.20.0 derivative automatically.
    pull: command(["pull", BASE_IMAGE]),
    // The displayed command shows the target's REAL stored viewer password
    // (localhost-only, 0600 secret file) so what the user runs by hand and
    // what Muster runs agree — previously this was a CHANGE_ME placeholder
    // while the actual container got a random secret.
    run: command(containerRunArgs(runtime, viewerPasswordFor(target), target)),
    start: null,
    stop: command(["stop", target.containerName]),
    remove: command(["rm", runtime === "container" ? "--force" : "-f", target.containerName]),
    view: `http://127.0.0.1:${target.viewerPort}/vnc.html`,
  };
}

/** Whether runtimeStart's command can be run by Muster itself: every case
 * except docker-on-linux, which needs sudo — a password prompt Muster has
 * no way to satisfy programmatically, and running anything as root without
 * the user watching it happen isn't a line to cross quietly. */
export function canAutoStartRuntime(runtime: Runtime | null, platform: NodeJS.Platform): boolean {
  return runtime !== null && !(runtime === "docker" && platform === "linux");
}

/** Actually run the runtime-start command — only ever called after
 * canAutoStartRuntime() confirmed it doesn't need sudo. Uses a real shell
 * (not CommandRunner, which is scoped to "runtime <args>" invocations) since
 * these are heterogeneous commands: launching a GUI app, a VM manager, or a
 * system service, not the container runtime CLI itself.
 *
 * The start command's exit code is NOT the truth — `podman machine start` on
 * an already-running machine exits non-zero with "already running", which IS
 * the desired end state (the field bug: the Local VM panel stayed red forever
 * because of it). So a failed start is followed by a daemon probe through the
 * same runner the status panel uses: if the daemon answers, the start worked. */
export async function startContainerRuntime(
  runtime: Runtime,
  platform: NodeJS.Platform = process.platform,
  runner: CommandRunner = sh,
  shell?: (command: string) => Promise<void>,
): Promise<void> {
  if (!canAutoStartRuntime(runtime, platform)) {
    throw Object.assign(new Error(`Starting ${runtime} on Linux needs sudo — run the command shown below yourself.`), {
      status: 409,
    });
  }
  const command =
    runtime === "container"
      ? "container system start"
      : runtime === "podman"
        ? "podman machine init 2>/dev/null; podman machine start"
        : "colima start || open -a Docker";
  const shellRun = promisify(execFile);
  const runShell = shell ?? (async (cmd: string) => {
    // Starting a VM/daemon can genuinely take a while on first run — same
    // generous timeout the image-prepare and container actions already use.
    await shellRun("/bin/sh", ["-c", cmd], { timeout: 2 * 60_000, env: { ...process.env, PATH: augmentedPath() } });
  });
  const daemonAnswers = async () => {
    try {
      await runner(runtime, runtime === "container" ? ["system", "status"] : ["info", "--format", "{{.ServerVersion}}"], 20_000);
      return true;
    } catch {
      return false;
    }
  };
  try {
    await runShell(command);
  } catch (e) {
    // "already running" is success by definition; anything else still gets
    // one daemon check before failing, because a half-reported start (the
    // VM came up but the CLI complained about forwarding/labels) should not
    // lock the panel into a permanent red state.
    const message = e instanceof Error ? e.message : String(e);
    if (!/already running/i.test(message) && !(await daemonAnswers())) {
      throw Object.assign(new Error(`Could not start ${runtime}: ${message}`), {
        status: 500,
      });
    }
  }
  // A start that "succeeded" without the daemon ever answering is the cold
  // `podman info` case: give the API forwarder a moment and ask again before
  // declaring victory, so callers that re-check status immediately agree.
  if (!(await daemonAnswers())) {
    throw Object.assign(new Error(`Could not start ${runtime}: the command finished but ${runtime} is not answering yet — try Re-check in a moment`), {
      status: 500,
    });
  }
}

/** Cloud boxes still use Muster's high-latency REST adapter. Local VMs
 * bypass it and mount Cua Driver's official MCP server through
 * containerComputerMcp(). OpenSandbox rides the same REST-style adapter
 * as Box — server/computer-proxy.ts dispatches to whichever backend's env
 * vars are actually present. */
export function computerProxyEnv(
  computer:
    | { kind?: "box"; boxId?: string; token?: string }
    | { kind: "opensandbox"; sandboxId?: string; url?: string; apiKey?: string },
): NodeJS.ProcessEnv {
  if (computer.kind === "opensandbox") {
    return {
      OGB_OPENSANDBOX_SANDBOX_ID: computer.sandboxId ?? "",
      OGB_OPENSANDBOX_URL: computer.url ?? "",
      OGB_OPENSANDBOX_API_KEY: computer.apiKey ?? "",
    };
  }
  return { OGB_BOX_ID: computer.boxId ?? "", OGB_BOX_TOKEN: computer.token ?? "" };
}
