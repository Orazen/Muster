// FlowerCharacter — the interactive mascot wrapper (plan slice B).
// Composes the pure reducer (src/lib/mascot/character.ts) with the app's
// existing avatar: clicks/taps poke it, a fast double-click or shift-click
// slaps it, three pokes in ten seconds annoy it, a slap stuns then goes
// dizzy. The wrapper owns the decay timers — one timeout scheduled only
// while an override is pending, none otherwise — and exposes the state for
// tests and the calm setting for callers.
//
// Accessibility: the character is a real button. Keyboard users press
// Space/Enter to "wave" (the same gentle greeting the old mascot button
// had); pokes and slaps are pointer-only richness on top. Reduced-motion
// users still get the truthful status face, just no wobble.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./flower-character.css";
import { AgentAvatar } from "@/components/Avatar";
import type { AgentCharacter, AgentColor, AgentState } from "@/lib/mascot";
import {
  INITIAL_INTERACTION,
  type CharacterState,
  type InteractionOverride,
  type InteractionState,
  poke,
  resolveCharacter,
  slap,
  tickInteraction,
} from "@/lib/mascot/character";

/** Which character carries interactions by default: the chat's own flower. */
export type CharacterBody = AgentCharacter;

interface FlowerCharacterProps {
  color: AgentColor;
  character?: CharacterBody;
  /** The bot's own expression state (stateForBot's output or a pinned one). */
  state: AgentState;
  /** Work status; when omitted it derives as idle — interactions still work. */
  status?: CharacterState["status"];
  /** Narrated task line for non-idle statuses. */
  task?: string;
  /** Calm mode: interactions and antics off. Persisted by the caller. */
  calm?: boolean;
  size?: number;
  label?: string;
  /** Existing one-shot motion beat (turn-tail/store driven). */
  motion?: "none" | import("@/lib/mascot").AgentMotion;
  motionKey?: number;
  /** Renders the narrated line under the face when true (collapsed surfaces). */
  withLabel?: boolean;
  /** Keyboard-focusable (default). Decorative-guide callers set false so the
   * character keeps pointer play without entering the tab order ahead of a
   * surface's own first field (the onboarding wizard's focus contract). */
  focusable?: boolean;
  /** Called on poke/slap for callers that want receipts (tests, telemetry-free logs). */
  onReact?: (reaction: "poked" | "slapped" | "annoyed" | "dizzy") => void;
}

function nextTimeoutMs(state: InteractionState): number | null {
  if (!state.override || state.overrideUntil <= 0) return null;
  return Math.max(0, state.overrideUntil - Date.now());
}

export function FlowerCharacter({
  color,
  character = "flower",
  state,
  status = "idle",
  task,
  calm = false,
  size = 44,
  label,
  motion = "none",
  motionKey = 0,
  withLabel = false,
  focusable = true,
  onReact,
}: FlowerCharacterProps) {
  const [interaction, setInteraction] = useState<InteractionState>(INITIAL_INTERACTION);
  const timerRef = useRef<number | null>(null);
  // Keep the latest callback without making the decay timer churn on rerenders.
  const reactRef = useRef(onReact);
  reactRef.current = onReact;

  const scheduleDecay = useCallback((next: InteractionState) => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const ms = nextTimeoutMs(next);
    if (ms === null) return;
    timerRef.current = window.setTimeout(() => {
      setInteraction((current) => {
        const advanced = tickInteraction(current, Date.now());
        // The slap → dizzy hand-off happens exactly here; report it once.
        if (advanced.override === "dizzy" && current.override === "slapped") {
          reactRef.current?.("dizzy");
        }
        return advanced;
      });
    }, ms);
  }, []);

  useEffect(() => {
    scheduleDecay(interaction);
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, [interaction, scheduleDecay]);

  const fire = (reaction: "poked" | "slapped" | "annoyed" | "dizzy") => {
    onReact?.(reaction);
  };

  const onPoke = () => {
    if (calm) return;
    setInteraction((current) => {
      const before = current.override;
      const next = tickInteraction(poke(current, Date.now()), Date.now());
      if (next.override === "annoyed" && before !== "annoyed") fire("annoyed");
      else fire("poked");
      return next;
    });
  };

  const onSlap = () => {
    if (calm) return;
    fire("slapped");
    setInteraction((current) => tickInteraction(slap(current, Date.now()), Date.now()));
  };

  const resolved = useMemo(
    () => resolveCharacter({ status, face: state, override: interaction.override, task, calm }),
    [status, state, interaction.override, task, calm],
  );

  // Idle antics — what the character does when nothing is happening. Only
  // when truly idle, not calm, and motion is welcome: a small stretch every
  // 25-45s (randomized so two mascots never sync). The blink already comes
  // from the shared FlowerBot animation; this adds the occasional fidget.
  const [antic, setAntic] = useState(false);
  useEffect(() => {
    if (calm || status !== "idle") return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    let timer: number | undefined;
    let clearTimer: number | undefined;
    const schedule = () => {
      timer = window.setTimeout(() => {
        setAntic(true);
        clearTimer = window.setTimeout(() => {
          setAntic(false);
          schedule();
        }, 900);
      }, 25_000 + Math.floor(Math.random() * 20_000));
    };
    schedule();
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(clearTimer);
    };
  }, [calm, status]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();
    // Keyboard = the gentle path: a wave-beat, not a poke. Never annoys.
    if (calm) return;
    fire("poked");
  };

  // SAFETY: faces emitted by resolveCharacter are AgentState members —
  // the reducer's OVERRIDE_FACE values and the callers' `state` prop both
  // come from the mascot vocabulary — but the reducer's contract is the
  // wider string union that flower poses also satisfy.
  const face = resolved.face as AgentState;

  return (
    <span
      className="flower-character inline-flex flex-col items-center gap-1"
      data-testid="flower-character"
      data-calm={calm || undefined}
      data-antic={antic || undefined}
      data-status={resolved.status}
      data-override={interaction.override ?? undefined}
    >
      <button
        type="button"
        tabIndex={focusable ? 0 : -1}
        aria-label={label ? `${label} — poke to say hi, shift-click to slap` : "Mascot"}
        className="bot-host cursor-default rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent"
        onPointerDown={(event) => {
          if (event.shiftKey || event.detail >= 2) onSlap();
          else onPoke();
        }}
        onKeyDown={handleKeyDown}
      >
        <AgentAvatar
          character={character}
          color={color}
          state={face}
          size={size}
          label={undefined}
          motion={motion}
          motionKey={motionKey}
        />
      </button>
      {withLabel && resolved.label && (
        <span className="max-w-56 truncate text-center text-[12px] text-ink-secondary" aria-live="polite">
          {resolved.label}
        </span>
      )}
      {/* The status narration lives in the caller's visible UI (turn tail,
          header); this live region covers interactions only, which have no
          other text. */}
      <span className="sr-only" aria-live="polite">
        {interaction.override === "annoyed"
          ? "The mascot is annoyed"
          : interaction.override === "slapped"
            ? "The mascot is stunned"
            : interaction.override === "dizzy"
              ? "The mascot is dizzy"
              : ""}
      </span>
      <HiddenReceipt root={interaction.override} />
    </span>
  );
}

/** Test hook: exposes the override without rendering anything visible. */
function HiddenReceipt({ root }: { root: InteractionOverride | null }) {
  return root ? <span data-override-receipt={root} className="hidden" /> : null;
}
