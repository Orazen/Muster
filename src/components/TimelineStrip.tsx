import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Check, Loader2, X } from "lucide-react";
import type { Bot, Message } from "@/state/store";
import { elapsedSince, timelineActions } from "@/lib/turn-timeline";
import { cn } from "@/lib/cn";

/** Execution timeline: a horizontal strip of the bot's most recent actions,
 * shown above the composer only while a turn is running. Idle renders
 * nothing — zero layout shift. Data is the same live activity messages the
 * thread already streams (tool.ok unset = still running), so there is no
 * second source of truth to drift. */
export function TimelineStrip({ bot, messages }: { bot: Bot; messages: readonly Message[] }) {
  const actions = timelineActions(messages);
  // a 1s tick keeps the running chip's duration-so-far honest; it exists
  // only while the turn does, so idle costs nothing.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!bot.busy) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [bot.busy]);
  // Reduced motion: no pulse, no entrance — the strip just is.
  const reduced = useReducedMotion();
  if (!bot.busy || actions.length === 0) return null;
  return (
    <motion.div
      initial={reduced ? false : { opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      aria-label="Recent actions"
      className="mx-auto flex w-full max-w-[860px] items-center gap-1.5 overflow-hidden px-5 pb-1.5"
    >
      {actions.map((a, i) => (
        <div
          key={a.id}
          className={cn(
            "flex shrink-0 items-center gap-1.5 rounded-full border border-hairline/40 bg-panel px-2.5 py-1 text-[12px]",
            a.failed ? "text-danger" : "text-ink-secondary",
            // newest action gets the pulse; everything older sits still
            i === 0 && !reduced && "timeline-pulse",
          )}
          title={i === 0 && a.running ? `${a.name} — ${elapsedSince(a.at, now)}` : a.name}
        >
          {a.running ? (
            <Loader2 size={11} className="animate-spin" />
          ) : a.failed ? (
            <X size={11} />
          ) : (
            <Check size={11} className="text-success" />
          )}
          <span className="max-w-[180px] truncate font-mono">{a.name}</span>
          {a.running && <span className="shrink-0 tabular-nums text-[10.5px] opacity-70">{elapsedSince(a.at, now)}</span>}
        </div>
      ))}
    </motion.div>
  );
}
