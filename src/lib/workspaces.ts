// Connected-workspaces storage + validation for the web app. A saved
// workspace is a bookmark of another Muster deployment (hosted or self-hosted
// with a public address) this browser can hop to — the list lives in this
// browser, per account, and switching is a plain navigation (the other
// deployment owns its own session). No server ever fetches these URLs; the
// reachability probe runs in the user's own browser.
import { z } from "zod";
//
// Validation mirrors the deployment's own SSRF discipline: https-only, and
// localhost/loopback/private/reserved host literals are refused — a web page
// reaching them would be pointless at best (the browser is on a different
// machine than a 127.0.0.1 self-host) and a confusion vector at worst. LAN
// installs are told to open their address directly.

export interface SavedWorkspace {
  id: string;
  origin: string;
  name: string;
  addedAt: number;
}

const KEY_PREFIX = "muster:workspaces:v1:";
const MAX_WORKSPACES = 12;

/** Accepts a bare address, a full pairing link (<origin>/pair#CODE or
 * /pair?code=...), or a muster://pair deep link; returns the origin plus an
 * optional pairing code to carry across. */
export function parseWorkspaceInput(raw: string): { origin: string; code: string | null } | { error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { error: "Enter a workspace address or paste a pairing link." };
  let url: URL;
  try {
    url = new URL(trimmed.startsWith("muster://") ? trimmed.replace(/^muster:\/\//, "https://") : (/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`));
  } catch {
    return { error: "That is not a valid address." };
  }
  // a muster://pair?address=<origin> deep link carries the real host in the
  // address parameter — that is the workspace, not the "pair" placeholder
  const addressParam = trimmed.startsWith("muster://") ? url.searchParams.get("address") : null;
  const code = readCode(url);
  if (addressParam) {
    try {
      url = new URL(addressParam);
    } catch {
      return { error: "The pairing link's address parameter is not a valid URL." };
    }
  }
  if (url.protocol !== "https:") {
    return { error: "Workspaces must be https — for a LAN self-host, open its address directly in a browser tab." };
  }
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "localhost.localdomain") {
    return { error: "localhost is this browser's own machine — a web workspace needs its public address." };
  }
  // a single-label host can never resolve to a public workspace: reject the
  // typo/garbage class ("muster cloud", "myserver") at the front door
  if (!host.includes(".")) {
    return { error: "Enter the workspace's full address, like https://bots.yourcompany.com" };
  }
  // same suffixes the browser panel's navigation guard refuses: names that
  // resolve only inside someone's network are not connectable from the web
  if (/\.(local|internal|lan|home|localdomain)$/.test(host)) {
    return { error: "Network-local addresses are not connectable from the web app — use the workspace's public https address." };
  }
  if (isPrivateLiteral(host)) {
    return { error: "Private and loopback addresses are not connectable from the web app — use the workspace's public https address." };
  }
  return { origin: url.origin, code };
}

function readCode(url: URL): string | null {
  const hash = url.hash.replace(/^#/, "");
  const fromHash = new URLSearchParams(hash).get("code");
  const fromQuery = url.searchParams.get("code");
  const value = fromHash || fromQuery;
  return value && /^[\w-]{4,64}$/.test(value) ? value : null;
}

function isPrivateLiteral(host: string): boolean {
  // IPv6 literals (URL.hostname keeps the brackets, e.g. "[fd00::1]") are
  // refused wholesale: no useful web workspace is addressed that way.
  if (host.startsWith("[") || host.includes(":")) return true;
  const octets = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!octets) return false;
  const a = Number(octets[1]);
  const b = Number(octets[2]);
  if (a === 0 || a === 10 || a === 127 || a === 169 || a >= 224) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a >= 240) return true; // reserved
  return false;
}

const savedWorkspaceSchema = z.object({ id: z.string(), origin: z.string(), name: z.string(), addedAt: z.number() });
const workspaceListSchema = z.array(savedWorkspaceSchema).catch([]);

export function loadWorkspaces(accountId: string): SavedWorkspace[] {
  try {
    return workspaceListSchema.parse(JSON.parse(localStorage.getItem(KEY_PREFIX + encodeURIComponent(accountId)) ?? "[]"));
  } catch {
    return [];
  }
}

export function saveWorkspaces(accountId: string, list: SavedWorkspace[]): void {
  try {
    localStorage.setItem(KEY_PREFIX + encodeURIComponent(accountId), JSON.stringify(list.slice(0, MAX_WORKSPACES)));
  } catch {
    // a full/blocked storage area must not break settings — the list is a
    // convenience, the deployments themselves are unaffected
  }
}

export interface AddWorkspaceResult {
  list: SavedWorkspace[];
  error?: string;
}

export function addWorkspace(accountId: string, origin: string, name: string): AddWorkspaceResult {
  const list = loadWorkspaces(accountId);
  if (list.some((w) => w.origin === origin)) return { list, error: "That workspace is already connected." };
  if (list.length >= MAX_WORKSPACES) return { list, error: "Too many saved workspaces — forget one first." };
  const next = [...list, { id: crypto.randomUUID(), origin, name: name.trim() || new URL(origin).hostname, addedAt: Date.now() }];
  saveWorkspaces(accountId, next);
  return { list: next };
}

export function forgetWorkspace(accountId: string, id: string): SavedWorkspace[] {
  const next = loadWorkspaces(accountId).filter((w) => w.id !== id);
  saveWorkspaces(accountId, next);
  return next;
}

/** Where a switch lands: the workspace's app, carrying a fresh pairing code
 * through to its /pair page when the connect link included one. */
export function switchTarget(origin: string, code?: string | null): string {
  return code ? `${origin}/pair#${encodeURIComponent(code)}` : `${origin}/app`;
}

/** Browser-side reachability probe (no-cors: an opaque success means the
 * host answered; a rejection means DNS/refused/offline). */
export async function probeWorkspace(origin: string): Promise<boolean> {
  try {
    await fetch(`${origin}/api/health`, { mode: "no-cors", signal: AbortSignal.timeout(4000) });
    return true;
  } catch {
    return false;
  }
}
