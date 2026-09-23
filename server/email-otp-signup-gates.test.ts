// Sign-up gate parity for email one-time-code sign-in, on a deployment with
// OMB_SIGNUPS_CLOSED=true plus an allowlist: the OTP door must close exactly
// the way /api/auth/sign-up/email's door closes — unknown addresses rejected
// on BOTH send and verify (a guessed code must not register anyone),
// allowlisted addresses still get accounts, and accounts that exist
// regardless of the gate keep signing in, by password and by code.
// Its own spawned server because the gate is read per-request from env.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pairingServerEnvironment, waitForOwnedServer } from "../e2e/pairing-harness.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

const SEND_PATH = "/api/auth/email-otp/send-verification-otp";
const SIGN_IN_PATH = "/api/auth/sign-in/email-otp";
const ALLOWLISTED = ["allow-open@example.test", "allow-member@example.test"];

describe.skipIf(process.platform === "win32")("email one-time-code sign-in honors the sign-up gates", () => {
  let dir = "";
  let dataDirectory = "";
  let url = "";
  const children: ChildProcess[] = [];
  let output = "";

  const api = (path: string, method: string, body?: Record<string, string>, cookie = "") => {
    const request: RequestInit = {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: { "content-type": "application/json", origin: url, cookie },
    };
    if (body !== undefined) request.body = JSON.stringify(body);
    return fetch(`${url}${path}`, request);
  };

  const sendCode = (email: string) => api(SEND_PATH, "POST", { email, type: "sign-in" }, "");
  // `name` is only read when verify creates the account (first-time
  // sign-in); omitting it entirely matches Better Auth's own contract.
  const verifyCode = (email: string, otp: string, name?: string) =>
    name
      ? api(SIGN_IN_PATH, "POST", { email, otp, name }, "")
      : api(SIGN_IN_PATH, "POST", { email, otp }, "");

  // SAFETY: better-auth always sets this cookie name on a successful sign-in.
  const sessionCookie = (res: Response) =>
    (res.headers.getSetCookie() ?? [])
      .find((cookie) => cookie.startsWith("better-auth.session_token="))
      ?.split(";")[0] ?? "";

  const authDb = () => new DatabaseSync(join(dataDirectory, "auth.db"));

  /** Dev-mode code delivery, same contract as server/email-otp-login.test.ts. */
  async function harvestCode(email: string, since: number): Promise<string> {
    const escaped = email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`\\[otp\\] sign-in code for ${escaped}: (\\d{6})`);
    for (let attempt = 0; attempt < 400; attempt++) {
      const match = output.slice(since).match(pattern);
      if (match) return match[1];
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`no [otp] sign-in code for ${email} appeared in the server output`);
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "muster-otp-gates-"));
    dataDirectory = join(dir, "data");
    const home = join(dir, "home");
    const companion = join(dir, "companion");
    const ui = join(dir, "ui");
    for (const path of [dataDirectory, home, companion, ui]) {
      mkdirSync(path, { recursive: true, mode: 0o700 });
    }
    const port = await freePortBlock([0, 1, 2], 46000, 9000);
    const env = pairingServerEnvironment({
      home,
      dataDirectory,
      companionDirectory: companion,
      staticDir: ui,
      port,
      webhookPort: port + 1,
      secret: randomBytes(32).toString("hex"),
    });
    Object.assign(env, {
      OMB_ALLOW_SIGNUPS: "true",
      OMB_SIGNUPS_CLOSED: "true",
      OMB_SIGNUP_ALLOWLIST: ALLOWLISTED.join(", "),
    });
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", join(ROOT, "server/index.ts")],
      { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    children.push(child);
    const append = (chunk: Buffer | string) => {
      output += String(chunk);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    url = `http://127.0.0.1:${port}`;
    await waitForOwnedServer(child, url);
  }, 30_000);

  afterAll(async () => {
    await Promise.all(children.map((child) => waitForExit(child, { signal: "SIGTERM" })));
    await removeTempDir(dir);
  });

  it("blocks a non-allowlisted address on send with 403 SIGNUPS_CLOSED", async () => {
    const res = await sendCode("blocked-outside@example.test");
    expect(res.status).toBe(403);
    // SAFETY: the gate answers { message, code } exactly like the password
    // sign-up gate in server/index.ts.
    const body = (await res.json()) as { code?: string; message?: string };
    expect(body.code).toBe("SIGNUPS_CLOSED");
    expect(body.message).toBe("Sign-ups are closed on this deployment.");
  }, 30_000);

  it("blocks a non-allowlisted address on verify too — a guessed code registers nobody", async () => {
    const email = "blocked-verify@example.test";
    const res = await verifyCode(email, "123456");
    expect(res.status).toBe(403);
    // SAFETY: the gate answers { message, code } exactly like the password
    // sign-up gate in server/index.ts.
    expect(((await res.json()) as { code?: string }).code).toBe("SIGNUPS_CLOSED");
    const db = authDb();
    try {
      const user = db.prepare('SELECT "id" FROM "user" WHERE "email" = ?').get(email);
      expect(user, "gate must run before the plugin's sign-up-on-verify").toBeUndefined();
    } finally {
      db.close();
    }
  }, 30_000);

  it("lets an allowlisted address register through OTP while sign-ups are closed", async () => {
    const email = ALLOWLISTED[0];
    const since = output.length;
    expect((await sendCode(email)).status).toBe(200);
    const code = await harvestCode(email, since);
    const res = await verifyCode(email, code, "Allowed Opener");
    expect(res.status).toBe(200);
    const cookie = sessionCookie(res);
    expect(cookie).not.toBe("");

    const session = await api("/api/auth/get-session", "GET", undefined, cookie);
    // SAFETY: get-session answers { user, session } for a live cookie.
    const sessionBody = (await session.json()) as { user?: { email?: string } | null } | null;
    expect(sessionBody?.user?.email).toBe(email);

    const db = authDb();
    try {
      // SAFETY: the SELECT projects exactly the column asserted below.
      const user = db.prepare('SELECT "emailVerified" FROM "user" WHERE "email" = ?').get(email) as
        | { emailVerified: number }
        | undefined;
      expect(user).toBeDefined();
      expect(Number(user!.emailVerified)).toBe(1);
    } finally {
      db.close();
    }
  }, 30_000);

  it("keeps an allowlisted account's password sign-in working across an OTP sign-in", async () => {
    const email = ALLOWLISTED[1];
    const password = randomBytes(24).toString("base64url");
    // The password sign-up gate admits allowlisted addresses identically.
    const signup = await api("/api/auth/sign-up/email", "POST", { email, password, name: "Allowlisted Member" }, "");
    expect(signup.status).toBe(200);
    const before = await api("/api/auth/sign-in/email", "POST", { email, password }, "");
    expect(before.status).toBe(200);

    const since = output.length;
    expect((await sendCode(email)).status).toBe(200);
    const code = await harvestCode(email, since);
    expect((await verifyCode(email, code)).status).toBe(200);

    const after = await api("/api/auth/sign-in/email", "POST", { email, password }, "");
    expect(after.status).toBe(200);
  }, 30_000);

  it("lets a pre-existing non-allowlisted account sign in by code (gates close NEW accounts only)", async () => {
    const email = "preexisting@example.test";
    const db = authDb();
    try {
      const now = new Date().toISOString();
      // SAFETY: the INSERT matches the user table's columns from auth.ts's migrate().
      db.prepare(
        'INSERT INTO "user" ("id", "name", "email", "emailVerified", "image", "createdAt", "updatedAt") VALUES (?, ?, ?, 0, NULL, ?, ?)',
      ).run(`usr_${randomBytes(12).toString("base64url")}`, "Preexisting", email, now, now);
    } finally {
      db.close();
    }

    const since = output.length;
    const send = await sendCode(email);
    expect(send.status, "existing accounts pass the gate on send").toBe(200);
    const code = await harvestCode(email, since);
    const res = await verifyCode(email, code);
    expect(res.status).toBe(200);
    const cookie = sessionCookie(res);
    expect(cookie).not.toBe("");

    const session = await api("/api/auth/get-session", "GET", undefined, cookie);
    expect(session.status).toBe(200);
    // SAFETY: get-session answers { user, session } for a live cookie.
    const sessionBody = (await session.json()) as { user?: { email?: string; name?: string } | null } | null;
    expect(sessionBody?.user?.email).toBe(email);
    // The account was promoted in place, not replaced: the pre-OTP name
    // survives, which is the observable half of "same account, verified".
    expect(sessionBody?.user?.name).toBe("Preexisting");

    const after = authDb();
    try {
      // SAFETY: the SELECT projects exactly the column asserted below.
      const user = after.prepare('SELECT "emailVerified" FROM "user" WHERE "email" = ?').get(email) as
        | { emailVerified: number }
        | undefined;
      expect(Number(user!.emailVerified)).toBe(1);
    } finally {
      after.close();
    }
  }, 30_000);
});
