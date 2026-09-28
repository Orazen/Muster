import { afterEach, describe, expect, it, vi } from "vitest";
import {
  localVmInstallManager, localVmSetupReady, requestLocalVmStatus, runLocalVmSetup,
  type LocalVmAction, type LocalVmStatus, type LocalVmSetupStage,
} from "./local-vm-setup";

function status(overrides: Partial<LocalVmStatus> = {}): LocalVmStatus {
  return {
    platform: "darwin", runtime: "podman", available: ["podman"], daemonUp: true,
    image: true, imageMatches: true, managed: true, container: "missing",
    network: "loopback", security: "hardened", persistence: "durable",
    desktopReady: false, desktop_starting: false, ready: false, problem: null,
    image_ref: "owned-image", base_image_ref: "owned-base", driver_version: "fixture",
    container_name: "owned-vm", workspace_path: "/owned/workspace", workspace_guest_path: "/home/cua/workspace",
    viewer_url: "http://127.0.0.1:6090/vnc.html", idle_timeout_ms: 28_800_000,
    mode: "shared", runtime_install: { installable: true, manager: "Homebrew" },
    commands: { install: null, runtimeStart: null, pull: null, run: null, start: null, stop: null, remove: null, view: "http://127.0.0.1:6090" },
    ...overrides,
  };
}

function fixture(initial: Partial<LocalVmStatus> = {}) {
  let current = status(initial);
  const stages: LocalVmSetupStage[] = [];
  const read = vi.fn(async () => current);
  const post = vi.fn(async (action: Exclude<LocalVmAction, "recreate">) => {
    const updates = {
      runtimeInstall: { runtime: "podman" }, runtimeStart: { daemonUp: true }, pull: { image: true },
      run: { container: "running" as const, desktop_starting: true },
      start: { container: "running" as const, desktop_starting: true }, stop: {}, remove: {},
    };
    current = { ...current, ...updates[action] };
  });
  return { read, post, onStage: (stage: LocalVmSetupStage) => stages.push(stage), stages };
}

afterEach(() => vi.unstubAllGlobals());

describe("Local VM setup", () => {
  it("installs, starts the runtime, prepares the image and creates only the missing VM", async () => {
    const flow = fixture({ runtime: null, daemonUp: false, image: false });
    const result = await runLocalVmSetup(flow);
    expect(flow.post.mock.calls.flat()).toEqual(["runtimeInstall", "runtimeStart", "pull", "run"]);
    expect(flow.stages).toEqual(["checking", "installing", "startingRuntime", "preparingImage", "creatingVm"]);
    expect(flow.read).toHaveBeenCalledTimes(5);
    expect(result.desktop_starting).toBe(true);
    expect(result.ready).toBe(false);
  });

  it("resumes a stopped VM without rebuilding or replacing it", async () => {
    const flow = fixture({ container: "stopped" });
    await runLocalVmSetup(flow);
    expect(flow.post.mock.calls.flat()).toEqual(["start"]);
    expect(flow.stages).toEqual(["checking", "startingVm"]);
  });

  it("retries the failed step without reinstalling or restarting the runtime", async () => {
    const flow = fixture({ runtime: null, daemonUp: false, image: false });
    const originalPost = flow.post.getMockImplementation()!;
    let failed = false;
    flow.post.mockImplementation(async action => {
      if (action === "pull" && !failed) { failed = true; throw new Error("Download interrupted"); }
      await originalPost(action);
    });
    await expect(runLocalVmSetup(flow)).rejects.toThrow("Download interrupted");
    await runLocalVmSetup(flow);
    expect(flow.post.mock.calls.flat()).toEqual(["runtimeInstall", "runtimeStart", "pull", "pull", "run"]);
  });

  it.each(["running", "stopped"] as const)("requires explicit replacement for an incompatible %s VM", async container => {
    const flow = fixture({ container, imageMatches: false, problem: "Existing VM needs replacement" });
    await expect(runLocalVmSetup(flow)).rejects.toThrow("Existing VM needs replacement");
    expect(flow.post).not.toHaveBeenCalled();
  });

  it.each(["missing", "stopped"] as const)("only prepares prerequisites in per-bot mode with a %s shared VM", async container => {
    const flow = fixture({ mode: "perBot", runtime: null, daemonUp: false, image: false, container });
    expect(localVmSetupReady(await flow.read())).toBe(false);
    const result = await runLocalVmSetup(flow);
    expect(flow.post.mock.calls.flat()).toEqual(["runtimeInstall", "runtimeStart", "pull"]);
    expect(localVmSetupReady(result)).toBe(true);
    expect(result.ready).toBe(false);
  });

  it("leaves a ready or still-starting VM alone", async () => {
    for (const ready of [true, false]) {
      const flow = fixture({ container: "running", ready, desktop_starting: !ready });
      await runLocalVmSetup(flow);
      expect(flow.post).not.toHaveBeenCalled();
    }
  });

  it("honors an unavailable install gate", async () => {
    const flow = fixture({ runtime: null, runtime_install: { installable: false, reason: "Install Homebrew first" } });
    await expect(runLocalVmSetup(flow)).rejects.toThrow("Install Homebrew first");
    expect(flow.post).not.toHaveBeenCalled();
  });

  it("does not attempt to satisfy a Linux sudo prompt", async () => {
    const flow = fixture({ runtime: "docker", platform: "linux", daemonUp: false });
    await expect(runLocalVmSetup(flow)).rejects.toThrow("needs sudo");
    expect(flow.post).not.toHaveBeenCalled();
  });

  it("stops when installation returns without a detectable runtime", async () => {
    const flow = fixture({ runtime: null });
    flow.post.mockResolvedValue(undefined);
    await expect(runLocalVmSetup(flow)).rejects.toThrow("not detected after installation");
    expect(flow.post.mock.calls.flat()).toEqual(["runtimeInstall"]);
  });

  it("stops if the runtime still is not ready after startup", async () => {
    const flow = fixture({ daemonUp: false, image: false });
    flow.post.mockResolvedValue(undefined);
    await expect(runLocalVmSetup(flow)).rejects.toThrow("still starting");
    expect(flow.post.mock.calls.flat()).toEqual(["runtimeStart"]);
  });

  it("does not perform later writes after a follow-up status request fails", async () => {
    const flow = fixture({ runtime: null, daemonUp: false, image: false });
    flow.read.mockResolvedValueOnce(await flow.read()).mockRejectedValueOnce(new Error("Status unavailable"));
    await expect(runLocalVmSetup(flow)).rejects.toThrow("Status unavailable");
    expect(flow.post.mock.calls.flat()).toEqual(["runtimeInstall"]);
  });
});

describe("Local VM response checks", () => {
  it("does not accept a late response after the poll was cancelled for setup", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async () => {
      controller.abort();
      return Response.json(status());
    }));
    await expect(requestLocalVmStatus(undefined, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects failed GETs and action responses before treating their JSON as status", async () => {
    const fetchMock = vi.fn(async () => Response.json({ error: "Status service failed" }, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(requestLocalVmStatus()).rejects.toThrow("Status service failed");
    await expect(requestLocalVmStatus("pull")).rejects.toThrow("Status service failed");
    expect(fetchMock.mock.calls).toHaveLength(2);
  });

  it.each([{}, { runtime: "podman", daemonUp: "yes" }, { error: "Unexpected envelope" }])("rejects malformed successful status %#", async body => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(body)));
    await expect(requestLocalVmStatus()).rejects.toThrow("status response was incomplete");
  });

  it("accepts the prior server contract without an install offer or mode", async () => {
    const legacy = status();
    delete legacy.runtime_install;
    delete legacy.mode;
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(legacy)));
    expect(await requestLocalVmStatus()).toEqual(legacy);
  });

  it("uses the offered package manager and supports older Windows status responses", () => {
    expect(localVmInstallManager(status())).toBe("Homebrew");
    expect(localVmInstallManager(status({ runtime_install: { installable: true, manager: "WinGet" } }))).toBe("WinGet");
    expect(localVmInstallManager(status({ platform: "win32", runtime_install: undefined }))).toBe("WinGet");
  });
});
