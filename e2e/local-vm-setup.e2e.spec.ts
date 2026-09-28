/** Owned pairing/account/settings flow with synthetic desktop capability.
 * Only Local VM HTTP is mocked: no runtime is installed, started or deleted. */
import { z } from "zod";
import type { Page } from "@playwright/test";
import { test, expect, pairDesktop } from "./browser-fixtures.ts";
import type { LocalVmStatus } from "../src/lib/local-vm-setup.ts";

function vmStatus(overrides: Partial<LocalVmStatus> = {}): LocalVmStatus {
  return {
    platform: "darwin", runtime: null, available: [], daemonUp: false, image: false,
    imageMatches: true, managed: true, container: "missing", network: "loopback",
    security: "hardened", persistence: "durable", desktopReady: false, desktop_starting: false,
    ready: false, problem: "Install a supported container runtime first", image_ref: "owned-image",
    base_image_ref: "owned-base", driver_version: "fixture", container_name: "owned-vm",
    workspace_path: "/owned/workspace", workspace_guest_path: "/home/cua/workspace",
    viewer_url: "http://127.0.0.1:6090/vnc.html", idle_timeout_ms: 28_800_000, mode: "shared", max_instances: 4,
    runtime_install: { installable: true, manager: "Homebrew" },
    commands: { install: null, runtimeStart: null, pull: null, run: null, start: null, stop: null, remove: null, view: "http://127.0.0.1:6090/vnc.html" },
    ...overrides,
  };
}

interface VmFixture { status: LocalVmStatus; writes: string[]; reads: number; failNextRead: boolean }

async function mockVm(page: Page, initial: Partial<LocalVmStatus> = {}, holdActions: string[] = []) {
  const fixture: VmFixture = { status: vmStatus(initial), writes: [], reads: 0, failNextRead: false };
  const gates = new Map<string, () => void>();
  const held = new Set(holdActions);
  await page.addInitScript(platform => {
    Object.defineProperty(window, "ogb", { configurable: true, value: { platform } });
  }, fixture.status.platform);
  await page.route("**/api/local-computer{,/**}", async route => {
    const request = route.request();
    if (request.method() === "GET") {
      fixture.reads += 1;
      if (fixture.failNextRead) {
        fixture.failNextRead = false;
        // A successful HTTP envelope with no usable status must stop setup.
        await route.fulfill({ json: { error: "Owned malformed status response" } });
      } else await route.fulfill({ json: fixture.status });
      return;
    }
    const action = z.enum(["runtimeInstall", "runtimeStart", "pull", "run", "start"]).parse(new URL(request.url()).pathname.split("/").at(-1));
    fixture.writes.push(action);
    expect(request.method()).toBe("POST");
    expect(request.postDataJSON()).toEqual({});
    if (held.has(action)) await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 10_000);
      gates.set(action, () => { clearTimeout(timer); resolve(); });
    });
    const patches = {
      runtimeInstall: { runtime: "podman", available: ["podman"], problem: "Start podman first" },
      runtimeStart: { daemonUp: true, problem: "Prepare the Cua desktop image" },
      pull: { image: true, problem: "Create the Local VM" },
      run: { container: "running", desktopReady: true, ready: true, problem: null },
      start: { container: "running", desktopReady: true, ready: true, problem: null },
    } satisfies Record<string, Partial<LocalVmStatus>>;
    expect(patches[action], "Only expected setup actions reach the mocked runtime").toBeDefined();
    fixture.status = { ...fixture.status, ...patches[action] };
    await route.fulfill({ json: fixture.status });
  });
  return { ...fixture, get status() { return fixture.status; }, get reads() { return fixture.reads; },
    failRead: () => { fixture.failNextRead = true; },
    release: (action: string) => { expect(gates.has(action)).toBe(true); gates.get(action)!(); },
    releaseAll: () => { for (const release of gates.values()) release(); },
  };
}

async function openSettings(page: Page) {
  const setup = page.getByRole("region", { name: "Set up Muster", exact: true });
  await expect(setup).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(setup).toHaveCount(0);
  await page.getByRole("button", { name: "App settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await settings.getByRole("button", { name: "Local VM", exact: true }).click();
  await expect(settings.getByRole("button", { name: "Re-check", exact: true })).toBeEnabled();
  return settings;
}

for (const [platform, manager] of [["darwin", "Homebrew"], ["win32", "WinGet"]] as const) {
  test(`${manager} setup shows each stage and blocks overlapping controls`, async ({ harness, newPage, pairCodeFromCloud }) => {
    const page = await newPage();
    const vm = await mockVm(page, { platform, runtime_install: { installable: true, manager } }, ["runtimeInstall", "runtimeStart", "pull", "run"]);
    try {
      await pairDesktop(page, harness, pairCodeFromCloud);
      const settings = await openSettings(page);
      await expect(settings.getByRole("button", { name: `Install Podman with ${manager}`, exact: true })).toBeVisible();
      if (platform === "win32") await expect(settings.getByText(/Windows may ask permission to install Podman/)).toBeVisible();
      await expect(settings.getByText(/First setup downloads and builds.*several minutes/)).toBeVisible();
      await settings.getByRole("button", { name: "Set up automatically", exact: true }).click();
      await expect(settings.getByRole("button", { name: "Installing Podman…", exact: true })).toBeDisabled();
      await expect(settings.getByRole("button", { name: `Install Podman with ${manager}`, exact: true })).toBeDisabled();
      await expect(settings.getByRole("button", { name: "Re-check", exact: true })).toBeDisabled();
      for (const radio of await settings.getByRole("radio").all()) await expect(radio).toBeDisabled();
      // Force both DOM click paths while the operation is blocked. Neither may
      // create a second installation request, even before the stage changes.
      await settings.getByRole("button", { name: "Installing Podman…", exact: true }).evaluate(node => {
        node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      expect(vm.writes).toEqual(["runtimeInstall"]);
      vm.release("runtimeInstall");
      await expect(settings.getByRole("button", { name: "Starting runtime…", exact: true })).toBeDisabled();
      await expect(settings.getByRole("button", { name: "Start podman", exact: true })).toBeDisabled();
      vm.release("runtimeStart");
      await expect(settings.getByRole("button", { name: "Preparing Cua desktop…", exact: true })).toBeDisabled();
      await expect(settings.getByRole("button", { name: "Prepare Cua desktop", exact: true })).toBeDisabled();
      vm.release("pull");
      await expect(settings.getByRole("button", { name: "Creating Local VM…", exact: true })).toBeDisabled();
      await expect(settings.getByRole("button", { name: "Create Local VM", exact: true })).toBeDisabled();
      vm.release("run");
      await expect(settings.getByText("Ready", { exact: true })).toBeVisible();
      await expect(settings.getByRole("button", { name: "Re-check", exact: true })).toBeEnabled();
      expect(vm.writes).toEqual(["runtimeInstall", "runtimeStart", "pull", "run"]);
    } finally { vm.releaseAll(); }
  });
}

test("a failed status check stays visible through polling and retries only unfinished setup", async ({ harness, newPage, pairCodeFromCloud }) => {
  const page = await newPage();
  const vm = await mockVm(page, {}, ["runtimeInstall"]);
  try {
    await pairDesktop(page, harness, pairCodeFromCloud);
    const settings = await openSettings(page);
    await settings.getByRole("button", { name: "Set up automatically", exact: true }).click();
    await expect(settings.getByRole("button", { name: "Installing Podman…", exact: true })).toBeDisabled();
    vm.failRead();
    vm.release("runtimeInstall");
    const alert = settings.getByRole("alert");
    await expect(alert).toHaveText("The Local VM status response was incomplete. Re-check and try again.");
    expect(vm.writes).toEqual(["runtimeInstall"]);
    const readsAfterFailure = vm.reads;
    await expect.poll(() => vm.reads, { timeout: 8_000 }).toBeGreaterThan(readsAfterFailure);
    await expect(alert).toBeVisible();
    await settings.getByRole("button", { name: "Set up automatically", exact: true }).click();
    await expect(settings.getByText("Ready", { exact: true })).toBeVisible();
    await expect(alert).toHaveCount(0);
    expect(vm.writes).toEqual(["runtimeInstall", "runtimeStart", "pull", "run"]);
  } finally { vm.releaseAll(); }
});

test("automatic setup resumes an existing stopped VM without deleting or recreating it", async ({ harness, newPage, pairCodeFromCloud }) => {
  const page = await newPage();
  const vm = await mockVm(page, { runtime: "podman", daemonUp: true, image: true, container: "stopped", problem: "The Local VM is stopped" }, ["start"]);
  try {
    await pairDesktop(page, harness, pairCodeFromCloud);
    const settings = await openSettings(page);
    await settings.getByRole("button", { name: "Set up automatically", exact: true }).click();
    await expect(settings.getByRole("button", { name: "Starting Local VM…", exact: true })).toBeDisabled();
    await expect(settings.getByRole("button", { name: "Start Local VM", exact: true })).toBeDisabled();
    await expect(settings.getByRole("button", { name: "Delete VM", exact: true })).toBeDisabled();
    vm.release("start");
    await expect(settings.getByText("Ready", { exact: true })).toBeVisible();
    expect(vm.writes).toEqual(["start"]);
  } finally { vm.releaseAll(); }
});

test("explicit Re-check clears an old setup error after the VM becomes ready", async ({ harness, newPage, pairCodeFromCloud }) => {
  const page = await newPage();
  const vm = await mockVm(page, { runtime: "podman", daemonUp: true, image: true, container: "stopped" }, ["start"]);
  try {
    await pairDesktop(page, harness, pairCodeFromCloud);
    const settings = await openSettings(page);
    await settings.getByRole("button", { name: "Set up automatically", exact: true }).click();
    await expect(settings.getByRole("button", { name: "Starting Local VM…", exact: true })).toBeDisabled();
    vm.failRead();
    vm.release("start");
    const alert = settings.getByRole("alert");
    await expect(alert).toHaveText("The Local VM status response was incomplete. Re-check and try again.");
    // The start succeeded, but its follow-up status read failed. Polling now
    // confirms readiness without erasing the action error; no retry CTA remains.
    const readsAfterFailure = vm.reads;
    await expect.poll(() => vm.reads, { timeout: 8_000 }).toBeGreaterThan(readsAfterFailure);
    await expect(settings.getByText("Ready", { exact: true })).toBeVisible();
    await expect(settings.getByRole("button", { name: "Set up automatically", exact: true })).toHaveCount(0);
    await expect(alert).toBeVisible();
    await settings.getByRole("button", { name: "Re-check", exact: true }).click();
    await expect(alert).toHaveCount(0);
    await expect(settings.getByRole("button", { name: "Re-check", exact: true })).toBeEnabled();
    expect(vm.writes).toEqual(["start"]);
  } finally { vm.releaseAll(); }
});

test("per-bot setup prepares the runtime and image without creating a shared VM", async ({ harness, newPage, pairCodeFromCloud }) => {
  const page = await newPage();
  const vm = await mockVm(page, { mode: "perBot", runtime: "podman" });
  await pairDesktop(page, harness, pairCodeFromCloud);
  const settings = await openSettings(page);
  await settings.getByRole("button", { name: "Set up automatically", exact: true }).click();
  await expect(settings.getByText("Ready for per-bot desktops", { exact: true })).toBeVisible();
  await expect(settings.getByText("Each bot’s desktop is created automatically when its first turn needs it.", { exact: true })).toBeVisible();
  await expect(settings.getByRole("button", { name: "Create Local VM", exact: true })).toHaveCount(0);
  await expect(settings.getByRole("link", { name: "Watch screen", exact: true })).toHaveCount(0);
  expect(vm.writes).toEqual(["runtimeStart", "pull"]);
});
