import { setupTeammate, type SetupIdentity } from "./teammate-setup";
import type { Bot, Message } from "./store";

export interface FirstTaskAcceptance {
  message?: Message;
}

export interface OnboardingFinishInput {
  identity: SetupIdentity | null;
  task: string;
  sendFirstTask?: boolean;
  readRoster(): Promise<Bot[]>;
  createBot(): Promise<{ bot: Bot }>;
  patchBot(botId: string, identity: SetupIdentity): Promise<{ bot: Bot }>;
  onBotReady(bot: Bot): void;
  sendTask(botId: string, task: string): Promise<FirstTaskAcceptance>;
}

export interface OnboardingFinishResult {
  bot: Bot;
  task: string;
  message?: Message;
}

class DisposedFinish extends Error {}

/** One mounted wizard's setup transaction. The lock covers the entire
 * operation; the accepted result survives completion-bookkeeping failures.
 * Transport failures with no response remain ambiguous: without a server
 * idempotency contract, retrying cannot promise exactly-once delivery. */
export function createOnboardingFinishSession() {
  let active = true;
  let generation = 0;
  let runningGeneration: number | null = null;
  let pending: Bot | null = null;
  let accepted: OnboardingFinishResult | null = null;

  const isCurrent = (attempt: number) => active && attempt === generation;
  const check = (attempt: number) => {
    if (!isCurrent(attempt)) throw new DisposedFinish();
  };

  return {
    // React StrictMode remounts effects; generation checks still invalidate
    // requests from the disposed effect without disabling the new mount.
    activate() { active = true; },
    dispose() {
      active = false;
      generation += 1;
      runningGeneration = null;
    },
    get busy() { return runningGeneration !== null; },
    get active() { return active; },
    async finish(input: OnboardingFinishInput): Promise<OnboardingFinishResult | null> {
      if (!active || runningGeneration !== null) return null;
      const attempt = generation;
      runningGeneration = attempt;
      try {
        // Work is already accepted. Retrying a failed cache/analytics/UI
        // completion must never PATCH or send the first task again.
        if (accepted) return accepted;
        const roster = await input.readRoster();
        check(attempt);
      const result = await setupTeammate({
          roster,
          pending,
          identity: input.identity,
          createBot: async () => {
            check(attempt);
            const created = await input.createBot();
            check(attempt);
            pending = created?.bot ?? null;
            return created;
          },
          patchBot: async (botId, identity) => {
            check(attempt);
            // Record a reused bot before PATCH, just as a new bot is
            // recorded before its PATCH, so either failure retries it.
            pending = roster.find((bot) => bot.id === botId) ?? pending;
            const patched = await input.patchBot(botId, identity);
            check(attempt);
            return patched;
          },
        });
        check(attempt);
        pending = result.bot;
        input.onBotReady(result.bot);
        check(attempt);
        const task = input.sendFirstTask === false ? "" : input.task.trim();
        const receipt = task ? await input.sendTask(result.bot.id, task) : {};
        check(attempt);
        accepted = { bot: result.bot, task, message: receipt.message };
        return accepted;
      } catch (error) {
        if (error instanceof DisposedFinish || !isCurrent(attempt)) return null;
        throw error;
      } finally {
        if (runningGeneration === attempt) runningGeneration = null;
      }
    },
  };
}
