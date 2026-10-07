// Pure helpers for the desktop shell's navigation and IPC boundaries.
//
// Kept free of Electron imports so they can be unit-tested in plain Node.

/** Schemes the OS may open on the app's behalf. Anything else (file:, smb:,
 * custom protocol handlers, javascript:, data:) is refused, because a link in
 * rendered model output must never become a local file open or a call into an
 * arbitrary registered app. */
const EXTERNAL_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/** The normalised URL to hand to shell.openExternal, or null to refuse. */
export function safeExternalUrl(raw) {
  // Only a non-empty, bounded string is a link; anything else is refused.
  if (String(raw) !== raw || raw.length === 0 || raw.length > 8192) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!EXTERNAL_SCHEMES.has(url.protocol)) return null;
  if ((url.protocol === "http:" || url.protocol === "https:") && !url.hostname) return null;
  return url.toString();
}

/** The origin of `raw`, or null when it is not an http(s) URL. */
function webOrigin(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Whether `target` stays on one of the app's own origins. */
export function isAppOrigin(target, appOrigins) {
  const origin = webOrigin(target);
  if (!origin) return false;
  try {
    const url = new URL(target);
    if (url.username || url.password) return false;
  } catch {
    return false;
  }
  return appOrigins.some((candidate) => webOrigin(candidate) === origin);
}

/** What a window should do with a top-level navigation.
 *  - "allow": load it in the window.
 *  - "external": cancel it and open the URL in the system handler.
 *  - "deny": cancel it.
 *
 * `strict` windows (the tray) never leave the app origin. The main window
 * still lets ordinary web navigations through, because in-window sign-in and
 * connection flows (Google calendar/drive consent, workspace switching)
 * navigate there today; the desktop bridge is withheld from those pages by
 * the IPC sender check instead. Non-web schemes are never loaded in-window. */
export function navigationDecision(target, appOrigins, { strict = false } = {}) {
  if (isAppOrigin(target, appOrigins)) return "allow";
  const external = safeExternalUrl(target);
  if (strict) return external ? "external" : "deny";
  if (webOrigin(target)) return "allow";
  return external ? "external" : "deny";
}

/** Whether an IPC call comes from the top-level frame of an app-origin page.
 * A subframe, or a window that navigated to another site, must not inherit
 * the desktop bridge. */
export function isTrustedAppSender(event, appOrigins) {
  try {
    const sender = event?.sender;
    const frame = event?.senderFrame;
    if (!sender || !frame) return false;
    if (sender.isDestroyed?.()) return false;
    if (sender.mainFrame && frame !== sender.mainFrame) return false;
    return isAppOrigin(frame.url, appOrigins);
  } catch {
    return false;
  }
}

/** Install the actual cancellable top-level navigation boundaries. Redirects
 * from an allowed app URL receive the same policy as direct navigation. */
export function installNavigationGuard(contents, getOrigins, openExternal, options) {
  const guard = (event, target) => {
    const decision = navigationDecision(target, getOrigins(), options);
    if (decision === "allow") return;
    event.preventDefault();
    if (decision === "external") openExternal(target);
  };
  contents.on("will-navigate", guard);
  contents.on("will-redirect", (event, target, _inPlace, isMainFrame) => {
    if (isMainFrame === false) return;
    guard(event, target);
  });
}
