// The voice room's caption bubble — shared by one-to-one and room calls so a
// spoken turn looks identical wherever it lands. The bubble is Vellum's soft
// raised surface (a translucent lift of the ink over the fill, not an opaque
// chip), and the word cursor is its leading-edge tone: the spoken word sits at
// full primary ink and eases back as the next word takes over.
import { cursorWords } from "@/lib/tts/word-cursor";

export function VoiceCaption({ caption, word }: { caption: string; word?: number }) {
  return (
    <span
      className="inline-block rounded-2xl px-4 py-2 text-[15px] leading-relaxed"
      style={{ background: "var(--room-bubble)", color: "var(--room-bubble-fg)" }}
    >
      {cursorWords(caption).map((w, i) => (
        <span
          key={i}
          style={{
            color: i === word ? "var(--room-fg)" : undefined,
            transition: "color 0.45s ease",
          }}
        >
          {w}{" "}
        </span>
      ))}
    </span>
  );
}
