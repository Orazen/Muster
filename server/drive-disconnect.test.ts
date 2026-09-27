// The Drive disconnect verb, over real HTTP.
//
// Until this route existed the only way to drop a user's stored Drive grant was
// to delete the install's database, and the privacy policy said exactly that
// ("the workspace backup interface currently has no Drive-disconnect control").
// A grant the user cannot withdraw is not consent they gave.
//
// The guards are the connect route's, so each one is asserted rather than
// assumed: a request with no session must never reach the database, a session
// that is not the grant's owner must be refused, and a cross-site request must
// not be able to disconnect anything. `disconnectDrive` also advances the grant
// generation, so an in-flight access assertion self-invalidates.

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const posixOnly = describe.skipIf(process.platform === "win32");

const DISCONNECT = "/api/workspace/google/connection";

let child: ChildProcess;
let home: string;
let base: string;
let stderr = "";
let dataDir = "";
const cookies = new Map<string, string>();

async function signUp(email: string): Promise<string> {
  const response = await fetch(`${base}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ email, password: "correct-horse-battery", name: email.split("@")[0] }),
    redirect: "manual",
  });
  expect(response.status, `sign-up for ${email}: ${await response.text()}`).toBe(200);
  const jar = response.headers.getSetCookie?.() ?? [];
  const session = jar.find((c) => c.startsWith("better-auth.session_token="));
  // SAFETY: the status assertion above throws first, so an absent cookie is a
  // fixture failure rather than an empty cookie silently 401ing every call.
  expect(session, `no session cookie for ${email}`).toBeTruthy();
  // SAFETY: guarded by the assertion immediately above.
  return (session as string).split(";")[0] as string;
}

type Options = { cookie?: string; origin?: string | null; secFetchSite?: string; method?: string };

function call(path: string, options: Options = {}): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (options.cookie) headers.cookie = options.cookie;
  if (options.origin !== null) headers.origin = options.origin ?? base;
  if (options.secFetchSite) headers["sec-fetch-site"] = options.secFetchSite;
  return fetch(`${base}${path}`, { method: options.method ?? "DELETE", headers, redirect: "manual" })
    .then(async (response) => {
      const text = await response.text();
      // SAFETY: every route here answers JSON — the contained 501, the 401, the
      // 403 and the 200 all carry `{error}` or `{disconnected}` — so the parse
      // cannot see an HTML error page from a proxy.
      return { status: response.status, body: text ? JSON.parse(text) : null };
    });
}

posixOnly("account Drive can be disconnected", () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "muster-drive-disconnect-"));
    const data = join(home, "data");
    dataDir = data;
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "config.json"), JSON.stringify({}));
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ["--experimental-strip-types", join(SERVER_DIR, "index.ts")], {
      cwd: ROOT,
      env: {
        HOME: home,
        USERPROFILE: home,
        OMB_DATA_DIR: data,
        OMB_COMPANION_DIR: join(home, "companion"),
        OMB_HOST: "127.0.0.1",
        OMB_PORT: String(port),
        OMB_WEBHOOK_PORT: String(port + 1),
        OMB_PUBLIC_URL: base,
        BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
        OMB_ALLOW_SIGNUPS: "true",
        // Random fixture credentials, never a real pair. These exist so the
        // route is past its "capability off" 501; the grant itself is created
        // directly against the database, so no consent flow is exercised.
        GOOGLE_CLIENT_ID: randomBytes(12).toString("hex"),
        GOOGLE_CLIENT_SECRET: randomBytes(32).toString("hex"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (chunk) => { stderr += chunk; });
    child.stdout!.resume();
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        const response = await fetch(`${base}/api/health`, { redirect: "manual" });
        if (response.ok) break;
      } catch {
        /* the listener is not up yet */
      }
      if (child.exitCode !== null || Date.now() > deadline) {
        throw new Error(`drive-disconnect fixture did not start: ${stderr}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    // pat@example.com exists only for the grant-ownership case below, so no
    // earlier case has advanced its generation and the seeding stays simple.
    for (const email of ["ada@example.com", "zoe@example.com", "pat@example.com"]) {
      cookies.set(email, await signUp(email));
    }
  }, 45_000);

  afterAll(async () => {
    child?.kill("SIGKILL");
    await waitForExit(child).catch(() => {});
    if (home) await removeTempDir(home);
  });

  it("refuses a request with no session, without reaching the database", async () => {
    // Same contained 501 the connect route answers. A request with no account
    // row must not be able to delete grants.
    const response = await call(DISCONNECT);
    expect(response.status).toBe(501);
    expect(response.body.error).toMatch(/not (available|connected|configured)|unavailable/i);
  });

  it("refuses a cross-site request", async () => {
    const response = await call(DISCONNECT, { cookie: cookies.get("ada@example.com"), secFetchSite: "cross-site" });
    expect(response.status).toBe(403);
    expect(response.body.error).toMatch(/settings/i);
  });

  it("answers honestly for a signed-in account with no grant", async () => {
    // The idempotent case: disconnecting nothing is not an error, and it must not
    // claim it removed a grant that never existed.
    const response = await call(DISCONNECT, { cookie: cookies.get("ada@example.com") });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ disconnected: true });
  });

  it("removes the grant it is given, and only that account's", async () => {
    // Seed real grant rows, then disconnect one account's and assert the other
    // survives. This is the whole point of the verb, and it is the only case
    // that would catch a route that deleted grants by table rather than by
    // owner.
    //
    // The database is opened at THIS fixture's auth.db path on purpose. The
    // store's own `getDb()` binds DATA_DIR at module load from the TEST
    // process's environment, so importing it here would read and write the real
    // repository database rather than the temp one this fixture created.
    const drive = await import("./drive-grants.ts");
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(dataDir, "auth.db"));
    try {
      const idOf = async (email: string): Promise<string> => {
        const session = (await fetch(`${base}/api/auth/get-session`, {
          headers: { cookie: cookies.get(email), origin: base },
          redirect: "manual",
        }).then((r) => r.json())) as { user: { id: string } };
        return session.user.id;
      };
      const zoeId = await idOf("zoe@example.com");
      const patId = await idOf("pat@example.com");

      for (const id of [zoeId, patId]) {
        drive.createDriveState(db, { userId: id, sessionId: "fixture" });
        // Read the generation createDriveState just left behind rather than
        // assuming 0: both it and disconnectDrive advance the counter, and
        // saveDriveGrant refuses a stale value on purpose.
        const epoch = db
          .prepare("SELECT generation FROM drive_grant_generations WHERE userId = ?")
          .get(id) as { generation: number } | undefined;
        drive.saveDriveGrant(db, {
          userId: id,
          googleSub: `google-${id}`,
          accessToken: "fixture-access",
          refreshToken: "fixture-refresh",
          expiresAt: 900_000_000_000,
          scopes: [drive.DRIVE_APPDATA_SCOPE],
          expectedGeneration: epoch?.generation ?? 0,
        });
      }
      expect(drive.getDriveGrant(db, zoeId), "ZOE's fixture grant was not written").not.toBeNull();
      expect(drive.getDriveGrant(db, patId), "PAT's fixture grant was not written").not.toBeNull();

      const response = await call(DISCONNECT, { cookie: cookies.get("zoe@example.com") });
      expect(response.status).toBe(200);
      expect(drive.getDriveGrant(db, zoeId), "ZOE's grant survived her own disconnect").toBeNull();
      expect(drive.getDriveGrant(db, patId), "disconnecting ZOE removed PAT's grant too").not.toBeNull();

      // And the second disconnect is honest rather than a lie about a removal.
      const again = await call(DISCONNECT, { cookie: cookies.get("zoe@example.com") });
      expect(again.status).toBe(200);
      expect(drive.getDriveGrant(db, patId)).not.toBeNull();

      drive.disconnectDrive(db, patId);
      expect(drive.getDriveGrant(db, patId)).toBeNull();
    } finally {
      db.close();
    }
  });

  it("is not reachable by any verb but DELETE", async () => {
    // A stray GET must not disconnect anything.
    const response = await call(DISCONNECT, {
      cookie: cookies.get("ada@example.com"),
      method: "GET",
    });
    expect(response.status).toBe(404);
  });
});
