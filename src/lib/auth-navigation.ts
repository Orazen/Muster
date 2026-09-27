/** Keep auth return paths on this origin, including hard desktop redirects. */
export function authDestination(value: string | null): string {
  if (!value?.startsWith("/")) return "/app";
  try {
    const base = "https://muster.invalid";
    const url = new URL(value, base);
    // Dot-segment normalization can produce //host even from /a/..//host.
    // A pathname must still be local when handed to a hard redirect alone.
    return url.origin === base && !url.pathname.startsWith("//")
      ? `${url.pathname}${url.search}${url.hash}` : "/app";
  } catch {
    return "/app";
  }
}

/** Matches server/auth.ts's minimum; used for new passwords only. */
export const AUTH_PASSWORD_MIN_LENGTH = 12;

/** The React desktop entry uses /, but public web / serves marketing.
 * A sign-in callback from that entry must return to the actual workspace. */
export function authGateReturnPath(location: { pathname: string; search: string; hash: string }): string {
  const path = location.pathname === "/" ? "/app" : location.pathname;
  return authDestination(path + location.search + location.hash);
}

const PAIR_RETURN_KEY = "muster.pair-return";

/** A carried pairing code must never ride a query string: the /pair deep
 * link's code would land in `?next=%2Fpair%23CODE`, and the server's own
 * rule is that codes go in fragments precisely because query strings land
 * in proxy and CDN access logs. The stash holds the return path across the
 * sign-in round trip instead — same tab, wiped on read, nothing logged. */
export function stashPairReturn(pathname: string, hash: string): string {
  try {
    globalThis.sessionStorage?.setItem(PAIR_RETURN_KEY, `${pathname}${hash}`);
  } catch { /* storage unavailable (private mode): the hash is lost, not leaked */ }
  return pathname;
}

/** Consume the stashed /pair return path (path + fragment) after sign-in.
 * Reading removes it: a stash is one round trip old, never reusable. */
export function takeStashedPairReturn(): string | null {
  try {
    const stashed = globalThis.sessionStorage?.getItem(PAIR_RETURN_KEY);
    globalThis.sessionStorage?.removeItem(PAIR_RETURN_KEY);
    return stashed && stashed.startsWith("/pair") ? stashed : null;
  } catch {
    return null;
  }
}
