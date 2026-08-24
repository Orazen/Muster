// Per-bot desktop isolation: config plumbing, target derivation, lease and
// idle lanes, cap counting, resource-limit fallback, and the shared-mode
// regression that keeps the historical singleton untouched.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LocalVmIdleTimerPool } from "./local-vm-idle.ts";
import { LocalVmLeasePool } from "./local-vm-lease.ts";

// OMB_DATA_DIR must be set before any server module loads: config.ts captures
// it at import time and every desktop workspace path derives from it.
process.env.OMB_DATA_DIR = await mkdtemp(join(tmpdir(), "muster-desktop-isolation-"));

const { envMaxPerBotDesktops, localVmMaxInstances, localVmMode, parseConfigPatch, saveConfig, loadConfig } =
  await import("./config.ts");
const {
  CONTAINER,
  IMAGE,
  LIMITS_LABEL,
  MANAGED_LABEL,
  DRIVER_LABEL,
  BASE_IMAGE_DIGEST,
  BASE_IMAGE_LABEL,
  IMAGE_LAYER_LABEL,
  IMAGE_LAYER_VERSION,
  CUA_DRIVER_VERSION,
  PER_BOT_VIEWER_PORT_BASE,
  PER_BOT_VIEWER_PORT_RANGE,
  SHARED_LOCAL_VM_TARGET,
  VM_WORKSPACE_DIR,
  VM_WORKSPACE_GUEST,
  countExistingDesktops,
  containerComputerAction,
  containerComputerMcp,
  containerRunArgs,
  perBotLocalVmTarget,
} = await import("./container-computer.ts");

/** Mirror of container-computer's CommandRunner — a `type` specifier cannot
 * ride a dynamic-import destructure. */
type RunFn = (command: string, args: string[], timeout?: number) => Promise<{ stdout: string }>;

describe("desktop isolation configuration", () => {
  it("preserves shared behavior by default and accepts a bounded per-bot section", () => {
    expect(parseConfigPatch({ localVm: { mode: "perBot", maxInstances: 4 } })).toEqual({
      localVm: { mode: "perBot", maxInstances: 4 },
    });
    const empty = {};
    expect(localVmMode(empty)).toBe("shared");
    expect(localVmMode({ localVm: { mode: "perBot" } })).toBe("perBot");
  });

  it.each(["one-per-bot", "windows", "1", "null"])("rejects an invalid isolation mode: %s", (mode) => {
    // SAFETY: these strings are deliberately malformed inputs; JSON.parse
    // erases their literal type so zod stays the runtime authority.
    const patch = JSON.parse(`{"localVm":{"mode":${JSON.stringify(mode)}}}`);
    expect(() => parseConfigPatch(patch)).toThrow();
  });

  it.each([0, 1.5, 17, -2])("rejects an out-of-range desktop cap: %j", (maxInstances) => {
    // SAFETY: deliberately out-of-range numbers; zod rejects what the
    // compiler-level type would never allow through.
    const patch = JSON.parse(`{"localVm":{"maxInstances":${JSON.stringify(maxInstances)}}}`);
    expect(() => parseConfigPatch(patch)).toThrow();
  });

  describe("envMaxPerBotDesktops", () => {
    it("accepts whole caps inside the bounds", () => {
      expect(envMaxPerBotDesktops("1")).toBe(1);
      expect(envMaxPerBotDesktops("4")).toBe(4);
      expect(envMaxPerBotDesktops("16")).toBe(16);
    });

    it("falls back to null for missing or malformed values", () => {
      expect(envMaxPerBotDesktops(undefined)).toBe(null);
      expect(envMaxPerBotDesktops("")).toBe(null);
      expect(envMaxPerBotDesktops("0")).toBe(null);
      expect(envMaxPerBotDesktops("17")).toBe(null);
      expect(envMaxPerBotDesktops("2.5")).toBe(null);
      expect(envMaxPerBotDesktops("four")).toBe(null);
    });
  });

  describe("localVmMaxInstances precedence", () => {
    const originalEnv = process.env.OMB_MAX_PER_BOT_DESKTOPS;
    afterEach(() => {
      if (originalEnv === undefined) delete process.env.OMB_MAX_PER_BOT_DESKTOPS;
      else process.env.OMB_MAX_PER_BOT_DESKTOPS = originalEnv;
    });

    it("prefers saved config over the env knob over the built-in default", () => {
      process.env.OMB_MAX_PER_BOT_DESKTOPS = "3";
      expect(localVmMaxInstances({})).toBe(3);
      process.env.OMB_MAX_PER_BOT_DESKTOPS = "not-a-number";
      expect(localVmMaxInstances({})).toBe(4);
      expect(localVmMaxInstances({ localVm: { maxInstances: 6 } })).toBe(6);
    });
  });

  it("persists an isolation patch into the merged on-disk config", () => {
    saveConfig({ localVm: { mode: "perBot", maxInstances: 2 } });
    // SAFETY: loadConfig reads the OMB_DATA_DIR-scoped temp config.json this
    // test file wrote; no user data is involved.
    const loaded = loadConfig();
    expect(loaded.localVm).toEqual({ mode: "perBot", maxInstances: 2 });
    saveConfig({ localVm: { mode: "shared" } });
    expect(loadConfig().localVm).toEqual({ mode: "shared", maxInstances: 2 });
  });
});

describe("desktop targets", () => {
  it("keeps the historical shared identity byte-for-byte", () => {
    expect(SHARED_LOCAL_VM_TARGET.key).toBe("shared");
    expect(SHARED_LOCAL_VM_TARGET.containerName).toBe(CONTAINER);
    expect(SHARED_LOCAL_VM_TARGET.workspaceDir).toBe(VM_WORKSPACE_DIR);
    // The shared viewer keeps its fixed port for compatibility.
    expect(SHARED_LOCAL_VM_TARGET.viewerPort).toBe(6080);
    expect(PER_BOT_VIEWER_PORT_BASE).toBe(6081);
  });

  it("derives opaque, distinct, deterministic identities per bot", () => {
    const a = perBotLocalVmTarget("bot-a");
    const b = perBotLocalVmTarget("bot-b");
    expect(a).toEqual(perBotLocalVmTarget("bot-a"));
    expect(a.containerName).not.toBe(b.containerName);
    expect(a.workspaceDir).not.toBe(b.workspaceDir);
    expect(a.key).not.toBe(b.key);
    expect(b.containerName.startsWith(`${CONTAINER}-`)).toBe(true);
    expect(b.workspaceDir.includes("vm-homes")).toBe(true);
  });

  it("fans per-bot viewers out above the shared port inside a fixed range", () => {
    for (let i = 0; i < 32; i++) {
      const target = perBotLocalVmTarget(`fleet-bot-${i}`);
      expect(target.viewerPort).toBeGreaterThanOrEqual(PER_BOT_VIEWER_PORT_BASE);
      expect(target.viewerPort).toBeLessThan(PER_BOT_VIEWER_PORT_BASE + PER_BOT_VIEWER_PORT_RANGE);
    }
  });
});

describe("run arguments", () => {
  it("caps every managed desktop at 4 GB memory and 2 CPUs in shared mode", () => {
    const args = containerRunArgs("docker").join(" ");
    expect(args).toContain(`--name ${CONTAINER}`);
    expect(args).toContain("--memory 4g --memory-swap 4g");
    expect(args).toContain("--cpus 2");
    expect(args).toContain("--pids-limit 512");
    expect(args).toContain("-p 127.0.0.1:6080:6901");
    expect(args).toContain(VM_WORKSPACE_DIR);
  });

  it("gives each per-bot desktop its own name, workspace and viewer port", () => {
    const target = perBotLocalVmTarget("bot-a");
    const args = containerRunArgs("docker", "pw", target).join(" ");
    expect(args).toContain(`--name ${target.containerName}`);
    expect(args).toContain(`-p 127.0.0.1:${target.viewerPort}:6901`);
    expect(args).toContain(`source=${target.workspaceDir},`);
    // "vm-home" is a prefix of "vm-homes", so compare exact mount fragments.
    expect(args).not.toContain(`source=${VM_WORKSPACE_DIR},`);
    expect(args).toContain(`${LIMITS_LABEL}=1`);
    expect(args).toContain("--memory 4g --memory-swap 4g");
    expect(args).toContain("--cpus 2");
  });

  it("strips only numeric caps when a runtime rejects limits, keeping capability drops", () => {
    const args = containerRunArgs("docker", "pw", SHARED_LOCAL_VM_TARGET, false).join(" ");
    expect(args).not.toContain("--memory");
    expect(args).not.toContain("--cpus");
    expect(args).not.toContain("--pids-limit");
    expect(args).toContain("--cap-drop ALL");
    expect(args).toContain("--cap-add SETUID");
    expect(args).toContain(`${LIMITS_LABEL}=none`);
  });
});

describe("containerComputerMcp", () => {
  it("mounts the driver MCP of the exact target container", () => {
    const target = perBotLocalVmTarget("bot-a");
    const launch = containerComputerMcp("docker", target);
    // args are [wrapper, runtime, containerName, socket].
    expect(launch.args[launch.args.length - 2]).toBe(target.containerName);
    const shared = containerComputerMcp("docker");
    expect(shared.args[shared.args.length - 2]).toBe(CONTAINER);
  });
});

describe("countExistingDesktops", () => {
  it("counts only targets whose container exists and dedupes identical keys", async () => {
    const a = perBotLocalVmTarget("bot-a");
    const b = perBotLocalVmTarget("bot-b");
    const runner: RunFn = async (_command, args) => {
      if (args[0] !== "inspect") throw new Error("unexpected");
      if (args[1] === a.containerName) return { stdout: "[]" };
      throw new Error("no such container");
    };
    expect(await countExistingDesktops("docker", [a, b], runner)).toBe(1);
    expect(await countExistingDesktops("docker", [a, a], runner)).toBe(1);
    expect(await countExistingDesktops("docker", [b], runner)).toBe(0);
  });
});

describe("resource-limit fallback", () => {
  /** Stateful fake: the bounded run always fails with the flag rejection;
   * the container only comes into existence through an unbounded run. */
  function limitsRejectingRunner(options: { failUnboundedToo: boolean }) {
    const calls: string[] = [];
    let created = false;
    const imageInspect = JSON.stringify([
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
    const unboundedContainerInspect = JSON.stringify([
      {
        Config: {
          Image: IMAGE,
          Labels: {
            [MANAGED_LABEL]: "1",
            [DRIVER_LABEL]: CUA_DRIVER_VERSION,
            [BASE_IMAGE_LABEL]: BASE_IMAGE_DIGEST,
            [IMAGE_LAYER_LABEL]: IMAGE_LAYER_VERSION,
            [LIMITS_LABEL]: "none",
          },
        },
        State: { Running: true },
        Image: "sha256:managed-image-id",
        HostConfig: { CapDrop: ["ALL"], CapAdd: ["CAP_SETUID", "CAP_SETGID"] },
        Mounts: [{ Type: "bind", Source: VM_WORKSPACE_DIR, Destination: VM_WORKSPACE_GUEST, RW: true }],
      },
    ]);
    const run: RunFn = async (command, args) => {
      const key = [command, ...args].join(" ");
      calls.push(key);
      if (command !== "docker" && command !== "/usr/bin/which") throw new Error(`unexpected command: ${key}`);
      if (command === "/usr/bin/which") return { stdout: "docker\n" };
      if (args[0] === "image") return { stdout: imageInspect };
      if (args[0] === "inspect") {
        if (!created) throw new Error("no such container");
        return { stdout: unboundedContainerInspect };
      }
      if (args[0] === "info") return { stdout: "29\n" };
      if (args[0] === "rm") {
        created = false;
        return { stdout: "" };
      }
      if (args[0] === "run") {
        if (args.includes("--memory")) throw new Error("unknown flag: --memory");
        if (options.failUnboundedToo) throw new Error("unknown flag: --memory");
        created = true;
        return { stdout: "container-id\n" };
      }
      throw new Error(`unexpected command: ${key}`);
    };
    return { calls, run };
  }

  it("recreates the desktop without numeric caps when the runtime refuses them", async () => {
    const fake = limitsRejectingRunner({ failUnboundedToo: false });
    await containerComputerAction("run", fake.run, "linux");
    const runs = fake.calls.filter((call) => call.includes(" run -d "));
    expect(runs.length).toBe(2);
    expect(runs[0]).toContain("--memory 4g");
    expect(runs[1]).toContain(`${LIMITS_LABEL}=none`);
    expect(runs[1]).not.toContain("--memory");
    expect(runs[1]).toContain("--cap-drop ALL");
  });

  it("surfaces the original runtime error when even the unbounded run fails", async () => {
    const fake = limitsRejectingRunner({ failUnboundedToo: true });
    await expect(containerComputerAction("run", fake.run, "linux")).rejects.toThrow("unknown flag: --memory");
  });
});

describe("LocalVmLeasePool", () => {
  it("gives separate bots independent lanes while each lane stays a strict singleton", () => {
    const pool = new LocalVmLeasePool(60_000);
    const busy = () => true;
    const laneA = pool.forTarget("bot:a");
    const laneB = pool.forTarget("bot:b");
    expect(laneA.claim("t1", "a", busy)).toBe(true);
    expect(laneB.claim("t2", "b", busy)).toBe(true);
    const sameLaneAgain = pool.forTarget("bot:a");
    expect(sameLaneAgain.claim("t3", "c", busy)).toBe(false);
    laneA.release("t1");
    expect(sameLaneAgain.claim("t3", "c", busy)).toBe(true);
  });
});

describe("LocalVmIdleTimerPool", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("runs one independent recycle deadline per desktop", async () => {
    const suspended: string[] = [];
    const busyKeys = new Set<string>();
    const pool = new LocalVmIdleTimerPool(
      1_000,
      (key) => busyKeys.has(key),
      async (key) => {
        suspended.push(key);
      },
    );
    pool.forTarget("bot:a").touch();
    pool.forTarget("bot:b").touch();
    busyKeys.add("bot:a");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(suspended).toEqual(["bot:b"]);
    busyKeys.delete("bot:a");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(suspended).toEqual(["bot:b", "bot:a"]);
  });

  it("cancelAll clears every lane", async () => {
    const suspended: string[] = [];
    const pool = new LocalVmIdleTimerPool(1_000, () => false, async (key) => {
      suspended.push(key);
    });
    pool.forTarget("bot:a").touch();
    pool.forTarget("bot:b").touch();
    pool.cancelAll();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(suspended).toEqual([]);
  });
});
