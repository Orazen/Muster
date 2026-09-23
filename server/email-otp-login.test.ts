// Live acceptance for email + 6-digit one-time-code sign-in over the real
// harness routes: a send logs the code under the [otp] prefix when no
// mailer is configured (a fresh child env never carries RESEND_API_KEY),
// verify mints the standard session cookie, an unknown email registers with
// an owner membership and an active organization, wrong/expired/exhausted
// codes fail with the plugin's own error codes, a password account keeps
// its password after an OTP sign-in (the revokeUnprovenAccountAccess
// hazard the policy wrapper exists to prevent), and both the per-mailbox
// cooldown and the per-IP send budget hold. Boot pattern mirrors
// server/workspace-brain-harness.test.ts.
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

describe.skipIf(process.platform === "win32")("email one-time-code sign-in over the live harness", () => {
  let dir = "";
  let dataDirectory = "";
  let url = "";
  const children: ChildProcess[] = [];
  let output = "";

  const uniqueEmail = (label: string) => `${label}-${randomBytes(5).toString("hex")}@example.test`;

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

  /** The dev-mode delivery channel: no mailer in a fresh child env, so the
   * server prints `[otp] sign-in code for <email>: <digits> — …` to its
   * output instead of mailing it. `since` scopes the hunt to lines printed
   * after the send that should have produced this code. */
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
    dir = mkdtempSync(join(tmpdir(), "muster-otp-live-"));
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
    Object.assign(env, { OMB_ALLOW_SIGNUPS: "true" });
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

  // Shared hand-off: the code harvested here is what the next test verifies.
  let firstSendEmail = "";
  let firstSendCode = "";

  it("sends a six-digit code and logs it under the [otp] prefix when no mailer is configured", async () => {
    firstSendEmail = uniqueEmail("send");
    const since = output.length;
    const res = await sendCode(firstSendEmail);
    expect(res.status).toBe(200);
    // SAFETY: the plugin's send route answers { success: true } on acceptance.
    expect(await res.json()).toEqual({ success: true });
    firstSendCode = await harvestCode(firstSendEmail, since);
    expect(firstSendCode).toMatch(/^\d{6}$/);
    // The prefix itself is the contract the local/dev delivery promise makes.
    expect(output.slice(since)).toContain(`[otp] sign-in code for ${firstSendEmail}: ${firstSendCode}`);
  }, 30_000);

  it("verifies the code, sets the standard session cookie, and answers get-session", async () => {
    const res = await verifyCode(firstSendEmail, firstSendCode);
    expect(res.status).toBe(200);
    // SAFETY: the plugin's sign-in route answers { token, user } on success.
    const body = (await res.json()) as { token?: string; user?: { email?: string } };
    expect(body.user?.email).toBe(firstSendEmail);
    expect(body.token).toEqual(expect.any(String));
    const cookie = sessionCookie(res);
    expect(cookie).not.toBe("");

    const session = await api("/api/auth/get-session", "GET", undefined, cookie);
    expect(session.status).toBe(200);
    // SAFETY: get-session answers { user, session } for a live cookie.
    const sessionBody = (await session.json()) as { user?: { email?: string } | null } | null;
    expect(sessionBody?.user?.email).toBe(firstSendEmail);
  }, 30_000);

  it("registers an unknown email on verify: verified account, owner membership, active organization", async () => {
    const email = uniqueEmail("fresh");
    const since = output.length;
    expect((await sendCode(email)).status).toBe(200);
    const code = await harvestCode(email, since);
    const res = await verifyCode(email, code, "Otp Tester");
    expect(res.status).toBe(200);
    const cookie = sessionCookie(res);
    expect(cookie).not.toBe("");

    const session = await api("/api/auth/get-session", "GET", undefined, cookie);
    expect(session.status).toBe(200);
    // SAFETY: get-session answers { user, session }; only email, name and
    // activeOrganizationId are read from that live-cookie envelope.
    const sessionBody = (await session.json()) as {
      user?: { email?: string; name?: string } | null;
      session?: { activeOrganizationId?: string | null };
    } | null;
    expect(sessionBody?.user?.email).toBe(email);
    expect(sessionBody?.user?.name).toBe("Otp Tester");
    expect(sessionBody?.session?.activeOrganizationId).toBeTruthy();

    const db = authDb();
    try {
      // SAFETY: the SELECT projects exactly the columns asserted below.
      const user = db
        .prepare('SELECT "id", "emailVerified" FROM "user" WHERE "email" = ?')
        .get(email) as { id: string; emailVerified: number } | undefined;
      expect(user, "user row created by OTP verify").toBeDefined();
      expect(Number(user!.emailVerified)).toBe(1);
      // SAFETY: the SELECT projects exactly the column asserted below.
      const member = db
        .prepare('SELECT "role" FROM "member" WHERE "userId" = ?')
        .get(user!.id) as { role: string } | undefined;
      expect(member?.role).toBe("owner");
    } finally {
      db.close();
    }
  }, 30_000);

  it("counts wrong codes: three 400 INVALID_OTP, then 403 TOO_MANY_ATTEMPTS, then the code is dead", async () => {
    const email = uniqueEmail("wrong");
    const since = output.length;
    expect((await sendCode(email)).status).toBe(200);
    const actual = await harvestCode(email, since);
    const wrong = String((parseInt(actual, 10) + 1) % 1_000_000).padStart(6, "0");
    for (let attempt = 1; attempt <= 3; attempt++) {
      const res = await verifyCode(email, wrong);
      expect(res.status).toBe(400);
      // SAFETY: the plugin answers { message, code } on OTP failures.
      expect(((await res.json()) as { code?: string }).code).toBe("INVALID_OTP");
    }
    const locked = await verifyCode(email, wrong);
    expect(locked.status).toBe(403);
    // SAFETY: the plugin answers { message, code } on OTP failures.
    expect(((await locked.json()) as { code?: string }).code).toBe("TOO_MANY_ATTEMPTS");
    // The verification row is consumed by the lockout: even the right code
    // no longer opens the door, so guessing after lockout gains nothing.
    const afterLock = await verifyCode(email, actual);
    expect(afterLock.status).toBe(400);
    // SAFETY: the plugin answers { message, code } on OTP failures.
    expect(((await afterLock.json()) as { code?: string }).code).toBe("INVALID_OTP");
  }, 30_000);

  it("rejects an expired code with OTP_EXPIRED", async () => {
    const email = uniqueEmail("expired");
    const since = output.length;
    expect((await sendCode(email)).status).toBe(200);
    await harvestCode(email, since);
    const db = authDb();
    try {
      const identifier = `sign-in-otp-${email}`;
      // SAFETY: the SELECT projects the expiry column this test rewrites.
      const row = db
        .prepare('SELECT "expiresAt" FROM "verification" WHERE "identifier" = ?')
        .get(identifier) as { expiresAt: string | number | bigint } | undefined;
      expect(row, "verification row for the sent code").toBeDefined();
      // Rewrite expiry into the past in whatever representation the server
      // wrote (ISO string, epoch ms, or bigint), so the plugin's expiry
      // comparison sees an expired row either way.
      const past =
        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- verification.expiresAt carries SQLite's date affinity: string | number | bigint all occur, and rewriting in-kind preserves whichever one the server wrote
        typeof row!.expiresAt === "string"
          ? new Date(Date.now() - 60_000).toISOString()
          // oxlint-disable-next-line anti-slop/no-runtime-typeof -- same three-representation rewrite; coercing across them would bind a value the column's original type never held
          : typeof row!.expiresAt === "bigint"
            ? BigInt(Date.now() - 60_000)
            : Date.now() - 60_000;
      const update = db
        .prepare('UPDATE "verification" SET "expiresAt" = ? WHERE "identifier" = ?')
        .run(past, identifier);
      expect(Number(update.changes)).toBe(1);
    } finally {
      db.close();
    }
    // Expiry is checked before the code is compared — any code answers the
    // same way for an expired row.
    const res = await verifyCode(email, "000000");
    expect(res.status).toBe(400);
    // SAFETY: the plugin answers { message, code } on OTP failures.
    expect(((await res.json()) as { code?: string }).code).toBe("OTP_EXPIRED");
  }, 30_000);

  it("keeps a password account working across an OTP sign-in (the revocation hazard)", async () => {
    const email = uniqueEmail("pwuser");
    const password = randomBytes(24).toString("base64url");
    const signup = await api("/api/auth/sign-up/email", "POST", { email, password, name: "Password User" }, "");
    expect(signup.status).toBe(200);

    // Baseline: the password works before the OTP flow touches anything.
    const before = await api("/api/auth/sign-in/email", "POST", { email, password }, "");
    expect(before.status).toBe(200);

    const since = output.length;
    expect((await sendCode(email)).status).toBe(200);
    const code = await harvestCode(email, since);
    const otpRes = await verifyCode(email, code);
    expect(otpRes.status).toBe(200);
    expect(sessionCookie(otpRes)).not.toBe("");

    // THE regression this suite exists for: without the wrapper's
    // check-then-promote step, the plugin's sign-in route would run
    // revokeUnprovenAccountAccess on this emailVerified: false account and
    // DELETE its password link — this sign-in would come back 401.
    const after = await api("/api/auth/sign-in/email", "POST", { email, password }, "");
    expect(after.status).toBe(200);

    const db = authDb();
    try {
      // SAFETY: the SELECT projects exactly the columns asserted below.
      const account = db
        .prepare(
          'SELECT "id" FROM "account" WHERE "userId" = (SELECT "id" FROM "user" WHERE "email" = ?) AND "providerId" = ?',
        )
        .get(email, "credential") as { id: string } | undefined;
      expect(account, "credential/password account link survives the OTP sign-in").toBeDefined();
      // SAFETY: the SELECT projects exactly the column asserted below.
      const user = db
        .prepare('SELECT "emailVerified" FROM "user" WHERE "email" = ?')
        .get(email) as { emailVerified: number } | undefined;
      expect(Number(user!.emailVerified)).toBe(1);
    } finally {
      db.close();
    }
  }, 30_000);

  it("enforces the per-mailbox resend cooldown with 429 RESEND_COOLDOWN", async () => {
    const email = uniqueEmail("cooldown");
    const first = await sendCode(email);
    expect(first.status).toBe(200);
    const second = await sendCode(email);
    expect(second.status).toBe(429);
    // SAFETY: the cooldown gate answers { code, message } like the other gates.
    const body = (await second.json()) as { code?: string; message?: string };
    expect(body.code).toBe("RESEND_COOLDOWN");
    expect(String(body.message)).toMatch(/already sent/i);
  }, 30_000);

  it("stops a send burst at the per-IP rate-limit budget (the last request 429s)", async () => {
    // Budget: 8 sends / 60s per IP (server/auth.ts customRules). Six sends
    // went out in the tests above (the cooldown rejection never reaches the
    // limiter), so the burst's first send is still inside the window at
    // most the 7th attempt — and even if the window rolled mid-suite, nine
    // back-to-back sends exceed eight on their own, so the last one must
    // trip the limiter in either timeline.
    const responses: Response[] = [];
    for (let index = 0; index < 9; index++) {
      responses.push(await sendCode(uniqueEmail(`burst${index}`)));
    }
    expect(responses[0].status).toBe(200);
    const last = responses[responses.length - 1];
    expect(last.status).toBe(429);
    // SAFETY: Better Auth's rate limiter answers this exact message + header.
    expect(String(((await last.json()) as { message?: string }).message)).toMatch(/too many requests/i);
    expect(last.headers.get("x-retry-after")).not.toBeNull();
  }, 30_000);
});
