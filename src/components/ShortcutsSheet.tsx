// Keyboard shortcuts cheat sheet — every binding the app actually ships,
// listed in one sheet. Opened with "?" outside a text field or ⌘/, and from
// the command palette, so the shortcuts are discoverable where keyboard
// users already are. Read-only: a reference, not a setting.
// The searchable presentation adapts OpenMausBot's shortcuts modal
// (© OpenMausBot contributors, Apache License 2.0); layout and tokens are
// Muster's own.
import { useEffect, useRef, useState } from "react";
import { Keyboard, Search, X } from "lucide-react";
import {
  SHORTCUT_GROUPS,
  filterShortcutGroups,
  isMacPlatform,
  shortcutKeysForPlatform,
  type ShortcutItem,
} from "@/lib/keyboard-shortcuts";

/** One row's keycaps: a chip per key, with "or" rendered as a plain
 * separator between alternative chords (e.g. ? or ⌘/). */
function Keys({ item, isMac }: { item: ShortcutItem; isMac: boolean }) {
  const keys = shortcutKeysForPlatform(item, isMac);
  return (
    <div className="flex shrink-0 items-center gap-1">
      {keys.map((key, index) =>
        key.toLowerCase() === "or" ? (
          <span key={index} className="px-0.5 text-[11px] text-ink-secondary">
            or
          </span>
        ) : (
          <kbd
            key={index}
            className="inline-flex min-w-[22px] items-center justify-center rounded-md border border-hairline/50 bg-inset px-1.5 py-0.5 font-mono text-[11.5px] text-ink-secondary"
          >
            {key}
          </kbd>
        ),
      )}
    </div>
  );
}

export function ShortcutsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Each open starts a fresh sheet with the search focused.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Esc clears an active search first; only an empty sheet closes.
      if (query) {
        e.preventDefault();
        setQuery("");
      } else {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, query, onClose]);

  if (!open) return null;
  const isMac = isMacPlatform();
  const groups = filterShortcutGroups(SHORTCUT_GROUPS, query, isMac);

  return (
    <div
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-card shadow-2xl"
      >
        <div className="flex items-center justify-between gap-3 px-5 pt-5 pb-3">
          <div className="flex items-center gap-2.5">
            <Keyboard size={17} className="text-ink-secondary" />
            <div className="text-[15px] font-medium text-ink">Keyboard shortcuts</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close keyboard shortcuts"
            className="rounded-lg p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-5 pb-3">
          <div className="flex items-center gap-2 rounded-xl border border-hairline/50 bg-inset px-3 py-1.5 focus-within:border-accent/60">
            <Search size={14} className="shrink-0 text-ink-secondary" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search shortcuts…"
              aria-label="Search shortcuts"
              className="w-full bg-transparent text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none"
            />
            {query && (
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  inputRef.current?.focus();
                }}
                aria-label="Clear search"
                className="shrink-0 rounded p-0.5 text-ink-secondary hover:text-ink"
              >
                <X size={13} />
              </button>
            )}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-5 pb-4">
          {groups.length === 0 ? (
            <div className="py-10 text-center text-[13px] text-ink-secondary">
              No shortcuts match “{query}”
            </div>
          ) : (
            groups.map((group) => (
              <div key={group.category} className="mb-4 last:mb-0">
                <div className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
                  {group.category}
                </div>
                <div className="grid gap-1">
                  {group.items.map((item) => (
                    <div
                      key={item.id}
                      className="flex items-center justify-between gap-4 rounded-lg px-2 py-1.5 hover:bg-raised/60"
                    >
                      <span className="text-[13px] text-ink">{item.description}</span>
                      <Keys item={item} isMac={isMac} />
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-hairline/40 bg-inset/60 px-5 py-3">
          <span className="flex items-center gap-1 text-[11.5px] text-ink-secondary">
            <kbd className="rounded border border-hairline/50 bg-card px-1 py-0.5 font-mono text-[10.5px] text-ink-secondary">
              ?
            </kbd>
            outside text fields, or
            <kbd className="rounded border border-hairline/50 bg-card px-1 py-0.5 font-mono text-[10.5px] text-ink-secondary">
              {isMac ? "⌘" : "Ctrl"}
            </kbd>
            <kbd className="rounded border border-hairline/50 bg-card px-1 py-0.5 font-mono text-[10.5px] text-ink-secondary">
              /
            </kbd>
            anywhere
          </span>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-lg bg-raised px-3 py-1.5 text-[12.5px] font-medium text-ink hover:brightness-110"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
