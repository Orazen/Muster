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

function desktopStart(fixture: Fixture, cookie?: string): Promise<Response> {
  const query = new URLSearchParams({ redirect: "http://127.0.0.1:5199" });
  return fetch(`${fixture.base}/desktop-auth/start?${query}`, {
    redirect: "manual",
    headers: cookie ? { cookie } : undefined,
  });
}

function authorization(response: Response, fixture: Fixture) {
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location") ?? "");
  expect(location.origin).toBe("https://accounts.google.com");
  expect(location.searchParams.get("client_id")).toBe(fixture.googleId);
  expect(location.searchParams.get("redirect_uri")).toBe(`${fixture.base}/api/auth/callback/google`);
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
  ])("rejects invalid loopback target %j before issuing auth cookies", async (redirect) => {
    const query = new URLSearchParams({ redirect });
    const response = await fetch(`${fixture.base}/desktop-auth/start?${query}`, { redirect: "manual" });
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.getSetCookie()).toHaveLength(0);
    expect(await response.text()).toContain("desktop sign-in needs");
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
