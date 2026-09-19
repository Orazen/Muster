import { z } from 'zod';
import { createRemoteJWKSet, customFetch, jwtVerify, type JWTVerifyGetKey } from 'jose';

export const GOOGLE_CALENDAR_READONLY_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
const AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const JWKS_ENDPOINT = 'https://www.googleapis.com/oauth2/v3/certs';
const TIMEOUT_MS = 15_000;
const FAILURE = 'Google Calendar authorization failed';
const nonemptyString = z.string().refine(value => value.trim().length > 0);
const tokenSchema = z.object({
  access_token: nonemptyString,
  refresh_token: nonemptyString.optional(),
  id_token: nonemptyString,
  token_type: z.string().refine(value => value.toLowerCase() === 'bearer'),
  expires_in: z.number().finite().positive(),
  scope: z.string(),
});

export type GoogleIdTokenVerifier = (idToken: string, nonce: string) => Promise<string>;

/** The injectable key resolver is for isolated signed-token tests, never runtime configuration. */
export function createGoogleIdTokenVerifier(clientId: string, keyResolver?: JWTVerifyGetKey): GoogleIdTokenVerifier {
  const keys = keyResolver ?? createRemoteJWKSet(new URL(JWKS_ENDPOINT), {
    timeoutDuration: TIMEOUT_MS,
    [customFetch]: (url, options) => fetch(url, { ...options, redirect: 'error' }),
  });
  return async (idToken, nonce) => {
    try {
      const { payload } = await jwtVerify(idToken, keys, {
        issuer: ['accounts.google.com', 'https://accounts.google.com'],
        audience: clientId,
        algorithms: ['RS256'],
        requiredClaims: ['exp', 'sub', 'nonce'],
      });
      if (!nonce || payload.nonce !== nonce || !nonemptyString.safeParse(payload.sub).success
        || (payload.azp !== undefined && payload.azp !== clientId)) throw new Error(FAILURE);
      return nonemptyString.parse(payload.sub);
    } catch {
      throw new Error(FAILURE);
    }
  };
}

export interface GoogleCalendarOAuthOptions {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetch?: typeof globalThis.fetch;
  verifyIdToken?: GoogleIdTokenVerifier;
}

export interface GoogleCalendarOAuthGrant {
  googleSub: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scopes: string[];
}

export class CalendarOAuthRefreshError extends Error {
  readonly reconnectRequired: boolean;
  constructor(reconnectRequired = false) {
    super('Google Calendar refresh failed');
    this.reconnectRequired = reconnectRequired;
  }
}

export class GoogleCalendarOAuthProvider {
  private readonly options: GoogleCalendarOAuthOptions;
  private readonly request: typeof globalThis.fetch;
  private readonly verifyIdToken: GoogleIdTokenVerifier;

  constructor(options: GoogleCalendarOAuthOptions) {
    try {
      const uri = new URL(options.redirectUri);
      const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(uri.hostname);
      if (!options.clientId.trim() || !options.clientSecret.trim()
        || (uri.protocol !== 'https:' && !(uri.protocol === 'http:' && loopback))
        || uri.username || uri.password || uri.hash) throw new Error();
    } catch {
      throw new Error('Invalid Google Calendar OAuth configuration');
    }
    this.options = { ...options };
    this.request = options.fetch ?? globalThis.fetch;
    this.verifyIdToken = options.verifyIdToken ?? createGoogleIdTokenVerifier(options.clientId);
  }

  authorizationUrl({ state, nonce, codeChallenge }: { state: string; nonce: string; codeChallenge: string }): string {
    if (!state || !nonce || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) throw new Error(FAILURE);
    const url = new URL(AUTHORIZATION_ENDPOINT);
    url.search = new URLSearchParams({
      client_id: this.options.clientId,
      redirect_uri: this.options.redirectUri,
      response_type: 'code',
      scope: `openid ${GOOGLE_CALENDAR_READONLY_SCOPE}`,
      access_type: 'offline',
      prompt: 'consent',
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    }).toString();
    return url.toString();
  }

  async refresh(grant: GoogleCalendarOAuthGrant): Promise<GoogleCalendarOAuthGrant> {
    try {
      if (!z.object({ googleSub: nonemptyString, accessToken: nonemptyString, refreshToken: nonemptyString,
        expiresAt: z.number().int().nonnegative().max(8.64e15),
        scopes: z.array(nonemptyString).refine(scopes => scopes.includes(GOOGLE_CALENDAR_READONLY_SCOPE)),
      }).safeParse(grant).success) throw new CalendarOAuthRefreshError(true);
      const response = await this.request(TOKEN_ENDPOINT, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: this.options.clientId, client_secret: this.options.clientSecret,
          grant_type: 'refresh_token', refresh_token: grant.refreshToken! }),
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        const failure = z.object({ error: z.string() }).safeParse(body);
        throw new CalendarOAuthRefreshError(failure.success && failure.data.error === 'invalid_grant');
      }
      const token = tokenSchema.omit({ id_token: true }).extend({ scope: z.string().optional() }).parse(body);
      const scopes = token.scope === undefined ? [...grant.scopes] : [...new Set(token.scope.split(/\s+/).filter(Boolean))];
      if (!scopes.includes(GOOGLE_CALENDAR_READONLY_SCOPE)) throw new CalendarOAuthRefreshError(true);
      const expiresAt = Date.now() + token.expires_in * 1000;
      if (!Number.isSafeInteger(expiresAt) || expiresAt > 8.64e15) throw new CalendarOAuthRefreshError();
      return { googleSub: grant.googleSub, accessToken: token.access_token,
        refreshToken: token.refresh_token ?? grant.refreshToken, expiresAt, scopes };
    } catch (error) {
      throw new CalendarOAuthRefreshError(error instanceof CalendarOAuthRefreshError && error.reconnectRequired);
    }
  }

  async exchange(code: string, { codeVerifier, nonce }: { codeVerifier: string; nonce: string }): Promise<GoogleCalendarOAuthGrant> {
    try {
      if (!code || !nonce || !/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier)) throw new Error(FAILURE);
      const response = await this.request(TOKEN_ENDPOINT, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: this.options.clientId,
          client_secret: this.options.clientSecret,
          redirect_uri: this.options.redirectUri,
          grant_type: 'authorization_code',
          code,
          code_verifier: codeVerifier,
        }),
      });
      if (!response.ok) throw new Error(FAILURE);
      const token = tokenSchema.parse(await response.json());
      const scopes = [...new Set(token.scope.split(/\s+/).filter(Boolean))];
      if (!scopes.includes(GOOGLE_CALENDAR_READONLY_SCOPE)) throw new Error(FAILURE);
      const expiresAt = Date.now() + token.expires_in * 1000;
      if (!Number.isFinite(expiresAt) || expiresAt > 8.64e15) throw new Error(FAILURE);
      const googleSub = nonemptyString.parse(await this.verifyIdToken(token.id_token, nonce));
      const grant: GoogleCalendarOAuthGrant = {
        googleSub,
        accessToken: token.access_token,
        expiresAt,
        scopes,
      };
      if (token.refresh_token !== undefined) grant.refreshToken = token.refresh_token;
      return grant;
    } catch {
      throw new Error(FAILURE);
    }
  }
}
