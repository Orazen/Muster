// Acceptance for the Google auth slice (plan phases 5 + 7): sign-in and the
// account-linked Drive connect share ONE env credential pair but never one
// consent. The unit half pins the scope lists and the capability predicate;
// the harness half boots the real server twice — without credentials
// (capability OFF: no provider advertised, no Google redirect, Drive status
// and connect refused with the exact unavailable body) and with fixture
// credentials (capability ON: basic-scope sign-in redirect, appdata-only
// Drive consent). Every credential is an owned random fixture value and the
// children cannot make outbound fetch/TCP calls, so no real Google round
// trip can run (plan milestone M12).
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { pairingServerEnvironment, waitForOwnedServer } from "../e2e/pairing-harness.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { GOOGLE_DRIVE_APPDATA_SCOPE } from "./drive-oauth.ts";
import { GOOGLE_SIGNIN_SCOPES, googleCredentials, googleDriveConnectConfigured, isDriveScope } from "./google-auth.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const ACCOUNT_DRIVE_UNAVAILABLE = {
  code: "ACCOUNT_DRIVE_UNAVAILABLE",
  error: "Account-linked Google Drive backup is unavailable. Use a Drive connection configured on this computer.",
};

describe("Google sign-in scope and capability predicates", () => {
  const ENV_KEYS = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"] as const;

  /** Apply an exact credential env for the duration of `run`, whatever the
   *  ambient process env holds, then restore it untouched. */
  function withGoogleEnv(id: string | undefined, secret: string | undefined, run: () => void): void {
    const saved = ENV_KEYS.map((key) => ({ key, value: process.env[key] }));
    try {
      for (const key of ENV_KEYS) delete process.env[key];
      if (id !== undefined) process.env.GOOGLE_CLIENT_ID = id;
      if (secret !== undefined) process.env.GOOGLE_CLIENT_SECRET = secret;
      run();
    } finally {
      for (const entry of saved) {
        if (entry.value === undefined) delete process.env[entry.key];
        else process.env[entry.key] = entry.value;
      }
    }
  }

  it("keeps the sign-in scope list basic and never Drive", () => {
    expect([...GOOGLE_SIGNIN_SCOPES]).toEqual(["openid", "email", "profile"]);
    for (const scope of GOOGLE_SIGNIN_SCOPES) expect(isDriveScope(scope)).toBe(false);
    expect([...GOOGLE_SIGNIN_SCOPES]).not.toContain(GOOGLE_DRIVE_APPDATA_SCOPE);
  });

  it.each([
    { scope: "https://www.googleapis.com/auth/drive", drive: true },
    { scope: "https://www.googleapis.com/auth/drive.file", drive: true },
    { scope: "https://www.googleapis.com/auth/drive.appdata", drive: true },
    { scope: "https://www.googleapis.com/auth/drive.readonly", drive: true },
    { scope: "https://www.googleapis.com/auth/drivefoo", drive: false },
    { scope: "https://www.googleapis.com/auth/calendar.readonly", drive: false },
    { scope: "openid", drive: false },
    { scope: "email", drive: false },
    { scope: "profile", drive: false },
    { scope: "", drive: false },
  ])("classifies $scope as a Drive scope: $drive", ({ scope, drive }) => {
    expect(isDriveScope(scope)).toBe(drive);
  });

  it.each([
    { label: "no pair at all", id: undefined, secret: undefined, expected: null },
    { label: "id only", id: "owned-client-id", secret: undefined, expected: null },
    { label: "secret only", id: undefined, secret: "owned-client-secret", expected: null },
    { label: "blank id half", id: " \t ", secret: "owned-client-secret", expected: null },
    { label: "blank secret half", id: "owned-client-id", secret: "   ", expected: null },
    { label: "complete padded pair", id: " owned-client-id ", secret: " owned-client-secret ", expected: { clientId: "owned-client-id", clientSecret: "owned-client-secret" } },
  ])("treats $label the same for sign-in and Drive connect", ({ id, secret, expected }) => {
    withGoogleEnv(id, secret, () => {
      expect(googleCredentials()).toEqual(expected);
      // The two surfaces can never diverge: configured-for-sign-in and
      // configured-for-Drive-connect are the same credential pair.
      expect(googleDriveConnectConfigured()).toBe(expected !== null);
      expect(googleDriveConnectConfigured()).toBe(googleCredentials() !== null);
    });
  });

  it("separates the two consents: they share only the openid handshake", () => {
    const signIn = new Set<string>(GOOGLE_SIGNIN_SCOPES);
    const driveConsent = ["openid", GOOGLE_DRIVE_APPDATA_SCOPE];
    expect(driveConsent.filter((scope) => signIn.has(scope))).toEqual(["openid"]);
    expect(driveConsent.filter((scope) => isDriveScope(scope))).toEqual([GOOGLE_DRIVE_APPDATA_SCOPE]);
    expect([...signIn].filter((scope) => isDriveScope(scope))).toEqual([]);
  });
});

interface Harness {
  child: ChildProcess;
  directory: string;
  base: string;
  networkLog: string;
  /** The fixture client id the child was configured with, or null. */
  googleId: string | null;
}

async function startHarness(basePort: number, googleId: string | null): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), "muster-google-auth-"));
  const dataDirectory = join(directory, "data");
  const home = join(directory, "home");
  const companionDirectory = join(directory, "companion");
  const ui = join(directory, "ui");
  for (const path of [dataDirectory, home, companionDirectory, join(dataDirectory, "memory"), ui]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  writeFileSync(join(ui, "index.html"), "<!doctype html><title>Google auth fixture</title>");
  writeFileSync(join(dataDirectory, "config.json"), JSON.stringify({
    instances: { ghost: { driver: "not-a-real-driver", displayName: "Google auth fixture" } },
  }), { mode: 0o600 });
  const networkLog = join(directory, "outbound-attempts.txt");
  const guard = join(directory, "block-outbound.mjs");
  writeFileSync(guard, `
import { Socket } from "node:net";
import { appendFileSync } from "node:fs";
const blocked = (first) => {
  const where = String(first?.url ?? first?.host ?? first ?? "?").slice(0, 200);
  const at = String(new Error().stack).split("\\n")[1]?.trim().slice(0, 200) ?? "?";
  appendFileSync(${JSON.stringify(networkLog)}, "blocked " + where + " at " + at + "\\n");
  throw new Error("Outbound network disabled in Google auth fixture");
};
globalThis.fetch = blocked;
Socket.prototype.connect = blocked;
`);
  const port = basePort;
  const base = `http://127.0.0.1:${port}`;
  const env = pairingServerEnvironment({
    home, dataDirectory, companionDirectory, staticDir: ui, port, webhookPort: port + 1,
    secret: randomBytes(32).toString("hex"),
  });
  // Hosted shape: decision 14's session-conditional accountDrive claim is
  // exactly the surface this slice must stop over-advertising.
  env.OMB_PUBLIC_HOST = `127.0.0.1:${port}`;
  env.OMB_ALLOW_SIGNUPS = "true";
  if (googleId) {
    env.GOOGLE_CLIENT_ID = googleId;
    env.GOOGLE_CLIENT_SECRET = randomBytes(32).toString("hex");
  }
  const child = spawn(process.execPath, ["--import", guard, "--experimental-strip-types", join(ROOT, "server/index.ts")], {
    cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"],
  });
  // Persistent consumers: waitForOwnedServer detaches its listener after
  // readiness, and an unread pipe would eventually block the child.
  child.stdout?.on("data", () => {});
  let stderr = "";
  child.stderr?.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-4000); });
  try {
    await waitForOwnedServer(child, base);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}\nfixture stderr: ${stderr || "<empty>"}`);
  }
  return { child, directory, base, networkLog, googleId };
}

describe.skipIf(process.platform === "win32")("Google auth capability over real routes", () => {
  const harnesses: Harness[] = [];
  let off: Harness;
  let on: Harness;

  const api = (harness: Harness, path: string, opts: RequestInit = {}) =>
    fetch(`${harness.base}${path}`, { redirect: "error", signal: AbortSignal.timeout(15_000), ...opts });

  const socialProvidersOf = async (harness: Harness) => {
    const response = await api(harness, "/api/auth-capabilities");
    expect(response.status).toBe(200);
    return z.object({ socialProviders: z.array(z.string()) }).parse(await response.json()).socialProviders;
  };

  const socialSignIn = (harness: Harness) => fetch(`${harness.base}/api/auth/sign-in/social`, {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
    headers: { "content-type": "application/json", origin: harness.base },
    body: JSON.stringify({ provider: "google", callbackURL: "/app" }),
  });

  const signUp = async (harness: Harness) => {
    const response = await api(harness, "/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: harness.base },
      body: JSON.stringify({
        email: `google-auth-${randomBytes(6).toString("hex")}@example.test`,
        password: randomBytes(24).toString("base64url"),
        name: "Google Auth Fixture",
      }),
    });
    expect(response.status).toBe(200);
    const cookie = response.headers.getSetCookie().find((value) => value.startsWith("better-auth.session_token="))?.split(";")[0];
    if (!cookie) throw new Error("Fixture sign-up returned no session cookie");
    return cookie;
  };

  const driveStatus = async (harness: Harness, cookie: string) => {
    const response = await api(harness, "/api/workspace/google/status", { headers: { origin: harness.base, cookie } });
    expect(response.status).toBe(200);
    return z.object({ accountDrive: z.object({ available: z.boolean(), connected: z.boolean() }) })
      .parse(await response.json()).accountDrive;
  };

  const driveConnect = (harness: Harness, cookie: string) =>
    api(harness, "/api/workspace/google/connect", { headers: { origin: harness.base, cookie } });

  beforeAll(async () => {
    // One block for both children: server + webhook port per harness.
    const basePort = await freePortBlock([0, 1, 2, 3], 57_000, 6_000);
    off = await startHarness(basePort, null);
    harnesses.push(off);
    on = await startHarness(basePort + 2, randomBytes(16).toString("hex"));
    harnesses.push(on);
  }, 60_000);

  afterAll(async () => {
    await Promise.all(harnesses.map((harness) => waitForExit(harness.child, { signal: "SIGTERM" })));
    const exited = harnesses.every((harness) => harness.child.exitCode !== null || harness.child.signalCode !== null);
    const noOutbound = harnesses.every((harness) => !existsSync(harness.networkLog));
    for (const harness of harnesses) await removeTempDir(harness.directory);
    const rootRemoved = harnesses.every((harness) => !existsSync(harness.directory));
    expect({ exited, noOutbound, rootRemoved }).toEqual({ exited: true, noOutbound: true, rootRemoved: true });
  }, 30_000);

  describe("capability off without credentials", () => {
    it("advertises no social provider, so no sign-in button can render", async () => {
      expect(await socialProvidersOf(off)).toEqual([]);
    }, 20_000);

    it("never redirects sign-in to Google", async () => {
      const response = await socialSignIn(off);
      expect(response.headers.get("location")).toBeNull();
      const body = await response.text();
      expect(response.status).toBe(404);
      expect(body).not.toContain("accounts.google.com");
    }, 20_000);

    it("keeps Drive unavailable for a signed-in user and refuses connect with the exact body", async () => {
      const cookie = await signUp(off);
      expect(await driveStatus(off, cookie)).toEqual({ available: false, connected: false });
      const connect = await driveConnect(off, cookie);
      expect({ status: connect.status, body: await connect.json() })
        .toEqual({ status: 501, body: ACCOUNT_DRIVE_UNAVAILABLE });
    }, 20_000);
  });

  describe("capability on with fixture credentials", () => {
    it("advertises exactly the Google provider", async () => {
      expect(await socialProvidersOf(on)).toEqual(["google"]);
    }, 20_000);

    it("sends sign-in basic-scope and never a Drive scope", async () => {
      const response = await socialSignIn(on);
      expect(response.status).toBe(200);
      const { url } = z.object({ url: z.string() }).parse(await response.json());
      const authorize = new URL(url);
      expect(authorize.origin).toBe("https://accounts.google.com");
      expect(authorize.searchParams.get("client_id")).toBe(on.googleId);
      // Deduped set: the provider appends its defaults to the configured list.
      const scopes = [...new Set((authorize.searchParams.get("scope") ?? "").split(/\s+/).filter(Boolean))].sort();
      expect(scopes).toEqual([...GOOGLE_SIGNIN_SCOPES].sort());
      expect(scopes.some((scope) => isDriveScope(scope))).toBe(false);
      expect(scopes).not.toContain(GOOGLE_DRIVE_APPDATA_SCOPE);
    }, 20_000);

    it("advertises Drive for a signed-in user with an appdata-only consent", async () => {
      const cookie = await signUp(on);
      expect(await driveStatus(on, cookie)).toEqual({ available: true, connected: false });
      const connect = await driveConnect(on, cookie);
      expect(connect.status).toBe(200);
      const consent = new URL(z.object({ url: z.string() }).parse(await connect.json()).url);
      expect(consent.origin + consent.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
      expect(consent.searchParams.get("client_id")).toBe(on.googleId);
      // Exactly the two consent scopes — no email/profile rides along, and
      // the Drive half asks for nothing the sign-in half never promised.
      const scopes = (consent.searchParams.get("scope") ?? "").split(/\s+/).filter(Boolean).sort();
      expect(scopes).toEqual([GOOGLE_DRIVE_APPDATA_SCOPE, "openid"].sort());
    }, 20_000);
  });
});
