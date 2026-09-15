// Voice session controls — talking to the voice itself, not the bot.
//
// Vellum's sessionControls insight: a call needs a few words that change
// HOW the agent speaks without becoming a conversation turn. "Be quieter"
// must never reach the model. Each control is capability-tagged so the UI
// and tests can enumerate what a call understands; the recognizers match
// only whole leading phrases, so a sentence that merely mentions "faster"
// (or a bot named Faster) is routed normally.

export type SpeechControl = "quieter" | "louder" | "faster" | "slower" | "normal";

export interface SpeechControls {
  rate: number;
  volume: number;
}

export const DEFAULT_SPEECH_CONTROLS: SpeechControls = { rate: 1, volume: 1 };

/** Step sizes and bounds. Volume is perceptual enough in ~30% steps; rate
 * stays inside the range where the voice still sounds like itself. */
const STEPS: Record<Exclude<SpeechControl, "normal">, { key: keyof SpeechControls; factor: number; min: number; max: number }> = {
  quieter: { key: "volume", factor: 0.7, min: 0.2, max: 1 },
  louder: { key: "volume", factor: 1.3, min: 0.2, max: 1 },
  faster: { key: "rate", factor: 1.15, min: 0.7, max: 1.6 },
  slower: { key: "rate", factor: 0.87, min: 0.7, max: 1.6 },
};

const MATCHERS: Array<[SpeechControl, RegExp]> = [
  // "lower" only counts as quieter after speak/talk/turn-it — never as a bare
  // leading word, so "can you lower the price estimate?" stays a bot turn.
  ["quieter", /^\s*(be\s+|please\s+|can you\s+)?(speak\s+|talk\s+)?(quieter|softer)\b|^\s*(speak|talk|turn\s+it)\s+(quieter|softer|lower|down)\b/i],
  ["louder", /^\s*(be\s+|please\s+|can you\s+)?louder\b|^\s*(please\s+|can you\s+)?(speak|talk|turn\s+it)\s+up\b/i],
  ["faster", /^\s*(speak|talk|go)\s+faster\b|^\s*speed\s+up\b/i],
  ["slower", /^\s*(speak|talk|go)\s+slower\b|^\s*slow\s+down\b/i],
  ["normal", /^\s*(normal|back\s+to\s+normal|reset\s+(the\s+)?(speed|volume|voice))\b/i],
];

/** Short acknowledgements — spoken back so the control is confirmed by ear. */
export const CONTROL_ACKS: Record<SpeechControl, string> = {
  quieter: "Okay, quieter.",
  louder: "Okay, louder.",
  faster: "Okay, faster.",
  slower: "Okay, slower.",
  normal: "Okay, back to normal.",
};

/** Which controls a call understands (capability tags for UI/tests). */
export const SPEECH_CONTROL_CAPABILITIES: SpeechControl[] = ["quieter", "louder", "faster", "slower", "normal"];

export function matchSpeechControl(text: string): SpeechControl | null {
  for (const [control, re] of MATCHERS) if (re.test(text)) return control;
  return null;
}

/** Returns a NEW controls object — callers keep the old one for undo/logging. */
export function applySpeechControl(controls: SpeechControls, control: SpeechControl): SpeechControls {
  if (control === "normal") return { ...DEFAULT_SPEECH_CONTROLS };
  const step = STEPS[control];
  const next = controls[step.key] * step.factor;
  const clamped = Math.min(step.max, Math.max(step.min, next));
  return { ...controls, [step.key]: Math.round(clamped * 100) / 100 };
}
