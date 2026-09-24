// Remote client mode — "Connect to another computer".
//
// Muster is local-first, but a Muster server is also a web app: a computer
// (or a VPS) running Muster serves /app, and its pairing link
// `https://host:port/claim#CODE` redeems to an owner session in whatever
// browser opens it. The desktop client-mode window is that same flow with a
// dedicated, address-pinned window instead of a browser tab.
//
// The companion sidecar's 6-digit code is deliberately NOT accepted here.
// That code authenticates a native phone client which sends a bearer token
// on every request; the companion proxy allows nothing else, so a page
// loaded in a window could not use it. Pretending otherwise would produce a
// window that pairs and then can't load anything.
import { z } from "zod";

export interface RemoteServerTarget {
  /** The URL to load, always including the carried claim code when given. */
  url: string;
  /** Lowercased hostname for display and storage. */
  host: string;
  /** host[:port] as a person would read it aloud. */
  displayHost: string;
  /** The carried claim code from /claim#CODE, when present. */
  carriedCode: string | null;
}

/** Hostnames where plain HTTP is accepted. Loopback and link-local/named
 * LAN hosts travel networks that are already the user's own; everything
 * else must be HTTPS, the same rule the pairing-link validator applies. */
export function isLoopbackOrLanHost(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
  if (name === "localhost" || name.endsWith(".localhost") || name.endsWith(".local")) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if ([a, b, Number(m[3]), Number(m[4])].some((n) => n > 255)) return false;
  return a === 127 || a === 10 || a === 192 && b === 168 || a === 172 && b >= 16 && b <= 31 || a === 169 && b === 254;
}

const CLAIM_FRAGMENT = /^#?code=([A-Za-z0-9-]{4,32})$|^#?([A-Za-z0-9-]{4,32})$/;

/** Turn what a person pasted into a URL Muster can open, or null.
 *
 * Accepted shapes, matching the server's own pairing handoffs:
 *  - full pairing link: https://host:port/claim#CODE (also /pair#CODE text
 *    copied from a server address, and #code=CODE keying)
 *  - bare origin: host:port or https://host
 *  - an address with a path (e.g. behind a reverse proxy): kept as-is
 * userinfo (user:pass@host) is rejected outright: a window that loads it
 * would carry embedded credentials we never asked for. */
export function normalizeRemoteServerInput(input: string): RemoteServerTarget | null {
  const text = input.trim();
  if (!text) return null;

  let url: URL;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text);
  try {
    url = new URL(hasScheme ? text : `http://${text}`);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname || url.username || url.password) return null;
  // A scheme-less paste of a public host is upgraded to https — the same
  // judgement the pairing-link validator makes. An EXPLICIT http:// to a
  // public host is refused, not silently rewritten: the person asked for
  // plain text over the internet, and that is never Muster's shape.
  if (!isLoopbackOrLanHost(url.hostname) && url.protocol !== "https:") {
    if (hasScheme) return null;
    try {
      url = new URL(`https://${text}`);
    } catch {
      return null;
    }
  }

  // Extract a carried code from the fragment without disturbing the path.
  let carriedCode: string | null = null;
  if (url.hash) {
    const match = CLAIM_FRAGMENT.exec(url.hash);
    if (!match) return null;
    carriedCode = (match[1] ?? match[2] ?? null)?.toUpperCase() ?? null;
  }

  const displayPort = url.port ? `:${url.port}` : "";
  return {
    url: url.toString(),
    host: url.hostname.toLowerCase(),
    displayHost: `${url.hostname.toLowerCase()}${displayPort}`,
    carriedCode,
  };
}

/** Recent remote connections, most recent first, deduplicated, capped. */
export const REMOTE_CONNECTIONS_LIMIT = 4;
const REMOTE_CONNECTIONS_KEY = "muster.remote-connections.v1";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

/** What storage is trusted to hold: a JSON array of pasted addresses.
 * Anything else is corruption, and reads back as an empty history. */
const StoredConnections = z.array(z.string());

export function loadRemoteConnections(storage: StorageLike | null | undefined): string[] {
  try {
    const raw = storage?.getItem(REMOTE_CONNECTIONS_KEY);
    if (!raw) return [];
    const decoded = StoredConnections.safeParse(JSON.parse(raw));
    if (!decoded.success) return [];
    const seen = new Set<string>();
    const urls: string[] = [];
    for (const entry of decoded.data) {
      const target = normalizeRemoteServerInput(entry);
      if (!target || seen.has(target.url)) continue;
      seen.add(target.url);
      urls.push(target.url);
    }
    return urls.slice(0, REMOTE_CONNECTIONS_LIMIT);
  } catch {
    return [];
  }
}

export function rememberRemoteConnection(storage: StorageLike | null | undefined, url: string): string[] {
  const target = normalizeRemoteServerInput(url);
  if (!target) return loadRemoteConnections(storage);
  const next = [target.url, ...loadRemoteConnections(storage).filter((existing) => existing !== target.url)];
  const trimmed = next.slice(0, REMOTE_CONNECTIONS_LIMIT);
  try {
    storage?.setItem(REMOTE_CONNECTIONS_KEY, JSON.stringify(trimmed));
  } catch {
    /* quota or private mode: the session still works, history just does not persist */
  }
  return trimmed;
}

export function forgetRemoteConnection(storage: StorageLike | null | undefined, url: string): string[] {
  const target = normalizeRemoteServerInput(url);
  if (!target) return loadRemoteConnections(storage);
  const next = loadRemoteConnections(storage).filter((existing) => existing !== target.url);
  try {
    storage?.setItem(REMOTE_CONNECTIONS_KEY, JSON.stringify(next));
  } catch {
    /* same tolerance as remember: losing history never breaks the session */
  }
  return next;
}
