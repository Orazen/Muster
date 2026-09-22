// The larger brand mascot, in the musterbot blob style. A real button owns
// the optional interaction; static marks and roster avatars reuse the same
// authored mark underneath (see src/lib/musterbot — canonical source in the
// Orazen/musterbot repo).
import { forwardRef, useState } from "react";
import { MusterBotMark, MUSTERBOT_ORANGE } from "@/lib/musterbot";
import "./muster-mascot.css";

export type BloomMood = "idle" | "working" | "thinking" | "happy";

export const MusterBloom = forwardRef<
  HTMLDivElement,
  {
    size?: number;
    wordmark?: boolean;
    mood?: BloomMood;
    /** Adds a keyboard-accessible wave button. Defaults to true. */
    interactive?: boolean;
    /** Ambient motion; defaults to the interactive setting. */
    animated?: boolean;
    className?: string;
  }
>(function MusterBloom(
  { size = 250, wordmark = false, mood = "idle", interactive = true, animated = interactive, className },
  ref,
) {
  const [wave, setWave] = useState(0);
  const eyes = wave || mood === "happy" ? "happy" : "open";
  const mascot = (
    <MusterBotMark
      size={size}
      eyes={eyes}
      label={interactive ? undefined : "Muster teammate"}
      animated={animated || wave > 0}
    />
  );

  return (
    <div ref={ref} className={`muster-bloom ${className ?? ""}`}>
      {interactive ? (
        <button
          type="button"
          className="muster-bloom__button"
          aria-label="Wave to Muster"
          onClick={() => setWave((previous) => previous === 1 ? 2 : 1)}
        >
          {mascot}
        </button>
      ) : mascot}
      {interactive && <span className="sr-only" role="status">{wave ? "Hello from Muster." : ""}</span>}
      {wordmark && (
        <span
          aria-hidden="true"
          style={{ color: MUSTERBOT_ORANGE, fontSize: size * 0.11, letterSpacing: "0.42em", fontWeight: 700 }}
        >
          MUSTER
        </span>
      )}
    </div>
  );
});
