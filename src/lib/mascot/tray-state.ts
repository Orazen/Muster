// Tray state — the pure mapping from the fleet's bot list (GET /api/bots,
// the same feed the web app folds) to the tray companion's view model.
// One bot in focus: the one that most needs you (waiting > error > working
// > settled > idle); the rest collapse to face + line. Kept pure so the
// window logic stays thin and the rules are testable.
//
// Status derivation mirrors src/lib/mascot/character.ts's statusForBotActivity
// (web side). The two stay in sync by test: tray-state.test.ts asserts the
// same facts produce the same statuses in both modules.

export type TrayStatus = "idle" | "working" | "thinking" | "uploading" | "finished" | "error";

export interface TrayBotInput {
  id: string;
  name: string;
  color: string;
  character?: string | null;
  busy?: boolean;
  unread?: boolean;
  activity?: string | null;
  streaming?: string | null;
  /** Newest message may carry a failed tool — the web face uses the same fact. */
  lastToolFailed?: boolean;
}

/** How many bots are waiting on a human — the count behind the tray
 * window's badge line. The menu-bar status item counts the same fact for
 * the same feed in electron/tray-badge.mjs; the two are pinned together by
 * electron/tray-badge.test.mjs so the icon and the window can never
 * disagree. Hidden bots are filtered at the call site (the renderer drops
 * them before render), matching resolveTrayView's inputs. */
export function countWaitingOnYou(bots: TrayBotInput[]): number {
  return bots.filter((bot) => bot.activity === "waiting-on-you").length;
}

export interface TrayBotView {
  id: string;
  name: string;
  color: string;
  status: TrayStatus;
  /** The narrated one-liner: never empty while status ≠ idle. */
  line: string;
  focus: boolean;
}

export type TrayMood = "idle" | "working" | "attention" | "settled";

/** Derive a tray status from the facts the bots feed already carries. */
export function trayStatusFor(bot: TrayBotInput): TrayStatus {
  if (bot.lastToolFailed) return "error";
  if (bot.busy) return bot.streaming ? "thinking" : "working";
  if (bot.unread) return "finished";
  return "idle";
}

/** The narrated line — identical wording rules to the web statusLine. */
export function trayLineFor(bot: TrayBotInput, status: TrayStatus): string {
  const task = bot.name;
  switch (status) {
    case "working":
      return `Working — ${task}`;
    case "thinking":
      return `Thinking about ${task}'s next step`;
    case "uploading":
      return `Sending ${task}'s work`;
    case "finished":
      return `Done — ${task} has news`;
    case "error":
      return `Hit a problem — ${task} needs you`;
    case "idle":
      return "";
  }
}

const STATUS_RANK = {
  // idle ranks at 0 so an all-idle fleet has no focused bot at all —
  // "nobody needs you" is itself the tray's honest message.
  error: 4,
  working: 3,
  thinking: 3,
  uploading: 3,
  finished: 2,
  idle: 0,
} as const satisfies Record<TrayStatus, number>;

export interface TrayView {
  bots: TrayBotView[];
  mood: TrayMood;
}

/** One bot in focus, the rest in sight: waiting-on-you wins outright, then
 * the highest-ranked status; ties break by bot order (stable, no thrash). */
export function resolveTrayView(bots: TrayBotInput[]): TrayView {
  const waiting = bots.find((bot) => bot.activity === "waiting-on-you");
  const views: TrayBotView[] = bots.map((bot) => {
    const status = bot.activity === "waiting-on-you" ? "finished" : trayStatusFor(bot);
    return {
      id: bot.id,
      name: bot.name,
      color: bot.color,
      status,
      line: trayLineFor(bot, status),
      focus: false,
    };
  });

  let focusIndex = -1;
  if (waiting) {
    focusIndex = bots.findIndex((bot) => bot.id === waiting.id);
  } else {
    let best = 0;
    for (const [index, view] of views.entries()) {
      const rank = STATUS_RANK[view.status];
      if (rank > best) {
        best = rank;
        focusIndex = index;
      }
    }
  }
  if (focusIndex >= 0) views[focusIndex].focus = true;

  let mood: TrayMood = "idle";
  if (waiting) mood = "attention";
  else if (views.some((view) => view.status === "working" || view.status === "thinking" || view.status === "uploading")) mood = "working";
  else if (views.some((view) => view.status === "error" || view.status === "finished")) mood = "settled";
  return { bots: views, mood };
}
