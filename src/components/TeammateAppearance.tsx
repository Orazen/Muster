import { useLayoutEffect, useRef, useState } from "react";
import { Check, RotateCcw } from "lucide-react";
import { AgentBotAvatar } from "./AgentBotAvatar";
import { Button } from "./ui/button";
import { AGENT_CHARACTERS, AGENT_COLOR_NAMES, AGENT_COLORS, type AgentCharacter, type AgentColor, type AgentState } from "@/lib/mascot";
import { CREW, CREW_STATES, isCrewCharacter, normalizeCrewState, type CrewState } from "@/lib/mascot/crew";
import { cn } from "@/lib/cn";

const previews = [
  { state: "idle", label: "Ready" },
  { state: "working", label: "Working" },
  { state: "sleeping", label: "Resting" },
] as const;

/** Identity edits use the existing account/draft owner. Motion previews stay
 * local: exploring a pose must never change a bot's actual activity or profile. */
export function TeammateAppearance({
  name, title, character = "flower", color, state = "idle", seed, onChange, onReset,
}: {
  name: string;
  title?: string;
  character?: AgentCharacter;
  color: AgentColor;
  state?: AgentState;
  seed?: string;
  onChange: (patch: { character?: AgentCharacter; color?: AgentColor }) => void;
  onReset?: () => void;
}) {
  const [preview, setPreview] = useState<CrewState | null>(null);
  const crew = isCrewCharacter(character);
  const stripRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const strip = stripRef.current;
    const selected = strip?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!strip || !selected) return;
    // Scroll only the character strip; never pull the whole setup page away
    // from the user's current field when a saved identity is restored.
    const box = strip.getBoundingClientRect(), choice = selected.getBoundingClientRect();
    strip.scrollLeft += choice.left - box.left - (box.width - choice.width) / 2;
  }, [character]);
  return (
    <section aria-label="Teammate appearance" className="w-full min-w-0 overflow-hidden rounded-2xl border border-hairline/40 bg-card">
      <div className="flex items-center justify-between gap-2 px-4 pt-3">
        <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-ink-secondary">Make it yours</span>
        {onReset && <Button variant="ghost" size="sm" type="button" onClick={() => { setPreview(null); onReset(); }} className="min-h-11 gap-1.5 px-2 text-[12px] text-ink-secondary" aria-label="Reset mascot appearance">
          <RotateCcw size={12} aria-hidden="true" /> Reset
        </Button>}
      </div>
      <div className="relative flex flex-col items-center px-4 pb-3 pt-1">
        <div className="relative flex h-40 w-full items-center justify-center overflow-hidden" data-testid="bot-avatar-preview">
          <span aria-hidden="true" className="absolute size-28 rounded-full" style={{ background: `radial-gradient(circle, ${AGENT_COLORS[color]}24, transparent 72%)` }} />
          <AgentBotAvatar character={character} color={color} state={!crew && preview === "thinking-dots" ? state : preview ?? state} seed={seed} size={128} label={`${name.trim() || "Your teammate"}, mascot preview`} interactive />
        </div>
        <p className="max-w-full break-words text-center text-[17px] font-semibold text-ink">{name.trim() || "Your teammate"}</p>
        {title?.trim() && <p className="mt-0.5 max-w-full break-words text-center text-[12px] text-ink-secondary">{title.trim()}</p>}
        <fieldset className="mt-3 flex min-w-0 flex-wrap justify-center gap-1 rounded-xl bg-inset p-1">
          <legend className="sr-only">Preview mascot motion</legend>
          {previews.map(item => <Button key={item.state} variant={preview === item.state ? "secondary" : "ghost"} size="sm" type="button" aria-pressed={preview === item.state} onClick={() => setPreview(preview === item.state ? null : item.state)} className="min-h-11 px-3 text-[12px]">
            {item.label}
          </Button>)}
        </fieldset>
        {crew && <label className="mt-2 flex max-w-full flex-wrap items-center justify-center gap-2 text-[12px] text-ink-secondary">
          <span>Explore expressions</span>
          <select aria-label="Preview crew expression" value={preview ?? ""} onChange={event => setPreview(event.target.value ? normalizeCrewState(event.target.value) : null)} className="min-h-11 max-w-full rounded-lg border border-hairline bg-inset px-2 text-ink focus-visible:outline-2 focus-visible:outline-focus">
            <option value="">Follow current activity</option>
            {CREW_STATES.map(cue => <option key={cue} value={cue}>{cue.replaceAll("-", " ")}</option>)}
          </select>
        </label>}
        <p className="mt-1.5 text-center text-[11px] text-ink-secondary" role="status">{preview ? (crew ? "Expression preview only · choose current activity to return" : "Motion preview only · tap again to return") : "Preview a motion without changing your bot"}</p>
      </div>
      <div className="border-t border-hairline/40 px-3 py-3">
        <div className="mb-2 flex items-center justify-between gap-2 text-[12px]">
          <span className="font-medium text-ink">Character</span>
          <span className="capitalize text-ink-secondary">{character === "lottie" ? "Saved character" : character}</span>
        </div>
        <fieldset className="min-w-0">
          <legend className="sr-only">Mascot character</legend>
          <div ref={stripRef} className="flex gap-1.5 overflow-x-auto pb-2 pt-1" tabIndex={0} aria-label="Scroll mascot characters">
            {AGENT_CHARACTERS.map(choice => <Button key={choice} variant="outline" type="button" aria-label={`Use the ${choice} character`} aria-pressed={choice === character} onClick={() => { setPreview(null); onChange({ character: choice }); }} className={cn("h-auto w-[66px] shrink-0 flex-col gap-1 rounded-xl px-1 py-2", choice === character ? "border-accent bg-accent/10 text-ink" : "border-transparent bg-inset text-ink-secondary hover:bg-raised")}>
              <AgentBotAvatar character={choice} color={color} seed={seed} size={36} animated={false} className="pointer-events-none" />
              <span className="max-w-full truncate text-[10px] capitalize">{isCrewCharacter(choice) ? CREW[choice].label : choice}</span>
            </Button>)}
          </div>
        </fieldset>
        <fieldset className="mt-2 min-w-0">
          <legend className="text-[12px] font-medium text-ink">Colour <span className="ml-1 font-normal capitalize text-ink-secondary">{color}</span></legend>
          <div className="mt-1 flex flex-wrap gap-0.5">
            {AGENT_COLOR_NAMES.map(choice => <button key={choice} type="button" aria-label={`Use ${choice} mascot color`} aria-pressed={choice === color} onClick={() => onChange({ color: choice })} className="flex size-11 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-focus">
              <span className={cn("flex size-7 items-center justify-center rounded-full border border-black/10 transition-transform", choice === color && "ring-2 ring-ink ring-offset-2 ring-offset-card")} style={{ backgroundColor: AGENT_COLORS[choice] }}>
                {choice === color && <Check size={15} className="text-black" strokeWidth={3} aria-hidden="true" />}
              </span>
            </button>)}
          </div>
        </fieldset>
      </div>
    </section>
  );
}
