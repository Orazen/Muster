import { describe, expect, it } from "vitest";

import { needsCli, needsSignIn } from "./EngineSetup";
import type { InstanceInfo } from "@/state/store";

function instance(snapshot: InstanceInfo["snapshot"]): InstanceInfo {
  return {
    instanceId: "kimi",
    driverKind: "kimiAgent",
    displayName: "Kimi",
    models: { default: "kimi-code/k3", options: [] },
    snapshot,
  };
}

describe("needsCli / needsSignIn", () => {
  it("treats a missing binary as a CLI install, not a sign-in", () => {
    const missing = instance({ state: "unavailable", reason: "`kimi` CLI not found" });
    expect(needsCli(missing)).toBe(true);
    expect(needsSignIn(missing)).toBe(false);
  });

  it("lets Custom inject run when the CLI is installed but unsigned-in", () => {
    const unsigned = instance({ state: "available", authenticated: false, version: "0.36.1" });
    expect(needsCli(unsigned)).toBe(false);
    expect(needsSignIn(unsigned)).toBe(true);
  });

  it("is ready for inject when the CLI is present", () => {
    const ready = instance({ state: "available", authenticated: true, version: "0.36.1" });
    expect(needsCli(ready)).toBe(false);
    expect(needsSignIn(ready)).toBe(false);
  });
});

describe("EnginesSettings rowAction", () => {
  it("routes an installed-but-unsigned-in engine to add-account", async () => {
    const { rowAction } = await import("./EnginesSettings");
    const unsigned = instance({ state: "available", authenticated: false, version: "0.36.1" });
    expect(rowAction(unsigned)).toBe("add-account");
  });

  it("keeps a ready engine on configure and a missing CLI on set-up", async () => {
    const { rowAction } = await import("./EnginesSettings");
    expect(rowAction(instance({ state: "available", authenticated: true }))).toBe("configure");
    expect(rowAction(instance({ state: "unavailable", reason: "`kimi` CLI not found" }))).toBe("set-up");
  });
});
