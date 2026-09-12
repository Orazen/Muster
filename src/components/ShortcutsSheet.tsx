// Keyboard shortcuts cheat sheet — every binding the app actually ships,
// listed in one sheet. Opened with "?" outside a text field or ⌘/, and from
// the command palette, so the shortcuts are discoverable where keyboard
// users already are. Read-only: a reference, not a setting.
import { useEffect } from "react";
import { Keyboard } from "lucide-react";

const GROUPS: Array<{ title: string; items: Array<[string, string]> }> = [
  {
    title: "Anywhere",
    items: [
      ["⌘K", "Command palette"],
      ["⌘N", "New teammate"],
      ["⌘1 – ⌘9", "Jump to teammate"],
      ["⌘⇧[ / ⌘⇧]", "Previous / next teammate"],
      ["?", "This cheat sheet"],
    ],
  },
  {
    title: "In a conversation",
    items: [
      ["⌘F", "Find in conversation"],
      ["Enter", "Send"],
      ["⇧Enter", "New line"],
      ["Esc", "Close find, cancel edit"],
    ],
  },
];

export function ShortcutsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      aria-hidden
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <div
        role="dialog"
        aria-label="Keyboard shortcuts"
        className="w-full max-w-md rounded-2xl bg-card p-5 shadow-2xl"
      >
        <div className="mb-4 flex items-center gap-2.5">
          <Keyboard size={17} className="text-ink-secondary" />
          <div className="text-[15px] font-medium text-ink">Keyboard shortcuts</div>
        </div>
        <div className="max-h-[60vh] overflow-auto">
          {GROUPS.map((group) => (
            <div key={group.title} className="mb-4 last:mb-0">
              <div className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
                {group.title}
              </div>
              <div className="grid gap-1">
                {group.items.map(([keys, label]) => (
                  <div key={keys} className="flex items-center justify-between gap-4 rounded-lg px-2 py-1.5 hover:bg-raised/60">
                    <span className="text-[13px] text-ink">{label}</span>
                    <kbd className="shrink-0 rounded-md border border-hairline/50 bg-inset px-1.5 py-0.5 font-mono text-[11.5px] text-ink-secondary">
                      {keys}
                    </kbd>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
