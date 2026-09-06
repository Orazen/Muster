import { Loader2, Square, Volume2 } from "lucide-react";

import { speaker } from "@/lib/tts";
import { useSpeech } from "@/lib/tts/useSpeech";
import { useStore } from "@/state/store";
import { cn } from "@/lib/cn";

/** Read one message aloud. Hover-revealed beside the copy control, and it
 * becomes a stop button while this message is the one speaking — the same
 * button, because "speak" and "shut up" are the same intent twice.
 *
 * Works with ZERO keys: without ElevenLabs the speaker falls back to the
 * browser's built-in voice (free, offline), so the button is always live
 * wherever the Web Speech API exists. */
export function SpeakButton({
  text,
  botId,
  messageId,
  voiceId,
  className,
}: {
  text: string;
  botId?: string;
  messageId: string;
  voiceId?: string;
  className?: string;
}) {
  const { state } = useStore();
  const speech = useSpeech();
  // capability probe of a window global, not input shaping
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  const hasNativeVoice = typeof window !== "undefined" && "speechSynthesis" in window;
  const ready =
    Boolean(state.config?.tts?.ready) || hasNativeVoice;
  const native = ready && !state.config?.tts?.ready; // free browser voice
  const mine = speech.messageId === messageId && speech.status !== "idle";
  const preparing = mine && speech.status === "preparing";

  const label = mine
    ? "Stop speaking"
    : native
      ? "Read this aloud (browser voice)"
      : ready
        ? "Read this aloud"
        : "Voice is not available in this browser";
  return (
    <button
      onClick={() => {
        if (mine) return speaker.stop();
        void speaker.speak(text, { botId, messageId, voiceId });
      }}
      disabled={!ready}
      aria-label={label}
      title={label}
      className={cn(
        "rounded-md p-1.5 text-ink-secondary transition-opacity hover:bg-raised hover:text-ink focus-visible:opacity-100 group-focus-within:opacity-100 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-ink-secondary",
        // stays visible while speaking — a stop button you have to hunt for
        // is not a stop button
        mine ? "text-accent opacity-100" : "opacity-0 group-hover:opacity-100",
        className,
      )}
    >
      {preparing ? <Loader2 size={14} className="animate-spin" /> : mine ? <Square size={14} className="fill-current" /> : <Volume2 size={14} />}
    </button>
  );
}
