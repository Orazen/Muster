// Voice-mode entry state — the first-run card's memory and the listening
// language override. Both live in localStorage (per browser, like the sidebar
// density preferences): they are presentation choices, not fleet state, and
// must survive the per-bot unmount that a composer does on every switch.

const FIRST_RUN_KEY = (botId: string) => `muster:voice-first-run:v1:${encodeURIComponent(botId)}`;
const LISTENING_LANG_KEY = "muster:listening-language:v1";

/** Vellum's rule: dismissing the card (Escape/backdrop/✕) is a plain cancel —
 * the first run stays un-consumed and the card returns next time. Only
 * committing via "Start talking" marks it seen. */
export function voiceFirstRunSeen(botId: string): boolean {
  try {
    return localStorage.getItem(FIRST_RUN_KEY(botId)) === "1";
  } catch {
    return false;
  }
}

export function markVoiceFirstRunSeen(botId: string): void {
  try {
    localStorage.setItem(FIRST_RUN_KEY(botId), "1");
  } catch {
    // private-mode storage failures must never block starting a call
  }
}

/** A browser tag the recognizer should listen for, or null for "whatever the
 * browser defaults to" (its own locale). A wrong STT language is broken rather
 * than suboptimal — that is why the first-run card surfaces this one setting
 * before the first session; everything else can wait for Settings. */
export function getListeningLanguage(): string | null {
  try {
    const v = localStorage.getItem(LISTENING_LANG_KEY);
    return v && LANG_TAG.test(v) ? v : null;
  } catch {
    return null;
  }
}

export function setListeningLanguage(tag: string | null): void {
  try {
    if (tag === null) localStorage.removeItem(LISTENING_LANG_KEY);
    else if (LANG_TAG.test(tag)) localStorage.setItem(LISTENING_LANG_KEY, tag);
  } catch {
    // same honest degradation: the default stays in effect
  }
}

// BCP-47-ish: letters, digits, dashes — no wildcards, no length runs.
const LANG_TAG = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/;

/** The picker's catalog: the languages browser SpeechRecognition reliably
 * supports across Chrome/Safari/Edge, labelled in English the way every
 * picker in this app is. */
export const LISTENING_LANGUAGES: Array<{ tag: string; label: string }> = [
  { tag: "en-US", label: "English (US)" },
  { tag: "en-GB", label: "English (UK)" },
  { tag: "en-IN", label: "English (India)" },
  { tag: "it-IT", label: "Italian" },
  { tag: "de-DE", label: "German" },
  { tag: "fr-FR", label: "French" },
  { tag: "es-ES", label: "Spanish" },
  { tag: "pt-BR", label: "Portuguese (Brazil)" },
  { tag: "hi-IN", label: "Hindi" },
  { tag: "ta-IN", label: "Tamil" },
  { tag: "ja-JP", label: "Japanese" },
  { tag: "ko-KR", label: "Korean" },
  { tag: "zh-CN", label: "Chinese (Mandarin)" },
];

export function listeningLanguageLabel(tag: string | null): string {
  if (!tag) return "Auto (browser language)";
  const hit = LISTENING_LANGUAGES.find((l) => l.tag === tag);
  return hit ? hit.label : tag;
}
