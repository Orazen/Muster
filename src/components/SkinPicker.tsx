// Picking a skin is a visual decision, so each option shows what it looks
// like: a swatch of its own palette drawn from literal hexes in skins.ts,
// next to the radio that selects it. The list is a real radiogroup — one
// active theme, keyboard-navigable like any other radio set.
import { useState } from "react";
import { THEMES, applyTheme, readTheme, type ThemeSwatch } from "@/lib/skins";
import { cn } from "@/lib/cn";

/** Three overlapping paint dots: surface behind, panel mid, accent front —
 * enough to tell "dark cool", "paper warm", "brass dark", "porcelain teal"
 * apart at a glance. */
function Swatch({ swatch }: { swatch: ThemeSwatch }) {
  return (
    <span aria-hidden="true" className="flex shrink-0 items-center -space-x-1.5">
      <span className="size-4 rounded-full ring-1 ring-hairline/60" style={{ background: swatch.surface }} />
      <span className="size-4 rounded-full ring-1 ring-hairline/60" style={{ background: swatch.panel }} />
      <span className="size-4 rounded-full ring-1 ring-hairline/60" style={{ background: swatch.accent }} />
    </span>
  );
}

export function SkinPicker() {
  // Storage is the source of truth here, not the attribute: main.tsx has
  // already stamped it before first paint, so both agree, and readTheme()
  // stays correct even if boot restore was skipped some other way.
  const [active, setActive] = useState(() => readTheme());

  return (
    <div role="radiogroup" aria-label="Theme" className="flex flex-col gap-2">
      {THEMES.map((theme) => {
        const selected = theme.id === active;
        return (
          <button
            key={theme.id}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => {
              applyTheme(theme.id);
              setActive(theme.id);
            }}
            className={cn(
              "flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors",
              selected
                ? "border-accent-border bg-raised/50"
                : "border-hairline/40 hover:border-hairline hover:bg-raised/30",
            )}
          >
            <Swatch swatch={theme.swatch} />
            <span className="min-w-0 flex-1">
              <span className="block text-[14px] font-medium text-ink">{theme.label}</span>
              <span className="mt-0.5 block text-[12.5px] leading-snug text-ink-secondary">
                {theme.description}
              </span>
            </span>
            {/* the radio itself: an empty ring when off, accent-filled dot on */}
            <span
              aria-hidden="true"
              className={cn(
                "flex size-4 shrink-0 items-center justify-center rounded-full border",
                selected ? "border-accent" : "border-hairline",
              )}
            >
              {selected && <span className="size-2 rounded-full bg-accent" />}
            </span>
          </button>
        );
      })}
    </div>
  );
}
