// Pairing-link parsing for Muster remote access.
//
// Muster's own codes are 8 characters from the unambiguous alphabet
// (server/pairing.ts and server/claim.ts), and a desktop-companion code is 6
// digits (src/lib/companion-pairing.ts). A deployment may also print a grouped
// 12-character form. The rule below accepts exactly those shapes — eight code
// characters, or hyphen-separated groups of four — so a short or
// underscore-bearing fragment is no longer parsed as a code.
//
// The shape that matters is positional, not stylistic: a pairing *code* must
// arrive in the link fragment, never in the query string.
//
// Host rules mirror src/lib/workspaces.ts (https-only, and localhost /
// loopback / private / reserved hosts refused) by reusing its exported
// parseWorkspaceInput host check rather than restating the rules.
import { parseWorkspaceInput } from "./workspaces";

export type PairingMode = "self-hosted" | "companion" | "cloud";

/** `missingCode` marks the one failure that is not a mistake the user made: a
 * link that points at a real /pair page and simply has no usable code in it,
 * which the client role may still connect to as a plain workspace. */
export type PairingLinkResult =
  | { ok: true; host: string; code: string; mode: PairingMode }
  | { ok: false; reason: string; missingCode?: boolean };

/** Any code Muster or a compatible deployment issues: 8-char alphabet codes,
 * 6-digit companion codes, and the grouped 12-character form — 8 to 64 code
 * characters, hyphens only as group separators. A short fragment ("#code=ab")
 * is no code at all, and an underscore never appears in an issued code. */
const SELF_HOSTED_CODE = /^(?:[A-Za-z0-9]{8}|[A-Za-z0-9]{4}(?:-[A-Za-z0-9]{4}){1,15})$/;
const COMPANION_CODE = /^\d{6}$/;
/** The cloud issuer's alphabet: 8 characters, no 0/O/1/I/L, typed by hand off
 * another screen (server/pairing.ts, server/claim.ts). */
const CLOUD_CODE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/;
/** A bare fragment is only a code on the /pair page; anywhere else it is an
 * ordinary anchor and must not be read as one. */
const PAIR_PATH = /\/pair\/?$/i;

export type CarriedCodeMode = "cloud" | "companion" | "self-hosted";

export interface CarriedCode {
  code: string;
  mode: CarriedCodeMode;
}

/** A bare fragment is only read as a code when it is at least plausibly one —
 * ordinary anchors like #pricing or #step=1 are left for the page to handle
 * its own way rather than guessed; modeOf makes the final call. */
const PLAUSIBLE_CODE_FRAGMENT = /^[A-Za-z0-9-]{6,64}$/;

function modeOf(code: string): CarriedCodeMode | null {
  // Six digits is checked first: it is also a valid run of the cloud alphabet,
  // and the two shapes mean different things. The cloud alphabet is checked
  // before the group form so an 8-character code keeps its issuer's mode.
  if (COMPANION_CODE.test(code)) return "companion";
  if (CLOUD_CODE.test(code)) return "cloud";
  if (SELF_HOSTED_CODE.test(code)) return "self-hosted";
  return null;
}

/** The code carried by a `/pair` visit's fragment, or null when the page was
 * opened normally. A present-but-unrecognised fragment (e.g. `#pricing`)
 * returns null rather than an error — the page should degrade to showing its
 * own code, not block the visitor. */
export function parseFragmentCode(hash: string | null | undefined): CarriedCode | null {
  const fragment = String(hash ?? "").replace(/^#/, "").trim();
  const keyed = new URLSearchParams(fragment).get("code");
  const candidate = (keyed ?? (PLAUSIBLE_CODE_FRAGMENT.test(fragment) ? fragment : "")).trim();
  if (!candidate) return null;
  const mode = modeOf(candidate);
  return mode ? { code: candidate, mode } : null;
}

/** One-line, copyable redemption instruction keyed to how the code was
 * issued. The page that shows a carried code never redeems it itself. */
export function carriedCodeInstruction(code: CarriedCode, origin: string): string {
  if (code.mode === "cloud") {
    return `Enter this code in Muster Desktop to sign in as the account that issued it on ${origin}, or run \`muster pair --redeem ${code.code} --cloud ${origin}\` on that account.`;
  }
  if (code.mode === "self-hosted") {
    return `This is a server pairing code for ${origin}. Enter it in the app connecting to that server — or paste the whole link there.`;
  }
  return "This is a desktop-companion code — enter it in Muster Desktop's pairing field on the computer it was issued for.";
}

/** What a 6-digit code, or a deep link the browser cannot redeem, deserves to
 * be told. Exported so the copy lives beside the decision that produces it. */
export const DESKTOP_LINK_GUIDANCE =
  "That is a desktop-companion code. Open Muster Desktop on the computer it was issued for and enter it in the app's pairing field — a companion code pairs the desktop app and does not connect a workspace here.";

/** Adds the scheme workspaces.ts also assumes, so a link pasted out of prose is
 * judged by the same rules as one pasted whole. A non-http scheme is left
 * untouched and refused by the protocol check below. */
function withScheme(trimmed: string): string {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export function parsePairingLink(raw: string): PairingLinkResult {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return { ok: false, reason: "Enter a pairing link." };

  let url: URL;
  try {
    url = new URL(withScheme(trimmed));
  } catch {
    return { ok: false, reason: "That is not a valid pairing link." };
  }

  if (url.protocol !== "https:") {
    return { ok: false, reason: "Pairing links must use https." };
  }

  // A code carried in the query string is explicitly not accepted; the
  // code must arrive in the fragment.
  if (url.searchParams.has("code")) {
    return { ok: false, reason: "Pairing codes must be in the link fragment (#code=...), not the query string." };
  }

  // Reuse the workspace link's host validation: https-only, and a public
  // host that is not localhost/loopback/private/reserved.
  const hostCheck = parseWorkspaceInput(url.origin);
  if ("error" in hostCheck) return { ok: false, reason: hostCheck.error };
  const host = new URL(hostCheck.origin).hostname.toLowerCase();

  const fragment = url.hash.replace(/^#/, "");
  // The keyed form (#code=CODE) is the documented one. The bare form
  // (/pair#CODE) is what Muster's own switchTarget() emits and must round-trip
  // — but only on the /pair page: on any other path an unrecognised fragment is
  // an ordinary anchor, not a mistake, so it leaves the link code-less instead
  // of failing it.
  const keyed = new URLSearchParams(fragment).get("code");
  const candidate = (keyed ?? (PAIR_PATH.test(url.pathname) ? fragment : "")).trim();

  // Six digits is checked first: it is also a valid run of the code alphabet,
  // and the two shapes mean different things. The cloud alphabet is checked
  // next so an 8-character code keeps its cloud mode (modeOf's ordering).
  if (COMPANION_CODE.test(candidate)) return { ok: true, host, code: candidate, mode: "companion" };
  if (CLOUD_CODE.test(candidate)) return { ok: true, host, code: candidate, mode: "cloud" };
  if (SELF_HOSTED_CODE.test(candidate)) return { ok: true, host, code: candidate, mode: "self-hosted" };
  return { ok: false, reason: "That link has no pairing code in its fragment (#code=...).", missingCode: true };
}

/** True when the input is meant as a pairing link rather than a bare workspace
 * address: it points at a /pair page, or it keys a code explicitly. The native
 * `muster://pair` deep link is deliberately excluded — it is the
 * desktop-companion handoff and keeps its own parser path. */
export function isPairingLinkInput(raw: string): boolean {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return false;
  const scheme = trimmed.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (scheme && !/^https?$/i.test(scheme[1])) return false;
  if (PAIR_PATH.test(trimmed.split(/[?#]/)[0])) return true;
  return /(?:^|[#&?])code=/i.test(trimmed);
}

/** What the web client role should do with one entry in "Connect hosted
 * workspace". Kept out of the component so the decision is testable without a
 * rendered tree, the way CompanionStateRequests is. */
export type ConnectPlan =
  // a self-hosted server link: connect there and carry the code across
  | { kind: "link"; origin: string; code: string }
  // a bare address (or a /pair page with no code yet): connect without one
  | { kind: "address"; origin: string; code: string | null }
  // a 6-digit code belongs to the desktop app, not to a browser workspace
  | { kind: "desktop-code"; code: string }
  | { kind: "error"; error: string };

/** The native desktop-companion handoff (companionPairingLink). The web client
 * role cannot redeem it — its address is a LAN host:port the browser refuses by
 * design — so it is reported as the desktop handoff it is rather than as a
 * workspace address that failed. */
function isCompanionDeepLink(trimmed: string): boolean {
  return /^muster:\/\/pair(?:[/?#]|$)/i.test(trimmed);
}

/** The one place the client role decides. Pairing-link input is held to the
 * strict fragment rule first; only input that is not a pairing link falls
 * through to the address parser, which keeps any explicit port. */
export function planWorkspaceConnect(raw: string): ConnectPlan {
  const trimmed = String(raw ?? "").trim();
  if (isCompanionDeepLink(trimmed)) {
    let code = "";
    try {
      code = new URL(trimmed).searchParams.get("code") ?? "";
    } catch {
      // still a desktop handoff, just an unreadable one
    }
    if (COMPANION_CODE.test(code)) return { kind: "desktop-code", code };
    return { kind: "error", error: DESKTOP_LINK_GUIDANCE };
  }

  const link = isPairingLinkInput(trimmed) ? parsePairingLink(trimmed) : null;

  if (link?.ok && link.mode === "companion") return { kind: "desktop-code", code: link.code };
  // A query-string code, a refused host or a non-https scheme is a real mistake
  // and is reported. A /pair link that merely has no code in it is not: it is
  // still an address worth connecting to.
  if (link && !link.ok && !link.missingCode) return { kind: "error", error: link.reason };

  const parsed = parseWorkspaceInput(trimmed);
  if ("error" in parsed) return { kind: "error", error: parsed.error };
  if (link?.ok) return { kind: "link", origin: parsed.origin, code: link.code };
  return { kind: "address", origin: parsed.origin, code: parsed.code };
}