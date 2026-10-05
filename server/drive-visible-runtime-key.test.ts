import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVisibleRuntimeProtector } from "./drive-visible-runtime-key.ts";
import { VisibleTokenProtector, type VisibleCredentialBinding } from "./drive-visible-token-protection.ts";

const deploymentSecret = "synthetic-deployment-secret-for-drive-runtime";
const credential = "synthetic-visible-access-token";
const binding: VisibleCredentialBinding = {
  kind: "grant", userId: "alice", googleSub: "google-alice", generation: 1,
  expiresAt: 1000, scopes: ["https://www.googleapis.com/auth/drive.file"], field: "accessToken",
};

afterEach(() => vi.unstubAllEnvs());

describe("Existing deployment-secret custody for visible Drive", () => {
  it("opens protected credentials after a runtime restart with the same explicit secret", () => {
    const first = createVisibleRuntimeProtector(deploymentSecret);
    const sealed = first.seal(credential, binding);
    expect(sealed).not.toContain(credential);
    expect(createVisibleRuntimeProtector(deploymentSecret).open(sealed, binding)).toBe(credential);
    expect(first.seal(credential, binding)).not.toBe(sealed);
  });

  it("pins the key derivation purpose/version to independently recorded bytes", () => {
    const expectedKey = Buffer.from("ec1fc44474e6e89f8c72206ad69d65c479b6c80a9183866d7bbb4d87a6470da2", "hex");
    const sealed = new VisibleTokenProtector(expectedKey).seal(credential, binding);
    expect(createVisibleRuntimeProtector(deploymentSecret).open(sealed, binding)).toBe(credential);
  });

  it("keeps credential protection distinct from the raw signing secret and another deployment", () => {
    const rawSecret = "s".repeat(32);
    const sealed = createVisibleRuntimeProtector(rawSecret).seal(credential, binding);
    expect(new VisibleTokenProtector(Buffer.from(rawSecret)).open(sealed, binding)).toBeNull();
    expect(createVisibleRuntimeProtector("t".repeat(32)).open(sealed, binding)).toBeNull();
  });

  it("preserves the protector's account, subject and credential-field binding", () => {
    const protector = createVisibleRuntimeProtector(deploymentSecret);
    const sealed = protector.seal(credential, binding);
    for (const change of [{ userId: "bob" }, { googleSub: "google-bob" }, { field: "refreshToken" as const }]) {
      expect(protector.open(sealed, { ...binding, ...change })).toBeNull();
    }
  });

  it("also opens session/attempt-bound ephemeral PKCE after a restart", () => {
    const consent: VisibleCredentialBinding = {
      kind: "consent", userId: "alice", sessionId: "session-alice", generation: 1,
      expiresAt: 1000, nonce: "a".repeat(43), field: "codeVerifier",
    };
    const pkce = randomBytes(32).toString("base64url");
    const sealed = createVisibleRuntimeProtector(deploymentSecret).seal(pkce, consent);
    const restarted = createVisibleRuntimeProtector(deploymentSecret);
    expect(restarted.open(sealed, consent)).toBe(pkce);
    expect(restarted.open(sealed, { ...consent, sessionId: "session-bob" })).toBeNull();
  });

  it.each(["", " ".repeat(32), "s".repeat(31), "s".repeat(4097), ` ${deploymentSecret}`, `${deploymentSecret}\n`])(
    "rejects missing, short, oversized or noncanonical custody without leaking it", secret => {
      let error: unknown;
      try { createVisibleRuntimeProtector(secret); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({ message: "Visible runtime credential custody is unavailable" });
    },
  );

  it("does not substitute an environment secret for a missing caller-supplied secret", () => {
    vi.stubEnv("BETTER_AUTH_SECRET", deploymentSecret);
    // @ts-expect-error verify an untyped caller fails closed despite a configured env
    expect(() => createVisibleRuntimeProtector(undefined)).toThrow("custody is unavailable");
    // @ts-expect-error verify the runtime boundary rejects non-secret values
    expect(() => createVisibleRuntimeProtector(randomBytes(32))).toThrow("custody is unavailable");
  });
});
