// Generic window chrome for the Muster OS desktop: draggable title bar,
// bottom-right resize handle, minimize/close, and focus styling. Drag and
// resize are local state so a window keeps its geometry while open —
// including across a minimize — and the parent only tracks the z-order
// stack. Motion tokens ease open/close/focus; an active drag sets
// data-dragging so nothing animates under the pointer.
import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { Minus, X } from "lucide-react";

const MIN_WIDTH = 300;
const MIN_HEIGHT = 180;

/** One active pointer gesture. Origin geometry is captured on
 * pointer-down so each move recomputes from where the drag began. */
interface DragSession {
  pointerId: number;
  mode: "move" | "resize";
  startClientX: number;
  startClientY: number;
  originX: number;
  originY: number;
  originWidth: number;
  originHeight: number;
}

interface WindowGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowFrameProps {
  title: string;
  ariaLabel: string;
  focused: boolean;
  minimized: boolean;
  zIndex: number;
  /** Open-order slot; offsets each new window so stacks cascade. */
  cascade: number;
  width: number;
  height: number;
  onFocus: () => void;
  onMinimize: () => void;
  onClose: () => void;
  children: ReactNode;
}

export function WindowFrame({
  title,
  ariaLabel,
  focused,
  minimized,
  zIndex,
  cascade,
  width,
  height,
  onFocus,
  onMinimize,
  onClose,
  children,
}: WindowFrameProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dragRef = useRef<DragSession | null>(null);
  const [dragging, setDragging] = useState(false);
  const [geometry, setGeometry] = useState<WindowGeometry>(() => ({
    x: 72 + cascade * 32,
    y: 36 + cascade * 26,
    width,
    height,
  }));

  // A newly opened (focused) window starts keyboard users inside it, as
  // the old centered dialog did.
  useEffect(() => {
    if (focused) closeRef.current?.focus();
    // Only on mount: later focus changes come from pointer clicks.
  }, []);

  const beginDrag = (mode: DragSession["mode"], e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    onFocus();
    const frame = frameRef.current;
    if (!frame) return;
    frame.setPointerCapture(e.pointerId);
    dragRef.current = {
      pointerId: e.pointerId,
      mode,
      startClientX: e.clientX,
      startClientY: e.clientY,
      originX: geometry.x,
      originY: geometry.y,
      originWidth: geometry.width,
      originHeight: geometry.height,
    };
    setDragging(true);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const bounds = frameRef.current?.parentElement;
    if (!bounds) return;
    const dx = e.clientX - drag.startClientX;
    const dy = e.clientY - drag.startClientY;
    if (drag.mode === "move") {
      // Keep a grabbable strip of the window inside the desktop body.
      setGeometry((g) => ({
        ...g,
        x: Math.min(Math.max(drag.originX + dx, 60 - drag.originWidth), bounds.clientWidth - 60),
        y: Math.min(Math.max(drag.originY + dy, 0), bounds.clientHeight - 40),
      }));
    } else {
      setGeometry((g) => ({
        ...g,
        width: Math.min(Math.max(drag.originWidth + dx, MIN_WIDTH), Math.max(bounds.clientWidth - drag.originX, MIN_WIDTH)),
        height: Math.min(Math.max(drag.originHeight + dy, MIN_HEIGHT), Math.max(bounds.clientHeight - drag.originY, MIN_HEIGHT)),
      }));
    }
  };

  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    const frame = frameRef.current;
    if (frame?.hasPointerCapture(e.pointerId)) frame.releasePointerCapture(e.pointerId);
  };

  // The title bar's minimize/close buttons must click, not drag.
  const onTitlebarPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.target instanceof Element && e.target.closest("button")) return;
    beginDrag("move", e);
  };

  return (
    <div
      ref={frameRef}
      className="os-window glass"
      role="dialog"
      aria-label={ariaLabel}
      tabIndex={-1}
      data-focused={focused ? "true" : "false"}
      data-minimized={minimized ? "true" : "false"}
      data-dragging={dragging ? "true" : "false"}
      style={{ zIndex, left: geometry.x, top: geometry.y, width: geometry.width, height: geometry.height }}
      onPointerDown={onFocus}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={(e) => {
        // Escape closes the focused window, but never while naming a room.
        if (e.key === "Escape" && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) {
          onClose();
        }
      }}
    >
      <div
        className="os-window-titlebar"
        onPointerDown={onTitlebarPointerDown}
        onDoubleClick={onMinimize}
      >
        <span className="os-window-title">{title}</span>
        <button
          type="button"
          className="os-window-min"
          aria-label={`Minimize ${title} window`}
          onClick={onMinimize}
        >
          <Minus size={14} />
        </button>
        <button
          ref={closeRef}
          type="button"
          className="os-window-close"
          aria-label={`Close ${title} window`}
          onClick={onClose}
        >
          <X size={14} />
        </button>
      </div>
      {children}
      <div className="os-window-resize" onPointerDown={(e) => beginDrag("resize", e)} />
    </div>
  );
}
