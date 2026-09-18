// Calm mode — the owner's off switch for mascot interactions and antics.
// Persisted per browser like the sidebar preferences; reads validate
// untrusted localStorage. Global motion preferences still apply on top:
// a calm mascot is quieter than the default, and reduced-motion is
// enforced by the CSS layer regardless.
import { useSyncExternalStore } from "react";

const KEY = "muster:mascot-calm";

function raw(): string | null {
  try {
    return globalThis.localStorage?.getItem(KEY) ?? null;
  } catch {
    return null;
  }
}

export function isCalmMascot(): boolean {
  return raw() === "1";
}

export function setCalmMascot(calm: boolean): void {
  try {
    if (calm) localStorage.setItem(KEY, "1");
    else localStorage.removeItem(KEY);
  } catch {
    // storage may be unavailable (privacy mode); the setting just won't persist
  }
  // Copy before iterating: a listener may call setCalm again, mutating the set mid-walk.
  const snapshot = Array.from(listeners);
  for (const listener of snapshot) listener();
}

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** React hook: the current calm value, re-rendering subscribers on change. */
export function useCalmMascot(): boolean {
  return useSyncExternalStore(subscribe, isCalmMascot, () => false);
}
