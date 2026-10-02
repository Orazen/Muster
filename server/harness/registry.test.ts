// The registry's contract is forward/backward compatibility: a config
// written by a newer or differently-built app must load as an
// unavailable shadow, never crash the fleet. These tests pin that.
import { describe, expect, it } from "vitest";

import { makeFakeDriver } from "../testing/fake-driver.ts";
import { ProviderRegistry } from "./registry.ts";

describe("ProviderRegistry", () => {
  it("creates live instances for known drivers", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake", displayName: "Bot A" } });

    const live = registry.get("a");
    expect(live).not.toBeNull();
    expect(live!.driverKind).toBe("fake");
    expect(live!.displayName).toBe("Bot A");
    expect(registry.instances()).toHaveLength(1);
  });

  it("uses defaultConfig when the entry has no config", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });
    // decodeConfig must NOT have been called — defaultConfig() is used verbatim
    expect(fake.decodedConfigs).toHaveLength(0);
    expect(registry.get("a")).not.toBeNull();
  });

  it("reports cli as overridden only when the raw config sets it", async () => {
    // Regression: override detection used to read the DECODED config, whose
    // cli field is always filled in with the driver default — every instance
    // then showed as "custom" though nothing was touched.
    const fake = makeFakeDriver();
    fake.driver.defaultConfig = () => ({ cli: "fakebin" });
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({
      untouched: { driver: "fake", config: { other: true } },
      overridden: { driver: "fake", config: { cli: "/opt/fake/custom-bin" } },
      bare: { driver: "fake" },
    });

    const described = Object.fromEntries((await registry.describe()).map((d) => [d.instanceId, d]));
    expect(described.untouched.cli).toBeUndefined();
    expect(described.bare.cli).toBeUndefined();
    expect(described.overridden.cli).toBe("/opt/fake/custom-bin");
    expect(described.untouched.cliDefault).toBe("fakebin");
    expect(described.untouched.access).toBe("subscription");
  });

  it("publishes custom-only access from driver metadata", async () => {
    const fake = makeFakeDriver();
    Object.assign(fake.driver.metadata, { access: "custom" });
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ local: { driver: "fake" } });
    const [described] = await registry.describe();
    expect(described.access).toBe("custom");
  });

  it("keeps an unknown driver as an unavailable shadow instead of failing", async () => {
    const registry = new ProviderRegistry([makeFakeDriver().driver]);
    await registry.load({ mystery: { driver: "from-the-future", displayName: "Tomorrow" } });

    expect(registry.get("mystery")).toBeNull();
    const [described] = await registry.describe();
    expect(described.snapshot.state).toBe("unavailable");
    expect(described.snapshot.reason).toContain("from-the-future");
    expect(described.displayName).toBe("Tomorrow");
    expect(described.models.options).toHaveLength(0);
  });

  it("downgrades a config-decode failure to a shadow with the error as reason", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ broken: { driver: "fake", config: { bad: true } } });

    expect(registry.get("broken")).toBeNull();
    const [described] = await registry.describe();
    expect(described.snapshot).toMatchObject({ state: "unavailable", reason: "fake: bad config" });
  });

  it("downgrades a create() rejection to a shadow without touching siblings", async () => {
    const good = makeFakeDriver({ kind: "good" });
    const flaky = makeFakeDriver({ kind: "flaky", failCreate: "boom at create" });
    const registry = new ProviderRegistry([good.driver, flaky.driver]);
    await registry.load({
      g: { driver: "good" },
      f: { driver: "flaky" },
    });

    expect(registry.get("g")).not.toBeNull();
    expect(registry.get("f")).toBeNull();
    const described = await registry.describe();
    const f = described.find((d) => d.instanceId === "f")!;
    expect(f.snapshot).toMatchObject({ state: "unavailable", reason: "boom at create" });
  });

  it("describe() reports a snapshot() failure as unavailable rather than throwing", async () => {
    const fake = makeFakeDriver({ failSnapshot: "provider probe exploded" });
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });

    const [described] = await registry.describe();
    expect(described.snapshot).toMatchObject({ state: "unavailable", reason: "provider probe exploded" });
  });

  it("forwards a live instance's declared effort levels in describe()", async () => {
    const fake = makeFakeDriver({ effortLevels: ["low", "high"] });
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });

    const [described] = await registry.describe();
    expect(described.capabilities.effortLevels).toEqual(["low", "high"]);
  });

  it("omits effortLevels from describe() when the driver declares none", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });

    const [described] = await registry.describe();
    expect(described.capabilities.effortLevels).toBeUndefined();
  });

  it("disposeAll disposes every live instance and empties the registry", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" }, b: { driver: "fake" } });

    await registry.disposeAll();
    expect(fake.disposed.sort()).toEqual(["a", "b"]);
    expect(registry.entries()).toHaveLength(0);
    expect(registry.get("a")).toBeNull();
  });

  it("replaces and removes only the selected scope, disposing predecessors before publication", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" }, removed: { driver: "fake" }, b: { driver: "fake" } });
    const old = registry.get("a");
    const sibling = registry.get("b");
    const retired: string[] = [];
    await registry.replaceScope({ a: { driver: "fake", displayName: "replacement" } }, id => id !== "b", { beforeDispose: instances => {
      expect(registry.get("a")).toBe(old);
      retired.push(...instances.map(instance => instance.instanceId));
    } });
    expect(retired.sort()).toEqual(["a", "removed"]);
    expect(fake.disposed.sort()).toEqual(["a", "removed"]);
    expect(registry.get("a")).not.toBe(old);
    expect(registry.get("b")).toBe(sibling);
    expect(registry.get("removed")).toBeNull();
  });

  it("preserves the entire old scope and reports a staged creation failure", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" }, b: { driver: "fake" } });
    const old = registry.get("a");
    const sibling = registry.get("b");
    let retired = false;
    await expect(registry.replaceScope({ a: { driver: "fake", config: { bad: true } }, next: { driver: "fake" } },
      id => id !== "b", { beforeDispose: () => { retired = true; } })).rejects.toThrow(/bad config/);
    expect(retired).toBe(false);
    expect(registry.get("a")).toBe(old);
    expect(registry.get("b")).toBe(sibling);
    expect(registry.get("next")).toBeNull();
    expect(fake.disposed).toEqual(["next"]);
  });

  it("refuses configs outside the replacement scope before creating them", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await expect(registry.replaceScope({ foreign: { driver: "fake" } }, id => id === "own")).rejects.toThrow(/outside/);
    expect(fake.created.size).toBe(0);
  });

  it("keeps unavailable shadow entries during boot reconciliation", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.replaceScope({ good: { driver: "fake" }, broken: { driver: "fake", config: { bad: true } } },
      () => true, { allowUnavailable: true });
    expect(registry.get("good")).not.toBeNull();
    expect(registry.entries().find(entry => entry.instanceId === "broken")?.shadow?.reason).toContain("bad config");
  });

  it("keeps the predecessor addressable until asynchronous disposal completes", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });
    const old = registry.get("a")!;
    let release = () => {};
    let begin = () => {};
    const begun = new Promise<void>(resolve => { begin = resolve; });
    const disposal = new Promise<void>(resolve => { release = resolve; });
    old.dispose = async () => { begin(); await disposal; };
    const replacing = registry.replaceScope({ a: { driver: "fake" } }, id => id === "a");
    await begun;
    expect(registry.get("a")).toBe(old);
    release();
    await replacing;
    expect(registry.get("a")).not.toBe(old);
  });

  it("quarantines a partially retired scope, reports failure and retries its failed disposer before recovery", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" }, retired: { driver: "fake" }, sibling: { driver: "fake" } });
    const sibling = registry.get("sibling");
    let attempts = 0;
    registry.get("a")!.dispose = async () => { if (++attempts === 1) throw new Error("synthetic cleanup failure"); };
    await expect(registry.replaceScope({ a: { driver: "fake" } }, id => id !== "sibling")).rejects.toThrow(/cleanup failed/);
    expect(registry.get("a")).toBeNull();
    expect(registry.get("retired")).toBeNull();
    expect(registry.get("sibling")).toBe(sibling);
    expect(registry.entries().find(entry => entry.instanceId === "a")?.shadow?.reason).toContain("previous work may still be running");
    await registry.replaceScope({ a: { driver: "fake" } }, id => id !== "sibling");
    expect(attempts).toBe(2);
    expect(registry.get("a")).not.toBeNull();
    expect(registry.entries().some(entry => entry.instanceId === "retired")).toBe(false);
    expect(registry.get("sibling")).toBe(sibling);
  });

  it("does not lose failed cleanup handles during whole-fleet disposal", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });
    let attempts = 0;
    registry.get("a")!.dispose = async () => { if (++attempts === 1) throw new Error("synthetic cleanup failure"); };
    await expect(registry.disposeAll()).rejects.toThrow(/cleanup failed/);
    expect(registry.get("a")).toBeNull();
    await registry.disposeAll();
    expect(attempts).toBe(2);
    expect(registry.entries()).toEqual([]);
  });
});
