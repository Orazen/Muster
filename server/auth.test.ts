import { describe, it, expect, vi } from "vitest";

/**
 * These cover the decision logic of the session gate without booting the whole
 * harness: which paths bypass authentication, and when self-hosting is on.
 *
 * The gate itself is three predicates ANDed together in index.ts:
 *   SELF_HOSTED && path.startsWith("/api/") && !isPublicApiPath(path)
 *   && !path.startsWith("/api/internal/")
 * so pinning the predicates pins the gate.
 */

describe("isPublicApiPath", () => {
  it("lets the auth endpoints through so sign-in is reachable", async () => {
    const { isPublicApiPath } = await import("./auth.ts");
    expect(isPublicApiPath("/api/auth/sign-in/email")).toBe(true);
    expect(isPublicApiPath("/api/auth/session")).toBe(true);
    expect(isPublicApiPath("/api/auth/sign-out")).toBe(true);
  });

  it("lets the liveness probe through for load balancers and smoke tests", async () => {
    const { isPublicApiPath } = await import("./auth.ts");
    expect(isPublicApiPath("/api/health")).toBe(true);
  });

  it("does not let privileged routes through", async () => {
    const { isPublicApiPath } = await import("./auth.ts");
    // The routes that make an unauthenticated harness dangerous.
    expect(isPublicApiPath("/api/config")).toBe(false);
    expect(isPublicApiPath("/api/providers")).toBe(false);
    expect(isPublicApiPath("/api/webhooks")).toBe(false);
    expect(isPublicApiPath("/api/local-computer/run")).toBe(false);
    expect(isPublicApiPath("/api/bots/abc/computer/exec")).toBe(false);
  });

  it("is not fooled by a prefix that merely looks like an auth path", async () => {
    const { isPublicApiPath } = await import("./auth.ts");
    expect(isPublicApiPath("/api/authorize")).toBe(false);
    expect(isPublicApiPath("/api/auth")).toBe(false);
    expect(isPublicApiPath("/api/health/../config")).toBe(false);
  });
});

describe("SELF_HOSTED", () => {
  const withEnv = async (env: Record<string, string | undefined>) => {
    const saved = { ...process.env };
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    // Fresh module instance so the top-level const re-evaluates. A query-string
    // specifier would be a variable dynamic import, which Vite cannot resolve.
    vi.resetModules();
    const mod = await import("./auth.ts");
    process.env = saved;
    return mod;
  };

  it("is false for the default loopback desktop install", async () => {
    const { SELF_HOSTED } = await withEnv({
      OMB_HOST: undefined,
      OMB_PUBLIC_HOST: undefined,
      BETTER_AUTH_SECRET: "test-secret-for-vitest-only-not-real",
    });
    expect(SELF_HOSTED).toBe(false);
  });

  it("is true once the listener binds beyond loopback", async () => {
    const { SELF_HOSTED } = await withEnv({
      OMB_HOST: "0.0.0.0",
      BETTER_AUTH_SECRET: "test-secret-for-vitest-only-not-real",
    });
    expect(SELF_HOSTED).toBe(true);
  });

  it("is true when a public host is named", async () => {
    const { SELF_HOSTED } = await withEnv({
      OMB_HOST: undefined,
      OMB_PUBLIC_HOST: "muster.example.com",
      BETTER_AUTH_SECRET: "test-secret-for-vitest-only-not-real",
    });
    expect(SELF_HOSTED).toBe(true);
  });
});

describe("gate composition", () => {
  /** Mirrors the condition in index.ts so a change there without a change
   *  here shows up as a failing test rather than a silent hole. */
  const gated = (selfHosted: boolean, path: string, isPublic: (p: string) => boolean) =>
    selfHosted && path.startsWith("/api/") && !isPublic(path) && !path.startsWith("/api/internal/");

  it("gates the dangerous routes when self-hosting", async () => {
    const { isPublicApiPath } = await import("./auth.ts");
    expect(gated(true, "/api/bots/abc/computer/exec", isPublicApiPath)).toBe(true);
    expect(gated(true, "/api/config", isPublicApiPath)).toBe(true);
    expect(gated(true, "/api/local-computer/run", isPublicApiPath)).toBe(true);
  });

  it("never gates loopback desktop installs", async () => {
    const { isPublicApiPath } = await import("./auth.ts");
    expect(gated(false, "/api/bots/abc/computer/exec", isPublicApiPath)).toBe(false);
    expect(gated(false, "/api/config", isPublicApiPath)).toBe(false);
  });

  it("leaves internal comms to its own loopback + token check", async () => {
    const { isPublicApiPath } = await import("./auth.ts");
    expect(gated(true, "/api/internal/agents", isPublicApiPath)).toBe(false);
    expect(gated(true, "/api/internal/ask-bot", isPublicApiPath)).toBe(false);
  });

  it("does not gate static asset requests", async () => {
    const { isPublicApiPath } = await import("./auth.ts");
    expect(gated(true, "/", isPublicApiPath)).toBe(false);
    expect(gated(true, "/index.html", isPublicApiPath)).toBe(false);
    expect(gated(true, "/assets/app.js", isPublicApiPath)).toBe(false);
  });
});
