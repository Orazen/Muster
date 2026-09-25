// Guided product tour (OMB parity, Apache-2.0 concept — Muster's own
// implementation and design). A handful of coach marks anchored to real UI:
// roster, composer, computer, model picker, app settings. Persisted in
// localStorage; replayable from Settings → General → First-run tour.
// Anchors that are not on screen (e.g. the model picker on a fresh roster)
// are skipped automatically — the tour never blocks on a missing element.
import { useCallback, useEffect, useRef, useState } from "react";

const TOUR_KEY = "muster.productTour.done.v1";

export function productTourPending(): boolean {
  try {
    return localStorage.getItem(TOUR_KEY) !== "1";
  } catch {
    return false;
  }
}

export function completeProductTour(): void {
  try {
    localStorage.setItem(TOUR_KEY, "1");
  } catch {
    /* private mode: tour will replay next visit — harmless */
  }
}

export function replayProductTour(): void {
  try {
    localStorage.removeItem(TOUR_KEY);
  } catch {
    /* ignore */
  }
}

interface TourStep {
  /** CSS selector for the anchor; `[data-tour="..."]` attributes are part
   * of the contract and pinned by product-tour.test.tsx. */
  selector: string;
  title: string;
  body: string;
}

const STEPS: TourStep[] = [
  {
    selector: '[data-tour="roster"]',
    title: "Your roster",
    body: "Every teammate here is a real agent with its own persona, model and computer. Right-click one to pin, duplicate or archive it.",
  },
  {
    selector: '[data-tour="composer"]',
    title: "Give a teammate work",
    body: "Type into the composer like a chat. Your bot plans, uses tools, and asks before risky actions.",
  },
  {
    selector: '[data-tour="model-picker"]',
    title: "Pick a brain",
    body: "Switch the engine or reasoning effort for this bot any time — mid-conversation is fine.",
  },
  {
    selector: '[data-tour="computer"]',
    title: "Every bot gets a computer",
    body: "Open the Computer panel to watch your bot work live, or lend it this machine or a VPS.",
  },
  {
    selector: '[data-tour="app-settings"]',
    title: "App settings",
    body: "About me, effort defaults, parallel threads, backups and more live here. Enjoy your crew!",
  },
];

/** Wait (briefly) for a selector to appear — first paint after sign-in can
 * still be mounting the conversation view. Bounded so a missing anchor
 * skips instead of hanging. */
function findAnchor(selector: string): Element | null {
  return document.querySelector(selector);
}

export function ProductTour() {
  const [stepIndex, setStepIndex] = useState<number | null>(productTourPending() ? 0 : null);
  const [anchorRect, setAnchorRect] = useState<{ top: number; left: number; width: number; height: number; bottom: number } | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const activeStep = stepIndex === null ? null : STEPS[stepIndex];

  const advance = useCallback(() => {
    setStepIndex((current) => {
      if (current === null) return null;
      const next = current + 1;
      if (next >= STEPS.length) {
        completeProductTour();
        return null;
      }
      return next;
    });
  }, []);

  const endTour = useCallback(() => {
    completeProductTour();
    setStepIndex(null);
  }, []);

  // Track the current anchor's position; re-measure briefly (first paint
  // after sign-in can still be mounting the conversation view) and skip the
  // step if its element never appears. An interval, not rAF: deterministic
  // under fake timers in tests and immune to jsdom's pretendToBeVisual flag.
  useEffect(() => {
    if (stepIndex === null || !activeStep) {
      setAnchorRect(null);
      return;
    }
    let attempts = 0;
    const measure = () => {
      const el = findAnchor(activeStep.selector);
      if (!el) {
        attempts += 1;
        if (attempts > 8) advance(); // anchor never appeared — skip, never block
        return;
      }
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        advance();
        return;
      }
      setAnchorRect({ top: rect.top, left: rect.left, width: rect.width, height: rect.height, bottom: rect.bottom });
    };
    measure();
    const timer = setInterval(measure, 250);
    const onResize = () => measure();
    window.addEventListener("resize", onResize);
    return () => {
      clearInterval(timer);
      window.removeEventListener("resize", onResize);
    };
  }, [stepIndex, activeStep, advance]);

  if (stepIndex === null || !activeStep) return null;

  const cardTop = anchorRect ? Math.min(Math.max(anchorRect.bottom + 10, 12), window.innerHeight - 170) : window.innerHeight / 2 - 80;
  const cardLeft = anchorRect
    ? Math.min(Math.max(anchorRect.left, 12), Math.max(12, window.innerWidth - 340))
    : window.innerWidth / 2 - 160;

  return (
    <div className="fixed inset-0 z-[9999]" data-testid="product-tour" role="dialog" aria-label="Product tour">
      <button
        type="button"
        aria-label="End tour"
        onClick={endTour}
        className="absolute inset-0 cursor-default bg-black/45"
        style={{ clipPath: anchorRect ? `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${anchorRect.left - 6}px ${anchorRect.top - 6}px, ${anchorRect.left + anchorRect.width + 6}px ${anchorRect.top - 6}px, ${anchorRect.left + anchorRect.width + 6}px ${anchorRect.top + anchorRect.height + 6}px, ${anchorRect.left - 6}px ${anchorRect.top + anchorRect.height + 6}px, ${anchorRect.left - 6}px ${anchorRect.top - 6}px)` : undefined }}
      />
      <div
        ref={cardRef}
        className="absolute w-[320px] rounded-xl border border-hairline bg-app p-4 shadow-xl"
        style={{ top: cardTop, left: cardLeft }}
      >
        <div className="text-[15px] font-semibold text-ink">{activeStep.title}</div>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-secondary">{activeStep.body}</p>
        <div className="mt-3.5 flex items-center justify-between">
          <span className="text-[12px] text-ink-secondary">
            {stepIndex! + 1} / {STEPS.length}
          </span>
          <span className="flex items-center gap-2">
            <button
              type="button"
              onClick={endTour}
              className="rounded-lg px-2.5 py-1.5 text-[12.5px] text-ink-secondary hover:text-ink"
            >
              Skip
            </button>
            <button
              type="button"
              onClick={advance}
              className="rounded-lg bg-raised px-3 py-1.5 text-[12.5px] font-medium text-ink hover:bg-raised-hover"
            >
              {stepIndex === STEPS.length - 1 ? "Done" : "Next"}
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}
