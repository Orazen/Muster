/* First-task teammate setup — the decision logic behind onboarding's finish
 * button, extracted so it can be unit-tested without a DOM.
 *
 * The old inline finish() POSTed a brand-new bot unconditionally, but every
 * fresh account already carries the seeded greeting bot (seedIfEmpty), so
 * finishing planted a duplicate teammate on the roster. It also never checked
 * response bodies: a 402 TIER_BOT_CAP parsed into `created.bot === undefined`
 * and either dispatched a garbage bot or threw inside a bare catch. This
 * module makes the reuse-or-create decision explicit and throws on any
 * response that lacks a usable bot, so the caller can show recovery instead
 * of marking failure as success. */

import { z } from "zod";

export interface SetupMessageRole {
  role: string;
}

/** Structural subset of the store's Bot that the setup decision needs. */
export interface SetupBot {
  id: string;
  threadId?: string;
  tasks?: { threadId: string }[];
  messages?: SetupMessageRole[];
  hasMore?: boolean;
  busy?: boolean;
  activity?: "working" | "waiting-on-you" | "idle" | "no-signal" | "dead";
  hidden?: boolean;
  chiefOfStaff?: boolean;
}

export interface SetupIdentity {
  name: string;
  color?: string;
  character?: string;
  title?: string;
  description?: string;
}

export interface SetupTeammateInput<T extends SetupBot> {
  /** Current roster — the seeded greeting bot is usually eligible here. */
  roster: T[];
  /** A bot already confirmed by a prior attempt, carried into the retry
   * so an acknowledged creation is not repeated. */
  pending?: T | null;
  /** Persona to apply via PATCH; null keeps the default identity (unnamed
   * "skip" path). */
  identity: SetupIdentity | null;
  createBot: () => Promise<{ bot: T }>;
  patchBot: (botId: string, identity: SetupIdentity) => Promise<{ bot: T }>;
}

export interface SetupTeammateResult<T extends SetupBot> {
  bot: T;
  /** Thread messages to hand to botAdded (PATCH responses may omit them). */
  messages: T["messages"];
  reused: boolean;
}

/** A bot is reusable when nobody has talked to it yet: the seeded greeter,
 * or the fresh bot from a failed attempt. Hidden bots were filed away on
 * purpose and the Chief of Staff is the roster's anchor — neither may be
 * renamed into the user's first teammate. */
const setupBotSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1).optional(),
  tasks: z.array(z.object({ threadId: z.string().min(1) })).optional(),
  messages: z.array(z.object({ role: z.string() })).optional(),
  hasMore: z.boolean().optional(),
  busy: z.boolean().optional(),
  activity: z.enum(["working", "waiting-on-you", "idle", "no-signal", "dead"]).optional(),
  hidden: z.boolean().optional(),
  chiefOfStaff: z.boolean().optional(),
});

function canConfigure(bot: SetupBot): boolean {
  // The roster transcript covers only the current thread. Other tasks may
  // contain prior work even when this thread is empty. Legacy single-thread
  // payloads omit tasks, but still must supply the complete transcript.
  return !bot.hidden && !bot.chiefOfStaff && !bot.busy
    && (bot.activity === undefined || bot.activity === "idle")
    && bot.messages !== undefined && !bot.hasMore
    && (bot.tasks === undefined || (bot.tasks.length === 1 && bot.tasks[0].threadId === bot.threadId));
}

function isReusable<T extends SetupBot>(bot: T | null | undefined): bot is T {
  const parsed = setupBotSchema.safeParse(bot);
  return parsed.success && canConfigure(parsed.data)
    && !parsed.data.messages?.some((message) => message.role === "user");
}

export async function setupTeammate<T extends SetupBot>(
  input: SetupTeammateInput<T>,
): Promise<SetupTeammateResult<T>> {
  const { roster, pending, identity, createBot, patchBot } = input;

  // A retry belongs to the bot this flow already chose. Refresh its record
  // from the authoritative roster; never silently switch to another bot.
  const candidate = pending ? roster.find((bot) => bot.id === pending.id) : roster.find(isReusable);
  if (pending && (!candidate || !setupBotSchema.safeParse(candidate).success || !canConfigure(candidate)
    || (pending.threadId !== undefined && candidate.threadId !== pending.threadId))) {
    throw new Error("The teammate from your previous attempt is no longer available for setup. Open its chat to check it.");
  }
  let bot: T;
  let messages: T["messages"];
  let reused: boolean;

  if (candidate) {
    bot = candidate;
    messages = candidate.messages;
    reused = true;
  } else {
    const created = await createBot();
    bot = created?.bot;
    if (!isReusable(bot)) throw new Error("Setting up your teammate failed — no usable teammate came back. Try again.");
    messages = bot.messages;
    reused = false;
  }

  if (identity) {
    const patched = await patchBot(bot.id, identity);
    const next = patched?.bot;
    // Reject an observed task switch; atomic binding of the later send to
    // this thread requires a separate server-side contract.
    if (!next || !setupBotSchema.safeParse(next).success || next.id !== bot.id
      || (bot.threadId !== undefined && next.threadId !== undefined && next.threadId !== bot.threadId)) {
      throw new Error("Setting up your teammate failed — the update did not stick. Try again.");
    }
    messages = next.messages ?? messages;
    bot = { ...bot, ...next, messages };
  }

  return { bot, messages, reused };
}
