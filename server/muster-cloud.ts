// Muster Cloud identity bridge — opt-in, additive, off by default.
//
// The default story stays exactly what it's always been: a self-hosted or
// packaged desktop Muster needs zero internet connection and trusts no
// server beyond itself. This module is what lets someone OPT IN to "the
// same email+password works on the web app and every desktop install too"
// without changing that default for anyone who doesn't set
// OMB_MUSTER_CLOUD_URL.
//
// What this deliberately does NOT do: sync bots, threads, or messages
// between installs. Each install's data stays exactly where it's always
// been — local to that install. This bridges IDENTITY only: proving "this
// email+password pair is the same real account" across independent local
// databases, not merging their data. That's a much bigger, separate
// project (real sync — conflict resolution, offline-first merge — not
// attempted here).
//
// How it works: a central Muster deployment (the "cloud", by default
// wherever OMB_MUSTER_CLOUD_URL points) is the identity a set of installs
// agree to trust. When a sign-up or sign-in request comes in on an install
// with this enabled, this module first proves the credentials are valid
// against that central server (creating the account there on first use,
// or verifying against it on every use after), then lets the LOCAL
// better-auth instance create/verify its own local account with the exact
// same email+password. Both stores keep their own independent password
// hash of the same plaintext the user just typed — no hash-format
// coupling, no shared secret beyond the URL itself.
import type { AppConfig } from "./config.ts";

export function musterCloudUrl(cfg?: AppConfig): string | null {
  const raw = cfg?.musterCloud?.url?.trim() || process.env.OMB_MUSTER_CLOUD_URL?.trim();
  if (!raw) return null;
  return raw.replace(/\/$/, "");
}

export function musterCloudEnabled(cfg?: AppConfig): boolean {
  return musterCloudUrl(cfg) !== null;
}

/** Verify (or, on first use, create) this identity against the central
 * server. Returns true only when the central server actually confirms the
 * credentials — never trust a network error as "verified". */
export async function verifyAgainstMusterCloud(
  cloudUrl: string,
  email: string,
  password: string,
  name: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  // Better Auth's CSRF check rejects any request with no Origin header at
  // all ("Missing or null Origin") — found live-testing this, a request
  // with zero Origin header is treated as untrusted, not as same-origin.
  // The central server's own trustedOrigins list (server/auth.ts) already
  // includes its own PUBLIC_BASE_URL, so identifying this server-to-server
  // call AS the cloud server's own origin satisfies that check correctly.
  const headers = { "content-type": "application/json", origin: cloudUrl };
  const signIn = await fetch(`${cloudUrl}/api/auth/sign-in/email`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email, password }),
  }).catch((e) => ({ ok: false as const, status: 0, error: String(e) }));

  if ("ok" in signIn && signIn.ok) return { ok: true };

  // Not an existing cloud account with this password — try creating one.
  // A real "account exists, wrong password" case correctly fails here too
  // (sign-up will 4xx for an email that already exists on the cloud).
  const signUp = await fetch(`${cloudUrl}/api/auth/sign-up/email`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email, password, name }),
  }).catch((e) => ({ ok: false as const, status: 0, error: String(e) }));

  if ("ok" in signUp && signUp.ok) return { ok: true };

  return { ok: false, reason: "Muster Cloud rejected the sign-in — check the email and password." };
}
