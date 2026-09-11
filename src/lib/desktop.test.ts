import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopCapabilitySession, initialDesktopCapabilities, loadDesktopCapabilities, type DesktopBridge } from "./desktop";

const off = initialDesktopCapabilities({ platform: "darwin", enableComputerAccess: async () => ({ mode: "embedded" }) });
const on: DesktopCapabilities = { ...off, localComputer: { available: true, support: "supported" } };
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
async function settle() { for (let i = 0; i < 10; i++) await Promise.resolve(); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  const getCapabilities = vi.fn<() => Promise<DesktopCapabilities>>().mockResolvedValue(off);
  const enableComputerAccess = vi.fn<NonNullable<DesktopBridge["enableComputerAccess"]>>().mockResolvedValue({ mode: "embedded" });
  const session = new DesktopCapabilitySession({ platform: "darwin", getCapabilities, enableComputerAccess });
  return { session, getCapabilities, enableComputerAccess, attach() { const detach = session.attach(); cleanups.push(detach); return detach; } };
}

describe("desktop capability session", () => {
  it("loads on attachment and refreshes shared capabilities without enabling computer access", async () => {
    const f = fixture(); f.attach(); await settle();
    expect(f.session.getSnapshot()).toMatchObject({ ready: true, canEnable: true, capabilities: off });
    f.getCapabilities.mockResolvedValue(on);
    await f.session.refresh();
    expect(f.session.getSnapshot().capabilities).toEqual(on);
    expect(f.getCapabilities).toHaveBeenCalledTimes(2);
    expect(f.enableComputerAccess).not.toHaveBeenCalled();
  });

  it("never caches a loader result forever", async () => {
    const f = fixture();
    const bridge: DesktopBridge = { platform: "darwin", getCapabilities: f.getCapabilities };
    expect(await loadDesktopCapabilities(bridge)).toEqual(off);
    f.getCapabilities.mockResolvedValue(on);
    expect(await loadDesktopCapabilities(bridge)).toEqual(on);
    expect(f.getCapabilities).toHaveBeenCalledTimes(2);
  });

  it("ignores an old initial read that resolves after the post-enable refresh", async () => {
    const f = fixture(), initial = deferred<DesktopCapabilities>();
    f.getCapabilities.mockReturnValueOnce(initial.promise).mockResolvedValue(on);
    f.attach();
    await f.session.enable();
    expect(f.session.getSnapshot().capabilities).toEqual(on);
    initial.resolve(off); await settle();
    expect(f.session.getSnapshot()).toMatchObject({ capabilities: on, ready: true, error: null, enabling: false });
    expect(f.enableComputerAccess).toHaveBeenCalledTimes(1);
  });

  it("keeps the latest successful refresh when an older read later fails", async () => {
    const f = fixture(); f.attach(); await settle();
    const stale = deferred<DesktopCapabilities>();
    f.getCapabilities.mockReturnValueOnce(stale.promise).mockResolvedValue(on);
    const first = f.session.refresh();
    await f.session.refresh();
    stale.reject(new Error("obsolete read failure"));
    await expect(first).rejects.toThrow("obsolete read failure");
    expect(f.session.getSnapshot()).toMatchObject({ capabilities: on, error: null, refreshing: false });
  });

  it("locks duplicate explicit requests immediately and waits for the capability refresh", async () => {
    const f = fixture(); f.attach(); await settle();
    const native = deferred<{ mode: string }>(), refresh = deferred<DesktopCapabilities>();
    f.enableComputerAccess.mockReturnValueOnce(native.promise);
    f.getCapabilities.mockReturnValueOnce(refresh.promise);
    const first = f.session.enable(), second = f.session.enable();
    expect(first).toBe(second);
    expect(f.session.getSnapshot().enabling).toBe(true);
    await settle();
    expect(f.enableComputerAccess).toHaveBeenCalledTimes(1);
    native.resolve({ mode: "embedded" }); await settle();
    expect(f.session.getSnapshot()).toMatchObject({ enabling: true, refreshing: true });
    expect(f.session.enable()).toBe(first);
    refresh.resolve(on); await first;
    expect(f.session.getSnapshot()).toMatchObject({ enabling: false, refreshing: false, capabilities: on });
  });

  it.each(["unavailable", "rejected"])("refreshes after an %s attempt, exposes its actual reason, and permits retry", async (outcome) => {
    const f = fixture(); f.attach(); await settle();
    if (outcome === "unavailable") f.enableComputerAccess.mockResolvedValueOnce({ mode: "unavailable", reason: "The driver daemon is missing" });
    else f.enableComputerAccess.mockRejectedValueOnce(new Error("The driver daemon is missing"));
    await f.session.enable();
    expect(f.getCapabilities).toHaveBeenCalledTimes(2);
    expect(f.session.getSnapshot()).toMatchObject({ enableError: "The driver daemon is missing", enabling: false, capabilities: off });
    f.getCapabilities.mockResolvedValue(on);
    await f.session.enable();
    expect(f.enableComputerAccess).toHaveBeenCalledTimes(2);
    expect(f.session.getSnapshot()).toMatchObject({ enableError: null, capabilities: on });
  });

  it("reports a refresh failure after enablement without claiming access is ready", async () => {
    const f = fixture(); f.attach(); await settle();
    f.getCapabilities.mockRejectedValueOnce(new Error("Capability IPC disconnected"));
    await f.session.enable();
    expect(f.session.getSnapshot()).toMatchObject({ error: "Capability IPC disconnected", enabling: false, refreshing: false });
    expect(f.session.getSnapshot().capabilities.localComputer.available).toBe(false);
    f.getCapabilities.mockResolvedValue(on);
    await f.session.refresh();
    expect(f.session.getSnapshot()).toMatchObject({ capabilities: on, error: null });
    expect(f.enableComputerAccess).toHaveBeenCalledTimes(1);
  });

  it("does not publish a read or enable completion after provider disposal", async () => {
    const f = fixture(); f.attach(); await settle();
    const native = deferred<{ mode: string }>(); f.enableComputerAccess.mockReturnValue(native.promise);
    const operation = f.session.enable(); await settle();
    const detach = cleanups.pop()!; detach();
    const listener = vi.fn(); cleanups.push(f.session.subscribe(listener));
    native.resolve({ mode: "embedded" }); await operation;
    expect(listener).not.toHaveBeenCalled();
    expect(f.getCapabilities).toHaveBeenCalledTimes(1);
    await f.session.enable(); await f.session.refresh();
    expect(f.enableComputerAccess).toHaveBeenCalledTimes(1);
  });

  it("fences the prior attachment during React effect replay", async () => {
    const f = fixture(), old = deferred<DesktopCapabilities>();
    f.getCapabilities.mockReturnValueOnce(old.promise).mockResolvedValue(on);
    const detach = f.attach(); detach(); f.attach(); await settle();
    old.resolve(off); await settle();
    expect(f.session.getSnapshot().capabilities).toEqual(on);
    expect(f.enableComputerAccess).not.toHaveBeenCalled();
  });

  it("reconciles a remounted provider when the old attachment's native request finishes", async () => {
    const f = fixture(); const detach = f.attach(); await settle();
    const native = deferred<{ mode: string }>(); f.enableComputerAccess.mockReturnValueOnce(native.promise);
    const operation = f.session.enable(); await settle();
    detach(); f.attach(); await settle();
    expect(f.session.getSnapshot().capabilities).toEqual(off);
    f.getCapabilities.mockResolvedValue(on);
    native.resolve({ mode: "embedded" }); await operation;
    expect(f.session.getSnapshot()).toMatchObject({ capabilities: on, enabling: false, error: null, enableError: null });
    expect(f.getCapabilities).toHaveBeenCalledTimes(3);
    expect(f.enableComputerAccess).toHaveBeenCalledTimes(1);
  });

  it("subscribes before reading and refreshes a new provider after an old page's native request settles", async () => {
    const listeners = new Set<() => void>();
    const retained: Array<() => void> = [];
    const native = deferred<{ mode: string }>();
    let capabilities = off;
    const getCapabilities = vi.fn(async () => {
      expect(listeners.size).toBe(1); // There is no unobserved initial-read gap.
      return capabilities;
    });
    const enableComputerAccess = vi.fn(() => native.promise);
    const unsubscribe = vi.fn();
    const bridge: DesktopBridge = {
      platform: "darwin", getCapabilities, enableComputerAccess,
      onComputerAccessChanged(listener) {
        listeners.add(listener); retained.push(listener);
        return () => { listeners.delete(listener); unsubscribe(); };
      },
    };
    const oldPage = new DesktopCapabilitySession(bridge);
    const detachOld = oldPage.attach(); cleanups.push(detachOld); await settle();
    const enabling = oldPage.enable(); await settle();
    detachOld(); detachOld();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    const newPage = new DesktopCapabilitySession(bridge);
    const detachNew = newPage.attach(); cleanups.push(detachNew); await settle();
    expect(newPage.getSnapshot().capabilities).toEqual(off);
    capabilities = on;
    native.resolve({ mode: "embedded" }); await enabling;
    // Main broadcasts only an invalidation after native work settles.
    for (const notify of listeners) notify();
    await settle();
    expect(newPage.getSnapshot()).toMatchObject({ capabilities: on, error: null, enableError: null });
    expect(enableComputerAccess).toHaveBeenCalledTimes(1);
    expect(getCapabilities).toHaveBeenCalledTimes(3);
    detachNew();
    for (const notify of retained) notify(); // Old queued callbacks are inert.
    await settle();
    expect(listeners.size).toBe(0);
    expect(unsubscribe).toHaveBeenCalledTimes(2);
    expect(getCapabilities).toHaveBeenCalledTimes(3);
  });

  it.each(["browser", "old-mac", "linux"])("keeps %s fallback unsupported without invoking an enable method", async (kind) => {
    const enable = vi.fn().mockResolvedValue({ mode: "embedded" });
    const bridge: DesktopBridge | undefined = kind === "browser" ? undefined : kind === "old-mac" ? { platform: "darwin" } : { platform: "linux", enableComputerAccess: enable };
    const session = new DesktopCapabilitySession(bridge); cleanups.push(session.attach()); await settle();
    await session.enable();
    expect(session.getSnapshot()).toMatchObject({ ready: true, canEnable: false });
    expect(session.getSnapshot().capabilities.localComputer.available).toBe(false);
    expect(enable).not.toHaveBeenCalled();
  });
});
