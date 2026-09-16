// Pairing-link parsing for Muster remote access.
//
// A self-hosted pairing link looks like:
//   https://host/pair#code=XXXX-XXXX-XXXX   (12 chars in 4-4-4 groups)
// A desktop-companion code is 6 digits, carried the same way:
//   https://host/pair#code=123456
// Muster's own switchTarget() emits the bare-fragment form (/pair#CODE); that
// is accepted too, because a link Muster produced must round-trip.
// A code in the query string (?code=...) is rejected on purpose.
//
// Host rules mirror src/lib/workspaces.ts (https-only, and localhost /
// loopback / private / reserved hosts refused) by reusing its exported
// parseWorkspaceInput host check rather than restating the rules.
import { parseWorkspaceInput } from "./workspaces";

export type PairingMode = "self-hosted" | "companion";

/** `missingCode` marks the one failure that is not malformed input: a link
 * that points at a real /pair page and simply has no code in it yet, which the
 * client role may still connect to as a plain workspace. */
export type PairingLinkResult =
  | { ok: true; host: string; code: string; mode: PairingMode }
  | { ok: false; reason: string; missingCode?: boolean };

const SELF_HOSTED_CODE = /^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/;
const COMPANION_CODE = /^\d{6}$/;

export function parsePairingLink(raw: string): PairingLinkResult {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return { ok: false, reason: "Enter a pairing link." };

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: "That is not a valid pairing link." };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "Pairing links must use http or https." };
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
  // Muster's own switchTarget() emits the bare form (/pair#CODE) while the
  // documented form keys the code (/pair#code=CODE). Both are fragments, which
  // is the rule that matters; a fragment that is neither is treated as absent
  // rather than as a code.
  const keyed = new URLSearchParams(fragment).get("code");
  const bare = /^[A-Za-z0-9-]+$/.test(fragment) ? fragment : "";
  const code = (keyed ?? bare).trim();

  if (SELF_HOSTED_CODE.test(code)) return { ok: true, host, code, mode: "self-hosted" };
  if (COMPANION_CODE.test(code)) return { ok: true, host, code, mode: "companion" };
  if (!code) {
    return { ok: false, reason: "That link has no pairing code in its fragment (#code=...).", missingCode: true };
  }
  return { ok: false, reason: "No valid pairing code found in the link fragment." };
}

/** True when the input is an http(s) URL that carries a code or points at a
 * /pair page — i.e. a pairing link rather than a bare workspace address. The
 * native `muster://pair` deep link is deliberately excluded: it is the
 * desktop-companion handoff and keeps its own parser path. */
export function isPairingLinkInput(raw: string): boolean {
  const trimmed = String(raw ?? "").trim();
  if (!/^https?:\/\//i.test(trimmed)) return false;
  if (/[#?]/.test(trimmed)) return true;
  return /\/pair(?:[/?#]|$)/i.test(trimmed);
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

/** The one place the client role decides. Pairing-link input is held to the
 * strict fragment rule first; only input that is not a pairing link falls
 * through to the address parser, which keeps any explicit port. */
export function planWorkspaceConnect(raw: string): ConnectPlan {
  const trimmed = String(raw ?? "").trim();
  const link = isPairingLinkInput(trimmed) ? parsePairingLink(trimmed) : null;

  if (link?.ok && link.mode === "companion") return { kind: "desktop-code", code: link.code };
  // A malformed code or a refused host is an error. A /pair link that merely
  // has no code in it is not: it is still an address worth connecting to.
  if (link && !link.ok && !link.missingCode) return { kind: "error", error: link.reason };

  const parsed = parseWorkspaceInput(trimmed);
  if ("error" in parsed) return { kind: "error", error: parsed.error };
  if (link?.ok) return { kind: "link", origin: parsed.origin, code: link.code };
  return { kind: "address", origin: parsed.origin, code: parsed.code };
}