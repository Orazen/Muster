// App registry for the Muster OS desktop — rome-style declarative
// manifests. Every singleton app the shell can host declares itself here as
// data: identity, chrome label, opening geometry, and dock icon. The shell
// (DesktopShell) derives its dock entries and window ids from this table,
// and the app's window component reads its own chrome constants from it, so
// adding an app to /os is a manifest entry plus a window component — the
// window manager never learns app internals. Per-bot agent windows stay
// outside this registry: they are data-driven (one per visible bot) and
// the dock renders live avatar/busy state for them.
import type { ComponentType } from "react";
import { Users } from "lucide-react";

export interface OsAppManifest {
  /** Stable app id; window ids derive from it (`window-<id>`). */
  id: string;
  /** Dock and window-chrome label. */
  title: string;
  /** Accessible name for the window dialog. */
  ariaLabel: string;
  /** Opening geometry; the user can drag-resize from here. */
  width: number;
  height: number;
  /** Dock icon. */
  icon: ComponentType<{ size?: number | string }>;
}

/** Singleton apps, in dock order. */
export const OS_SINGLETON_APPS: Array<OsAppManifest> = [
  {
    id: "rooms",
    title: "Rooms",
    ariaLabel: "Agent rooms window",
    width: 440,
    height: 480,
    icon: Users,
  },
];

export function appManifest(id: string): OsAppManifest | undefined {
  return OS_SINGLETON_APPS.find((app) => app.id === id);
}
