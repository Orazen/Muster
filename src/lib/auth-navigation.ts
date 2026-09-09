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
