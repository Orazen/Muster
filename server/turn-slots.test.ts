import { afterEach, describe, expect, it } from "vitest";
import { claimSlot, clearSlots, configuredWidth, hasSlot, releaseSlot, PARALLEL_THREADS_MAX } from "./turn-slots.ts";

describe("turn slots (parallel threads, OMB parity)", () => {
  afterEach(() => clearSlots());

  it("width defaults to 1 with no config — the classic single-worker invariant", () => {
    expect(configuredWidth(undefined, "b1", false)).toBe(1);
    expect(configuredWidth({}, "b1", false)).toBe(1);
    expect(configuredWidth({ perBot: {} }, "b1", false)).toBe(1);
  });

  it("group threads are pinned to 1 regardless of config", () => {
    expect(configuredWidth({ default: 4, perBot: { b1: 6 } }, "b1", true)).toBe(1);
  });

  it("per-bot override wins over the deployment default", () => {
    expect(configuredWidth({ default: 2, perBot: { b1: 4 } }, "b1", false)).toBe(4);
    expect(configuredWidth({ default: 2 }, "b1", false)).toBe(2);
  });

  it("out-of-range and non-integer values mean OFF (fall back), never a crash", () => {
    expect(configuredWidth({ perBot: { b1: 0 } }, "b1", false)).toBe(1);
    expect(configuredWidth({ perBot: { b1: 99 } }, "b1", false)).toBe(1);
    expect(configuredWidth({ perBot: { b1: 2.5 } }, "b1", false)).toBe(1);
    expect(configuredWidth({ default: -3 }, "b1", false)).toBe(1);
    // the clamp ceiling is exported so config/UI stay honest about the bound
    expect(PARALLEL_THREADS_MAX).toBe(8);
  });

  it("slot ledger admits turns up to the width and refuses past it", () => {
    expect(hasSlot("b", "t1", 2)).toBe(true);
    claimSlot("b", "t1");
    expect(hasSlot("b", "t2", 2)).toBe(true);
    claimSlot("b", "t2");
    expect(hasSlot("b", "t3", 2)).toBe(false);
  });

  it("width 1 serializes exactly like the old busy-only gate", () => {
    claimSlot("b", "t1");
    expect(hasSlot("b", "t2", 1)).toBe(false);
  });

  it("a thread occupying a slot does not consume the bot's other threads' budget", () => {
    claimSlot("b", "t1");
    claimSlot("b", "t1"); // double claim of the same thread is one slot
    expect(hasSlot("b", "t2", 2)).toBe(true);
  });

  it("release is idempotent and frees the bot for new turns", () => {
    claimSlot("b", "t1");
    releaseSlot("b", "t1");
    releaseSlot("b", "t1");
    expect(hasSlot("b", "t2", 1)).toBe(true);
    claimSlot("b", "t2");
    releaseSlot("b", "t2");
    // empty sets are dropped so the ledger cannot leak per-bot entries
    expect(hasSlot("b", "t3", 1)).toBe(true);
  });

  it("ledgers are per-bot: one bot's slots never block another", () => {
    claimSlot("a", "t1");
    claimSlot("a", "t2");
    expect(hasSlot("b", "t3", 2)).toBe(true);
  });
});
