// Real HTTP coverage for the browser-to-desktop OAuth entry point. Google
// credentials are random fixture values; redirects are never followed and
// the child cannot make outbound fetch/TCP requests. Provider cancellation
// exercises Better Auth's real state-cookie validation without a token swap.
import { spawn, type ChildProcess } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { isDriveScope } from "./google-auth.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const posixOnly = describe.skipIf(process.platform === "win32");

interface Fixture {
  child: ChildProcess;
  directory: string;
  base: string;
  secret: string;
  googleId: string;
}

const fixtures: Fixture[] = [];

async function startFixture(googleConfigured = true): Promise<Fixture> {
  const directory = mkdtempSync(join(tmpdir(), "muster-desktop-auth-"));
  const data = join(directory, "data");
  mkdirSync(data);
  writeFileSync(join(data, "config.json"), JSON.stringify({
    instances: { ghost: { driver: "not-a-real-driver", displayName: "Fixture" } },
  }));
  const guard = join(directory, "block-outbound.mjs");
  writeFileSync(guard, `
    import { Socket } from "node:net";
    const blocked = () => { throw new Error("Outbound network disabled in OAuth fixture"); };
    globalThis.fetch = async () => blocked();
    Socket.prototype.connect = blocked;
  `);
  const port = await freePortBlock([0, 1]);
  const base = `http://127.0.0.1:${port}`;
  const secret = randomBytes(32).toString("hex");
  const googleId = randomBytes(16).toString("hex");
  const env: NodeJS.ProcessEnv = {
    OMB_DATA_DIR: data,
    OMB_COMPANION_DIR: join(directory, "companion"),
    OMB_HOST: "127.0.0.1",
    OMB_PORT: String(port),
    OMB_WEBHOOK_PORT: String(port + 1),
    OMB_PUBLIC_URL: base,
    BETTER_AUTH_SECRET: secret,
  };
  if (googleConfigured) {
    env.GOOGLE_CLIENT_ID = googleId;
    env.GOOGLE_CLIENT_SECRET = randomBytes(32).toString("hex");
  }
  if (process.env.PATH) env.PATH = process.env.PATH;
  const child = spawn(process.execPath, ["--import", guard, join(ROOT, "server/index.ts")], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const fixture = { child, directory, base, secret, googleId };
  fixtures.push(fixture);
  let stderr = "";
  child.stderr!.on("data", (chunk) => { stderr += chunk; });
  child.stdout!.resume();
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const response = await fetch(`${base}/api/health`, { redirect: "manual" });
      if (response.ok) return fixture;
    } catch {
      // Wait for this fixture's listener only.
    }
    if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) {
      throw new Error(`OAuth fixture did not start: ${stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

function desktopStart(fixture: Fixture, cookie?: string, forwardedFor?: string): Promise<Response> {
  const query = new URLSearchParams({ redirect: "http://127.0.0.1:5199" });
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  if (forwardedFor !== undefined) headers.set("x-forwarded-for", forwardedFor);
  return fetch(`${fixture.base}/desktop-auth/start?${query}`, {
    redirect: "manual",
    headers,
  });
}

function socialStart(fixture: Fixture, forwardedFor: string): Promise<Response> {
  return fetch(`${fixture.base}/api/auth/sign-in/social`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/json",
      origin: fixture.base,
      "x-forwarded-for": forwardedFor,
    },
    body: JSON.stringify({ provider: "google", callbackURL: "/app" }),
  });
}

async function expectDesktopThrottle(response: Response, maxSeconds = 10): Promise<void> {
  expect(response.status).toBe(429);
  const retryAfter = response.headers.get("retry-after");
  expect(retryAfter).toMatch(/^[1-9]\d*$/);
  expect(Number(retryAfter)).toBeLessThanOrEqual(maxSeconds);
  expect(response.headers.get("location")).toBeNull();
  expect(response.headers.getSetCookie()).toHaveLength(0);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("content-type")).toContain("text/html");
  const body = await response.text();
  expect(body).toContain("Give it a moment");
  expect(body).toContain(`Try signing in again in ${retryAfter} ${Number(retryAfter) === 1 ? "second" : "seconds"}.`);
  expect(body).not.toContain("Google sign-in is not available");
}

function authorization(response: Response, fixture: Fixture) {
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location") ?? "");
  expect(location.origin).toBe("https://accounts.google.com");
  expect(location.searchParams.get("client_id")).toBe(fixture.googleId);
  expect(location.searchParams.get("redirect_uri")).toBe(`${fixture.base}/api/auth/callback/google`);
  // This is Better Auth's sign-in redirect, so it must carry exactly the
  // basic identity scopes and never a Drive scope: drive.appdata is asked
  // for only by the separate account connect consent (server/drive-oauth.ts).
  // Deduped set: the provider appends its defaults to the configured list.
  const scopes = [...new Set((location.searchParams.get("scope") ?? "").split(/\s+/).filter(Boolean))].sort();
  expect(scopes).toEqual(["email", "openid", "profile"]);
  expect(scopes.some((scope) => isDriveScope(scope))).toBe(false);
  const state = location.searchParams.get("state") ?? "";
  expect(state.length).toBeGreaterThan(20);
  const cookies = response.headers.getSetCookie();
  const stateCookies = cookies.filter((cookie) => cookie.startsWith("better-auth.state="));
  expect(stateCookies).toHaveLength(1);
  const stateCookie = stateCookies[0]!;
  expect(stateCookie).toContain("Max-Age=300");
  expect(stateCookie).toContain("Path=/");
  expect(stateCookie).toContain("HttpOnly");
  expect(stateCookie).toContain("SameSite=Lax");
  const cookie = stateCookie.split(";")[0]!;
  const signedValue = decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1));
  const signature = createHmac("sha256", fixture.secret).update(state).digest("base64");
  expect(signedValue).toBe(`${state}.${signature}`);
  return { state, cookie };
}

async function providerCancellation(fixture: Fixture, state: string, cookie?: string): Promise<URL> {
  const query = new URLSearchParams({ state, error: "access_denied" });
  const response = await fetch(`${fixture.base}/api/auth/callback/google?${query}`, {
    redirect: "manual",
    headers: cookie ? { cookie } : undefined,
  });
  expect(response.status).toBe(302);
  return new URL(response.headers.get("location") ?? "", fixture.base);
}

posixOnly("desktop OAuth start route", () => {
  let fixture: Fixture;

  // A fresh auth store/rate-limit bucket per behavior keeps the actual
  // sign-in throttles enabled without time-based waits between assertions.
  beforeEach(async () => { fixture = await startFixture(); });

  afterEach(async () => {
    for (const current of fixtures.splice(0)) {
      await waitForExit(current.child, { signal: "SIGTERM" });
      await removeTempDir(current.directory);
    }
  });

  it("preserves the signed state cookie when redirecting the browser to Google", async () => {
    authorization(await desktopStart(fixture), fixture);
  });

  it("issues fresh matching state and cookies on a repeated desktop start", async () => {
    const first = authorization(await desktopStart(fixture), fixture);
    const second = authorization(await desktopStart(fixture, first.cookie), fixture);
    expect(second.state).not.toBe(first.state);
    expect(second.cookie).not.toBe(first.cookie);
  });

  it("retains the real three-attempt social throttle and gives the same client retry guidance", async () => {
    const client = "198.51.100.10";
    for (let attempt = 0; attempt < 3; attempt++) {
      authorization(await desktopStart(fixture, undefined, client), fixture);
    }
    await expectDesktopThrottle(await desktopStart(fixture, undefined, client));
  });

  it("keeps an independent single-IP client available after another client reaches its limit", async () => {
    const limitedClient = "198.51.100.10";
    for (let attempt = 0; attempt < 3; attempt++) {
      authorization(await desktopStart(fixture, undefined, limitedClient), fixture);
    }
    authorization(await desktopStart(fixture, undefined, "198.51.100.11"), fixture);
    await expectDesktopThrottle(await desktopStart(fixture, undefined, limitedClient));
  });

  it("retains the outer ten-attempt gate with one-minute guidance before reaching social auth", async () => {
    const invalidTarget = `${fixture.base}/desktop-auth/start?redirect=%2Fapp`;
    const request = { redirect: "manual" as const, headers: { "x-forwarded-for": "198.51.100.13" } };
    for (let attempt = 0; attempt < 10; attempt++) {
      const response = await fetch(invalidTarget, request);
      expect(response.status).toBe(400);
      expect(response.headers.getSetCookie()).toHaveLength(0);
    }
    const response = await fetch(invalidTarget, request);
    expect(response.headers.get("retry-after")).toBe("60");
    await expectDesktopThrottle(response, 60);
    // Rejected targets never spend the social endpoint's independent budget.
    expect((await socialStart(fixture, "198.51.100.13")).status).toBe(200);
  });

  it("shares a client's limit between the direct social route and the desktop wrapper", async () => {
    const client = "198.51.100.12";
    const first = await socialStart(fixture, client);
    expect(first.status).toBe(200);
    expect(first.headers.getSetCookie().some((cookie) => cookie.startsWith("better-auth.state="))).toBe(true);
    authorization(await desktopStart(fixture, undefined, client), fixture);
    expect((await socialStart(fixture, client)).status).toBe(200);
    await expectDesktopThrottle(await desktopStart(fixture, undefined, client));
    const directThrottle = await socialStart(fixture, client);
    expect(directThrottle.status).toBe(429);
    expect(directThrottle.headers.get("x-retry-after")).toMatch(/^[1-9]\d*$/);
    expect(directThrottle.headers.getSetCookie()).toHaveLength(0);
  });

  it.each([
    {
      name: "absent IP headers",
      headers: [undefined, undefined, undefined, undefined],
    },
    {
      name: "different malformed IP headers",
      headers: ["not-an-ip", "invalid-client", "999.2.3.4", "still-not-an-ip"],
    },
    {
      name: "multi-value headers with different leftmost addresses",
      headers: [
        "198.51.100.21, 203.0.113.50",
        "198.51.100.22, 203.0.113.50",
        "198.51.100.23, 203.0.113.50",
        "198.51.100.24, 203.0.113.50",
      ],
    },
    {
      name: "mixed unresolved header forms",
      headers: [undefined, "invalid-client", "198.51.100.31, 203.0.113.50", "198.51.100.32, 203.0.113.50"],
    },
  ])("keeps $name in Better Auth's shared fallback bucket", async ({ headers }) => {
    // Keep the original header intact: neither arbitrary values nor a chain's
    // leftmost address establishes an identity under the installed auth policy.
    for (const forwardedFor of headers.slice(0, 3)) {
      authorization(await desktopStart(fixture, undefined, forwardedFor), fixture);
    }
    await expectDesktopThrottle(await desktopStart(fixture, undefined, headers[3]));
    authorization(await desktopStart(fixture, undefined, "198.51.100.99"), fixture);
  });

  it("accepts its returned cookie at the real callback before handling provider cancellation", async () => {
    const { state, cookie } = authorization(await desktopStart(fixture), fixture);
    const location = await providerCancellation(fixture, state, cookie);
    expect(location.searchParams.get("error")).toBe("access_denied");
  });

  it("rejects a callback with the state query but no browser state cookie", async () => {
    const { state } = authorization(await desktopStart(fixture), fixture);
    const location = await providerCancellation(fixture, state);
    expect(location.searchParams.get("error")).toBe("state_mismatch");
  });

  it("rejects a valid state cookie belonging to another desktop start", async () => {
    const first = authorization(await desktopStart(fixture), fixture);
    const second = authorization(await desktopStart(fixture), fixture);
    const location = await providerCancellation(fixture, first.state, second.cookie);
    expect(location.searchParams.get("error")).toBe("state_mismatch");
  });

  it.each([
    "",
    "https://example.test/finish",
    "https://127.0.0.1:5199",
    "/app",
    "http://localhost.example.test:5199",
  ])("rejects invalid handoff target %j before issuing auth cookies", async (redirect) => {
    const query = new URLSearchParams({ redirect });
    const response = await fetch(`${fixture.base}/desktop-auth/start?${query}`, { redirect: "manual" });
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.getSetCookie()).toHaveLength(0);
    expect(await response.text()).toContain("sign-in needs");
  });

  it("accepts the companion's muster://oauth/finish and bounces to Google", async () => {
    const query = new URLSearchParams({ redirect: "muster://oauth/finish" });
    const response = await fetch(`${fixture.base}/desktop-auth/start?${query}`, { redirect: "manual" });
    // The full happy path: the scheme target validates, and the browser is
    // bounced into Google exactly as a loopback target would be.
    expect(response.status).toBe(302);
    expect(response.headers.get("location") ?? "").toContain("accounts.google.com");
    expect(response.headers.getSetCookie().length).toBeGreaterThan(0);
  });

  it("does not finish a desktop handoff without an authenticated cloud session", async () => {
    const response = await fetch(`${fixture.base}/desktop-auth/done?grant=${randomBytes(16).toString("hex")}`, {
      redirect: "manual",
    });
    expect(response.status).toBe(403);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.getSetCookie()).toHaveLength(0);
  });

  it("returns a recoverable unavailable-provider response without auth cookies", async () => {
    const unconfigured = await startFixture(false);
    const response = await desktopStart(unconfigured);
    expect(response.status).toBe(500);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.getSetCookie()).toHaveLength(0);
    expect(await response.text()).toContain("Google sign-in is not available");
  });
});
