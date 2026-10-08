import type { AgentMotion, AgentState } from "../mascot";
// @ts-expect-error Pure approved JavaScript catalog is bundled locally, with no Three.js or browser dependency.
import { CREW as publicCrew } from "../../../www/landing-workroom/v1/mascot/crew.js";
// @ts-expect-error The shared 40-state face vocabulary is authored in JavaScript.
import { FACE_STATES } from "../../../www/landing-workroom/v1/mascot/expressions.js";

export const CREW_CHARACTERS = Object.freeze(["designer", "researcher", "developer", "coordinator"] as const);
export type CrewCharacter = (typeof CREW_CHARACTERS)[number];
/** thinking-dots is a local preview cue, not a new persisted activity value. */
export type CrewState = AgentState | "thinking-dots";

export interface CrewMember {
  readonly id: CrewCharacter;
  readonly name: string;
  readonly label: string;
  readonly color: string;
  readonly trim: string;
  readonly costume: string;
  readonly description: string;
  readonly workState: CrewState;
}

export const CREW: Readonly<Record<CrewCharacter, CrewMember>> = publicCrew;
export const CREW_STATES: readonly CrewState[] = FACE_STATES;

export function isCrewCharacter(value?: string | null): value is CrewCharacter {
  return CREW_CHARACTERS.some(character => character === value);
}

export function normalizeCrewState(value?: string | null): CrewState {
  return CREW_STATES.find(state => state === value) ?? "idle";
}

/** Preserve the event's expression for crew; the legacy adapter keeps its old three-state mapping. */
export function crewMotionState(motion: AgentMotion): CrewState | null {
  switch (motion) {
    case "arrive": return "waking";
    case "switch": return "curious";
    case "customize": return "proud";
    case "alert": return "alerting";
    case "thinking": return "thinking";
    case "working": return "working";
    case "launch": return "spawning";
    case "success":
    case "celebrate": return "celebrate";
    case "surprise": return "surprised";
    case "failure": return "sad";
    default: return null;
  }
}
