// Gaze tracking — every bot avatar watches the cursor, the page-mascot way,
// but built for a screen with 15-30 avatars at once: ONE passive pointermove
// listener + ONE shared rAF, writing two CSS custom properties per target.
// Nothing re-renders; all downstream motion is transform-only.
//
// The contract (consumed by flower-bot.css / BlobBot / the mark):
//   --mx, --my : signed -1..1 gaze vector, updated at most once per frame.
//   Written on documentElement as a viewport-center vector (every avatar
//   inherits a plausible "the tribe looks toward the cursor" default), and
//   per registered [data-gaze] element as the exact pointer→element vector,
//   shadowing the inherited pair through the cascade.
//   --bot-gaze-on : instance kill-switch (0 collapses gaze); forced to 0 on
//   documentElement under prefers-reduced-motion.
//   --bot-gaze-range-x/y : reach in user units, set once per instance.
//
// Gating mirrors the page-mascot precedent: tracking only exists for real
// pointers (`(hover: hover) and (pointer: fine)`), and reduced-motion users
// never get it. Both are watched live via MediaQueryList change events.
export interface GazeVector {
  mx: number;
  my: number;
  /** distance falloff in [0,1]: far avatars rest near center, near strain */
  attenuation: number;
}

const QUANT = 1000; // 3 decimals — keeps writes cheap and diffs stable

/** Pure math: the gaze vector from an element's rect toward a pointer. */
export function computeGaze(
  rect: { left: number; top: number; width: number; height: number },
  x: number,
  y: number,
  attenuate: boolean,
): GazeVector {
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  // a zero-size rect (hidden ancestor) must never divide
  const half = Math.max(1, Math.min(rect.width, rect.height) / 2);
  const mx = clamp((x - cx) / (half * 3));
  const my = clamp((y - cy) / (half * 3));
  let attenuation = 1;
  if (attenuate) {
    const d = Math.hypot(x - cx, y - cy);
    // SSR probe: node-side tests import this module; absence of window is the
    // environment fact checked, with a fixed fallback.
    // oxlint-disable-next-line anti-slop/no-runtime-typeof
    const vw = typeof window === "undefined" ? 1280 : window.innerWidth || 1280;
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- SSR probe (see vw)
    const vh = typeof window === "undefined" ? 720 : window.innerHeight || 720;
    const r = 0.35 * Math.hypot(vw, vh);
    attenuation = clamp(0.2 + (0.8 * r) / (r + d), 0.2, 1);
  }
  return { mx: q(mx * attenuation), my: q(my * attenuation), attenuation };
}

const clamp = (n: number, lo = -1, hi = 1) => Math.min(hi, Math.max(lo, n));
const q = (n: number) => Math.round(n * QUANT) / QUANT;

const registered = new Set<HTMLElement>();
let installed = false;
let rafPending = false;
let lastX = 0;
let lastY = 0;
let observers: MediaQueryList[] = [];

function enabled(): boolean {
  // SSR probe: no matchMedia means no browser at all.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  if (typeof window === "undefined" || !window.matchMedia) return false;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
  return window.matchMedia("(hover: hover) and (pointer: fine)").matches;
}

function tick(): void {
  rafPending = false;
  const root = document.documentElement;
  if (!enabled()) {
    root.style.setProperty("--bot-gaze-on", "0");
    return;
  }
  root.style.removeProperty("--bot-gaze-on");
  // viewport-center vector for everything that never registers
  const vw = window.innerWidth || 1;
  const vh = window.innerHeight || 1;
  root.style.setProperty("--mx", String(q(clamp((lastX - vw / 2) / (vw / 2)))));
  root.style.setProperty("--my", String(q(clamp((lastY - vh / 2) / (vh / 2)))));
  // two passes: read every rect first, then write — no layout thrash
  const nodes = [...registered].filter((el) => el.isConnected);
  const computed = nodes.map((el) => ({
    el,
    gaze: computeGaze(el.getBoundingClientRect(), lastX, lastY, el.hasAttribute("data-gaze-attenuate")),
  }));
  for (const { el, gaze } of computed) {
    el.style.setProperty("--mx", String(gaze.mx));
    el.style.setProperty("--my", String(gaze.my));
  }
}

function onPointerMove(event: PointerEvent): void {
  lastX = event.clientX;
  lastY = event.clientY;
  if (!rafPending) {
    rafPending = true;
    requestAnimationFrame(tick);
  }
}

/** Idempotent app-level install. Call once from the React root. */
export function installGazeTracking(): void {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- SSR probe (see enabled()).
  if (installed || typeof window === "undefined" || !window.matchMedia) return;
  installed = true;
  for (const query of ["(prefers-reduced-motion: reduce)", "(hover: hover) and (pointer: fine)"]) {
    const list = window.matchMedia(query);
    list.addEventListener("change", () => {
      if (enabled()) requestAnimationFrame(tick);
      else tick(); // writes the kill-switch
    });
    observers.push(list);
  }
  if (enabled()) {
    window.addEventListener("pointermove", onPointerMove, { passive: true });
  }
  // pick up [data-gaze] elements as avatars mount/unmount — the ~20 render
  // sites stay untouched (a static attribute is all they carry)
  const observe = () => {
    for (const el of document.querySelectorAll<HTMLElement>("[data-gaze]")) {
      if (!el.dataset.gazeRegistered) {
        el.dataset.gazeRegistered = "1";
        registered.add(el);
      }
    }
  };
  observe();
  new MutationObserver(observe).observe(document.body, { childList: true, subtree: true });
  tick();
}

/** Test/SSR escape hatch: fully detach. Not used by the app. */
export function uninstallGazeTrackingForTest(): void {
  if (!installed) return;
  window.removeEventListener("pointermove", onPointerMove);
  registered.clear();
  observers.length = 0;
  installed = false;
}
