import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { createGoogleIdTokenVerifier, GOOGLE_CALENDAR_READONLY_SCOPE, GoogleCalendarOAuthProvider } from './calendar-oauth.ts';

const config = { clientId: 'calendar-client', clientSecret: 'fixture-secret', redirectUri: 'https://muster.example/calendar/callback' };
const nonce = 'fixture-nonce';
const codeVerifier = 'v'.repeat(43);
const validResponse = () => ({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', id_token: 'fixture-id-token', token_type: 'Bearer', expires_in: 3600, scope: `openid ${GOOGLE_CALENDAR_READONLY_SCOPE}` });
type FixtureBody = Record<string, string | number | null | undefined>;
function fixture(body: FixtureBody = validResponse(), status = 200) {
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body), { status }));
  const verifyIdToken = vi.fn().mockResolvedValue('google-account');
  const provider = new GoogleCalendarOAuthProvider({ ...config, fetch: request, verifyIdToken });
  return { provider, request, verifyIdToken };
}

describe('Google Calendar OAuth adapter', () => {
  it('requests explicit read-only consent with state, nonce and PKCE', () => {
    const url = new URL(fixture().provider.authorizationUrl({ state: 'state-value', nonce, codeChallenge: 'c'.repeat(43) }));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(url.searchParams)).toEqual({ client_id: config.clientId, redirect_uri: config.redirectUri, response_type: 'code', scope: `openid ${GOOGLE_CALENDAR_READONLY_SCOPE}`, access_type: 'offline', prompt: 'consent', state: 'state-value', nonce, code_challenge: 'c'.repeat(43), code_challenge_method: 'S256' });
    expect(url.searchParams.has('include_granted_scopes')).toBe(false);
  });

  it('exchanges only at the official endpoint with bounded requests and verified identity', async () => {
    const { provider, request, verifyIdToken } = fixture();
    const before = Date.now();
    const result = await provider.exchange('fixture-code', { codeVerifier, nonce });
    expect(result).toMatchObject({ googleSub: 'google-account', accessToken: 'fixture-access', refreshToken: 'fixture-refresh', scopes: ['openid', GOOGLE_CALENDAR_READONLY_SCOPE] });
    expect(result.expiresAt).toBeGreaterThanOrEqual(before + 3600_000);
    expect(verifyIdToken).toHaveBeenCalledWith('fixture-id-token', nonce);
    const [url, options] = request.mock.calls[0];
    expect(url).toBe('https://oauth2.googleapis.com/token');
    expect(options).toMatchObject({ method: 'POST', redirect: 'error', signal: expect.any(AbortSignal) });
    // SAFETY: The adapter creates URLSearchParams for the token request; its request shape is asserted above.
    expect(Object.fromEntries(options!.body as URLSearchParams)).toEqual({ client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: config.redirectUri, grant_type: 'authorization_code', code: 'fixture-code', code_verifier: codeVerifier });
  });

  it('allows a response without a refresh token', async () => {
    const body: FixtureBody = validResponse();
    delete body.refresh_token;
    expect(await fixture(body).provider.exchange('code', { codeVerifier, nonce })).not.toHaveProperty('refreshToken');
  });

  it.each([
    { access_token: '' }, { id_token: '' }, { token_type: 'Basic' }, { expires_in: 0 },
    { expires_in: -1 }, { expires_in: '3600' }, { expires_in: null }, { expires_in: 1e308 },
    { scope: 'https://www.googleapis.com/auth/calendar' }, { scope: `${GOOGLE_CALENDAR_READONLY_SCOPE}.extra` },
    { refresh_token: '' }, { refresh_token: 123 },
  ])('rejects malformed or insufficient grants: %j', async (patch) => {
    const { provider, verifyIdToken } = fixture({ ...validResponse(), ...patch });
    await expect(provider.exchange('code', { codeVerifier, nonce })).rejects.toThrow(/^Google Calendar authorization failed$/);
    expect(verifyIdToken).not.toHaveBeenCalled();
  });

  it('suppresses provider and verifier error details', async () => {
    const failure = fixture({ error_description: 'PRIVATE_PROVIDER_DETAIL' }, 400);
    await expect(failure.provider.exchange('code', { codeVerifier, nonce })).rejects.toThrow(/^Google Calendar authorization failed$/);
    const identity = fixture();
    identity.verifyIdToken.mockRejectedValue(new Error('PRIVATE_ID_TOKEN'));
    await expect(identity.provider.exchange('code', { codeVerifier, nonce })).rejects.toThrow(/^Google Calendar authorization failed$/);
    const network = fixture();
    network.request.mockRejectedValue(new Error('PRIVATE_NETWORK_DETAIL'));
    await expect(network.provider.exchange('code', { codeVerifier, nonce })).rejects.toThrow(/^Google Calendar authorization failed$/);
  });

  it.each(['http://remote.example/callback', 'ftp://localhost/callback', 'https://user:pass@example.com/callback', 'https://example.com/#fragment', 'not a url'])('refuses invalid redirect %s', (redirectUri) => {
    expect(() => new GoogleCalendarOAuthProvider({ ...config, redirectUri })).toThrow('Invalid Google Calendar OAuth configuration');
  });
  it.each(['http://localhost:9999/callback', 'http://127.0.0.1:9999/callback', 'http://[::1]:9999/callback'])('accepts loopback HTTP %s', (redirectUri) => {
    expect(() => new GoogleCalendarOAuthProvider({ ...config, redirectUri })).not.toThrow();
  });
  it('rejects missing correlation and malformed PKCE before making a request', async () => {
    const { provider, request } = fixture();
    expect(() => provider.authorizationUrl({ state: '', nonce, codeChallenge: 'c'.repeat(43) })).toThrow();
    await expect(provider.exchange('code', { codeVerifier: 'short', nonce })).rejects.toThrow();
    await expect(provider.exchange('code', { codeVerifier, nonce: '' })).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
});

describe('Google signed identity verification', () => {
  let keys: Awaited<ReturnType<typeof generateKeyPair>>;
  let verify: ReturnType<typeof createGoogleIdTokenVerifier>;
  beforeAll(async () => {
    keys = await generateKeyPair('RS256');
    const jwk = await exportJWK(keys.publicKey);
    verify = createGoogleIdTokenVerifier(config.clientId, createLocalJWKSet({ keys: [{ ...jwk, kid: 'fixture-key', alg: 'RS256' }] }));
  });
  function sign(patch: JWTPayload = {}) {
    return new SignJWT({ iss: 'https://accounts.google.com', aud: config.clientId, sub: 'verified-sub', nonce, exp: Math.floor(Date.now() / 1000) + 120, ...patch }).setProtectedHeader({ alg: 'RS256', kid: 'fixture-key' }).sign(keys.privateKey);
  }
  it.each(['https://accounts.google.com', 'accounts.google.com'])('accepts correctly signed Google issuer %s', async (iss) => {
    expect(await verify(await sign({ iss, azp: config.clientId }), nonce)).toBe('verified-sub');
  });
  it.each([
    { nonce: 'wrong' }, { aud: 'wrong-client' }, { iss: 'https://attacker.example' },
    { exp: 1 }, { exp: undefined }, { sub: '' }, { azp: 'wrong-client' },
  ])('rejects invalid signed claims %j', async (patch) => {
    await expect(verify(await sign(patch), nonce)).rejects.toThrow(/^Google Calendar authorization failed$/);
  });
  it('rejects forged signatures and unsigned tokens', async () => {
    const impostor = await generateKeyPair('RS256');
    const jwt = await new SignJWT({ iss: 'https://accounts.google.com', aud: config.clientId, sub: 'forged', nonce, exp: Math.floor(Date.now() / 1000) + 120 }).setProtectedHeader({ alg: 'RS256', kid: 'fixture-key' }).sign(impostor.privateKey);
    await expect(verify(jwt, nonce)).rejects.toThrow(/^Google Calendar authorization failed$/);
    await expect(verify('eyJhbGciOiJub25lIn0.e30.', nonce)).rejects.toThrow(/^Google Calendar authorization failed$/);
  });
});

describe('Calendar refresh', () => {
  const old = { googleSub: 'verified-user', accessToken: 'old', refreshToken: 'existing-refresh', expiresAt: 1, scopes: ['openid', GOOGLE_CALENDAR_READONLY_SCOPE] };
  it('preserves verified identity, omitted scopes and refresh token at the bounded official endpoint', async () => {
    const { provider, request, verifyIdToken } = fixture({ access_token: 'new', token_type: 'Bearer', expires_in: 3600 });
    expect(await provider.refresh(old)).toMatchObject({ googleSub: old.googleSub, refreshToken: old.refreshToken, scopes: old.scopes, accessToken: 'new' });
    expect(verifyIdToken).not.toHaveBeenCalled();
    const [url, options] = request.mock.calls[0];
    expect(url).toBe('https://oauth2.googleapis.com/token');
    expect(options).toMatchObject({ redirect: 'error', signal: expect.any(AbortSignal) });
    expect(String(options?.body)).toContain('grant_type=refresh_token');
  });
  it.each([{ scope: 'openid' }, { token_type: 'Basic' }, { expires_in: 0 }, { expires_in: -1 }, { expires_in: '3600' }, { refresh_token: '' }])('rejects invalid refresh %j', async patch => {
    await expect(fixture({ ...validResponse(), ...patch }).provider.refresh(old)).rejects.toThrow('Google Calendar refresh failed');
  });
  it('reports invalid_grant without exposing provider details', async () => {
    await expect(fixture({ error: 'invalid_grant', error_description: 'PRIVATE' }, 400).provider.refresh(old)).rejects.toMatchObject({ message: 'Google Calendar refresh failed', reconnectRequired: true });
  });
});
