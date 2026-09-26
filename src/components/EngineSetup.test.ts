import { describe, expect, it, vi } from "vitest";

import { installCommandFor, needsCli, needsSignIn } from "./EngineSetup";
import type { EngineInstall, InstanceInfo } from "@/state/store";

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

// The engine runs on the SERVER. A Mac reader in a hosted deployment used
// to be shown the brew line because that was the reader's user agent, and
// a POSIX-only installer was offered to a Windows host for the same reason
// in reverse. The server's platform is the only correct key.
describe("install command platform", () => {
  const install: EngineInstall = {
    command: { darwin: "brew install acme", linux: "curl -fsSL https://acme.test/i.sh | sh" },
    needsNode: true,
  };

  it("uses the platform the server described, not the reader's", () => {
    // No navigator here at all: the server's answer is the only input.
    expect(installCommandFor(install, "linux")).toBe("curl -fsSL https://acme.test/i.sh | sh");
    expect(installCommandFor(install, "darwin")).toBe("brew install acme");
  });

  it("returns null rather than another platform's line when the server has none", () => {
    // A Windows host gets the docs route, never a curl|bash it cannot run.
    expect(installCommandFor(install, "win32")).toBeNull();
  });

  it("falls back to the desktop marker only when the server sent no platform", () => {
    // A server too old to carry the field must still render something, and
    // on a desktop the marker is the same machine as the server.
    vi.stubGlobal("window", { ogb: { platform: "darwin" }, userAgent: "Mozilla/5.0 (Macintosh)" });
    try {
      expect(installCommandFor({ command: { darwin: "brew install acme" } })).toBe("brew install acme");
      // and it still honours the preload over the user agent
      expect(installCommandFor({ command: { win32: "winget install acme" } })).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("claims no install for an engine that declares none", () => {
    expect(installCommandFor(undefined, "linux")).toBeNull();
    expect(installCommandFor({}, "linux")).toBeNull();
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
