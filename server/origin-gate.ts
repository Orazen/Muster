// Desktop CSRF tightening for state-changing requests.
//
// The host/origin gate already defeats remote-web attacks, but any LOCAL web
// context (a compromised dev server, a malicious npm package's UI) sends a
// loopback Origin — previously always trusted. On desktop installs (no
// sessions, loopback-only), state-changing requests now additionally require
// the Origin to be same-origin with the request's own Host header.
//
// Machine callers are unaffected: CLIs and curl send no Origin at all, and
// token-authenticated callers (companion sidecar, MCP control plane) carry an
// Authorization header, which a hostile browser page cannot attach cross-
// origin without a successful CORS preflight — this server never grants one.

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** True when the request's Origin and Host describe the same origin
 * (scheme-agnostic: the server is plain HTTP on desktop). */
export function isSameOrigin(origin: string, host: string | undefined): boolean {
  if (!host) return false;
  try {
    return new URL(origin).host === host.trim().toLowerCase();
  } catch {
    return false;
  }
}

/** Whether this request needs the desktop same-origin mutation check.
 * Cloud/self-hosted deployments are excluded: they sit behind proxies that
 * legitimately rewrite Host, and they already gate on real sessions. */
export function needsSameOriginMutationCheck(opts: {
  selfHosted: boolean;
  method: string;
  hasOrigin: boolean;
  hasAuthorization: boolean;
}): boolean {
  if (opts.selfHosted) return false;
  if (!opts.hasOrigin) return false;
  if (opts.hasAuthorization) return false;
  return MUTATING_METHODS.has(opts.method);
}
