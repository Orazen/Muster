// The visible half of voice session controls: a quiet chip per changed axis,
// so "be quieter" is confirmed on screen as well as by ear. The chips live in
// the voice room, so they wear the room's derived tones (--room-*, set by
// voiceRoomVars) with brand-token fallbacks for any other surface.
export function SpeechControlChips({ rate, volume }: { rate?: number; volume?: number }) {
  const chips: string[] = [];
  if (rate !== undefined && Math.abs(rate - 1) > 0.01) chips.push(`${rate.toFixed(2).replace(/0$/, "")}x speed`);
  if (volume !== undefined && Math.abs(volume - 1) > 0.01) chips.push(`${Math.round(volume * 100)}% volume`);
  if (!chips.length) return null;
  return (
    <>
      {chips.map((label) => (
        <span
          key={label}
          className="rounded-full px-2 py-0.5 text-[11px]"
          style={{
            background: "var(--room-wash, rgba(240,70,14,0.1))",
            color: "var(--room-fg, var(--color-accent))",
          }}
        >
          {label}
        </span>
      ))}
    </>
  );
}
