// Voice mode first-run card — the Vellum entry point.
//
// A one-time welcome shown the first time a bot enters voice mode, before the
// session starts. Deliberately NOT a settings quiz: the defaults work, so the
// card sets expectations and starts. The two sanctioned exceptions mirror
// Vellum's reasoning — the assistant's voice (the thing people come to change,
// hot-applies on the next reply) and the listening language (a wrong STT
// language is broken, not suboptimal, so it is the one default worth surfacing
// before the first spoken turn).
//
// The settings are VIEWS of this one dialog, never stacked modals; width is
// held constant so navigating doesn't resize the card under the cursor. Escape
// inside a sub-view goes back to the intro; on the intro it is a plain cancel
// that leaves the first run UN-consumed — only "Start talking" commits it.

import { useEffect, useState } from "react";
import { ArrowLeft, AudioLines, Captions, Languages, MicOff, Settings } from "lucide-react";

import { api, useStore, type Bot } from "@/state/store";
import {
  getListeningLanguage,
  LISTENING_LANGUAGES,
  listeningLanguageLabel,
  setListeningLanguage,
} from "@/lib/voice-first-run";
import { normalizeState } from "@/lib/mascot";
import { cn } from "@/lib/cn";
import { AgentAvatar } from "./Avatar";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

type View = "intro" | "settings" | "language";

export function VoiceFirstRunCard({
  bot,
  open,
  onStart,
  onDismiss,
  onPickVoice,
}: {
  bot: Bot;
  open: boolean;
  /** Commit: enter voice mode. The caller marks the first run seen here. */
  onStart: () => void;
  /** Cancel without starting — the card will return on the next entry. */
  onDismiss: () => void;
  /** Persist a per-bot voice choice (hot-applies on the next spoken reply). */
  onPickVoice: (voice: string) => void;
}) {
  const { state } = useStore();
  const [view, setView] = useState<View>("intro");
  const [languageReturn, setLanguageReturn] = useState<"intro" | "settings">("intro");
  const [voices, setVoices] = useState<Array<{ id: string; label: string; description?: string }>>([]);
  const [language, setLanguage] = useState<string | null>(() => getListeningLanguage());
  const voiceConfig = state.config?.tts ?? null;

  // Reset to the intro whenever the card is reopened.
  useEffect(() => {
    if (open) setView("intro");
  }, [open]);

  // The voice list is only needed once the settings view is open — and only
  // for installs that actually have an ElevenLabs key (everywhere else the
  // free built-in voice is the honest note).
  useEffect(() => {
    if (!open || !voiceConfig?.configured) return;
    let alive = true;
    api("/api/tts/voices")
      .then((r: { voices?: Array<{ id: string; label: string; description?: string }>; error?: string }) => {
        if (alive) setVoices(r.voices ?? []);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [open, voiceConfig?.configured]);

  const pickLanguage = (tag: string | null) => {
    setListeningLanguage(tag);
    setLanguage(tag);
    setView(languageReturn); // hot-applies from the next spoken turn — no Save
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) return;
        // Radix escape / backdrop / ✕ all route here. In a sub-view a close
        // request means "back", never "cancel"; on the intro it is a plain
        // cancel that leaves the first run un-consumed.
        if (view !== "intro") setView(view === "language" ? languageReturn : "intro");
        else onDismiss();
      }}
    >
      <DialogContent className="max-w-[520px]">
        {view === "intro" && (
          <>
            <DialogHeader>
              <div className="flex items-center gap-3">
                <span className="shrink-0">
                  <AgentAvatar
                    character={bot.character}
                    color={bot.color}
                    state={normalizeState(bot.mascotExpression) ?? "happy"}
                    size={44}
                  />
                </span>
                <div className="flex min-w-0 flex-col">
                  <DialogTitle className="leading-tight">Voice mode</DialogTitle>
                  <DialogDescription>A hands-free, spoken conversation with {bot.name}.</DialogDescription>
                </div>
              </div>
            </DialogHeader>
            <div className="flex flex-col gap-4 pt-4">
              {/* Each bullet's icon matches the in-session control it describes,
                  so the card doubles as a legend for the call room. */}
              <ul className="flex flex-col gap-4">
                <li className="flex items-start gap-2.5 text-[14px] text-ink">
                  <AudioLines aria-hidden className="mt-0.5 size-4 shrink-0 text-ink-secondary" />
                  <span>Speak naturally and {bot.name} replies out loud.</span>
                </li>
                <li className="flex items-start gap-2.5 text-[14px] text-ink">
                  <MicOff aria-hidden className="mt-0.5 size-4 shrink-0 text-ink-secondary" />
                  <span>Mute the mic without ending the session.</span>
                </li>
                <li className="flex items-start gap-2.5 text-[14px] text-ink">
                  <Captions aria-hidden className="mt-0.5 size-4 shrink-0 text-ink-secondary" />
                  <span>Turn on live captions anytime.</span>
                </li>
              </ul>
              <button
                type="button"
                onClick={() => {
                  setLanguageReturn("intro");
                  setView("language");
                }}
                className="flex items-center justify-between gap-3 rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-left text-[14px] text-ink transition-colors hover:bg-raised"
              >
                <span className="flex items-center gap-2.5">
                  <Languages aria-hidden className="size-4 shrink-0 text-ink-secondary" />
                  Listening language
                </span>
                <span className="text-[13px] text-ink-secondary">{listeningLanguageLabel(language)} ›</span>
              </button>
            </div>
            <DialogFooter className="items-center justify-between gap-3">
              {/* A destination, not a task: the gear is the same control the
                  room uses, so the card previews the affordance met a moment
                  later. Quiet by design — it must not compete with Start. */}
              <button
                type="button"
                onClick={() => setView("settings")}
                className="flex cursor-pointer items-center gap-1.5 rounded text-[12.5px] text-ink-secondary transition-colors hover:text-ink"
              >
                <Settings aria-hidden className="size-3.5 shrink-0" />
                Voice settings
              </button>
              <StartButton onClick={onStart} />
            </DialogFooter>
          </>
        )}

        {view === "settings" && (
          <>
            <DialogHeader>
              <div className="flex items-center gap-2">
                <BackButton onClick={() => setView("intro")} />
                <div className="flex min-w-0 flex-col">
                  <DialogTitle className="leading-tight">Voice settings</DialogTitle>
                  <DialogDescription>Applies from the next spoken reply — nothing to save.</DialogDescription>
                </div>
              </div>
            </DialogHeader>
            <div className="flex flex-col gap-4 pt-4">
              <button
                type="button"
                onClick={() => {
                  setLanguageReturn("settings");
                  setView("language");
                }}
                className="flex items-center justify-between gap-3 rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-left text-[14px] text-ink transition-colors hover:bg-raised"
              >
                <span className="flex items-center gap-2.5">
                  <Languages aria-hidden className="size-4 shrink-0 text-ink-secondary" />
                  Listening language
                </span>
                <span className="text-[13px] text-ink-secondary">{listeningLanguageLabel(language)} ›</span>
              </button>
              {voiceConfig?.configured ? (
                <div>
                  <div className="mb-1.5 text-[13px] text-ink-secondary">Voice</div>
                  <select
                    value={bot.voice ?? ""}
                    onChange={(e) => onPickVoice(e.target.value)}
                    aria-label={`${bot.name}'s voice`}
                    className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink focus:border-hairline focus:outline-none"
                  >
                    <option value="">App default — {voiceConfig.voice || "built-in voice"}</option>
                    {bot.voice && !voices.some((v) => v.id === bot.voice) && <option value={bot.voice}>Current bot voice</option>}
                    {voices.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.label}
                        {v.description ? ` — ${v.description}` : ""}
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <div className="rounded-lg bg-inset px-3 py-2.5 text-[13px] text-ink-secondary">
                  The free built-in voice is active. Add an ElevenLabs key under Settings → Voice to pick
                  from studio voices.
                </div>
              )}
            </div>
            <DialogFooter className="items-center justify-between gap-3">
              <span className="text-[12px] text-ink-secondary">Heard instantly on the next reply.</span>
              <StartButton onClick={onStart} />
            </DialogFooter>
          </>
        )}

        {view === "language" && (
          <>
            <DialogHeader>
              <div className="flex items-center gap-2">
                <BackButton onClick={() => setView(languageReturn)} />
                <div className="flex min-w-0 flex-col">
                  <DialogTitle className="leading-tight">Listening language</DialogTitle>
                  <DialogDescription>Applies from your next spoken turn.</DialogDescription>
                </div>
              </div>
            </DialogHeader>
            <div className="flex max-h-[340px] flex-col gap-1 overflow-y-auto pt-3">
              <LanguageRow label="Auto (browser language)" active={language === null} onClick={() => pickLanguage(null)} />
              {LISTENING_LANGUAGES.map((l) => (
                <LanguageRow key={l.tag} label={l.label} active={language === l.tag} onClick={() => pickLanguage(l.tag)} />
              ))}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function StartButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-full bg-accent px-5 py-2.5 text-[14px] font-medium text-white transition-[filter] hover:brightness-110 active:scale-[0.97]"
    >
      Start talking
    </button>
  );
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Back"
      className="-ml-1 flex size-8 shrink-0 items-center justify-center rounded-full text-ink-secondary transition-colors hover:bg-raised hover:text-ink"
    >
      <ArrowLeft size={16} />
    </button>
  );
}

function LanguageRow({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center justify-between rounded-lg px-3 py-2 text-left text-[14px] transition-colors",
        active ? "bg-accent/10 text-accent" : "text-ink hover:bg-raised",
      )}
    >
      {label}
      {active && <span aria-hidden>✓</span>}
    </button>
  );
}
