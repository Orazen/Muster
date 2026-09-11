import { connectionOrigin, parseAddress } from "./connection";

export interface PairingInput {
  address: string;
  code?: string;
  credential?: string;
}

export type NormalizedPairingInput =
  | { address: string; credential: string; code?: never }
  | { address: string; code: string; credential?: never };
export type PairingResolution =
  | { ok: true; method: "invite" | "manual"; value: NormalizedPairingInput }
  | { ok: false; error: string };

const tokenPattern = /^omb_pair_[A-Za-z0-9_-]{43}$/;
const codePattern = /^[0-9]{6}$/;
const invalidInvite = "Paste a complete Muster pairing invitation from your computer.";

function canonicalAddress(address: string): string {
  // Query values have already been decoded once. Do not let URL's hostname
  // parser interpret another percent-encoding layer or discard whitespace.
  if (!address || /[\s%]/.test(address)) throw new Error("Enter a server address without spaces or encoded host characters");
  const authority = address.replace(/^https?:\/\//i, "");
  if (/[/\\]/.test(authority.replace(/\/$/, ""))) throw new Error("Enter the server host and port, without a path");
  return connectionOrigin(parseAddress(address));
}

function invitation(input: string): PairingResolution {
  try {
    // URLSearchParams tolerates malformed escapes; validate encoding first.
    // Raw pipes were separators in older Android invitations. Encoded pipes
    // stay value data because replacement happens before query decoding.
    // Check the literal authority too: URL normalizes away empty userinfo
    // and an empty port, neither of which belongs to the invitation grammar.
    if (!/^muster:\/\/pair\?/i.test(input) || /\s/.test(input) || input.includes("#")) return { ok: false, error: invalidInvite };
    const url = new URL(input);
    if (url.protocol !== "muster:" || url.host !== "pair" || url.pathname !== "" || url.username || url.password || url.port) return { ok: false, error: invalidInvite };
    const query = url.search.slice(1).replace(/\|/g, "&");
    for (const field of query.split("&")) {
      if (!field || !field.includes("=")) return { ok: false, error: invalidInvite };
      const split = field.indexOf("=");
      decodeURIComponent(field.slice(0, split).replace(/\+/g, " "));
      decodeURIComponent(field.slice(split + 1).replace(/\+/g, " "));
    }
    const params = new URLSearchParams(query);
    const keys = [...params.keys()];
    if (keys.some((key) => !["address", "token", "code", "name"].includes(key)) || new Set(keys).size !== keys.length) return { ok: false, error: invalidInvite };
    const address = canonicalAddress(params.get("address") ?? "");
    const code = params.get("code");
    if (code !== null && !codePattern.test(code)) return { ok: false, error: invalidInvite };
    const token = params.get("token");
    if (token !== null) {
      if (!tokenPattern.test(token)) return { ok: false, error: invalidInvite };
      return { ok: true, method: "invite", value: { address, credential: token } };
    }
    // Older invitations explicitly carried only a code. A present invalid
    // token never reaches this branch, even alongside a correct code.
    if (code !== null) return { ok: true, method: "invite", value: { address, code } };
    return { ok: false, error: invalidInvite };
  } catch {
    return { ok: false, error: invalidInvite };
  }
}

/** Pure readiness and submission normalization; no pairing request is sent. */
export function resolvePairingInput(input: PairingInput): PairingResolution {
  const address = input.address.trim();
  if (/^muster:/i.test(address)) {
    const result = invitation(address);
    if (result.ok && input.credential !== undefined && input.credential !== result.value.credential) {
      return { ok: false, error: "The invitation and supplied pairing credential do not match." };
    }
    return result;
  }
  try {
    const normalized = canonicalAddress(address);
    if (input.credential !== undefined) {
      if (!tokenPattern.test(input.credential)) return { ok: false, error: "Use the complete one-time pairing credential from your computer." };
      return { ok: true, method: "manual", value: { address: normalized, credential: input.credential } };
    }
    const code = input.code ?? "";
    if (!codePattern.test(code)) return { ok: false, error: "Enter the 6-digit pairing code from your computer." };
    return { ok: true, method: "manual", value: { address: normalized, code } };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Enter a valid HTTP or HTTPS server address." };
  }
}

/** Compatibility shape for callers that specifically need a token invite. */
export function parsePairingInvite(input: string): { address: string; token: string } | null {
  const result = invitation(input.trim());
  if (!result.ok || !result.value.credential) return null;
  return { address: result.value.address, token: result.value.credential };
}
