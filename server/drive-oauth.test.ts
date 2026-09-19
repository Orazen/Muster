import { describe, expect, it, vi } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { GOOGLE_DRIVE_APPDATA_SCOPE, GoogleDriveOAuthProvider } from './drive-oauth.ts';

import { createGoogleIdTokenVerifier } from './calendar-oauth.ts';

const config = { clientId: 'drive-client', clientSecret: 'fixture-secret', redirectUri: 'https://muster.example/drive/callback' };
const nonce = 'fixture-nonce';
const codeVerifier = 'v'.repeat(43);
const validResponse = () => ({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', id_token: 'fixture-id-token', token_type: 'Bearer', expires_in: 3600, scope: `openid ${GOOGLE_DRIVE_APPDATA_SCOPE}` });
type FixtureBody = Record<string, string | number | null | undefined>;
function fixture(body: FixtureBody = validResponse(), status = 200) {
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body), { status }));
  const verifyIdToken = vi.fn().mockResolvedValue('google-account');
  const provider = new GoogleDriveOAuthProvider({ ...config, fetch: request, verifyIdToken });
  return { provider, request, verifyIdToken };
}

describe('Google Drive OAuth adapter', () => {
  it('requests explicit app-data consent with state, nonce and PKCE', () => {
    const url = new URL(fixture().provider.authorizationUrl({ state: 'state-value', nonce, codeChallenge: 'c'.repeat(43) }));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(url.searchParams)).toEqual({ client_id: config.clientId, redirect_uri: config.redirectUri, response_type: 'code', scope: `openid ${GOOGLE_DRIVE_APPDATA_SCOPE}`, access_type: 'offline', prompt: 'consent', state: 'state-value', nonce, code_challenge: 'c'.repeat(43), code_challenge_method: 'S256' });
    expect(url.searchParams.has('include_granted_scopes')).toBe(false);
  });

  it('exchanges only at the official endpoint with bounded requests and verified identity', async () => {
    const { provider, request, verifyIdToken } = fixture();
    const before = Date.now();
    const result = await provider.exchange('fixture-code', { codeVerifier, nonce });
    expect(result).toMatchObject({ googleSub: 'google-account', accessToken: 'fixture-access', refreshToken: 'fixture-refresh', scopes: ['openid', GOOGLE_DRIVE_APPDATA_SCOPE] });
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
    { expires_in: -1 }, { expires_in: '3600' }, { expires_in: null }, { expires_in: 1e308 }, { expires_in: 1e-12 },
    { scope: 'https://www.googleapis.com/auth/drive' }, { scope: 'https://www.googleapis.com/auth/drive.file' }, { scope: `${GOOGLE_DRIVE_APPDATA_SCOPE}.extra` },
    { refresh_token: '' }, { refresh_token: 123 },
  ])('rejects malformed or insufficient grants: %j', async (patch) => {
    const { provider, verifyIdToken } = fixture({ ...validResponse(), ...patch });
    await expect(provider.exchange('code', { codeVerifier, nonce })).rejects.toThrow(/^Google Drive authorization failed$/);
    expect(verifyIdToken).not.toHaveBeenCalled();
  });

  it('suppresses provider and verifier error details', async () => {
    const failure = fixture({ error_description: 'PRIVATE_PROVIDER_DETAIL' }, 400);
    await expect(failure.provider.exchange('code', { codeVerifier, nonce })).rejects.toThrow(/^Google Drive authorization failed$/);
    const identity = fixture();
    identity.verifyIdToken.mockRejectedValue(new Error('PRIVATE_ID_TOKEN'));
    await expect(identity.provider.exchange('code', { codeVerifier, nonce })).rejects.toThrow(/^Google Drive authorization failed$/);
    const network = fixture();
    network.request.mockRejectedValue(new Error('PRIVATE_NETWORK_DETAIL'));
    await expect(network.provider.exchange('code', { codeVerifier, nonce })).rejects.toThrow(/^Google Drive authorization failed$/);
  });

  it.each(['http://remote.example/callback', 'ftp://localhost/callback', 'https://user:pass@example.com/callback', 'https://example.com/#fragment', 'not a url'])('refuses invalid redirect %s', (redirectUri) => {
    expect(() => new GoogleDriveOAuthProvider({ ...config, redirectUri })).toThrow('Invalid Google Drive OAuth configuration');
  });
  it.each(['http://localhost:9999/callback', 'http://127.0.0.1:9999/callback', 'http://[::1]:9999/callback'])('accepts loopback HTTP %s', (redirectUri) => {
    expect(() => new GoogleDriveOAuthProvider({ ...config, redirectUri })).not.toThrow();
  });
  it('rejects missing correlation and malformed PKCE before making a request', async () => {
    const { provider, request } = fixture();
    expect(() => provider.authorizationUrl({ state: '', nonce, codeChallenge: 'c'.repeat(43) })).toThrow();
    await expect(provider.exchange('code', { codeVerifier: 'short', nonce })).rejects.toThrow();
    await expect(provider.exchange('code', { codeVerifier, nonce: '' })).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
});

describe('Drive refresh', () => {
  const old = { googleSub: 'verified-user', accessToken: 'old', refreshToken: 'existing-refresh', expiresAt: 1, scopes: ['openid', GOOGLE_DRIVE_APPDATA_SCOPE] };
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
    await expect(fixture({ ...validResponse(), ...patch }).provider.refresh(old)).rejects.toThrow('Google Drive refresh failed');
  });
  it('reports invalid_grant without exposing provider details', async () => {
    await expect(fixture({ error: 'invalid_grant', error_description: 'PRIVATE' }, 400).provider.refresh(old)).rejects.toMatchObject({ message: 'Google Drive refresh failed', reconnectRequired: true });
  });
});


describe('Drive identity and refresh boundaries', () => {
  const old = { googleSub: 'verified-user', accessToken: 'old', refreshToken: 'existing-refresh', expiresAt: 1, scopes: ['openid', GOOGLE_DRIVE_APPDATA_SCOPE] };
  it('verifies a real signed identity through the shared verifier and wraps nonce failures', async () => {
    const keys = await generateKeyPair('RS256');
    const jwk = await exportJWK(keys.publicKey);
    const verifyIdToken = createGoogleIdTokenVerifier(config.clientId, createLocalJWKSet({ keys: [{ ...jwk, kid: 'owned-key', alg: 'RS256' }] }));
    const id_token = await new SignJWT({ iss: 'https://accounts.google.com', aud: config.clientId, sub: 'signed-drive-user', nonce, exp: Math.floor(Date.now() / 1000) + 120 })
      .setProtectedHeader({ alg: 'RS256', kid: 'owned-key' }).sign(keys.privateKey);
    const request = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ ...validResponse(), id_token })));
    const provider = new GoogleDriveOAuthProvider({ ...config, fetch: request, verifyIdToken });
    expect(await provider.exchange('code', { codeVerifier, nonce })).toMatchObject({ googleSub: 'signed-drive-user' });
    await expect(provider.exchange('code', { codeVerifier, nonce: 'different' })).rejects.toThrow(/^Google Drive authorization failed$/);
  });
  it('rejects a grant that expires while identity verification is pending', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      const { provider, verifyIdToken } = fixture({ ...validResponse(), expires_in: 1 });
      verifyIdToken.mockImplementation(async () => { clock.mockReturnValue(3000); return 'verified-user'; });
      await expect(provider.exchange('code', { codeVerifier, nonce })).rejects.toThrow(/^Google Drive authorization failed$/);
    } finally { clock.mockRestore(); }
  });
  it('accepts optional rotated refresh token and normalizes exact scope tokens', async () => {
    const { provider } = fixture({ access_token: 'renewed', refresh_token: 'rotated', token_type: 'bearer', expires_in: 60, scope: `openid  ${GOOGLE_DRIVE_APPDATA_SCOPE} ${GOOGLE_DRIVE_APPDATA_SCOPE}` });
    const grant = await provider.refresh(old);
    expect(grant).toMatchObject({ googleSub: old.googleSub, refreshToken: 'rotated', scopes: ['openid', GOOGLE_DRIVE_APPDATA_SCOPE] });
    expect(grant.expiresAt).toBeGreaterThan(Date.now());
    expect(Number.isSafeInteger(grant.expiresAt)).toBe(true);
  });
  it.each(['https://www.googleapis.com/auth/drive', `${GOOGLE_DRIVE_APPDATA_SCOPE}.extra`, 'openid'])('marks reduced or substituted refresh scope as reconnect-required: %s', async scope => {
    await expect(fixture({ ...validResponse(), scope }).provider.refresh(old)).rejects.toMatchObject({ message: 'Google Drive refresh failed', reconnectRequired: true });
  });
  it.each([{ refreshToken: '' }, { scopes: ['openid'] }, { googleSub: ' ' }, { expiresAt: -1 }])('rejects invalid stored grants without network: %j', async patch => {
    const { provider, request } = fixture();
    await expect(provider.refresh({ ...old, ...patch })).rejects.toMatchObject({ message: 'Google Drive refresh failed', reconnectRequired: true });
    expect(request).not.toHaveBeenCalled();
  });
  it.each([0, -1, 1e-12, 1e308])('rejects non-future or unrepresentable refresh expiry: %s', async expires_in => {
    await expect(fixture({ ...validResponse(), expires_in }).provider.refresh(old)).rejects.toThrow(/^Google Drive refresh failed$/);
  });
  it('does not expose refresh transport or provider details and only invalid_grant requires reconnect', async () => {
    const network = fixture(); network.request.mockRejectedValue(new Error('PRIVATE_REFRESH_DETAIL'));
    await expect(network.provider.refresh(old)).rejects.toMatchObject({ message: 'Google Drive refresh failed', reconnectRequired: false });
    await expect(fixture({ error: 'temporarily_unavailable', error_description: 'PRIVATE_PROVIDER_DETAIL' }, 503).provider.refresh(old))
      .rejects.toMatchObject({ message: 'Google Drive refresh failed', reconnectRequired: false });
  });
});
