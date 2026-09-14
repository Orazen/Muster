// PostHog usage analytics + the email → person identity link.
// The phc_ token is a write-only public key (safe to ship in the client).
// Only the named events below are sent — autocapture is OFF on purpose:
// it would ship the $el_text of clicked elements, and the sidebar/option
// cards render model output and message previews, so it would leak fragments
// of private conversations to a third party. Email submissions call
// identify(), so PostHog's Persons tab doubles as the collected-email list.
import posthog from "posthog-js";
import { z } from "zod";

const TOKEN = "phc_m2hP39w8y2gLPvHgDvSXAu6xcZ3agjf4ruL56rGcMZEe";

let ready = false;

export function initAnalytics() {
  if (ready) return;
  posthog.init(TOKEN, {
    api_host: "https://us.i.posthog.com",
    autocapture: false, // never capture clicked-element text (conversation leak)
    capture_pageview: false, // single-window desktop app — no page routes
    person_profiles: "identified_only",
    persistence: "localStorage",
  });
  ready = true;
  const platform = navigator.userAgent.includes("Electron") ? "desktop" : "browser";
  // one-time install marker — app_first_open counts installs (the closest
  // truth to "downloads that mattered"; raw download counts live on the
  // GitHub release assets)
  if (!localStorage.getItem("omb-installed")) {
    localStorage.setItem("omb-installed", new Date().toISOString());
    posthog.capture("app_first_open", { platform });
  }
  posthog.capture("app_opened", { platform });
}

/** Analytics event properties: scalars only — PostHog renders these as
 * event columns and complex values would be stringified opaquely. */
export type AnalyticsProps = Record<string, string | number | boolean | null | undefined>;

export function track(event: string, props?: AnalyticsProps) {
  if (!ready) return;
  posthog.capture(event, props);
}

export function identifyEmail(email: string) {
  if (!ready) return;
  posthog.identify(email, { email });
  posthog.capture("email_submitted");
}

// First-run onboarding state — the ACCOUNT is the source of truth, the
// browser is only a cache. The gate used to live solely in localStorage,
// keyed by user id, which split the decision along login-method lines: an
// account that finished onboarding via email sign-in saw the wizard again
// on its next Google sign-in (different browser, cleared storage, or the
// auth flicker writing the key under "legacy"). Now a dismissal is
// persisted server-side per better-auth user id (PUT /api/me/onboarding)
// and this localStorage key is just the fast path.
export function emailGateDone(userId?: string): boolean {
  return Boolean(localStorage.getItem(gateKey(userId)));
}

/** Server check: has this account been through onboarding already? A
 * failed fetch (offline, old server) resolves false — the wizard shows
 * and a fresh dismissal re-persists, which is the safe direction. */
export async function serverGateDone(): Promise<boolean> {
  try {
    const res = await fetch("/api/me/onboarding", { credentials: "include" });
    if (!res.ok) return false;
    // SAFETY: the endpoint's contract is { done: boolean }; a narrow
    // shape-check on the parsed JSON replaces an unchecked cast, and any
    // malformed answer resolves false so it can only re-show the wizard,
    // never silently skip it.
    const data = z.object({ done: z.boolean() }).safeParse(await res.json());
    return data.success && data.data.done;
  } catch {
    return false;
  }
}

/** Persist the dismissal everywhere: localStorage (instant, same-browser)
 * and the server (durable, follows the account across logins/browsers). */
export function setEmailGateDone(userId: string | undefined, status: "submitted" | "skipped") {
  localStorage.setItem(gateKey(userId), status);
  void fetch("/api/me/onboarding", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ status }),
  }).catch(() => {});
}

/** Undo the dismissal everywhere — the client half of "Replay welcome
 * tour". Awaited, so the caller only reloads once the server gate is truly
 * cleared (a stale server flag would silently re-hide the wizard). */
export async function clearOnboardingGate(userId: string | undefined): Promise<void> {
  localStorage.removeItem(gateKey(userId));
  localStorage.removeItem(gateKey(undefined));
  requestTourReplay();
  await fetch("/api/me/onboarding", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ status: "reset" }),
  }).catch(() => {});
}

/** The wizard's returning-user guard (a transcript means you've seen it)
 * must not auto-skip a deliberate replay. sessionStorage survives the
 * reload and is consumed once, per tab. */
const REPLAY_KEY = "muster:tour-replay";
export function requestTourReplay(): void {
  try {
    sessionStorage.setItem(REPLAY_KEY, "1");
  } catch {
    // storage-blocked browsers lose only the replay, never the app
  }
}
export function consumeTourReplay(): boolean {
  try {
    const v = sessionStorage.getItem(REPLAY_KEY);
    if (v) sessionStorage.removeItem(REPLAY_KEY);
    return Boolean(v);
  } catch {
    return false;
  }
}

function gateKey(userId?: string): string {
  return userId ? `omb-email-gate.${userId}` : "omb-email-gate.legacy";
}
