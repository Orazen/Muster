// The visible-file consent round trip: a dedicated `drive.file` authorization
// with its own redirect, kept deliberately apart from the appData connect
// (drive-oauth.ts) and from Google sign-in (google-auth.ts). Sharing one
// consent across those would let a snapshot token reach a visible file or a
// visible scope ride along in a login redirect; this module therefore
// enforces its own scope set and never imports the appData provider.
//
// Scope sensitivity is not uniform across drive.* — `drive.file` is
// NON-SENSITIVE because access stops at files this app created, which is what
// makes it the right scope for a visible folder the user can open and read.
// Broad `auth/drive` is rejected here rather than merely unused: a consent
// that came back wider than asked for is a failed consent, not a wider grant.
import { z } from "zod";
import { createGoogleIdTokenVerifier, type GoogleIdTokenVerifier } from "./calendar-oauth.ts";
import { VISIBLE_FILE_SCOPE, VISIBLE_OIDC_SCOPE } from "./drive-visible-grants.ts";

export const GOOGLE_VISIBLE_FILE_SCOPE = VISIBLE_FILE_SCOPE;
const AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const TIMEOUT_MS = 15_000;
const FAILURE = "Visible file authorization failed";
const nonemptyString = z.string().refine(value => value.trim().length > 0);

/** OIDC identity plus `drive.file`, and nothing else. */
export const VISIBLE_CONSENT_SCOPES = `${VISIBLE_OIDC_SCOPE} ${VISIBLE_FILE_SCOPE}`;

const tokenSchema = z.object({
  access_token: nonemptyString,
  refresh_token: nonemptyString.optional(),
  id_token: nonemptyString,
  token_type: z.string().refine(value => value.toLowerCase() === "bearer"),
  expires_in: z.number().finite().positive(),
  scope: z.string(),
});

/**
 * The exact scope set a visible consent may come back with. Closed, like the
 * grant's: a token response carrying `auth/drive`, `drive.readonly`,
 * `drive.metadata` or `drive.appdata` is refused before it is ever persisted,
 * so what the user consented to and what we hold cannot drift apart.
 */
const ALLOWED_SCOPES = new Set<string>([VISIBLE_OIDC_SCOPE, VISIBLE_FILE_SCOPE]);

function parseGrantedScopes(scope: string): string[] {
  const scopes = [...new Set(scope.split(/\s+/).filter(Boolean))];
  // Narrow on both counts: the scope we asked for must be present, and every
  // scope returned must be one of the two this consent is allowed to hold.
  if (!scopes.includes(VISIBLE_FILE_SCOPE)) throw new Error(FAILURE);
  if (!scopes.every(candidate => ALLOWED_SCOPES.has(candidate))) throw new Error(FAILURE);
  return scopes;
}

export interface VisibleFileOAuthOptions {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetch?: typeof globalThis.fetch;
  verifyIdToken?: GoogleIdTokenVerifier;
}

export interface VisibleFileOAuthGrant {
  googleSub: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scopes: string[];
}

export class VisibleFileOAuthRefreshError extends Error {
  readonly reconnectRequired: boolean;
  constructor(reconnectRequired = false) {
    super("Visible file refresh failed");
    this.reconnectRequired = reconnectRequired;
  }
}

export class VisibleFileOAuthProvider {
  private readonly options: VisibleFileOAuthOptions;
  private readonly request: typeof globalThis.fetch;
  private readonly verifyIdToken: GoogleIdTokenVerifier;

  constructor(options: VisibleFileOAuthOptions) {
    try {
      const uri = new URL(options.redirectUri);
      const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(uri.hostname);
      if (!options.clientId.trim() || !options.clientSecret.trim()
        || (uri.protocol !== "https:" && !(uri.protocol === "http:" && loopback))
        || uri.username || uri.password || uri.hash) throw new Error();
    } catch {
      throw new Error("Invalid visible file OAuth configuration");
    }
    this.options = { ...options };
    this.request = options.fetch ?? globalThis.fetch;
    this.verifyIdToken = options.verifyIdToken ?? createGoogleIdTokenVerifier(options.clientId);
  }

  /**
   * The consent URL. `prompt: consent` keeps every visible connection an
   * explicit, re-showable decision rather than a silent re-authorisation, and
   * the scope string is fixed so no caller can widen it at this boundary.
   */
  authorizationUrl({ state, nonce, codeChallenge }: { state: string; nonce: string; codeChallenge: string }): string {
    if (!state || !nonce || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) throw new Error(FAILURE);
    const url = new URL(AUTHORIZATION_ENDPOINT);
    url.search = new URLSearchParams({
      client_id: this.options.clientId,
      redirect_uri: this.options.redirectUri,
      response_type: "code",
      scope: VISIBLE_CONSENT_SCOPES,
      access_type: "offline",
      prompt: "consent",
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    }).toString();
    return url.toString();
  }

  async refresh(grant: VisibleFileOAuthGrant): Promise<VisibleFileOAuthGrant> {
    try {
      if (!z.object({
        googleSub: nonemptyString, accessToken: nonemptyString, refreshToken: nonemptyString,
        expiresAt: z.number().int().nonnegative().max(8.64e15),
        scopes: z.array(nonemptyString).refine(
          scopes => scopes.includes(VISIBLE_FILE_SCOPE) && scopes.every(scope => ALLOWED_SCOPES.has(scope)),
        ),
      }).safeParse(grant).success) throw new VisibleFileOAuthRefreshError(true);
      const response = await this.request(TOKEN_ENDPOINT, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: this.options.clientId, client_secret: this.options.clientSecret,
          grant_type: "refresh_token", refresh_token: grant.refreshToken!,
        }),
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        const failure = z.object({ error: z.string() }).safeParse(body);
        throw new VisibleFileOAuthRefreshError(failure.success && failure.data.error === "invalid_grant");
      }
      const token = tokenSchema.omit({ id_token: true }).extend({ scope: z.string().optional() }).parse(body);
      // A refresh that omits the scope keeps the one we already hold. A refresh
      // that *proves* a different, substituted or widened scope is a different
      // consent than the one stored, so it is reconnect-required rather than
      // silently narrowed — thrown as this class so the outer wrap preserves
      // the flag instead of downgrading it to a plain transport failure.
      let scopes: string[];
      if (token.scope === undefined) {
        scopes = [...grant.scopes];
      } else {
        try {
          scopes = parseGrantedScopes(token.scope);
        } catch {
          throw new VisibleFileOAuthRefreshError(true);
        }
      }
      if (!scopes.includes(VISIBLE_FILE_SCOPE) || !scopes.every(scope => ALLOWED_SCOPES.has(scope))) {
        throw new VisibleFileOAuthRefreshError(true);
      }
      const now = Date.now();
      const expiresAt = now + token.expires_in * 1000;
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > 8.64e15) throw new VisibleFileOAuthRefreshError();
      return { googleSub: grant.googleSub, accessToken: token.access_token,
        refreshToken: token.refresh_token ?? grant.refreshToken, expiresAt, scopes };
    } catch (error) {
      throw new VisibleFileOAuthRefreshError(
        error instanceof VisibleFileOAuthRefreshError && error.reconnectRequired,
      );
    }
  }

  async exchange(code: string, { codeVerifier, nonce }: { codeVerifier: string; nonce: string }): Promise<VisibleFileOAuthGrant> {
    try {
      if (!code || !nonce || !/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier)) throw new Error(FAILURE);
      const response = await this.request(TOKEN_ENDPOINT, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: this.options.clientId,
          client_secret: this.options.clientSecret,
          redirect_uri: this.options.redirectUri,
          grant_type: "authorization_code",
          code,
          code_verifier: codeVerifier,
        }),
      });
      if (!response.ok) throw new Error(FAILURE);
      const token = tokenSchema.parse(await response.json());
      const scopes = parseGrantedScopes(token.scope);
      const now = Date.now();
      const expiresAt = now + token.expires_in * 1000;
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > 8.64e15) throw new Error(FAILURE);
      const googleSub = nonemptyString.parse(await this.verifyIdToken(token.id_token, nonce));
      if (expiresAt <= Date.now()) throw new Error(FAILURE);
      const grant: VisibleFileOAuthGrant = { googleSub, accessToken: token.access_token, expiresAt, scopes };
      if (token.refresh_token !== undefined) grant.refreshToken = token.refresh_token;
      return grant;
    } catch {
      throw new Error(FAILURE);
    }
  }
}
