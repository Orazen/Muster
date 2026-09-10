// The larger brand mascot. A real button owns the optional interaction;
// static marks and roster avatars reuse the same authored SVG underneath.
import { forwardRef, useState } from "react";
import { MusterMascot, MUSTER_ORANGE } from "./MusterMascot";

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
  const mascot = (
    <MusterMascot
      size={size}
      eyes={mood === "happy" ? "happy" : "open"}
      eyeOpenness={mood === "working" ? 0.82 : mood === "thinking" ? 0.9 : 1}
      label={interactive ? undefined : "Muster teammate"}
      animated={animated}
      reaction={interactive ? wave : 0}
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
          style={{ color: MUSTER_ORANGE, fontSize: size * 0.11, letterSpacing: "0.42em", fontWeight: 700 }}
        >
          MUSTER
        </span>
      )}
    </div>
  );
});
