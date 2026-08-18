// LottieCharacter — the Muster bot character rendered from a .lottie asset.
//
// A second, selectable "character" alongside the procedural CursorAvatar.
// The asset ships a state machine (idle / hover scale → hover loop / click →
// fail) that this component drives from inputs the rest of the app already
// produces:
//   - "idle"     → the character's idle loop
//   - busy       → a periodic "click" beat so it visibly stays active
//   - "sleeping" → paused on the idle resting frame
//
// Interactions ride the state machine:
//   - hover sets the `isHovered` boolean input (scale → hover loop)
//   - click fires the `clickEvent` named event (click → fail → idle)
//
// The dotlottie WASM engine is served from /dotlottie-player.wasm (bundled in
// public/) via setWasmUrl so the desktop app stays fully offline-first.

import { memo, useEffect, useRef, useState } from "react";
import { DotLottieReact, setWasmUrl, type DotLottie } from "@lottiefiles/dotlottie-react";

import type { AgentState } from "@/lib/mascot";

/** Serve the WASM engine from our own static dir, never a CDN. */
setWasmUrl("/dotlottie-player.wasm");

const ANIMATION_SRC = "/muster-character.lottie";
const STATE_MACHINE_ID = "StateMachine1";

/** The state-machine named event that runs the click → fail → idle beat. */
const CLICK_EVENT = "clickEvent";

/**
 * Bot states that keep the character visibly busy rather than idling. The
 * character has no per-expression morphs, so we compress the app's rich state
 * vocabulary into three beats: idle, busy, and asleep.
 */
const BUSY_STATES = new Set<AgentState>([
  "working",
  "thinking",
  "searching",
  "loading",
  "writing",
  "sending",
  "receiving",
  "uploading",
  "dictating",
  "listening",
  "alerting",
  "notifying",
  "spawning",
  "humming",
]);

const SLEEP_STATES = new Set<AgentState>(["sleeping", "powering-down"]);

export interface LottieCharacterProps {
  state?: AgentState;
  size?: number;
  /** Run the animation. Off pauses on the idle resting frame. */
  animated?: boolean;
  /** Whether hover/click should drive the state machine. */
  interactive?: boolean;
  /** Accessible label, used for the aria role. */
  label?: string;
  className?: string;
}

function LottieCharacterComponent({
  state = "idle",
  size = 44,
  animated = true,
  interactive = true,
  label,
  className,
}: LottieCharacterProps) {
  const [dotLottie, setDotLottie] = useState<DotLottie | null>(null);
  const hovering = useRef(false);

  const busy = BUSY_STATES.has(state);
  const asleep = SLEEP_STATES.has(state);

  // Keep the state machine's `isHovered` input in sync with the pointer.
  const setHovering = (next: boolean) => {
    hovering.current = next;
    dotLottie?.stateMachineSetBooleanInput("isHovered", next);
  };

  const tap = () => {
    setHovering(false);
    dotLottie?.stateMachineFireEvent(CLICK_EVENT);
  };

  // While busy, fire a click beat on entry and then on a gentle cadence so the
  // character keeps looking alive instead of freezing on idle.
  useEffect(() => {
    if (!animated || asleep || !dotLottie) return;
    if (!busy) return;
    dotLottie.stateMachineFireEvent(CLICK_EVENT);
    const id = window.setInterval(() => {
      if (hovering.current) return; // don't fight the hover loop
      dotLottie.stateMachineFireEvent(CLICK_EVENT);
    }, 2400);
    return () => window.clearInterval(id);
  }, [busy, asleep, animated, dotLottie]);

  // Pause/resume to honour `animated` (and to stop the idle loop when asleep).
  useEffect(() => {
    if (!dotLottie) return;
    if (!animated || asleep) dotLottie.pause();
    else dotLottie.play();
  }, [animated, asleep, dotLottie]);

  return (
    <DotLottieReact
      src={ANIMATION_SRC}
      stateMachineId={STATE_MACHINE_ID}
      autoplay
      loop
      className={className}
      style={{ width: size, height: size }}
      dotLottieRefCallback={setDotLottie}
      onMouseEnter={() => interactive && setHovering(true)}
      onMouseLeave={() => interactive && setHovering(false)}
      onClick={() => interactive && tap()}
      role={label ? "img" : undefined}
      aria-label={label}
    />
  );
}

export const LottieCharacter = memo(LottieCharacterComponent);
