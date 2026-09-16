// NOTE (bridge): this fragment parser is intentionally self-contained so that
// `src/pages/PairPage.tsx` can be finished WITHOUT editing
// `src/lib/pairing-link.ts` while a parallel writer has that module mid-flight.
// Once pairing-link.ts lands a fragment-only export (it is shaping up to),
// `PairPage` should import from there and this file should be deleted. The code
// shapes below mirror Muster's own issuers exactly:
//  - `server/pairing.ts` and `server/claim.ts` each issue 8 chars of
//    `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no 0/O/1/I/L, typed by hand off
//    another screen);
//  - `src/lib/companion-pairing.ts` issues a 6-digit desktop code.
// A `/pair` page is only ever served by the host that issued the code, so a
// carried code always belongs to the host the visitor is already on — the page
// never connects them "to another computer". It only ever *displays* the code
// and tells the visitor how to redeem it in the desktop app / CLI. The page
// itself never consumes it: `POST /api/pair/verify` is a device redeemer.
export type CarriedCodeMode = "cloud" | "companion" | "self-hosted";

export interface CarriedCode {
  code: string;
  mode: CarriedCodeMode;
}

const CLOUD_CODE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/;
const COMPANION_CODE = /^\d{6}$/;
const SELF_HOSTED_CODE = /^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/;

/** A bare fragment is only read as a code when it is at least plausibly code —
 * ordinary anchors like #pricing or #step=1 are left for the page to handle
 * its own way rather than guessed. */
const BARE_CODE_FRAGMENT = /^[A-Za-z0-9-]{6,64}$/;

function modeOf(code: string): CarriedCodeMode | null {
  // Six digits is checked first: it is also a valid run of the cloud alphabet,
  // and the two shapes mean different things.
  if (COMPANION_CODE.test(code)) return "companion";
  if (SELF_HOSTED_CODE.test(code)) return "self-hosted";
  if (CLOUD_CODE.test(code)) return "cloud";
  return null;
}

/** The code carried by a `/pair` visit's fragment, or null when the page was
 * opened normally. A present-but-unrecognised fragment (e.g. `#pricing`) returns
 * null rather than an error — the page should degrade to showing its own code,
 * not block the visitor. */
export function parseFragmentCode(hash: string | null | undefined): CarriedCode | null {
  const fragment = String(hash ?? "").replace(/^#/, "").trim();
  const keyed = new URLSearchParams(fragment).get("code");
  const candidate = (keyed ?? (BARE_CODE_FRAGMENT.test(fragment) ? fragment : "")).trim();
  if (!candidate) return null;
  const mode = modeOf(candidate);
  return mode ? { code: candidate, mode } : null;
}

/** One-line, copyable redemption instruction keyed to how the code was issued. */
export function carriedCodeInstruction(code: CarriedCode, origin: string): string {
  if (code.mode === "cloud") {
    return `Enter this code in Muster Desktop to sign in as the account that issued it on ${origin}, or run \`muster pair --redeem ${code.code} --cloud ${origin}\` on that account.`;
  }
  return "This is a desktop-companion code — enter it in Muster Desktop's pairing field on the computer it was issued for.";
}
