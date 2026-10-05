import { describe, expect, it, vi } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  GOOGLE_VISIBLE_FILE_SCOPE, VISIBLE_CONSENT_SCOPES, VisibleFileOAuthProvider,
  VisibleFileOAuthRefreshError,
} from "./drive-visible-oauth.ts";
import { DRIVE_APPDATA_SCOPE } from "./drive-grants.ts";
import { createGoogleIdTokenVerifier } from "./calendar-oauth.ts";

const config = { clientId: "visible-client", clientSecret: "fixture-secret", redirectUri: "https://muster.example/visible/callback" };
const nonce = "fixture-nonce";
const codeVerifier = "v".repeat(43);
const validResponse = () => ({
  access_token: "fixture-access", refresh_token: "fixture-refresh", id_token: "fixture-id-token",
  token_type: "Bearer", expires_in: 3600, scope: `openid ${GOOGLE_VISIBLE_FILE_SCOPE}`,
});
type FixtureBody = Record<string, string | number | null | undefined>;
function fixture(body: FixtureBody = validResponse(), status = 200) {
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body), { status }));
  const verifyIdToken = vi.fn().mockResolvedValue("google-account");
  const provider = new VisibleFileOAuthProvider({ ...config, fetch: request, verifyIdToken });
  return { provider, request, verifyIdToken };
}

describe("Visible file OAuth adapter", () => {
  it("requests the dedicated drive.file consent with state, nonce and PKCE", () => {
    const url = new URL(fixture().provider.authorizationUrl({ state: "state-value", nonce, codeChallenge: "c".repeat(43) }));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: config.clientId, redirect_uri: config.redirectUri, response_type: "code",
      scope: `openid ${GOOGLE_VISIBLE_FILE_SCOPE}`, access_type: "offline", prompt: "consent",
      state: "state-value", nonce, code_challenge: "c".repeat(43), code_challenge_method: "S256",
    });
    expect(url.searchParams.has("include_granted_scopes")).toBe(false);
  });

  it("never widens the consent with the appData or a broad Drive scope", () => {
    const { provider } = fixture();
    const scope = new URL(provider.authorizationUrl({ state: "s".repeat(43), nonce, codeChallenge: "c".repeat(43) })).searchParams.get("scope")!;
    expect(scope).toBe(VISIBLE_CONSENT_SCOPES);
    expect(scope).not.toContain(DRIVE_APPDATA_SCOPE);
    expect(scope).not.toContain("https://www.googleapis.com/auth/drive ");
    expect(scope.split(" ")).toEqual(["openid", GOOGLE_VISIBLE_FILE_SCOPE]);
    expect(scope).not.toMatch(/auth\/drive(?!\.file)/);
  });

  it("exchanges only at the official endpoint with bounded requests and verified identity", async () => {
    const { provider, request, verifyIdToken } = fixture();
    const before = Date.now();
    const result = await provider.exchange("fixture-code", { codeVerifier, nonce });
    expect(result).toMatchObject({
      googleSub: "google-account", accessToken: "fixture-access",
      refreshToken: "fixture-refresh", scopes: ["openid", GOOGLE_VISIBLE_FILE_SCOPE],
    });
    expect(result.expiresAt).toBeGreaterThanOrEqual(before + 3600_000);
    expect(verifyIdToken).toHaveBeenCalledWith("fixture-id-token", nonce);
    const [url, options] = request.mock.calls[0];
    expect(url).toBe("https://oauth2.googleapis.com/token");
    expect(options).toMatchObject({ method: "POST", redirect: "error", signal: expect.any(AbortSignal) });
    // SAFETY: The adapter creates URLSearchParams for the token request; its request shape is asserted above.
    expect(Object.fromEntries(options!.body as URLSearchParams)).toEqual({
      client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: config.redirectUri,
      grant_type: "authorization_code", code: "fixture-code", code_verifier: codeVerifier,
    });
  });

  it("allows a response without a refresh token", async () => {
    const body: FixtureBody = validResponse();
    delete body.refresh_token;
    expect(await fixture(body).provider.exchange("code", { codeVerifier, nonce })).not.toHaveProperty("refreshToken");
  });

  it.each([
    { access_token: "" }, { id_token: "" }, { token_type: "Basic" }, { expires_in: 0 },
    { expires_in: -1 }, { expires_in: "3600" }, { expires_in: null }, { expires_in: 1e308 }, { expires_in: 1e-12 },
    { refresh_token: "" }, { refresh_token: 123 },
  ])("rejects malformed grants: %j", async (patch) => {
    const { provider, verifyIdToken } = fixture({ ...validResponse(), ...patch });
    await expect(provider.exchange("code", { codeVerifier, nonce })).rejects.toThrow(/^Visible file authorization failed$/);
    expect(verifyIdToken).not.toHaveBeenCalled();
  });

  it.each([
    { scope: "" },
    // Missing the scope this consent exists for.
    { scope: "openid" },
    { scope: `openid ${DRIVE_APPDATA_SCOPE}` },
    // Wider than the visible consent: refused rather than persisted wider.
    { scope: "openid https://www.googleapis.com/auth/drive" },
    { scope: `openid ${GOOGLE_VISIBLE_FILE_SCOPE} https://www.googleapis.com/auth/drive` },
    { scope: `openid ${GOOGLE_VISIBLE_FILE_SCOPE} https://www.googleapis.com/auth/drive.readonly` },
    { scope: `openid ${GOOGLE_VISIBLE_FILE_SCOPE} https://www.googleapis.com/auth/drive.metadata` },
    { scope: `openid ${GOOGLE_VISIBLE_FILE_SCOPE} ${DRIVE_APPDATA_SCOPE}` },
    { scope: `openid ${GOOGLE_VISIBLE_FILE_SCOPE} openid ${DRIVE_APPDATA_SCOPE}` },
    // A lookalike that is not the real scope string.
    { scope: "openid drive.file" },
    { scope: `openid ${GOOGLE_VISIBLE_FILE_SCOPE}.extra` },
  ])("refuses a scope that is missing, substituted or too broad: %j", async (patch) => {
    const { provider, verifyIdToken } = fixture({ ...validResponse(), ...patch });
    await expect(provider.exchange("code", { codeVerifier, nonce })).rejects.toThrow(/^Visible file authorization failed$/);
    expect(verifyIdToken).not.toHaveBeenCalled();
  });

  it("suppresses provider and verifier error details", async () => {
    const failure = fixture({ error_description: "PRIVATE_PROVIDER_DETAIL" }, 400);
    await expect(failure.provider.exchange("code", { codeVerifier, nonce })).rejects.toThrow(/^Visible file authorization failed$/);
    const identity = fixture();
    identity.verifyIdToken.mockRejectedValue(new Error("PRIVATE_ID_TOKEN"));
    await expect(identity.provider.exchange("code", { codeVerifier, nonce })).rejects.toThrow(/^Visible file authorization failed$/);
    const network = fixture();
    network.request.mockRejectedValue(new Error("PRIVATE_NETWORK_DETAIL"));
    await expect(network.provider.exchange("code", { codeVerifier, nonce })).rejects.toThrow(/^Visible file authorization failed$/);
  });

  it.each([
    "http://remote.example/callback", "ftp://localhost/callback",
    "https://user:pass@example.com/callback", "https://example.com/#fragment", "not a url",
  ])("refuses invalid redirect %s", (redirectUri) => {
    expect(() => new VisibleFileOAuthProvider({ ...config, redirectUri })).toThrow("Invalid visible file OAuth configuration");
  });
  it.each(["http://localhost:9999/callback", "http://127.0.0.1:9999/callback", "http://[::1]:9999/callback"])(
    "accepts loopback HTTP %s", (redirectUri) => {
      expect(() => new VisibleFileOAuthProvider({ ...config, redirectUri })).not.toThrow();
    },
  );
  it("rejects missing correlation and malformed PKCE before making a request", async () => {
    const { provider, request } = fixture();
    expect(() => provider.authorizationUrl({ state: "", nonce, codeChallenge: "c".repeat(43) })).toThrow();
    await expect(provider.exchange("code", { codeVerifier: "short", nonce })).rejects.toThrow();
    await expect(provider.exchange("code", { codeVerifier, nonce: "" })).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
});

describe("Visible file refresh", () => {
  const old = {
    googleSub: "verified-user", accessToken: "old", refreshToken: "existing-refresh",
    expiresAt: 1, scopes: ["openid", GOOGLE_VISIBLE_FILE_SCOPE],
  };
  it("preserves verified identity, omitted scopes and refresh token at the bounded official endpoint", async () => {
    const { provider, request, verifyIdToken } = fixture({ access_token: "new", token_type: "Bearer", expires_in: 3600 });
    expect(await provider.refresh(old)).toMatchObject({
      googleSub: old.googleSub, refreshToken: old.refreshToken, scopes: old.scopes, accessToken: "new",
    });
    expect(verifyIdToken).not.toHaveBeenCalled();
    const [url, options] = request.mock.calls[0];
    expect(url).toBe("https://oauth2.googleapis.com/token");
    expect(options).toMatchObject({ redirect: "error", signal: expect.any(AbortSignal) });
    expect(String(options?.body)).toContain("grant_type=refresh_token");
  });
  it.each([
    { token_type: "Basic" }, { expires_in: 0 }, { expires_in: -1 },
    { expires_in: "3600" }, { refresh_token: "" },
  ])("rejects invalid refresh %j", async (patch) => {
    await expect(fixture({ ...validResponse(), ...patch }).provider.refresh(old))
      .rejects.toThrow("Visible file refresh failed");
  });
  it.each([
    // Reduced below the visible consent.
    { scope: "openid" },
    { scope: "" },
    // Substituted for appData, or widened to a broad/restricted scope.
    { scope: `openid ${DRIVE_APPDATA_SCOPE}` },
    { scope: "openid https://www.googleapis.com/auth/drive" },
    { scope: `openid ${GOOGLE_VISIBLE_FILE_SCOPE} https://www.googleapis.com/auth/drive.readonly` },
    { scope: `openid ${GOOGLE_VISIBLE_FILE_SCOPE} ${DRIVE_APPDATA_SCOPE}` },
  ])("marks reduced, substituted or widened refresh scope as reconnect-required: %j", async (patch) => {
    await expect(fixture({ ...validResponse(), ...patch }).provider.refresh(old))
      .rejects.toMatchObject({ message: "Visible file refresh failed", reconnectRequired: true });
  });
  it("reports invalid_grant without exposing provider details", async () => {
    await expect(fixture({ error: "invalid_grant", error_description: "PRIVATE" }, 400).provider.refresh(old))
      .rejects.toMatchObject({ message: "Visible file refresh failed", reconnectRequired: true });
  });
  it.each([
    { refreshToken: "" }, { scopes: ["openid"] }, { scopes: [DRIVE_APPDATA_SCOPE] },
    { scopes: ["openid", "https://www.googleapis.com/auth/drive"] },
    { googleSub: " " }, { expiresAt: -1 },
  ])("rejects invalid stored grants without network: %j", async (patch) => {
    const { provider, request } = fixture();
    await expect(provider.refresh({ ...old, ...patch })).rejects.toBeInstanceOf(VisibleFileOAuthRefreshError);
    expect(request).not.toHaveBeenCalled();
  });
  it.each([0, -1, 1e-12, 1e308])("rejects non-future or unrepresentable refresh expiry: %s", async (expires_in) => {
    await expect(fixture({ ...validResponse(), expires_in }).provider.refresh(old))
      .rejects.toThrow(/^Visible file refresh failed$/);
  });
  it("does not expose refresh transport or provider details and only invalid_grant requires reconnect", async () => {
    const network = fixture();
    network.request.mockRejectedValue(new Error("PRIVATE_REFRESH_DETAIL"));
    await expect(network.provider.refresh(old))
      .rejects.toMatchObject({ message: "Visible file refresh failed", reconnectRequired: false });
    await expect(fixture({ error: "temporarily_unavailable", error_description: "PRIVATE_PROVIDER_DETAIL" }, 503).provider.refresh(old))
      .rejects.toMatchObject({ message: "Visible file refresh failed", reconnectRequired: false });
  });
  it("keeps holding the granted scope when a refresh omits the scope field", async () => {
    const body = { access_token: "new", token_type: "Bearer", expires_in: 60 };
    const grant = await fixture(body).provider.refresh(old);
    expect(grant.scopes).toEqual(old.scopes);
    expect(grant.accessToken).toBe("new");
  });
});

describe("Visible file identity boundary", () => {
  it("verifies a real signed identity through the shared verifier and wraps nonce failures", async () => {
    const keys = await generateKeyPair("RS256");
    const jwk = await exportJWK(keys.publicKey);
    const verifyIdToken = createGoogleIdTokenVerifier(config.clientId, createLocalJWKSet({
      keys: [{ ...jwk, kid: "owned-key", alg: "RS256" }],
    }));
    const id_token = await new SignJWT({
      iss: "https://accounts.google.com", aud: config.clientId, sub: "signed-visible-user",
      nonce, exp: Math.floor(Date.now() / 1000) + 120,
    }).setProtectedHeader({ alg: "RS256", kid: "owned-key" }).sign(keys.privateKey);
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ...validResponse(), id_token }), { status: 200 }),
    );
    const provider = new VisibleFileOAuthProvider({ ...config, fetch: request, verifyIdToken });
    expect(await provider.exchange("code", { codeVerifier, nonce })).toMatchObject({ googleSub: "signed-visible-user" });
    await expect(provider.exchange("code", { codeVerifier, nonce: "different" }))
      .rejects.toThrow(/^Visible file authorization failed$/);
  });
  it("rejects a grant that expires while identity verification is pending", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    try {
      const { provider, verifyIdToken } = fixture({ ...validResponse(), expires_in: 1 });
      verifyIdToken.mockImplementation(async () => { clock.mockReturnValue(3000); return "verified-user"; });
      await expect(provider.exchange("code", { codeVerifier, nonce })).rejects.toThrow(/^Visible file authorization failed$/);
    } finally { clock.mockRestore(); }
  });
  it("normalizes exact scope tokens and accepts an optional rotated refresh token", async () => {
    const stored = {
      googleSub: "verified-user", accessToken: "old", refreshToken: "existing-refresh",
      expiresAt: 1, scopes: ["openid", GOOGLE_VISIBLE_FILE_SCOPE],
    };
    const { provider } = fixture({
      access_token: "renewed", refresh_token: "rotated", token_type: "bearer", expires_in: 60,
      scope: `openid  ${GOOGLE_VISIBLE_FILE_SCOPE} ${GOOGLE_VISIBLE_FILE_SCOPE}`,
    });
    const grant = await provider.refresh(stored);
    expect(grant).toMatchObject({ refreshToken: "rotated", scopes: ["openid", GOOGLE_VISIBLE_FILE_SCOPE] });
    expect(grant.expiresAt).toBeGreaterThan(Date.now());
    expect(Number.isSafeInteger(grant.expiresAt)).toBe(true);
  });
});
