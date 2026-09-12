import { describe, expect, it, vi } from "vitest";
import { StopCleanupRegistry } from "./stop-cleanup.ts";

const snapshot = () => [{ threadId: "task-original", itemIds: ["queue-original"] }];
const exists = () => true;

describe("original-generation Stop cleanup receipts", () => {
  it("issues an opaque receipt and retries only the captured queue", () => {
    const registry = new StopCleanupRegistry();
    registry.begin("bot", "owner");
    const token = registry.issue("bot", "owner", snapshot());
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    const cleanup = vi.fn(() => true);
    expect(registry.retry("bot", "owner", token, exists, cleanup)).toBe("ok");
    expect(cleanup.mock.calls).toEqual([[snapshot()[0]]]);
  });

  it("retains failed cleanup and makes repeated successful requests idempotent", () => {
    const registry = new StopCleanupRegistry();
    const token = registry.issue("bot", "owner", snapshot());
    const cleanup = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    expect(registry.retry("bot", "owner", token, exists, cleanup)).toBe("pending");
    expect(registry.retry("bot", "owner", token, exists, cleanup)).toBe("ok");
    expect(registry.retry("bot", "owner", token, exists, cleanup)).toBe("ok");
    expect(cleanup).toHaveBeenCalledTimes(2);
  });

  it.each(["other-owner", "", "local"])("refuses requester owner %s without consuming the rightful receipt", (owner) => {
    const registry = new StopCleanupRegistry();
    const token = registry.issue("bot", "owner", snapshot());
    const cleanup = vi.fn(() => true);
    expect(registry.retry("bot", owner, token, exists, cleanup)).toBe("stale");
    expect(cleanup).not.toHaveBeenCalled();
    expect(registry.current("bot", "owner", token)).toBe(true);
  });

  it.each(["other-bot", ""])("refuses a different bot %s", (botId) => {
    const registry = new StopCleanupRegistry();
    const token = registry.issue("bot", "owner", snapshot());
    const cleanup = vi.fn(() => true);
    expect(registry.retry(botId, "owner", token, exists, cleanup)).toBe("stale");
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("a later admitted generation retires an old receipt even on the same task", () => {
    const registry = new StopCleanupRegistry();
    registry.begin("bot", "owner");
    const token = registry.issue("bot", "owner", snapshot());
    registry.begin("bot", "owner");
    const cleanup = vi.fn(() => true);
    expect(registry.retry("bot", "owner", token, exists, cleanup)).toBe("stale");
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("retains a receipt across task selection without admitting a new turn", () => {
    const registry = new StopCleanupRegistry();
    const token = registry.issue("bot", "owner", snapshot());
    const tasks = new Set(["task-original", "task-selected-later"]);
    const cleanup = vi.fn(() => true);
    expect(registry.retry("bot", "owner", token, (id) => tasks.has(id), cleanup)).toBe("ok");
    expect(cleanup).toHaveBeenCalledWith(snapshot()[0]);
  });

  it("a deleted original task retires its receipt before any cleanup", () => {
    const registry = new StopCleanupRegistry();
    const token = registry.issue("bot", "owner", snapshot());
    const cleanup = vi.fn(() => true);
    expect(registry.retry("bot", "owner", token, () => false, cleanup)).toBe("stale");
    expect(cleanup).not.toHaveBeenCalled();
    expect(registry.current("bot", "owner", token)).toBe(false);
  });

  it("checks every detached task before changing any queue", () => {
    const registry = new StopCleanupRegistry();
    const token = registry.issue("bot", "owner", [...snapshot(), { threadId: "detached", itemIds: ["queue-2"] }]);
    const cleanup = vi.fn(() => true);
    expect(registry.retry("bot", "owner", token, (id) => id !== "detached", cleanup)).toBe("stale");
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("copies captured queues so a caller cannot expand authority later", () => {
    const registry = new StopCleanupRegistry();
    const queues = snapshot();
    const token = registry.issue("bot", "owner", queues);
    queues[0].itemIds.push("later");
    queues.push({ threadId: "another", itemIds: ["later"] });
    const cleanup = vi.fn(() => true);
    registry.retry("bot", "owner", token, exists, cleanup);
    expect(cleanup.mock.calls).toEqual([[snapshot()[0]]]);
  });

  it("coalesces repeated Stops in one generation without replacing a late response's token", () => {
    const registry = new StopCleanupRegistry();
    const first = registry.issue("bot", "owner", snapshot());
    const second = registry.issue("bot", "owner", [{ threadId: "detached", itemIds: ["queue-2"] }, ...snapshot()]);
    expect(first).toBe(second);
    const cleanup = vi.fn(() => true);
    registry.retry("bot", "owner", first, exists, cleanup);
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(cleanup.mock.calls[1]).toEqual([{ threadId: "detached", itemIds: ["queue-2"] }]);
  });

  it("a new owner never inherits an old owner's receipt", () => {
    const registry = new StopCleanupRegistry();
    const old = registry.issue("bot", "owner", snapshot());
    const fresh = registry.issue("bot", "new-owner", snapshot());
    expect(fresh).not.toBe(old);
    expect(registry.current("bot", "owner", old)).toBe(false);
    expect(registry.current("bot", "new-owner", fresh)).toBe(true);
  });

  it("expires at the exact lifetime boundary", () => {
    let now = 0;
    const registry = new StopCleanupRegistry(() => now, 100);
    const token = registry.issue("bot", "owner", snapshot());
    now = 99;
    expect(registry.current("bot", "owner", token)).toBe(true);
    now = 100;
    expect(registry.retry("bot", "owner", token, exists, () => true)).toBe("stale");
  });

  it("explicit lifecycle invalidation retires completed receipts", () => {
    const registry = new StopCleanupRegistry();
    const token = registry.issue("bot", "owner", snapshot());
    registry.retry("bot", "owner", token, exists, () => true);
    registry.invalidate("bot");
    const cleanup = vi.fn(() => true);
    expect(registry.retry("bot", "owner", token, exists, cleanup)).toBe("stale");
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("a new server registry refuses an old process receipt", () => {
    const token = new StopCleanupRegistry().issue("bot", "owner", snapshot());
    const cleanup = vi.fn(() => true);
    expect(new StopCleanupRegistry().retry("bot", "owner", token, exists, cleanup)).toBe("stale");
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("one failed detached queue keeps the receipt pending while successful cleanup remains idempotent", () => {
    const registry = new StopCleanupRegistry();
    const token = registry.issue("bot", "owner", [...snapshot(), { threadId: "detached", itemIds: ["queue-2"] }]);
    const remaining = new Set(["task-original", "detached"]);
    let blocked = true;
    const cleanup = (s: { threadId: string }) => {
      if (s.threadId === "detached" && blocked) return false;
      remaining.delete(s.threadId);
      return true;
    };
    expect(registry.retry("bot", "owner", token, exists, cleanup)).toBe("pending");
    expect([...remaining]).toEqual(["detached"]);
    blocked = false;
    expect(registry.retry("bot", "owner", token, exists, cleanup)).toBe("ok");
    expect(remaining.size).toBe(0);
  });
});
