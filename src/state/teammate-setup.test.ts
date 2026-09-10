import { describe, expect, it, vi } from "vitest";
import { setupTeammate, type SetupBot, type SetupIdentity } from "./teammate-setup";

interface FixtureBot extends SetupBot { name?: string }

const seedGreeter: FixtureBot = {
  id: "seed",
  threadId: "seed-thread",
  tasks: [{ threadId: "seed-thread" }],
  messages: [{ role: "assistant" }, { role: "assistant" }],
};

const identity: SetupIdentity = { name: "Scout", color: "orange", character: "star", title: "Research", description: "about" };

describe("teammate setup", () => {
  it("reuses the seeded greeting bot instead of creating a duplicate", async () => {
    const createBot = vi.fn();
    const patchBot = vi.fn();
    const result = await setupTeammate({
      roster: [seedGreeter],
      identity: null,
      createBot,
      patchBot,
    });
    expect(result.reused).toBe(true);
    expect(result.bot.id).toBe("seed");
    expect(result.messages).toEqual(seedGreeter.messages);
    expect(createBot).not.toHaveBeenCalled();
    expect(patchBot).not.toHaveBeenCalled();
  });

  it("creates when no roster bot is eligible", async () => {
    const talkedTo = { id: "b1", messages: [{ role: "user" }] };
    const created = { bot: { id: "b2", messages: [] } };
    const createBot = vi.fn().mockResolvedValue(created);
    const result = await setupTeammate({ roster: [talkedTo], identity: null, createBot, patchBot: vi.fn() });
    expect(result.reused).toBe(false);
    expect(result.bot.id).toBe("b2");
    expect(createBot).toHaveBeenCalledTimes(1);
  });

  it("never renames hidden or chief-of-staff bots into the first teammate", async () => {
    const created = { bot: { id: "b2", messages: [] } };
    const createBot = vi.fn().mockResolvedValue(created);
    const result = await setupTeammate({
      roster: [{ id: "h", hidden: true }, { id: "cos", chiefOfStaff: true }],
      identity: null,
      createBot,
      patchBot: vi.fn(),
    });
    expect(result.bot.id).toBe("b2");
  });

  it("applies the identity to the reused bot and keeps its messages when the patch omits them", async () => {
    const createBot = vi.fn(async () => ({ bot: { id: "unused", name: "" } }));
    const patchBot = vi.fn(async () => ({ bot: { id: "seed", name: "Scout", color: "orange" } }));
    const result = await setupTeammate({
      roster: [seedGreeter],
      identity,
      createBot,
      patchBot,
    });
    expect(patchBot).toHaveBeenCalledWith("seed", identity);
    expect(result.bot.id).toBe("seed");
    expect(result.bot.name).toBe("Scout");
    expect(result.messages).toEqual(seedGreeter.messages);
  });

  it("prefers the pending bot from a failed attempt, so a retry cannot duplicate it", async () => {
    const pending: FixtureBot = { id: "pending-1", messages: [] };
    const createBot = vi.fn(async () => ({ bot: { id: "unused", name: "" } }));
    const patchBot = vi.fn(async () => ({ bot: { id: "pending-1", name: "Scout" } }));
    const result = await setupTeammate({
      roster: [seedGreeter, pending],
      pending,
      identity,
      createBot,
      patchBot,
    });
    expect(result.bot.id).toBe("pending-1");
    expect(result.bot.name).toBe("Scout");
    expect(createBot).not.toHaveBeenCalled();
  });

  it("throws when creation returns no usable bot (e.g. an unchecked 402 body)", async () => {
    const createBot = vi.fn().mockResolvedValue({ bot: undefined });
    await expect(
      setupTeammate({ roster: [], identity: null, createBot, patchBot: vi.fn() }),
    ).rejects.toThrow(/no usable teammate/);
  });

  it("throws when creation resolves without a bot id", async () => {
    const createBot = vi.fn().mockResolvedValue({ bot: { id: "" } });
    await expect(
      setupTeammate({ roster: [], identity: null, createBot, patchBot: vi.fn() }),
    ).rejects.toThrow(/no usable teammate/);
  });

  it("throws when the patch response carries no bot, without losing the created one", async () => {
    const createBot = vi.fn().mockResolvedValue({ bot: { id: "n1", messages: [] } });
    const patchBot = vi.fn().mockResolvedValue({});
    await expect(
      setupTeammate({ roster: [], identity, createBot, patchBot }),
    ).rejects.toThrow(/did not stick/);
  });

  it("does not treat absent transcript history as an unused greeter", async () => {
    const createBot = vi.fn(async () => ({ bot: { id: "new", messages: [] } }));
    const result = await setupTeammate<SetupBot>({ roster: [{ id: "unknown-history" }], identity: null, createBot, patchBot: vi.fn() });
    expect(result.bot.id).toBe("new");
    expect(createBot).toHaveBeenCalledOnce();
  });

  it.each<{ reason: string; bot: SetupBot }>([
    { reason: "prior tasks behind an empty current thread", bot: { id: "used", threadId: "new", tasks: [{ threadId: "new" }, { threadId: "old" }], messages: [] } },
    { reason: "a sole task belonging to a different thread", bot: { id: "used", threadId: "new", tasks: [{ threadId: "old" }], messages: [] } },
    { reason: "an explicitly empty task list", bot: { id: "unknown", threadId: "current", tasks: [], messages: [] } },
    { reason: "task metadata without a current thread", bot: { id: "unknown", tasks: [{ threadId: "current" }], messages: [] } },
    { reason: "incomplete legacy transcript history", bot: { id: "unknown", messages: [], hasMore: true } },
    { reason: "active scheduled work", bot: { ...seedGreeter, busy: true } },
    { reason: "work waiting on a decision", bot: { ...seedGreeter, activity: "waiting-on-you" } },
  ])("does not rename a bot with $reason", async ({ bot }) => {
    const createBot = vi.fn(async () => ({ bot: { id: "new-teammate", messages: [] } }));
    const patchBot = vi.fn(async (id: string) => ({ bot: { id, name: "Scout" } }));
    const result = await setupTeammate<SetupBot>({ roster: [bot], identity, createBot, patchBot });
    expect(result.bot.id).toBe("new-teammate");
    expect(createBot).toHaveBeenCalledOnce();
    expect(patchBot.mock.calls).toEqual([["new-teammate", identity]]);
  });

  it("preserves legacy single-thread greeters with complete transcripts", async () => {
    const legacy = { id: "legacy", threadId: "legacy-thread", messages: [{ role: "bot" }], hasMore: false };
    const createBot = vi.fn();
    const result = await setupTeammate({ roster: [legacy], identity: null, createBot, patchBot: vi.fn() });
    expect(result.bot).toBe(legacy);
    expect(createBot).not.toHaveBeenCalled();
  });

  it.each<{ reason: string; bot: SetupBot }>([
    { reason: "became busy", bot: { ...seedGreeter, busy: true } },
    { reason: "switched its sole thread", bot: { ...seedGreeter, threadId: "other", tasks: [{ threadId: "other" }] } },
  ])("stops a retry when its chosen bot $reason", async ({ bot }) => {
    const createBot = vi.fn();
    const patchBot = vi.fn();
    await expect(setupTeammate<SetupBot>({ roster: [bot], pending: seedGreeter, identity, createBot, patchBot }))
      .rejects.toThrow(/no longer available/);
    expect(createBot).not.toHaveBeenCalled();
    expect(patchBot).not.toHaveBeenCalled();
  });

  it("rejects a PATCH response naming a different bot", async () => {
    await expect(setupTeammate({
      roster: [seedGreeter], identity, createBot: vi.fn(),
      patchBot: vi.fn(async () => ({ bot: { id: "other", messages: [] } })),
    })).rejects.toThrow(/did not stick/);
  });

  it("rejects a same-bot PATCH response that reports a changed thread", async () => {
    await expect(setupTeammate({
      roster: [seedGreeter], identity, createBot: vi.fn(),
      patchBot: vi.fn(async () => ({ bot: { ...seedGreeter, threadId: "switched-thread", tasks: [{ threadId: "switched-thread" }] } })),
    })).rejects.toThrow(/did not stick/);
  });

  it("does not create a replacement when the retry's chosen bot disappeared", async () => {
    const createBot = vi.fn();
    await expect(setupTeammate({
      roster: [seedGreeter], pending: { id: "missing", messages: [] }, identity: null,
      createBot, patchBot: vi.fn(),
    })).rejects.toThrow(/no longer available/);
    expect(createBot).not.toHaveBeenCalled();
  });
});
