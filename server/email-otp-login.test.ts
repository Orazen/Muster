// Live acceptance for email + 6-digit one-time-code sign-in over the real
// harness routes: a send logs the code under the [otp] prefix when no
// mailer is configured (a fresh child env never carries RESEND_API_KEY),
// verify mints the standard session cookie, an unknown email registers with
// an owner membership and an active organization, wrong/expired/exhausted
// codes fail with the plugin's own error codes, a password account keeps
// its password after an OTP sign-in (the revokeUnprovenAccountAccess
// hazard the policy wrapper exists to prevent), and both the per-mailbox
// cooldown and the per-IP send budget hold — now uniformly priced in
// machine-readable `retryAfterSeconds` on every send rejection, with an
// Idempotency-Key replaying its accepted send instead of tripping the
// cooldown (study §5 S2/S3). Boot pattern mirrors
// server/workspace-brain-harness.test.ts; the gated describe mirrors
// server/email-otp-signup-gates.test.ts (its own child because the gate is
// read per-request from env); the otpSendPolicy describe runs on an
// injected clock with no server at all.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pairingServerEnvironment, waitForOwnedServer } from "../e2e/pairing-harness.ts";
import { otpSendPolicy } from "./email-otp-login.ts";
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

  const api = (
    path: string,
    method: string,
    body?: Record<string, string>,
    cookie = "",
    extraHeaders: Record<string, string> = {},
  ) => {
    const request: RequestInit = {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: { "content-type": "application/json", origin: url, cookie, ...extraHeaders },
    };
    if (body !== undefined) request.body = JSON.stringify(body);
    return fetch(`${url}${path}`, request);
  };

  // `idempotencyKey` rides the optional `Idempotency-Key` header — absent
  // for callers that do not pass one, exactly like a pre-S3 client.
  const sendCode = (email: string, idempotencyKey?: string) =>
    api(SEND_PATH, "POST", { email, type: "sign-in" }, "", idempotencyKey ? { "idempotency-key": idempotencyKey } : {});
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

  // Shared hand-offs: the code harvested here is what the next test
  // verifies; the cooldown triple is what the replay test replays against.
  let firstSendEmail = "";
  let firstSendCode = "";
  let cooldownEmail = "";
  let cooldownKey = "";
  let cooldownCode = "";

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

  it("enforces the per-mailbox resend cooldown with 429 RESEND_COOLDOWN priced in seconds", async () => {
    cooldownEmail = uniqueEmail("cooldown");
    cooldownKey = `k-${randomBytes(8).toString("hex")}`;
    const since = output.length;
    const first = await sendCode(cooldownEmail, cooldownKey);
    expect(first.status).toBe(200);
    cooldownCode = await harvestCode(cooldownEmail, since);
    expect(cooldownCode).toMatch(/^\d{6}$/);

    // No key on the repeat: there is no replay to serve, so the cooldown
    // must answer — with machine-readable seconds in body and both headers.
    const second = await sendCode(cooldownEmail);
    expect(second.status).toBe(429);
    // SAFETY: the cooldown gate answers { code, message, retryAfterSeconds }.
    const body = (await second.json()) as { code?: string; message?: string; retryAfterSeconds?: number };
    expect(body.code).toBe("RESEND_COOLDOWN");
    expect(String(body.message)).toMatch(/already sent/i);
    const seconds = Number(body.retryAfterSeconds);
    expect(Number.isInteger(seconds)).toBe(true);
    expect(seconds).toBeGreaterThanOrEqual(1);
    expect(seconds).toBeLessThanOrEqual(60);
    expect(second.headers.get("retry-after")).toBe(String(seconds));
    expect(second.headers.get("x-retry-after")).toBe(String(seconds));
  }, 30_000);

  it("replays an accepted send for its Idempotency-Key instead of tripping the cooldown", async () => {
    // Same (email, key) as the cooldown test's first send, still inside the
    // cooldown that send armed — a bare repeat would 429 here.
    const replayed = await sendCode(cooldownEmail, cooldownKey);
    expect(replayed.status).toBe(200);
    expect(replayed.headers.get("x-otp-replay")).toBe("1");
    expect(replayed.headers.get("idempotency-replayed")).toBe("true");
    // SAFETY: the plugin's send route answers { success: true } on
    // acceptance — the replay serves the recorded answer as-is.
    expect(await replayed.json()).toEqual({ success: true });

    // Nothing new went out: the original code still verifies.
    expect((await verifyCode(cooldownEmail, cooldownCode)).status).toBe(200);

    // A NEW key is a NEW attempt — it still pays the cooldown in full.
    const fresh = await sendCode(cooldownEmail, `k-${randomBytes(8).toString("hex")}`);
    expect(fresh.status).toBe(429);
    // SAFETY: as above — { code, message, retryAfterSeconds }.
    const body = (await fresh.json()) as { code?: string; retryAfterSeconds?: number };
    expect(body.code).toBe("RESEND_COOLDOWN");
    expect(Number(body.retryAfterSeconds)).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it("answers every non-rate send rejection with the uniform retryAfterSeconds field", async () => {
    // Wrapper-side validation (empty email): field present as 0, no wait headers.
    const empty = await sendCode("");
    expect(empty.status).toBe(400);
    // SAFETY: the wrapper's send rejections answer { message, code, retryAfterSeconds }.
    const emptyBody = (await empty.json()) as { code?: string; retryAfterSeconds?: number };
    expect(emptyBody.code).toBe("INVALID_EMAIL");
    expect(emptyBody.retryAfterSeconds).toBe(0);
    expect(empty.headers.get("retry-after")).toBeNull();

    // A malformed body is rejected before any window is consulted.
    const malformed = await fetch(`${url}${SEND_PATH}`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: { "content-type": "application/json", origin: url },
      body: "{not-json",
    });
    expect(malformed.status).toBe(400);
    // SAFETY: the readBody rejection passes through the same uniform shape.
    expect(((await malformed.json()) as { retryAfterSeconds?: number }).retryAfterSeconds).toBe(0);

    // A DELEGATED rejection — the plugin's own email validation — comes back
    // through the same shape: the backend's 400 relayed with seconds
    // injected as 0 (this send is accepted into the per-IP budget: the 7th).
    const junk = await sendCode("not-an-email");
    expect(junk.status).toBe(400);
    // SAFETY: the injected uniform shape on delegated send rejections.
    expect(((await junk.json()) as { retryAfterSeconds?: number }).retryAfterSeconds).toBe(0);
    expect(junk.headers.get("retry-after")).toBeNull();
  }, 30_000);

  it("stops a send burst at the per-IP rate-limit budget (the last request 429s)", async () => {
    // Budget: 8 sends / 60s per IP — the wrapper's tracked window answers
    // first (server/email-otp-login.ts), mirroring Better Auth's own send
    // rule (server/auth.ts customRules). Seven sends went out in the tests
    // above (cooldown rejection, keyed replay, verify and the validation
    // rejection never spend it), so the burst's first send is still inside
    // the window — at most the 8th accepted attempt — and even if the
    // window rolled mid-suite, nine back-to-back sends exceed eight on
    // their own, so the last one must trip the window in either timeline.
    const responses: Response[] = [];
    for (let index = 0; index < 9; index++) {
      responses.push(await sendCode(uniqueEmail(`burst${index}`)));
    }
    expect(responses[0].status).toBe(200);
    const last = responses[responses.length - 1];
    expect(last.status).toBe(429);
    // SAFETY: the wrapper's per-IP window answers this shape on the send route.
    const body = (await last.json()) as { code?: string; message?: string; retryAfterSeconds?: number };
    expect(body.code).toBe("RATE_LIMITED");
    expect(String(body.message)).toMatch(/too many code requests/i);
    const seconds = Number(body.retryAfterSeconds);
    expect(Number.isInteger(seconds)).toBe(true);
    expect(seconds).toBeGreaterThanOrEqual(1);
    expect(seconds).toBeLessThanOrEqual(60);
    expect(last.headers.get("retry-after")).toBe(String(seconds));
    expect(last.headers.get("x-retry-after")).not.toBeNull();
  }, 30_000);
});

// Gate parity for the new windows on a CLOSED deployment (own child: the
// gate is read per-request from env). The invariant under test: gates run
// before any window bookkeeping, so a stored Idempotency-Key can never
// answer for an address the gate closes — the gate's 403 comes back in the
// uniform shape (retryAfterSeconds 0, no wait headers) no matter what key
// rides the request.
describe.skipIf(process.platform === "win32")("OTP send windows never answer across a sign-up gate", () => {
  let dir = "";
  let url = "";
  const children: ChildProcess[] = [];
  let output = "";
  const ALLOWLISTED = "allow-send@example.test";

  const api = (
    path: string,
    method: string,
    body?: Record<string, string>,
    cookie = "",
    extraHeaders: Record<string, string> = {},
  ) => {
    const request: RequestInit = {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: { "content-type": "application/json", origin: url, cookie, ...extraHeaders },
    };
    if (body !== undefined) request.body = JSON.stringify(body);
    return fetch(`${url}${path}`, request);
  };

  const sendCode = (email: string, idempotencyKey?: string) =>
    api(SEND_PATH, "POST", { email, type: "sign-in" }, "", idempotencyKey ? { "idempotency-key": idempotencyKey } : {});

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "muster-otp-gated-"));
    const dataDirectory = join(dir, "data");
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
      OMB_SIGNUP_ALLOWLIST: ALLOWLISTED,
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

  it("replays the allowlisted mailbox's key while the gate keeps closing blocked ones", async () => {
    const key = `k-${randomBytes(8).toString("hex")}`;
    const first = await sendCode(ALLOWLISTED, key);
    expect(first.status).toBe(200);
    const replayed = await sendCode(ALLOWLISTED, key);
    expect(replayed.status).toBe(200);
    expect(replayed.headers.get("x-otp-replay")).toBe("1");

    // The SAME key on a gated address must not answer: the gate runs
    // before the replay map is consulted, and the map is keyed per mailbox
    // anyway — either way this is a 403 in the uniform shape, not a replay.
    const blocked = await sendCode("blocked-outside@example.test", key);
    expect(blocked.status).toBe(403);
    // SAFETY: the gate answers { message, code } plus the injected retryAfterSeconds.
    const body = (await blocked.json()) as { code?: string; message?: string; retryAfterSeconds?: number };
    expect(body.code).toBe("SIGNUPS_CLOSED");
    expect(body.message).toBe("Sign-ups are closed on this deployment.");
    expect(body.retryAfterSeconds).toBe(0);
    expect(blocked.headers.get("retry-after")).toBeNull();

    // Repeating with the same key changes nothing — a key can never turn a
    // gated address into an accepted one.
    const blockedAgain = await sendCode("blocked-outside@example.test", key);
    expect(blockedAgain.status).toBe(403);
    // SAFETY: same gate shape as above.
    expect(((await blockedAgain.json()) as { retryAfterSeconds?: number }).retryAfterSeconds).toBe(0);
  }, 30_000);
});

// The S2/S3 bookkeeping on an injected clock — window edges, TTL edges and
// the keyed independence of the three maps, provable without sleeping or a
// server (every otpSendPolicy function takes `now` explicitly).
describe("otpSendPolicy (deterministic clock)", () => {
  const T0 = 1_700_000_000_000;
  const EMAIL = "clocked@example.test";
  const NEIGHBOR = "neighbor@example.test";
  const IP = "203.0.113.7";
  const OTHER_IP = "198.51.100.23";

  beforeEach(() => {
    otpSendPolicy.reset();
  });
  afterAll(() => {
    otpSendPolicy.reset();
  });

  it("prices the per-mailbox cooldown to the second with an exact 60s boundary", () => {
    otpSendPolicy.armCooldown(EMAIL, T0);
    expect(otpSendPolicy.cooldownRemainingMs(EMAIL, T0)).toBe(60_000);
    expect(otpSendPolicy.cooldownRemainingMs(EMAIL, T0 + 59_999)).toBe(1);
    expect(otpSendPolicy.cooldownRemainingMs(EMAIL, T0 + 60_000)).toBe(0);
    // Per-mailbox, not per-IP: a neighbor never inherits the wait.
    expect(otpSendPolicy.cooldownRemainingMs(NEIGHBOR, T0 + 1_000)).toBe(0);
  });

  it("lets the per-IP window take exactly SEND_WINDOW_MAX sends, then waits the window out", () => {
    for (let sent = 0; sent < otpSendPolicy.SEND_WINDOW_MAX; sent++) {
      expect(otpSendPolicy.ipWindowRemainingMs(IP, T0)).toBe(0);
      otpSendPolicy.spendIpSend(IP, T0);
    }
    const blocked = otpSendPolicy.ipWindowRemainingMs(IP, T0);
    expect(blocked).toBeGreaterThan(0);
    expect(blocked).toBeLessThanOrEqual(otpSendPolicy.SEND_WINDOW_MS);
    expect(otpSendPolicy.ipWindowRemainingMs(IP, T0 + blocked - 1)).toBeGreaterThan(0);
    // A different source IP keeps its own budget — reads never create entries.
    expect(otpSendPolicy.ipWindowRemainingMs(OTHER_IP, T0)).toBe(0);
    expect(otpSendPolicy.sizes().ipWindows).toBe(1);
    // The window expires exactly at SEND_WINDOW_MS and drops out.
    expect(otpSendPolicy.ipWindowRemainingMs(IP, T0 + otpSendPolicy.SEND_WINDOW_MS)).toBe(0);
    expect(otpSendPolicy.sizes().ipWindows).toBe(0);
  });

  it("replays only a live (email, key) pair, scoped per mailbox and per key", () => {
    const recorded = JSON.stringify({ success: true });
    otpSendPolicy.rememberAcceptedSend(EMAIL, "key-a", 200, recorded, "application/json", [], T0);
    const replay = otpSendPolicy.replayOf(EMAIL, "key-a", T0);
    expect(replay?.status).toBe(200);
    expect(replay?.body).toBe(recorded);
    // Key scoping: another key for the same mailbox never answers.
    expect(otpSendPolicy.replayOf(EMAIL, "key-b", T0)).toBeNull();
    // Mailbox scoping: the same key never answers for a different address —
    // half of why "gate first" is safe even if ordering ever drifts.
    expect(otpSendPolicy.replayOf(NEIGHBOR, "key-a", T0)).toBeNull();
    // Live right up to the code's TTL boundary, dead one ms past it — and
    // the TTL outlives the cooldown, so a replay can never die before the
    // wait it is meant to replace.
    expect(otpSendPolicy.IDEMPOTENCY_TTL_MS).toBeGreaterThan(otpSendPolicy.RESEND_COOLDOWN_MS);
    expect(otpSendPolicy.replayOf(EMAIL, "key-a", T0 + otpSendPolicy.IDEMPOTENCY_TTL_MS)).not.toBeNull();
    expect(otpSendPolicy.replayOf(EMAIL, "key-a", T0 + otpSendPolicy.IDEMPOTENCY_TTL_MS + 1)).toBeNull();
    // The expired entry was dropped with the lookup — the map stays bounded.
    expect(otpSendPolicy.sizes().replays).toBe(0);
  });

  it("arms only what was spent, and prunes every map past its window", () => {
    otpSendPolicy.armCooldown(EMAIL, T0);
    otpSendPolicy.spendIpSend(IP, T0);
    otpSendPolicy.rememberAcceptedSend(EMAIL, "key-a", 200, "{}", "application/json", [], T0);
    expect(otpSendPolicy.sizes()).toEqual({ cooldowns: 1, ipWindows: 1, replays: 1 });
    // One prune past the longest window (the replay TTL) clears everything.
    otpSendPolicy.prune(T0 + otpSendPolicy.IDEMPOTENCY_TTL_MS + 1);
    expect(otpSendPolicy.sizes()).toEqual({ cooldowns: 0, ipWindows: 0, replays: 0 });
    expect(otpSendPolicy.cooldownRemainingMs(EMAIL, T0)).toBe(0);
    expect(otpSendPolicy.ipWindowRemainingMs(IP, T0)).toBe(0);
    expect(otpSendPolicy.replayOf(EMAIL, "key-a", T0)).toBeNull();
  });
});
