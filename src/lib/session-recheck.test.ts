import { describe, expect, it, vi } from "vitest";
import { createSessionRecheckCoordinator } from "./session-recheck";

describe("shared session rechecks", () => {
  it("coalesces simultaneous authorization failures and permits a later retry", async () => {
    let finish!: () => void;
    const check = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; })).mockResolvedValue(null);
    const coordinator = createSessionRecheckCoordinator();
    coordinator.register(check);
    const first = coordinator.capture()();
    const second = coordinator.capture()();
    expect(first).toBe(second);
    await Promise.resolve();
    expect(check).toHaveBeenCalledOnce();
    finish();
    await first;
    await coordinator.capture()();
    expect(check).toHaveBeenCalledTimes(2);
  });
  it("ignores a previous owner's late failure without unregistering its replacement", async () => {
    const coordinator = createSessionRecheckCoordinator();
    const previous = vi.fn().mockResolvedValue(null);
    const remove = coordinator.register(previous);
    const oldRequest = coordinator.capture();
    const current = vi.fn().mockResolvedValue(null);
    coordinator.register(current);
    remove();
    await oldRequest();
    expect(previous).not.toHaveBeenCalled();
    expect(current).not.toHaveBeenCalled();
    await coordinator.capture()();
    expect(current).toHaveBeenCalledOnce();
  });
  it("does not run a queued check after unmount and contains unavailable checks", async () => {
    const coordinator = createSessionRecheckCoordinator();
    const check = vi.fn().mockRejectedValue(new Error("Unavailable"));
    const remove = coordinator.register(check);
    const queued = coordinator.capture()();
    remove();
    await queued;
    expect(check).not.toHaveBeenCalled();
    coordinator.register(check);
    await expect(coordinator.capture()()).resolves.toBeUndefined();
    await expect(coordinator.capture()()).resolves.toBeUndefined();
    expect(check).toHaveBeenCalledTimes(2);
  });
});
