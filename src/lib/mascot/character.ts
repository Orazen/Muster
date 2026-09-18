// The character contract — Muster's mascot as a character, not a status
// light. Two layers, per docs/plans/mascot-character-system-plan-2026-09-18.md:
//
//   status  — what the WORK is doing (idle/working/thinking/uploading/
//             finished/error). Drives motion and the narrated line. Never
//             changed by interactions.
//   face    — what the bot LOOKS like. The bot's own expression state
//             (stateForBot / flower poses), temporarily overridden by
//             interactions.
//   override— an interaction state (following/annoyed/slap/dizzy). Borrows
//             the face for a beat and decays; the status underneath is
//             untouched — the Novra coexistence rule.
//
// Everything here is pure and testable: timers are injected as `now`, and
// decay is data (untilStamps), not setTimeout, so the reducer stays
// deterministic under test.
import type { AgentMotion } from "@/lib/mascot";

export const WORK_STATUSES = [
  "idle",
  "working",
  "thinking",
  "uploading",
  "finished",
  "error",
] as const;
export type WorkStatus = (typeof WORK_STATUSES)[number];

export const INTERACTION_OVERRIDES = ["annoyed", "slapped", "dizzy"] as const;
export type InteractionOverride = (typeof INTERACTION_OVERRIDES)[number];

/** Faces borrowed while an override holds. Flower-pose vocabulary so both
 * the flower and blob bodies can render them; poseFor falls back to idle
 * for anything it does not know, and these are all known names. */
const OVERRIDE_FACE = {
  annoyed: "mad",
  slapped: "scared",
  dizzy: "unsure",
} as const satisfies Record<InteractionOverride, string>;

/** The narrated line rule: status ≠ idle always carries text. The task is
 * the caller's current one-liner (thread title, tool name, "Working…"). */
export function statusLine(status: WorkStatus, task: string | undefined): string {
  switch (status) {
    case "working":
      return task ? `Working — ${task}` : "Working";
    case "thinking":
      return task ? `Thinking about ${task}` : "Thinking";
    case "uploading":
      return task ? `Sending ${task}` : "Sending";
    case "finished":
      return task ? `Done — ${task}` : "Done";
    case "error":
      return task ? `Hit a problem — ${task}` : "Hit a problem";
    case "idle":
      return "";
  }
}

/** Motion suggestion per status: reuses the app's existing one-shot motion
 * vocabulary (AGENT_MOTIONS) so no new consumer code is needed. "none" means
 * the status's motion is CSS-ambient (the turn-tail shimmer, gaze) rather
 * than a one-shot beat. */
export const STATUS_MOTION = {
  idle: "none",
  working: "none",
  thinking: "thinking",
  uploading: "working",
  finished: "success",
  error: "failure",
} as const satisfies Record<WorkStatus, AgentMotion>;

export interface CharacterInput {
  status: WorkStatus;
  /** The bot's own face — an AgentState or flower pose name. */
  face: string;
  /** Active interaction override, already decayed by the caller. */
  override?: InteractionOverride | null;
  /** Narrated task line (optional; statusLine supplies a fallback). */
  task?: string;
  /** Calm mode: the owner's off switch. Interactions and antics off; the
   * character keeps truthful status faces. */
  calm?: boolean;
  /** prefers-reduced-motion: same as calm for motion, faces still resolve. */
  reducedMotion?: boolean;
}

export interface CharacterState {
  status: WorkStatus;
  /** Face to render right now. */
  face: string;
  /** Suggested one-shot motion for the status (consumers may ignore). */
  motion: AgentMotion;
  /** Narrated line — empty only when idle. */
  label: string;
  /** True when the caller should render the character still (calm or
   * reduced motion): no blink, no antics, no wobble. */
  still: boolean;
}

/**
 * Resolve the character for a render. The invariants, each asserted by
 * tests: an override borrows the face but NEVER changes status, motion or
 * label; calm/reducedMotion force still + no override face; idle has an
 * empty label; every non-idle status has a non-empty label.
 */
export function resolveCharacter(input: CharacterInput): CharacterState {
  const still = input.calm === true || input.reducedMotion === true;
  // A calm mascot ignores overrides entirely — the off switch means off.
  const override = still ? null : input.override;
  const face = override ? OVERRIDE_FACE[override] : input.face;
  return {
    status: input.status,
    face,
    motion: STATUS_MOTION[input.status],
    label: statusLine(input.status, input.task),
    still,
  };
}

// ── Interaction state machine ────────────────────────────────────────────
// Pokes and slaps chain: a poke squashes (CSS :active, no state), but three
// pokes within POKE_WINDOW annoys the character; a slap stuns ("slapped")
// then goes dizzy, then decays. All stamps are caller-injected so tests and
// future surfaces (tray, watch) drive time explicitly.

export const POKE_WINDOW_MS = 10_000;
export const POKES_TO_ANNOY = 3;
export const ANNOYED_HOLD_MS = 4_000;
export const SLAP_DIZZY_AFTER_MS = 1_500;
export const DIZZY_HOLD_MS = 2_500;

export interface InteractionState {
  override: InteractionOverride | null;
  /** Recent poke timestamps (epoch ms), pruned to the window. */
  pokes: number[];
  /** Epoch ms after which a timed override (annoyed/dizzy) has ended. */
  overrideUntil: number;
}

export const INITIAL_INTERACTION: InteractionState = {
  override: null,
  pokes: [],
  overrideUntil: 0,
};

function prunePokes(pokes: number[], now: number): number[] {
  return pokes.filter((at) => now - at < POKE_WINDOW_MS);
}

function timedOverride(
  state: InteractionState,
  override: InteractionOverride,
  until: number,
): InteractionState {
  return { ...state, override, overrideUntil: until };
}

/** The user poked the character (a click/tap/Space on it). */
export function poke(state: InteractionState, now: number): InteractionState {
  const pokes = [...prunePokes(state.pokes, now), now];
  if (pokes.length >= POKES_TO_ANNOY) {
    // Enough. The counter resets after the annoyed beat so one more poke
    // later starts a fresh chain rather than extending the grudge.
    return timedOverride({ override: null, pokes: [], overrideUntil: 0 }, "annoyed", now + ANNOYED_HOLD_MS);
  }
  return { ...state, pokes, override: null, overrideUntil: 0 };
}

/** The user slapped the character (a fast flick — double-click / shift-click). */
export function slap(_state: InteractionState, now: number): InteractionState {
  // A slap overrides any grudge: stunned first, dizzy right after, then it
  // decays on its own.
  return timedOverride({ override: null, pokes: [], overrideUntil: 0 }, "slapped", now + SLAP_DIZZY_AFTER_MS);
}

/** Advance time: expired overrides clear, and a slap hands off to dizzy. */
export function tickInteraction(state: InteractionState, now: number): InteractionState {
  if (state.override === "slapped" && now >= state.overrideUntil) {
    return timedOverride({ ...state }, "dizzy", now + DIZZY_HOLD_MS);
  }
  if (state.override && state.override !== "slapped" && now >= state.overrideUntil) {
    return { ...INITIAL_INTERACTION };
  }
  return state;
}

/** Derive the work status from the bot/activity facts callers already have.
 * Waiting-on-you is a working state whose TASK is the approval — the
 * character never errors on the owner's behalf. */
export function statusForBotActivity(bot: {
  busy?: boolean;
  unread?: boolean;
  activity?: string | null;
  lastToolFailed?: boolean;
}, streaming?: boolean): WorkStatus {
  if (bot.lastToolFailed) return "error";
  if (bot.busy) return streaming ? "thinking" : "working";
  if (bot.unread) return "finished";
  return "idle";
}
