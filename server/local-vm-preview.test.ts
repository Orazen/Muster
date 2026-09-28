import { describe, expect, it, vi } from "vitest";
import { SHARED_LOCAL_VM_TARGET, perBotLocalVmTarget } from "./container-computer.ts";
import { localVmPreviewTarget, type LocalVmPreviewContext } from "./local-vm-preview.ts";

function fixture(mode: "shared" | "perBot") {
  const records = [
    { id: "mine", ownerId: "alice", hidden: false },
    { id: "other", ownerId: "bob", hidden: false },
    { id: "hidden", ownerId: "alice", hidden: true },
    { id: "legacy", hidden: false },
  ];
  const context = {
    bot: vi.fn((id: string) => records.find((bot) => bot.id === id)),
    ownsRecord: vi.fn((bot: { ownerId?: string }) => bot.ownerId === "alice" || !bot.ownerId),
    desktopTargetForBot: vi.fn((id: string) => mode === "perBot" ? perBotLocalVmTarget(id) : SHARED_LOCAL_VM_TARGET),
  } satisfies LocalVmPreviewContext;
  return context;
}

describe("Local VM preview target", () => {
  it.each(["shared", "perBot"] as const)("keeps unscoped Settings on the shared target in %s mode", (mode) => {
    const context = fixture(mode);
    expect(localVmPreviewTarget(null, context)).toBe(SHARED_LOCAL_VM_TARGET);
    expect(context.bot).not.toHaveBeenCalled();
    expect(context.ownsRecord).not.toHaveBeenCalled();
    expect(context.desktopTargetForBot).not.toHaveBeenCalled();
  });

  it.each(["shared", "perBot"] as const)("uses the dispatcher's exact target for the owned bot in %s mode", (mode) => {
    const context = fixture(mode);
    const result = localVmPreviewTarget("mine", context);
    expect(context.ownsRecord).toHaveBeenCalledWith({ id: "mine", ownerId: "alice", hidden: false });
    expect(context.desktopTargetForBot).toHaveBeenCalledExactlyOnceWith("mine");
    expect(result).toEqual(mode === "perBot" ? perBotLocalVmTarget("mine") : SHARED_LOCAL_VM_TARGET);
  });

  it.each(["", "unknown", "other", "hidden"])("refuses %j before target registration or runtime access", (id) => {
    const context = fixture("perBot");
    expect(localVmPreviewTarget(id, context)).toBeNull();
    expect(context.desktopTargetForBot).not.toHaveBeenCalled();
  });

  it("preserves the installation operator's ownership rule for legacy bots", () => {
    const context = fixture("perBot");
    expect(localVmPreviewTarget("legacy", context)).toEqual(perBotLocalVmTarget("legacy"));
    context.ownsRecord.mockReturnValue(false);
    context.desktopTargetForBot.mockClear();
    expect(localVmPreviewTarget("legacy", context)).toBeNull();
    expect(context.desktopTargetForBot).not.toHaveBeenCalled();
  });

  it("keeps different owned per-bot workspace and viewer identities separate", () => {
    const context = fixture("perBot");
    const first = localVmPreviewTarget("mine", context);
    const second = localVmPreviewTarget("legacy", context);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first?.key).not.toBe(second?.key);
    expect(first?.workspaceDir).not.toBe(second?.workspaceDir);
    expect(first?.containerName).not.toBe(second?.containerName);
  });
});
