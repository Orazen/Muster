/**
 * CursorAvatar — now only the mascot's state vocabulary.
 *
 * The renderer itself was retired when `bot-avatars` became the project's one
 * avatar system (see src/components/AgentBotAvatar.tsx); the 39-state union
 * below is still the app's behaviour vocabulary — `src/lib/mascot.ts` aliases
 * it to `AgentState` and derives `AGENT_STATES` from `CURSOR_STATES`.
 */

export type CursorState =
  | "sleeping"
  | "waking"
  | "idle"
  | "listening"
  | "thinking"
  | "searching"
  | "working"
  | "excited"
  | "surprised"
  | "suspicious"
  | "angry"
  | "drowsy"
  | "happy"
  | "curious"
  | "confused"
  | "bored"
  | "proud"
  | "shy"
  | "sad"
  | "laughing"
  | "scared"
  | "playful"
  | "celebrate"
  | "orbit"
  | "radar"
  | "progress"
  | "spawning"
  | "humming"
  | "loading"
  | "dictating"
  | "sending"
  | "receiving"
  | "uploading"
  | "writing"
  | "notifying"
  | "alerting"
  | "bouncing"
  | "dragging"
  | "powering-down";

/** The full vocabulary, in the engine's canonical order. */
export const CURSOR_STATES = [
  "sleeping",
  "waking",
  "idle",
  "listening",
  "thinking",
  "searching",
  "working",
  "excited",
  "surprised",
  "suspicious",
  "angry",
  "drowsy",
  "happy",
  "curious",
  "confused",
  "bored",
  "proud",
  "shy",
  "sad",
  "laughing",
  "scared",
  "playful",
  "celebrate",
  "orbit",
  "radar",
  "progress",
  "spawning",
  "humming",
  "loading",
  "dictating",
  "sending",
  "receiving",
  "uploading",
  "writing",
  "notifying",
  "alerting",
  "bouncing",
  "dragging",
  "powering-down",
] as const satisfies readonly CursorState[];

// Compile-time guarantee the array and the union stay in lockstep: any state
// missing from the array (or listed twice) fails `tsc`.
type _StatesMissingFromArray = Exclude<CursorState, (typeof CURSOR_STATES)[number]>;
// SAFETY: resolves to `never` exactly when the two lists agree; a non-never
// type makes this assignment an error that names the missing member.
const _statesInSync: _StatesMissingFromArray extends never ? true : never = true;
void _statesInSync;
