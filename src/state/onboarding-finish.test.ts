import { describe, expect, it, vi } from "vitest";
import { createOnboardingFinishSession, type FirstTaskAcceptance, type OnboardingFinishInput } from "./onboarding-finish";
import type { Bot, Message } from "./store";

const greeter: Bot = {
  id: "seed", threadId: "seed-thread", name: "Noodle", title: "", description: "",
  color: "orange", notifications: true, unread: false,
  modelSelection: { instanceId: "fixture", model: "default" },
  messages: [{ id: "hello", role: "bot", kind: "text", text: "Hello", at: 1 }],
};
const userMessage: Message = { id: "accepted-task", role: "user", kind: "text", text: "Draft a brief", at: 2 };

class Deferred<T> {
  resolve!: (value: T) => void;
  readonly promise = new Promise<T>((resolve) => { this.resolve = resolve; });
}

function fixture(initialRoster: Bot[] = [greeter]) {
  const roster = [...initialRoster];
  const readRoster = vi.fn(async () => [...roster]);
  const createBot = vi.fn(async () => {
    const bot = { ...greeter, id: "created", threadId: "created-thread" };
    roster.push(bot);
    return { bot };
  });
  const patchBot = vi.fn(async (id: string) => {
    const bot = roster.find((entry) => entry.id === id);
    if (!bot) throw new Error("no such bot");
    return { bot: { ...bot, name: "Scout" } };
  });
  const sendTask = vi.fn(async (): Promise<FirstTaskAcceptance> => ({ message: userMessage }));
  const onBotReady = vi.fn();
  const input = {
    task: "Draft a brief", identity: { name: "Scout" }, readRoster, createBot, patchBot, sendTask, onBotReady,
  } satisfies OnboardingFinishInput;
  return { roster, input, session: createOnboardingFinishSession() };
}

describe("onboarding finish lifecycle", () => {
  it("waits for authoritative history instead of creating from a still-empty UI roster", async () => {
    const { input, session } = fixture();
    const response = new Deferred<Bot[]>();
    input.readRoster.mockReturnValueOnce(response.promise);
    const finishing = session.finish(input);
    expect(input.createBot).not.toHaveBeenCalled();
    expect(input.patchBot).not.toHaveBeenCalled();
    expect(input.sendTask).not.toHaveBeenCalled();
    response.resolve([greeter]);
    expect((await finishing)?.bot.id).toBe(greeter.id);
    expect(input.createBot).not.toHaveBeenCalled();
    expect(input.patchBot).toHaveBeenCalledWith(greeter.id, input.identity);
  });

  it("preserves a failed roster read without creating or sending", async () => {
    const { input, session } = fixture();
    input.readRoster.mockRejectedValueOnce(new Error("roster unavailable"));
    await expect(session.finish(input)).rejects.toThrow("roster unavailable");
    expect(input.createBot).not.toHaveBeenCalled();
    expect(input.sendTask).not.toHaveBeenCalled();
    expect(session.busy).toBe(false);
  });

  it("creates once across create → PATCH failure → retry", async () => {
    const { input, session } = fixture([]);
    input.patchBot.mockRejectedValueOnce(new Error("PATCH rejected"));
    await expect(session.finish(input)).rejects.toThrow("PATCH rejected");
    expect(input.sendTask).not.toHaveBeenCalled();
    expect((await session.finish(input))?.bot.id).toBe("created");
    expect(input.createBot).toHaveBeenCalledOnce();
    expect(input.patchBot.mock.calls.map(([id]) => id)).toEqual(["created", "created"]);
    expect(input.sendTask).toHaveBeenCalledOnce();
  });

  it("keeps the same reused bot after PATCH failure even if another greeter moves to the front", async () => {
    const { input, session, roster } = fixture();
    input.patchBot.mockRejectedValueOnce(new Error("PATCH rejected"));
    await expect(session.finish(input)).rejects.toThrow("PATCH rejected");
    roster.unshift({ ...greeter, id: "newer" });
    expect((await session.finish(input))?.bot.id).toBe(greeter.id);
    expect(input.createBot).not.toHaveBeenCalled();
    expect(input.patchBot.mock.calls.map(([id]) => id)).toEqual([greeter.id, greeter.id]);
  });

  it("does not complete a rejected send and retries the task on the same bot", async () => {
    const { input, session } = fixture();
    input.sendTask.mockRejectedValueOnce(new Error("send rejected"));
    await expect(session.finish(input)).rejects.toThrow("send rejected");
    expect(input.task).toBe("Draft a brief");
    const accepted = await session.finish(input);
    expect(accepted).toMatchObject({ bot: { id: greeter.id }, task: input.task, message: userMessage });
    expect(input.createBot).not.toHaveBeenCalled();
    expect(input.sendTask.mock.calls).toEqual([[greeter.id, input.task], [greeter.id, input.task]]);
  });

  it("does not auto-send first task when user chooses to skip onboarding task", async () => {
    const { input, session } = fixture();
    const result = await session.finish({ ...input, sendFirstTask: false });
    expect(input.sendTask).not.toHaveBeenCalled();
    expect(result).toMatchObject({ bot: { id: greeter.id }, task: "" });
  });

  it("retains acceptance when final bookkeeping fails so retry does not PATCH or send again", async () => {
    const { input, session } = fixture();
    const accepted = await session.finish(input);
    // Simulate the caller failing to persist its completion flag after the
    // accepted response. Only that bookkeeping should run on the next try.
    const saveCompletion = vi.fn().mockRejectedValueOnce(new Error("cache unavailable")).mockResolvedValueOnce(undefined);
    await expect(saveCompletion()).rejects.toThrow("cache unavailable");
    expect(await session.finish({ ...input, task: "Changed after acceptance" })).toBe(accepted);
    await saveCompletion();
    expect(input.readRoster).toHaveBeenCalledOnce();
    expect(input.patchBot).toHaveBeenCalledOnce();
    expect(input.sendTask).toHaveBeenCalledOnce();
    expect(input.onBotReady).toHaveBeenCalledOnce();
  });

  it("locks synchronously so competing finish entrypoints cannot double-create or double-send", async () => {
    const { input, session } = fixture([]);
    const response = new Deferred<Bot[]>();
    input.readRoster.mockReturnValueOnce(response.promise);
    const first = session.finish(input);
    expect(session.busy).toBe(true);
    expect(await session.finish(input)).toBeNull();
    response.resolve([]);
    await first;
    expect(input.createBot).toHaveBeenCalledOnce();
    expect(input.sendTask).toHaveBeenCalledOnce();
    expect(session.busy).toBe(false);
  });

  it("disposal during roster loading prevents every follow-on action", async () => {
    const { input, session } = fixture([]);
    const response = new Deferred<Bot[]>();
    input.readRoster.mockReturnValueOnce(response.promise);
    const finishing = session.finish(input);
    session.dispose();
    response.resolve([]);
    expect(await finishing).toBeNull();
    expect(input.createBot).not.toHaveBeenCalled();
    expect(input.patchBot).not.toHaveBeenCalled();
    expect(input.sendTask).not.toHaveBeenCalled();
    expect(input.onBotReady).not.toHaveBeenCalled();
  });

  it("disposal during creation prevents PATCH, send and completion", async () => {
    const { input, session } = fixture([]);
    const response = new Deferred<{ bot: Bot }>();
    input.createBot.mockReturnValueOnce(response.promise);
    const finishing = session.finish(input);
    await vi.waitFor(() => expect(input.createBot).toHaveBeenCalledOnce());
    session.dispose();
    response.resolve({ bot: { ...greeter, id: "created" } });
    expect(await finishing).toBeNull();
    expect(input.patchBot).not.toHaveBeenCalled();
    expect(input.sendTask).not.toHaveBeenCalled();
    expect(input.onBotReady).not.toHaveBeenCalled();
  });

  it("disposal during PATCH prevents sending or publishing the configured bot", async () => {
    const { input, session } = fixture();
    const response = new Deferred<{ bot: Bot }>();
    input.patchBot.mockReturnValueOnce(response.promise);
    const finishing = session.finish(input);
    await vi.waitFor(() => expect(input.patchBot).toHaveBeenCalledOnce());
    session.dispose();
    response.resolve({ bot: greeter });
    expect(await finishing).toBeNull();
    expect(input.sendTask).not.toHaveBeenCalled();
    expect(input.onBotReady).not.toHaveBeenCalled();
  });

  it("disposal during a send prevents late completion for another account", async () => {
    const { input, session } = fixture();
    const response = new Deferred<FirstTaskAcceptance>();
    input.sendTask.mockReturnValueOnce(response.promise);
    const completion = vi.fn();
    const finishing = session.finish(input).then((result) => { if (result) completion(result); });
    await vi.waitFor(() => expect(input.sendTask).toHaveBeenCalledOnce());
    session.dispose();
    response.resolve({ message: userMessage });
    await finishing;
    expect(completion).not.toHaveBeenCalled();
  });

  it("can activate again after an effect remount without reviving old requests", async () => {
    const { input, session } = fixture();
    const response = new Deferred<Bot[]>();
    input.readRoster.mockReturnValueOnce(response.promise);
    const old = session.finish(input);
    session.dispose();
    session.activate();
    expect((await session.finish(input))?.bot.id).toBe(greeter.id);
    response.resolve([]);
    expect(await old).toBeNull();
    expect(input.createBot).not.toHaveBeenCalled();
    expect(input.sendTask).toHaveBeenCalledOnce();
  });
});
