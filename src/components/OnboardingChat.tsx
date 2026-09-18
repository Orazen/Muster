// The conversational onboarding (hosted): GAIA-style chat-first first-run,
// Muster-native — the Flower speaks in bubbles on the aurora ambient, every
// answer is a chip, the user's picks render as their own bubbles, and the
// whole thing composes the existing pieces (storage gate → this chat → crew
// hire via the same create/patch endpoints the templates use). Desktop keeps
// the classic wizard untouched.
import { useEffect, useMemo, useRef, useState } from "react";
import "./onboarding-chat.css";

import { FlowerCharacter } from "@/components/FlowerCharacter";
import { api, useStore } from "@/state/store";
import { beatAt, beatCount, planCrew, type Turn } from "@/lib/onboarding-chat";

const DONE_KEY = "muster.onboarding-chat.done";

export function OnboardingChat() {
  const { state } = useStore();
  const [step, setStep] = useState(0);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [picked, setPicked] = useState<{ role?: string; pains: string[]; crew?: string }>({ pains: [] });
  const [busy, setBusy] = useState(false);
  const [hired, setHired] = useState(false);
  const [dismissed] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const gate = state.config?.storageGate;
  const shown = gate?.required === true && gate.satisfied && !state.bots.length && !dismissed && !hired;

  const beat = beatAt(step);
  const userName = state.config?.profile?.name?.split(" ")[0] ?? "there";

  // The transcript grows as beats advance: replay the assistant's lines for
  // the current beat once. Typed as turns; the greeting uses the name.
  useEffect(() => {
    if (!shown) return;
    const lines = beat.intro.map((line) => line.replace("{name}", userName));
    const asTurns = lines.map((text): Turn => ({ who: "assistant", text }));
    setTurns((prev) => {
      const last = prev[prev.length - 1];
      // Re-entry after a user answer: the beat advanced, append its lines.
      if (last?.who === "user") return [...prev, ...asTurns];
      if (!prev.length) return asTurns;
      return prev;
    });
  }, [shown, step]); // eslint-disable-line react-hooks/exhaustive-deps -- beat identity is step-derived

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [turns.length]);

  const answer = (optionId: string, label: string) => {
    if (beat.kind === "single") {
      if (beat.id === "role") setPicked((p) => ({ ...p, role: optionId }));
      if (beat.id === "crew") setPicked((p) => ({ ...p, crew: optionId }));
      setTurns((prev) => [...prev, { who: "user", text: label }]);
      setStep((s) => s + 1);
    }
  };

  const togglePain = (optionId: string) => {
    setPicked((p) => {
      const has = p.pains.includes(optionId);
      if (!has && p.pains.length >= (beat.max ?? 3)) return p;
      const next = has ? p.pains.filter((x) => x !== optionId) : [...p.pains, optionId];
      return { ...p, pains: next };
    });
  };

  const advance = async () => {
    if (beat.id === "pains") {
      const labels = (beat.options ?? []).filter((o) => picked.pains.includes(o.id)).map((o) => o.label);
      setTurns((prev) => [...prev, { who: "user", text: labels.length ? labels.join(", ") : "I'll figure it out as we go" }]);
      setStep((s) => s + 1);
      return;
    }
    if (beat.id === "crew" && picked.crew) {
      setBusy(true);
      try {
        const plan = planCrew(picked.crew, picked.pains);
        if (plan) {
          for (const member of plan.members) {
            // SAFETY: create answers {bot:{id}}; a missing id fails loudly below.
            const created = await api("/api/bots", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) }) as { bot?: { id?: string } };
            const id = created?.bot?.id;
            if (!id) throw new Error(`could not create ${member.name}`);
            await api(`/api/bots/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(member) });
          }
        }
        try { window.localStorage.setItem(DONE_KEY, "1"); } catch { /* private mode */ }
        setHired(true);
      } catch {
        setError("Hiring failed — try again.");
      } finally {
        setBusy(false);
      }
    }
  };

  const [error, setError] = useState<string | null>(null);

  const chipTone = (index: number) => `onboarding-chat-chip tone-${index % 6}`;

  const transcript = useMemo(() => turns, [turns]);

  if (!shown) return null;

  return (
    <div className="onboarding-chat" role="region" aria-label="Set up Muster with your assistant">
      <div className="onboarding-chat-progress" aria-hidden="true">
        {Array.from({ length: beatCount() }, (_, i) => (
          <span key={i} className={i <= step ? "seg on" : "seg"} />
        ))}
      </div>
      <div ref={scrollRef} className="onboarding-chat-scroll">
        <div className="onboarding-chat-column">
          {transcript.map((turn, i) =>
            turn.who === "assistant" ? (
              <div key={i} className="chat-row assistant">
                <FlowerCharacter color="orange" size={30} state={busy ? "working" : "listening"} focusable={false} label="Your guide" />
                <div className="bubble assistant">{turn.text}</div>
              </div>
            ) : (
              <div key={i} className="chat-row user">
                <div className="bubble user">{turn.text}</div>
                <span className="user-avatar" aria-hidden="true">{(state.config?.profile?.name ?? "U")[0]?.toUpperCase()}</span>
              </div>
            ),
          )}

          {!busy && beat.kind === "none" && beat.id !== "done" && (
            <div className="chat-row options">
              <div className="chat-meta" style={{ justifyContent: "flex-start" }}>
                <button className="continue-pill" onClick={() => setStep((s) => s + 1)}>Continue →</button>
              </div>
            </div>
          )}
          {!busy && beat.kind !== "none" && (
            <div className="chat-row options" role="group" aria-label={beat.question}>
              <div className="bubble assistant question">{beat.question}</div>
              <div className="chips">
                {(beat.options ?? []).map((option, i) => {
                  const selected = beat.id === "pains" ? picked.pains.includes(option.id) : picked.role === option.id || picked.crew === option.id;
                  return (
                    <button
                      key={option.id}
                      className={`chip ${chipTone(i)} ${selected ? "selected" : ""}`}
                      onClick={() => (beat.id === "pains" ? togglePain(option.id) : answer(option.id, option.label))}
                      aria-pressed={selected}
                    >
                      {option.emoji && <span aria-hidden="true">{option.emoji}</span>} {option.label}
                    </button>
                  );
                })}
              </div>
              {beat.id === "pains" && (
                <div className="chat-meta">
                  <span className="left">{Math.max(0, (beat.max ?? 3) - picked.pains.length)} left</span>
                  <button className="continue-pill" onClick={() => void advance()} disabled={busy}>Continue →</button>
                </div>
              )}
              {beat.id === "crew" && picked.crew && picked.crew !== "empty" && (
                <div className="chat-meta">
                  <button className="continue-pill" onClick={() => void advance()} disabled={busy}>{busy ? "Hiring…" : "Continue →"}</button>
                </div>
              )}
              {beat.id === "crew" && picked.crew === "empty" && (
                <div className="chat-meta">
                  <button
                    className="continue-pill"
                    onClick={() => {
                      try { window.localStorage.setItem(DONE_KEY, "1"); } catch { /* private mode */ }
                      setHired(true);
                    }}
                  >
                    Start empty →
                  </button>
                </div>
              )}
            </div>
          )}
          {error && <p role="alert" className="chat-error">{error}</p>}
        </div>
      </div>
      <button
        className="restart"
        onClick={() => { setStep(0); setPicked({ pains: [] }); setTurns([]); setHired(false); }}
      >
        ⟳ Restart onboarding
      </button>
    </div>
  );
}
