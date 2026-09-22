import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ChevronDown, SlidersHorizontal } from "lucide-react";
import { cn } from "@/lib/cn";
import "./chat/conversation-header.css";

/** Controls respond to the conversation column, including beside a desktop panel. */
export function ConversationHeader({ identity, primary, tools, interrupt, windows = false, collapsed = false }: {
  identity: ReactNode;
  primary: ReactNode;
  tools: ReactNode;
  interrupt?: ReactNode;
  windows?: boolean;
  /** Scroll-collapsed: chrome reclaims while reading down; identity and
   *  the interrupt control never hide (the interrupt is the emergency). */
  collapsed?: boolean;
}) {
  const [open, setOpen] = useState(false);
  // A drawer hanging off a shrunk header looks detached — collapsing
  // closes it along with the row it belongs to.
  useEffect(() => {
    if (collapsed) setOpen(false);
  }, [collapsed]);
  const toolsId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const closeWithEscape = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !open) return;
    event.preventDefault();
    setOpen(false);
    toggleRef.current?.focus();
  };

  return (
    <header className={cn("conversation-header", windows && "conversation-header--windows")} data-collapsed={collapsed || undefined} aria-label="Conversation controls">
      <div className="conversation-header-layout">
        <div className="conversation-header-identity">{identity}</div>
        <div className="conversation-header-interrupt">{interrupt}</div>
        <div className="conversation-primary" onClick={(event) => {
          if (event.target instanceof Node && !toggleRef.current?.contains(event.target)) setOpen(false);
        }}>
          {primary}
          <button ref={toggleRef} type="button" className="conversation-tools-toggle"
            aria-expanded={open} aria-controls={toolsId} onClick={() => setOpen(!open)} onKeyDown={closeWithEscape}>
            <SlidersHorizontal size={15} aria-hidden="true" /><span>Tools</span>
            <ChevronDown size={13} aria-hidden="true" className={cn("transition-transform", open && "rotate-180")} />
          </button>
        </div>
        <div id={toolsId} className="conversation-tools" data-open={open} role="group" aria-label="Conversation tools" onKeyDown={closeWithEscape}>
          {tools}
        </div>
      </div>
    </header>
  );
}
