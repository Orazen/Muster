import { describe, expect, it } from "vitest";

import {
  BASE_IMAGE,
  BASE_IMAGE_DIGEST,
  BASE_IMAGE_LABEL,
  CONTAINER,
  CUA_DRIVER_VERSION,
  CUA_EXECUTABLE,
  CUA_SOCKET,
  DRIVER_LABEL,
  IMAGE,
  IMAGE_LAYER_LABEL,
  IMAGE_LAYER_VERSION,
  LEGACY_CONTAINER,
  MANAGED_LABEL,
  SHARED_LOCAL_VM_TARGET,
  VM_WORKSPACE_DIR,
  VM_WORKSPACE_GUEST,
  WORKSPACE_LABEL,
  computerProxyEnv,
  conciseProbeError,
  containerComputerAction,
  containerComputerMcp,
  containerComputerScreenshot,
  containerComputerStatus,
  canAutoStartRuntime,
  startContainerRuntime,
  managedImageDockerfile,
  setupCommands,
  type CommandRunner,
} from "./container-computer.ts";

function runner(responses: Record<string, string | Error>) {
  const calls: string[] = [];
  const run: CommandRunner = async (command, args) => {
    const key = [command, ...args].join(" ");
    calls.push(key);
    const response = responses[key];
    if (response instanceof Error || response === undefined) {
      // `docker run` (the big generated command) and the versioned artifact
      // variant are always accepted — tests assert on `calls`, not on the
      // exact line, and the full arg list embeds a random VNC secret.
      if (key.startsWith("docker run ")) return { stdout: "container-id\n" };
      throw response ?? new Error(`unexpected command: ${key}`);
    }
    return { stdout: response };
  };
  return { calls, run };
}

const driverExec =
  `docker exec -u cua -e HOME=/home/cua -e DISPLAY=:1 -e CUA_DRIVER_INSTALL_CHANNEL=python_package ` +
  `-e CUA_DRIVER_RS_TELEMETRY_ENABLED=0 ${CONTAINER} ${CUA_EXECUTABLE}`;
const versionProbe = `${driverExec} --version`;
const statusProbe = `${driverExec} status --socket ${CUA_SOCKET}`;
const healthProbe = `${driverExec} call health_report {} --socket ${CUA_SOCKET}`;
const readinessProbe =
  `${driverExec} call get_desktop_state {} --socket ${CUA_SOCKET} ` +
  "--screenshot-out-file /tmp/muster-readiness.png";
const readinessRead = `docker exec ${CONTAINER} base64 -w0 /tmp/muster-readiness.png`;
const validPng = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(600),
  Buffer.from("IEND", "ascii"),
]);

function preparedImageInspect() {
  return JSON.stringify([
    {
      Id: "sha256:managed-image-id",
      Config: {
        Labels: {
          [MANAGED_LABEL]: "1",
          [DRIVER_LABEL]: CUA_DRIVER_VERSION,
          [BASE_IMAGE_LABEL]: BASE_IMAGE_DIGEST,
          [IMAGE_LAYER_LABEL]: IMAGE_LAYER_VERSION,
        },
      },
    },
  ]);
}

/** The healthy ready-container inspect a status check expects; tests may
 * override top-level fields to exercise degraded shapes. */
interface InspectState {
  Running: boolean;
  StartedAt?: string;
}

const READY_INSPECT = {
  Config: {
    Image: IMAGE,
    Labels: {
      [MANAGED_LABEL]: "1",
      [DRIVER_LABEL]: CUA_DRIVER_VERSION,
      [BASE_IMAGE_LABEL]: BASE_IMAGE_DIGEST,
      [IMAGE_LAYER_LABEL]: IMAGE_LAYER_VERSION,
      [WORKSPACE_LABEL]: "1",
    },
    Env: ["VNC_PW=secret123"],
  },
  // SAFETY: the happy-path inspect this fixture stands in for always reports a
  // running container; `StartedAt` is present only in the uptime variants.
  State: { Running: true } as InspectState,
  Image: "sha256:managed-image-id",
  HostConfig: {
    Memory: 4 * 1024 * 1024 * 1024,
    MemorySwap: 4 * 1024 * 1024 * 1024,
    NanoCpus: 2_000_000_000,
    PidsLimit: 512,
    CapDrop: ["ALL"],
    CapAdd: ["CAP_SETUID", "CAP_SETGID"],
    PortBindings: { "6901/tcp": [{ HostIp: "127.0.0.1" }] },
  },
  Mounts: [
    {
      Type: "bind",
      Source: VM_WORKSPACE_DIR,
      Destination: VM_WORKSPACE_GUEST,
      RW: true,
    },
  ],
};

function readyInspect(overrides: Partial<typeof READY_INSPECT> = {}) {
  return JSON.stringify([{ ...READY_INSPECT, ...overrides }]);
}

describe("containerComputerStatus", () => {
  it("prefers a running runtime over an earlier installed but stopped one", async () => {
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": "podman\n",
      "docker info --format {{.ServerVersion}}": new Error("daemon stopped"),
      "podman info --format {{.ServerVersion}}": "5.0\n",
      [`podman image inspect ${IMAGE}`]: preparedImageInspect(),
      [`podman inspect ${CONTAINER}`]: JSON.stringify([
        {
          State: { Running: false },
          HostConfig: { PortBindings: { "6901/tcp": [{ HostIp: "127.0.0.1" }] } },
        },
      ]),
    });

    const status = await containerComputerStatus(fake.run, "linux");

    expect(status.runtime).toBe("podman");
    expect(status.available).toEqual(["docker", "podman"]);
    expect(status.daemonUp).toBe(true);
    expect(status.image).toBe(true);
    expect(status.container).toBe("stopped");
    expect(status.network).toBe("loopback");
  });

  it("uses Apple container's actual system and inspect commands", async () => {
    const fake = runner({
      "/usr/bin/which docker": new Error("missing"),
      "/usr/bin/which podman": new Error("missing"),
      "/usr/bin/which container": "container\n",
      "container system status": "running\n",
      [`container image inspect ${IMAGE}`]: preparedImageInspect(),
      [`container inspect ${CONTAINER}`]: JSON.stringify([
        {
          configuration: {
            image: { reference: IMAGE, descriptor: { digest: "sha256:managed-image-id" } },
            resources: { cpus: 2, memoryInBytes: 4 * 1024 * 1024 * 1024 },
            publishedPorts: [{ hostAddress: "127.0.0.1", containerPort: 6901 }],
            labels: {
              [MANAGED_LABEL]: "1",
              [DRIVER_LABEL]: CUA_DRIVER_VERSION,
              [BASE_IMAGE_LABEL]: BASE_IMAGE_DIGEST,
              [IMAGE_LAYER_LABEL]: IMAGE_LAYER_VERSION,
              [WORKSPACE_LABEL]: "1",
            },
            mounts: [{ source: VM_WORKSPACE_DIR, destination: VM_WORKSPACE_GUEST, options: [] }],
          },
          status: { state: "running" },
        },
      ]),
    });

    const status = await containerComputerStatus(fake.run, "darwin");

    expect(status.runtime).toBe("container");
    expect(status.container).toBe("running");
    expect(status.network).toBe("loopback");
    expect(fake.calls).not.toContain("container info --format {{.ServerVersion}}");
  });

  it("does not report a running container as ready when its viewer is public", async () => {
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": new Error("missing"),
      "docker info --format {{.ServerVersion}}": "27\n",
      [`docker image inspect ${IMAGE}`]: preparedImageInspect(),
      [`docker inspect ${CONTAINER}`]: readyInspect({
        HostConfig: {
          Memory: 4 * 1024 * 1024 * 1024,
          MemorySwap: 4 * 1024 * 1024 * 1024,
          NanoCpus: 2_000_000_000,
          PidsLimit: 512,
          CapDrop: ["ALL"],
          CapAdd: ["CAP_SETUID", "CAP_SETGID"],
          PortBindings: { "6901/tcp": [{ HostIp: "0.0.0.0" }] },
        },
      }),
    });

    const status = await containerComputerStatus(fake.run, "linux");

    expect(status.container).toBe("running");
    expect(status.network).toBe("unsafe");
    expect(status.ready).toBe(false);
  });

  it("rejects missing or unexpected host mounts instead of exposing them to the bot", async () => {
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": new Error("missing"),
      "docker info --format {{.ServerVersion}}": "29\n",
      [`docker image inspect ${IMAGE}`]: preparedImageInspect(),
      [`docker inspect ${CONTAINER}`]: readyInspect({
        Mounts: [
          { Type: "bind", Source: VM_WORKSPACE_DIR, Destination: VM_WORKSPACE_GUEST, RW: true },
          { Type: "bind", Source: "/tmp/unexpected", Destination: "/host", RW: true },
        ],
      }),
    });

    const status = await containerComputerStatus(fake.run, "linux");

    expect(status.persistence).toBe("unsafe");
    expect(status.ready).toBe(false);
    expect(status.problem).toContain("durable workspace");
  });

  it("does not mistake an unrelated container executable for Apple container off macOS", async () => {
    const fake = runner({
      "where.exe docker": new Error("missing"),
      "where.exe podman": new Error("missing"),
    });

    const status = await containerComputerStatus(fake.run, "win32");

    expect(status.runtime).toBeNull();
    expect(fake.calls).not.toContain("where.exe container");
  });

  it("reports ready only after the exact image, limits, network, version and daemon pass", async () => {
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": new Error("missing"),
      "docker info --format {{.ServerVersion}}": "29\n",
      [`docker image inspect ${IMAGE}`]: preparedImageInspect(),
      [`docker inspect ${CONTAINER}`]: readyInspect(),
      [versionProbe]: `cua-driver ${CUA_DRIVER_VERSION}\n`,
      [statusProbe]: "running\n",
      [healthProbe]: JSON.stringify({ schema_version: "1", overall: "ok", checks: [] }),
      [readinessProbe]: "{}\n",
      [readinessRead]: validPng.toString("base64"),
    });

    const status = await containerComputerStatus(fake.run, "linux");

    expect(status).toMatchObject({
      imageMatches: true,
      managed: true,
      network: "loopback",
      security: "hardened",
      persistence: "durable",
      desktopReady: true,
      desktop_error: null,
      ready: true,
      problem: null,
      driver_version: "0.20.0",
    });
    expect(status.viewer_url).toContain("#autoconnect=true&resize=scale&password=secret123");
  });

  it("reports the bounded desktop startup error instead of waiting forever", async () => {
    const errorProbe =
      `docker exec ${CONTAINER} tail -n 4 /var/log/supervisor/cua-driver.error.log`;
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": new Error("missing"),
      "docker info --format {{.ServerVersion}}": "29\n",
      [`docker image inspect ${IMAGE}`]: preparedImageInspect(),
      [`docker inspect ${CONTAINER}`]: readyInspect(),
      [versionProbe]: new Error("driver unavailable"),
      [errorProbe]: "X display :1 did not become ready within 45 seconds\n",
    });

    const status = await containerComputerStatus(fake.run, "linux");

    expect(status.desktopReady).toBe(false);
    expect(status.desktop_error).toContain("did not become ready");
    expect(status.problem).toContain("desktop failed to start");
  });

  it("does not report ready when the driver's health contract fails", async () => {
    const errorProbe = `docker exec ${CONTAINER} tail -n 4 /var/log/supervisor/cua-driver.error.log`;
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": new Error("missing"),
      "docker info --format {{.ServerVersion}}": "29\n",
      [`docker image inspect ${IMAGE}`]: preparedImageInspect(),
      [`docker inspect ${CONTAINER}`]: readyInspect(),
      [versionProbe]: `cua-driver ${CUA_DRIVER_VERSION}\n`,
      [statusProbe]: "running\n",
      [healthProbe]: JSON.stringify({ schema_version: "1", overall: "failed", checks: [] }),
      [errorProbe]: "",
    });

    const status = await containerComputerStatus(fake.run, "linux");

    expect(status.desktopReady).toBe(false);
    expect(status.desktop_error).toContain("health report is failed");
    expect(fake.calls).not.toContain(readinessProbe);
  });

  it("rejects a lookalike container with a different driver or base-image label", async () => {
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": new Error("missing"),
      "docker info --format {{.ServerVersion}}": "29\n",
      [`docker image inspect ${IMAGE}`]: preparedImageInspect(),
      [`docker inspect ${CONTAINER}`]: readyInspect({
        Config: {
          // A lookalike: managed, but built from an older driver against a
          // different base image digest.
          ...READY_INSPECT.Config,
          Labels: {
            ...READY_INSPECT.Config.Labels,
            [DRIVER_LABEL]: "0.12.4",
            [BASE_IMAGE_LABEL]: "wrong",
          },
        },
      }),
    });

    const status = await containerComputerStatus(fake.run, "linux");

    expect(status.imageMatches).toBe(false);
    expect(status.ready).toBe(false);
    expect(status.problem).toContain("older desktop or Cua Driver");
    expect(fake.calls).not.toContain(versionProbe);
  });

  it("rejects a container created from a stale build under the same mutable tag", async () => {
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": new Error("missing"),
      "docker info --format {{.ServerVersion}}": "29\n",
      [`docker image inspect ${IMAGE}`]: preparedImageInspect(),
      [`docker inspect ${CONTAINER}`]: readyInspect({ Image: "sha256:previous-build-id" }),
    });

    const status = await containerComputerStatus(fake.run, "linux");

    expect(status.image_id).toBe("managed-image-id");
    expect(status.imageMatches).toBe(false);
    expect(status.ready).toBe(false);
    expect(status.problem).toContain("older desktop or Cua Driver");
  });

  it("does not treat an unlabelled image under the local tag as prepared", async () => {
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": new Error("missing"),
      "docker info --format {{.ServerVersion}}": "29\n",
      [`docker image inspect ${IMAGE}`]: JSON.stringify([{ Config: { Labels: {} } }]),
      [`docker inspect ${CONTAINER}`]: new Error("missing container"),
    });

    const status = await containerComputerStatus(fake.run, "linux");

    expect(status.image).toBe(false);
    expect(status.problem).toContain("Prepare the Cua desktop image");
  });
});

describe("Cua integration", () => {
  it("hands cloud credentials only to the isolated remote adapter", () => {
    expect(computerProxyEnv({ boxId: "bx_1", token: "t" })).toEqual({
      OGB_BOX_ID: "bx_1",
      OGB_BOX_TOKEN: "t",
    });
  });

  it("mounts the official Cua MCP server for Local VM turns", () => {
    const connection = containerComputerMcp("podman");
    expect(connection.command).toBe(process.execPath);
    expect(connection.args.at(-3)).toBe("podman");
    expect(connection.args.at(-2)).toBe(CONTAINER);
    expect(connection.args.at(-1)).toBe(CUA_SOCKET);
    expect(connection.env).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
  });

  it("builds an exact, checksum-verified Cua Driver 0.20.0 image", () => {
    const dockerfile = managedImageDockerfile();
    expect(BASE_IMAGE).toMatch(/@sha256:[a-f0-9]{64}$/);
    expect(dockerfile).toContain(`FROM ${BASE_IMAGE}`);
    expect(dockerfile).toContain("cua_driver-0.20.0-py3-none-manylinux_2_31_x86_64.whl");
    expect(dockerfile).toContain("cua_driver-0.20.0-py3-none-manylinux_2_31_aarch64.whl");
    expect(dockerfile).not.toContain("/tmp/cua-driver.whl");
    expect(dockerfile).toContain("sha256sum -c -");
    expect(dockerfile).toContain(`install -D -m 0755 "$driver_bin" ${CUA_EXECUTABLE}`);
    expect(dockerfile).toContain(`cua-driver ${CUA_DRIVER_VERSION}`);
    expect(dockerfile).toContain(`serve --socket ${CUA_SOCKET} --permission-mode standard`);
    expect(dockerfile).toContain("CUA_DRIVER_RS_TELEMETRY_ENABLED=0");
    expect(dockerfile).toContain("prepare-muster-workspace.sh");
    expect(dockerfile).toContain("migrate_profile google-chrome");
    expect(dockerfile).toContain("migrate_profile chromium");
    expect(dockerfile).toContain("SingletonLock");
    expect(dockerfile).toContain(`${IMAGE_LAYER_LABEL}="${IMAGE_LAYER_VERSION}"`);
    expect(dockerfile).toContain("did not become ready within 45 seconds");
    expect(dockerfile).not.toContain("while ! DISPLAY=:1 xset q");
  });

  it("captures the preview through Cua Driver rather than xdotool or VNC", async () => {
    const screenshotCall =
      `${driverExec} call get_desktop_state {} --socket ${CUA_SOCKET} ` +
      "--screenshot-out-file /tmp/muster-preview.png";
    const png = validPng;
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": new Error("missing"),
      "docker info --format {{.ServerVersion}}": "29\n",
      [`docker image inspect ${IMAGE}`]: preparedImageInspect(),
      [`docker inspect ${CONTAINER}`]: readyInspect(),
      [versionProbe]: `cua-driver ${CUA_DRIVER_VERSION}\n`,
      [statusProbe]: "running\n",
      [healthProbe]: JSON.stringify({ schema_version: "1", overall: "degraded", checks: [] }),
      [readinessProbe]: "{}\n",
      [readinessRead]: png.toString("base64"),
      [screenshotCall]: "{}\n",
      [`docker exec ${CONTAINER} base64 -w0 /tmp/muster-preview.png`]: png.toString("base64"),
    });

    const image = await containerComputerScreenshot(fake.run, "linux");

    expect(image).toBe(`data:image/png;base64,${png.toString("base64")}`);
    expect(fake.calls).toContain(screenshotCall);
    expect(fake.calls.some((call) => /xdotool|scrot|vnc/i.test(call))).toBe(false);
  });
});

describe("containerComputerAction", () => {
  it("does not create a VM before its managed image is prepared", async () => {
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": new Error("missing"),
      "docker info --format {{.ServerVersion}}": "29\n",
      [`docker image inspect ${IMAGE}`]: new Error("missing image"),
      [`docker inspect ${CONTAINER}`]: new Error("missing container"),
    });

    await expect(containerComputerAction("run", fake.run, "linux")).rejects.toThrow(
      "Prepare the Cua desktop image",
    );
    expect(fake.calls.some((call) => call.startsWith("docker run "))).toBe(false);
  });

  it("recycles a stopped managed desktop on run — never leaves a port-allocating corpse", async () => {
    // The field bug: docker run died with "port is already allocated"
    // because a previous (stopped) container still held the viewer port.
    // run now removes the stopped managed container first, then creates
    // fresh — with the stored viewer secret, not CHANGE_ME.
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": new Error("missing"),
      "docker info --format {{.ServerVersion}}": "29\n",
      [`docker image inspect ${IMAGE}`]: preparedImageInspect(),
      [`docker inspect ${CONTAINER}`]: readyInspect({ State: { Running: false } }),
      [`docker rm -f ${CONTAINER}`]: "",
      [`docker run -d --name ${CONTAINER}`]: "container-id\n",
    });

    await containerComputerAction("run", fake.run, "linux");
    expect(fake.calls).toContain(`docker rm -f ${CONTAINER}`);
    expect(fake.calls.some((call) => call.startsWith("docker run ") && call.includes("VNC_PW="))).toBe(true);
    expect(fake.calls.some((call) => call.includes("CHANGE_ME"))).toBe(false);
  });

  it("run refuses when an existing container is managed but not recycleable (unsafe config)", async () => {
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": new Error("missing"),
      "docker info --format {{.ServerVersion}}": "29\n",
      [`docker image inspect ${IMAGE}`]: preparedImageInspect(),
      [`docker inspect ${CONTAINER}`]: readyInspect({
        State: { Running: false },
        HostConfig: {
          Memory: 0,
          MemorySwap: 0,
          NanoCpus: 0,
          PidsLimit: 128,
          CapDrop: [],
          CapAdd: [],
          PortBindings: { "6901/tcp": [{ HostIp: "127.0.0.1" }] },
        },
      }),
    });

    await expect(containerComputerAction("run", fake.run, "linux")).rejects.toThrow(
      "A Local VM already exists",
    );
  });

  it("refuses to run the desktop on a container machine smaller than its memory floor", async () => {
    // The field failure: a podman machine created with the old 2 GiB default
    // starts the 4 GiB desktop and OOM-kills it, surfacing as a mysterious
    // "desktop failed to start". The run guard must name the resize command.
    const fake = runner({
      "/usr/bin/which docker": new Error("missing"),
      "/usr/bin/which podman": "podman\n",
      "podman info --format {{.ServerVersion}}": "6.1.1\n",
      "podman info --format {{.Host.MemTotal}}": "2147483648\n",
      [`podman image inspect ${IMAGE}`]: preparedImageInspect(),
      [`podman inspect ${CONTAINER}`]: new Error("missing container"),
    });

    await expect(containerComputerAction("run", fake.run, "darwin")).rejects.toThrow(
      /2 GiB of memory.*podman machine set --memory 8192/s,
    );
    expect(fake.calls.some((call) => call.startsWith("podman run "))).toBe(false);
  });

  it("proceeds with the run when the machine has enough memory", async () => {
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": new Error("missing"),
      "docker info --format {{.ServerVersion}}": "29\n",
      "docker info --format {{.Host.MemTotal}}": "8589934592\n",
      [`docker image inspect ${IMAGE}`]: preparedImageInspect(),
      [`docker inspect ${CONTAINER}`]: new Error("missing container"),
    });

    await containerComputerAction("run", fake.run, "linux");
    expect(fake.calls.some((call) => call.startsWith("docker run "))).toBe(true);
  });

  it("runtimeStart no-ops without touching the runner when the daemon is already up", async () => {
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": new Error("missing"),
      "docker info --format {{.ServerVersion}}": "29\n",
      [`docker image inspect ${IMAGE}`]: new Error("missing image"),
      [`docker inspect ${CONTAINER}`]: new Error("missing container"),
    });

    const status = await containerComputerAction("runtimeStart", fake.run, "darwin");
    expect(status.daemonUp).toBe(true);
    // Nothing beyond the status probes docker info/inspect already needs —
    // no attempt to (re-)start a daemon that's already answering.
    expect(fake.calls.every((call) => call.startsWith("docker info") || call.includes("inspect") || call.startsWith("/usr/bin/which"))).toBe(true);
  });
});

describe("canAutoStartRuntime", () => {
  it("is true for every runtime except docker on Linux, which needs sudo", () => {
    expect(canAutoStartRuntime("docker", "darwin")).toBe(true);
    expect(canAutoStartRuntime("docker", "win32")).toBe(true);
    expect(canAutoStartRuntime("podman", "linux")).toBe(true);
    expect(canAutoStartRuntime("podman", "darwin")).toBe(true);
    expect(canAutoStartRuntime("container", "darwin")).toBe(true);
    expect(canAutoStartRuntime("docker", "linux")).toBe(false);
  });

  it("is false with no runtime at all", () => {
    expect(canAutoStartRuntime(null, "darwin")).toBe(false);
  });
});

describe("startContainerRuntime", () => {
  const daemonUp: CommandRunner = async () => ({ stdout: "6.1.1\n" });
  const daemonDown: CommandRunner = async () => {
    throw new Error("cannot connect");
  };

  it("treats an already-running podman machine as success when the daemon answers", async () => {
    // The field bug: `podman machine start` exits non-zero with "already
    // running" — the desired end state — and the panel stayed red forever.
    await expect(
      startContainerRuntime("podman", "darwin", daemonUp, async () => {
        throw new Error('Error: unable to start "podman-machine-default": already running');
      }),
    ).resolves.toBeUndefined();
  });

  it("keeps probing while a cold API forwarder warms up instead of failing once", async () => {
    // The second field bug: right after machine start, the first `podman
    // info` can lose the race with the gvproxy/SSH forwarder. The daemon is
    // UP — the user's own terminal proves it — so one failed probe must not
    // read as "not answering yet". Probes continue until the window closes.
    let probes = 0;
    const warming: CommandRunner = async () => {
      probes += 1;
      if (probes < 3) throw new Error("cannot connect");
      return { stdout: "6.1.2\n" };
    };
    await expect(
      startContainerRuntime("podman", "darwin", warming, async () => undefined),
    ).resolves.toBeUndefined();
    expect(probes).toBe(3);
  });

  it("verifies the daemon after a clean start and fails honestly when it never answers", async () => {
    let probes = 0;
    const neverUp: CommandRunner = async () => {
      probes += 1;
      throw new Error("cannot connect");
    };
    await expect(
      startContainerRuntime("podman", "darwin", neverUp, async () => undefined),
    ).rejects.toThrow(/not answering yet/);
    // The window is bounded, not infinite: 10 attempts.
    expect(probes).toBe(10);
  });

  it("still surfaces real start failures when the daemon is down", async () => {
    await expect(
      startContainerRuntime("podman", "darwin", daemonDown, async () => {
        throw new Error("podman machine start: SSH handshake failed");
      }),
    ).rejects.toThrow(/Could not start podman.*SSH handshake/s);
  });

  it("refuses sudo-requiring starts before touching the shell", async () => {
    let shellTouched = false;
    await expect(
      startContainerRuntime("docker", "linux", daemonUp, async () => {
        shellTouched = true;
      }),
    ).rejects.toThrow(/needs sudo/);
    expect(shellTouched).toBe(false);
  });
});

describe("setupCommands", () => {
  it("does not invent Docker commands when no runtime was detected", () => {
    const commands = setupCommands(null, "darwin");
    expect(commands.pull).toBeNull();
    expect(commands.run).toBeNull();
    expect(commands.start).toBeNull();
    expect(commands.install).toContain("podman");
    expect(commands.install).not.toContain("Docker");
  });

  it("publishes only the password-protected viewer and only on loopback", () => {
    const command = setupCommands("podman", "linux").run!;
    expect(command).toContain(`-p 127.0.0.1:${SHARED_LOCAL_VM_TARGET.viewerPort}:6901`);
    expect(command).not.toContain(` -p ${SHARED_LOCAL_VM_TARGET.viewerPort}:6901`);
    expect(command).not.toContain("5900");
    // The displayed command carries the target's REAL stored viewer secret
    // (never the CHANGE_ME placeholder and never an empty/weak value), so
    // running it by hand logs into the same VM Muster would create.
    expect(command).not.toContain("VNC_PW=CHANGE_ME");
    expect(command).toMatch(/VNC_PW=[A-Za-z0-9_-]{10,}/);
  });

  it("does not suggest docker start for an image that must be recreated", () => {
    expect(setupCommands("docker", "linux").start).toBeNull();
  });

  it("limits resources and retains only the sandbox supervisor's identity-switch caps", () => {
    const command = setupCommands("docker", "linux").run!;
    expect(command).toContain("--memory 4g --memory-swap 4g");
    expect(command).toContain("--cpus 2 --pids-limit 512");
    expect(command).toContain("--cap-drop ALL --cap-add SETUID --cap-add SETGID");
    expect(command).toContain(`--label ${MANAGED_LABEL}=1`);
    expect(command).toContain(`--label ${DRIVER_LABEL}=${CUA_DRIVER_VERSION}`);
    expect(command).toContain(`--label ${WORKSPACE_LABEL}=1`);
    expect(command).toContain(`--hostname ${CONTAINER}`);
    expect(command).toContain(
      `--mount type=bind,source=${VM_WORKSPACE_DIR},target=${VM_WORKSPACE_GUEST}`,
    );
  });

  it("asks rootless Podman to map and privately relabel the durable workspace", () => {
    const command = setupCommands("podman", "linux").run!;
    expect(command).toContain(
      `--mount type=bind,source=${VM_WORKSPACE_DIR},target=${VM_WORKSPACE_GUEST},relabel=private,U=true`,
    );
  });

  it("shows the pinned base pull while creating the managed derivative through the API", () => {
    expect(setupCommands("docker", "linux").pull).toBe(`docker pull ${BASE_IMAGE}`);
    expect(setupCommands("docker", "linux").run).toContain(IMAGE);
  });

  it("generates Apple container lifecycle commands without Docker-only flags", () => {
    const commands = setupCommands("container", "darwin");
    expect(commands.runtimeStart).toBe("container system start");
    expect(commands.remove).toBe(`container rm --force ${CONTAINER}`);
    expect(commands.run).toContain("--memory 4g --cpus 2 --cap-drop ALL");
    expect(commands.run).not.toContain("--memory-swap");
  });

  it("offers the supported Podman Desktop installer on Windows", () => {
    expect(setupCommands(null, "win32").install).toBe("winget install -e --id RedHat.Podman-Desktop");
  });
});

describe("Local VM first-run field bugs", () => {
  /** Runner whose `docker run` fails the first `failFirst` attempts exactly,
   * standing in for Docker Desktop's VirtioFS lag on a brand-new folder. */
  function flakyRunRunner(failFirst: number, failMessage: string) {
    const calls: string[] = [];
    let runAttempts = 0;
    const responses = new Map<string, string | Error>([
      ["/usr/bin/which docker", "docker\n"],
      ["/usr/bin/which podman", new Error("missing")],
      ["docker info --format {{.ServerVersion}}", "29\n"],
      [`docker image inspect ${IMAGE}`, preparedImageInspect()],
      [`docker inspect ${CONTAINER}`, new Error("missing container")],
    ]);
    const run: CommandRunner = async (command, args) => {
      const key = [command, ...args].join(" ");
      calls.push(key);
      if (key.startsWith("docker run ")) {
        runAttempts += 1;
        if (runAttempts <= failFirst) throw new Error(failMessage);
        return { stdout: "container-id\n" };
      }
      const response = responses.get(key);
      if (response instanceof Error || response === undefined) {
        throw response ?? new Error(`unexpected command: ${key}`);
      }
      return { stdout: response };
    };
    return { calls, run, attempts: () => runAttempts };
  }

  it("retries a first docker run when the fresh workspace folder isn't visible to the VM yet", async () => {
    const fake = flakyRunRunner(
      1,
      'Command failed: docker run -d --name x\ndocker: Error response from daemon: invalid mount config for type "bind": bind source path does not exist: /x/vm-home',
    );
    await containerComputerAction("run", fake.run, "linux");
    expect(fake.attempts()).toBe(2);
    // The legacy-singleton probe ran (and found nothing) before the retry.
    expect(fake.calls).toContain(`docker inspect ${LEGACY_CONTAINER}`);
  });

  it("refuses the workspace race politely after the retries, without echoing the run command", async () => {
    const fake = flakyRunRunner(
      9,
      'Command failed: docker run -d --name x -e VNC_PW=sup3rsecret\ndocker: Error response from daemon: invalid mount config for type "bind": bind source path does not exist: /x/vm-home',
    );
    const error = await containerComputerAction("run", fake.run, "linux").catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/could not see the durable workspace/);
    expect(error.message).not.toContain("sup3rsecret");
    expect(error.message).not.toContain("Command failed:");
    expect(fake.attempts()).toBe(4);
  });

  it("maps a viewer-port collision to an actionable message free of the secret", async () => {
    const fake = flakyRunRunner(
      9,
      "Command failed: docker run -d --name x -e VNC_PW=sup3rsecret\ndocker: Error response from daemon: driver failed programming external connectivity: Bind for 127.0.0.1:6080 failed: port is already allocated",
    );
    const error = await containerComputerAction("run", fake.run, "linux").catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/viewer port \d+ is already in use/);
    expect(error.message).not.toContain("sup3rsecret");
    expect(error.message).not.toContain("Command failed:");
    // No pointless retry loop for a deterministic collision.
    expect(fake.attempts()).toBe(1);
  });

  it("replaces the legacy singleton VM owned by this install before running the new one", async () => {
    const legacyInspect = JSON.stringify([
      { Mounts: [{ Type: "bind", Source: VM_WORKSPACE_DIR, Destination: VM_WORKSPACE_GUEST }] },
    ]);
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": new Error("missing"),
      "docker info --format {{.ServerVersion}}": "29\n",
      [`docker image inspect ${IMAGE}`]: preparedImageInspect(),
      [`docker inspect ${CONTAINER}`]: new Error("missing container"),
      [`docker inspect ${LEGACY_CONTAINER}`]: legacyInspect,
      [`docker rm -f ${LEGACY_CONTAINER}`]: "",
    });
    await containerComputerAction("run", fake.run, "linux");
    const rmAt = fake.calls.indexOf(`docker rm -f ${LEGACY_CONTAINER}`);
    const runAt = fake.calls.findIndex((c) => c.startsWith("docker run "));
    expect(rmAt).toBeGreaterThanOrEqual(0);
    expect(rmAt).toBeLessThan(runAt);
  });

  it("leaves a legacy VM mounted to another install's workspace untouched", async () => {
    const legacyInspect = JSON.stringify([
      { Mounts: [{ Type: "bind", Source: "/Users/someone-else/.muster/vm-home", Destination: VM_WORKSPACE_GUEST }] },
    ]);
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": new Error("missing"),
      "docker info --format {{.ServerVersion}}": "29\n",
      [`docker image inspect ${IMAGE}`]: preparedImageInspect(),
      [`docker inspect ${CONTAINER}`]: new Error("missing container"),
      [`docker inspect ${LEGACY_CONTAINER}`]: legacyInspect,
    });
    await containerComputerAction("run", fake.run, "linux");
    expect(fake.calls).not.toContain(`docker rm -f ${LEGACY_CONTAINER}`);
    expect(fake.calls.some((c) => c.startsWith("docker run "))).toBe(true);
  });

  it("treats 'daemon is not running' on a young container as booting, not failure", async () => {
    const young = new Date(Date.now() - 5_000).toISOString();
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": new Error("missing"),
      "docker info --format {{.ServerVersion}}": "29\n",
      [`docker image inspect ${IMAGE}`]: preparedImageInspect(),
      [`docker inspect ${CONTAINER}`]: readyInspect({ State: { Running: true, StartedAt: young } }),
      [versionProbe]: `cua-driver ${CUA_DRIVER_VERSION}\n`,
      [statusProbe]: new Error(`Command failed: docker exec -u cua ${CONTAINER} ${CUA_EXECUTABLE} status --socket ${CUA_SOCKET}\nCua Driver daemon is not running`),
    });
    const status = await containerComputerStatus(fake.run);
    expect(status.desktop_starting).toBe(true);
    expect(status.desktop_error).toBeNull();
    expect(status.ready).toBe(false);
    expect(status.problem).toMatch(/starting/i);
    expect(status.problem).not.toContain("docker exec");
  });

  it("still reports real desktop failures after the grace window — minus the echoed command and secret", async () => {
    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    const errorLog = `docker exec ${CONTAINER} tail -n 4 /var/log/supervisor/cua-driver.error.log`;
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": new Error("missing"),
      "docker info --format {{.ServerVersion}}": "29\n",
      [`docker image inspect ${IMAGE}`]: preparedImageInspect(),
      [`docker inspect ${CONTAINER}`]: readyInspect({ State: { Running: true, StartedAt: old } }),
      [versionProbe]: `cua-driver ${CUA_DRIVER_VERSION}\n`,
      [statusProbe]: new Error(`Command failed: docker exec -e VNC_PW=abc123 ${CONTAINER} ${CUA_EXECUTABLE} status --socket ${CUA_SOCKET}\nCua Driver daemon is not running`),
      [errorLog]: new Error("no log"),
    });
    const status = await containerComputerStatus(fake.run);
    expect(status.desktop_starting).toBe(false);
    expect(status.desktop_error).toBe("Cua Driver daemon is not running");
    expect(status.problem).toBe("The Local VM desktop failed to start: Cua Driver daemon is not running");
    expect(status.problem).not.toContain("Command failed");
    expect(status.problem).not.toContain("VNC_PW");
  });

  it("conciseProbeError drops the command echo and redacts secrets", () => {
    expect(conciseProbeError("Command failed: docker run -e VNC_PW=secret123 img\ndocker: nope")).toBe("docker: nope");
    expect(conciseProbeError("single line")).toBe("single line");
    expect(conciseProbeError("x VNC_PW=secret123 y")).toContain("VNC_PW=•");
  });
});
