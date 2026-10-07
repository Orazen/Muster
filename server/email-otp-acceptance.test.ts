// Acceptance for four OTP sign-in requirements the owner register claims as
// PASS but that no suite in this lane actually proves. Each case below failed
// to exist before this file; none of them asserts a new behaviour of the
// server, only what the shipped routes and tables already do. Read the
// library source this pins:
//   • supersession — better-auth/dist/plugins/email-otp/index.mjs resolveOTP
//     has no default resendStrategy, so every send mints a fresh code;
//     db/internal-adapter.mjs findVerificationValue sorts createdAt DESC
//     limit 1 and consumeVerificationValue deletes every row for the
//     identifier, so only the newest code can ever be consumed.
//   • logout / account switching / identity separation — better-auth's
//     own sign-out and session routes over the tables server/auth.ts
//     migrates.
//
// Boot pattern mirrors server/email-otp-login.test.ts: an owned child server
// on an owned port, a throwaway HOME and data dir, and codes harvested from
// the dev-mode [otp] console sink. No real mail, no Google account, no
// production data, and nothing here touches 127.0.0.1:8845.
//
// The second describe boots its own child with a CONFIGURED mailer (a stub
// transport that replaces global fetch inside the child only — the fixture
// server/email-otp-delivery-harness.test.ts already uses) so two claims can be
// checked on the path a real deployment takes: that a 6-digit code never
// reaches the server's own stdout/stderr once a mailer is configured, and that
// the per-MAILBOX cooldown — not the per-IP window — is the bound that holds.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { pairingServerEnvironment, waitForOwnedServer } from "../e2e/pairing-harness.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

const SEND_PATH = "/api/auth/email-otp/send-verification-otp";
const SIGN_IN_PATH = "/api/auth/sign-in/email-otp";
const SIGN_OUT_PATH = "/api/auth/sign-out";
const GET_SESSION_PATH = "/api/auth/get-session";
const SIGN_UP_PATH = "/api/auth/sign-up/email";
const PASSWORD_SIGN_IN_PATH = "/api/auth/sign-in/email";

/** The plugin's own hashed-OTP storage format: sha256, unpadded base64url,
 * with the attempt counter after the last colon. Mirrors
 * defaultKeyHasher/splitAtLastColon in
 * node_modules/better-auth/dist/plugins/email-otp/{utils,otp-token}.mjs. */
const hashOtp = (otp: string) => createHash("sha256").update(otp).digest().toString("base64url");
const signInIdentifier = (email: string) => `sign-in-otp-${email}`;

const userRow = z.object({ id: z.string(), emailVerified: z.number() });
const sessionRows = z.array(z.object({ id: z.string(), userId: z.string(), expiresAt: z.union([z.string(), z.number(), z.bigint()]) }));
const accountRows = z.array(z.object({ id: z.string(), providerId: z.string(), accountId: z.string(), userId: z.string() }));

describe.skipIf(process.platform === "win32")("OTP sign-in acceptance the register claimed but nothing proved", () => {
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

  const sendCode = (email: string, type = "sign-in") => api(SEND_PATH, "POST", { email, type });
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

  /** Sign a fresh mailbox in by code and return its live session cookie. */
  const signInByCode = async (label: string): Promise<{ email: string; code: string; cookie: string }> => {
    const email = uniqueEmail(label);
    const since = output.length;
    expect((await sendCode(email)).status).toBe(200);
    const code = await harvestCode(email, since);
    const res = await verifyCode(email, code, "Acceptance Tester");
    expect(res.status).toBe(200);
    const cookie = sessionCookie(res);
    expect(cookie).not.toBe("");
    return { email, code, cookie };
  };

  const userIdOf = (db: DatabaseSync, email: string): string | undefined => {
    // SAFETY: the SELECT projects exactly the column read below.
    const row = db.prepare('SELECT "id" FROM "user" WHERE "email" = ?').get(email) as
      | { id: string }
      | undefined;
    return row?.id;
  };

  const verifiedFlagOf = (db: DatabaseSync, email: string): number => {
    // SAFETY: the SELECT projects exactly the two columns asserted below.
    const row = userRow.safeParse(db.prepare('SELECT "id", "emailVerified" FROM "user" WHERE "email" = ?').get(email));
    expect(row.success, `user row for ${email}`).toBe(true);
    return row.success ? row.data.emailVerified : -1;
  };

  const sessionCountOf = (db: DatabaseSync, userId: string): number =>
    // SAFETY: the SELECT projects exactly the columns counted here.
    sessionRows.safeParse(db.prepare('SELECT "id", "userId", "expiresAt" FROM "session" WHERE "userId" = ?').all(userId))
      .data?.length ?? 0;

  const accountRowsOf = (db: DatabaseSync, userId: string) =>
    // SAFETY: the SELECT projects exactly the columns asserted below.
    accountRows.parse(
      db.prepare('SELECT "id", "providerId", "accountId", "userId" FROM "account" WHERE "userId" = ?').all(userId),
    );

  /** Session death, tested the way the house suites test it: get-session
   * answers 200 null with refresh disabled (so a dead token cannot be
   * silently renewed by the read) and a protected route refuses it. */
  const assertSessionDead = async (cookie: string) => {
    const dead = await api(`${GET_SESSION_PATH}?disableRefresh=true`, "GET", undefined, cookie);
    expect(dead.status).toBe(200);
    expect(await dead.json()).toBeNull();
    expect((await api("/api/bots", "GET", undefined, cookie)).status).toBe(401);
  };

  const assertSessionLiveAs = async (cookie: string, email: string) => {
    expect((await api("/api/bots", "GET", undefined, cookie)).status).toBe(200);
    const res = await api(GET_SESSION_PATH, "GET", undefined, cookie);
    // SAFETY: get-session answers { user, session }; only email is read here.
    const body = (await res.json()) as { user?: { email?: string } | null } | null;
    expect(body?.user?.email).toBe(email);
  };

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
    dir = mkdtempSync(join(tmpdir(), "muster-otp-accept-"));
    dataDirectory = join(dir, "data");
    const home = join(dir, "home");
    const companion = join(dir, "companion");
    const ui = join(dir, "ui");
    for (const path of [dataDirectory, home, companion, ui]) {
      mkdirSync(path, { recursive: true, mode: 0o700 });
    }
    const port = await freePortBlock([0, 1, 2], 48000, 9000);
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
      // The SELF_HOSTED gate input (server/auth.ts), so /api/bots really
      // demands a live session the way the hosted deployment does.
      OMB_PUBLIC_HOST: `127.0.0.1:${port}`,
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
  }, 45_000);

  afterAll(async () => {
    await Promise.all(children.map((child) => waitForExit(child, { signal: "SIGTERM" })));
    await removeTempDir(dir);
  });

  it("supersedes the previous code: a newer send kills the older one for the same mailbox", async () => {
    // The register claims "superseded codes" are handled. Nothing proved it.
    // The wrapper's 60s per-mailbox cooldown means a second LIVE send cannot
    // happen here, so the older code is seeded straight into the plugin's own
    // verification row (the fixture technique server/email-otp-verify-email-custody.test.ts
    // already uses) and then superseded by a real send.
    const email = uniqueEmail("superseded");
    const supersededCode = "445566";
    const seed = authDb();
    try {
      const now = new Date();
      // SAFETY: the INSERT names exactly the six columns server/auth.ts's
      // migrate() declares for "verification", and the value carries the
      // plugin's own hash:attempts form.
      seed
        .prepare(
          'INSERT INTO "verification" ("id", "identifier", "value", "expiresAt", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(
          `ver_${randomBytes(12).toString("hex")}`,
          signInIdentifier(email),
          `${hashOtp(supersededCode)}:0`,
          new Date(now.getTime() + 10 * 60_000).toISOString(),
          new Date(now.getTime() - 60_000).toISOString(),
          new Date(now.getTime() - 60_000).toISOString(),
        );
    } finally {
      seed.close();
    }

    // Prove the old unexpired row exists without consuming it. Verifying it
    // here would delete it, making the later refusal a replay test instead
    // of a supersession test.
    const beforeSend = authDb();
    try {
      const row = z.object({ value: z.string(), expiresAt: z.string() }).parse(
        beforeSend.prepare('SELECT "value", "expiresAt" FROM "verification" WHERE "identifier" = ?').get(signInIdentifier(email)),
      );
      expect(row.value).toBe(`${hashOtp(supersededCode)}:0`);
      expect(Date.parse(row.expiresAt)).toBeGreaterThan(Date.now());
      expect(userIdOf(beforeSend, email)).toBeUndefined();
    } finally {
      beforeSend.close();
    }

    // A newer send for the same mailbox supersedes it.
    const since = output.length;
    expect((await sendCode(email)).status).toBe(200);
    const currentCode = await harvestCode(email, since);
    expect(currentCode).not.toBe(supersededCode);

    const beforeSuperseded = authDb();
    try {
      expect(userIdOf(beforeSuperseded, email)).toBeUndefined();
    } finally {
      beforeSuperseded.close();
    }

    const superseded = await verifyCode(email, supersededCode);
    expect(superseded.status).toBe(400);
    // SAFETY: the plugin answers { message, code } on OTP failures.
    expect(((await superseded.json()) as { code?: string }).code).toBe("INVALID_OTP");
    expect(sessionCookie(superseded), "a superseded code mints no session").toBe("");

    // The superseded attempt added no session of its own.
    const afterSuperseded = authDb();
    try {
      expect(userIdOf(afterSuperseded, email), "the old code cannot create an account or session").toBeUndefined();
    } finally {
      afterSuperseded.close();
    }

    // And only the newer code opens the door.
    const current = await verifyCode(email, currentCode);
    expect(current.status).toBe(200);
    const cookie = sessionCookie(current);
    expect(cookie).not.toBe("");

    const db = authDb();
    try {
      expect(sessionCountOf(db, userIdOf(db, email)!)).toBe(1);
    } finally {
      db.close();
    }
  }, 45_000);

  it("logs a mailbox out: sign-out kills the OTP-minted session on every surface", async () => {
    const { email, cookie } = await signInByCode("logout");
    await assertSessionLiveAs(cookie, email);

    const signedOut = await api(SIGN_OUT_PATH, "POST", {}, cookie);
    expect(signedOut.status).toBe(200);

    // The cookie no longer answers a session read, and a protected route
    // refuses it: logout is not cosmetic.
    await assertSessionDead(cookie);

    // The session row is gone from the table too, not just unreadable.
    const db = authDb();
    try {
      expect(sessionCountOf(db, userIdOf(db, email)!)).toBe(0);
    } finally {
      db.close();
    }
  }, 45_000);

  it("keeps two code-signed-in accounts separate across a switch, and signing out of one keeps the other", async () => {
    const first = await signInByCode("switch-a");
    const second = await signInByCode("switch-b");
    expect(first.email).not.toBe(second.email);

    // Switching: the second sign-in replaces the browser's cookie (that is
    // what one cookie jar holds), but the FIRST session is untouched on the
    // server — it is a separate row owned by a separate account.
    await assertSessionLiveAs(second.cookie, second.email);
    await assertSessionLiveAs(first.cookie, first.email);

    const db = authDb();
    try {
      expect(sessionCountOf(db, userIdOf(db, first.email)!)).toBe(1);
      expect(sessionCountOf(db, userIdOf(db, second.email)!)).toBe(1);
    } finally {
      db.close();
    }

    // Signing out of the account the browser is currently on must not reach
    // across and kill the other account's standing session.
    expect((await api(SIGN_OUT_PATH, "POST", {}, second.cookie)).status).toBe(200);
    await assertSessionDead(second.cookie);
    await assertSessionLiveAs(first.cookie, first.email);

    // And the signed-out account is gone from the table, not merely unreadable.
    const afterSignOut = authDb();
    try {
      expect(sessionCountOf(afterSignOut, userIdOf(afterSignOut, second.email)!)).toBe(0);
      expect(sessionCountOf(afterSignOut, userIdOf(afterSignOut, first.email)!)).toBe(1);
    } finally {
      afterSignOut.close();
    }
  }, 45_000);

  it("does not let a non-sign-in code request arm the sign-in cooldown", async () => {
    // THE REGRESSION this file found. `type` is forwarded to the plugin, so a
    // caller can send an email-verification / forget-password / change-email
    // code down the intercepted send route. For a non-sign-in type on an
    // unknown address the plugin short-circuits: no code is stored, the sender
    // is never called, and the route answers {success:true}. shouldRecordDelivery
    // records only the sign-in type, so the outcome read back was structurally
    // undefined — and the wrapper armed the 60s per-mailbox cooldown anyway.
    // Observed before the fix in server/email-otp-login.ts:
    //   first  = 200 {"success":true}      (no code, no mail — proved below)
    //   second = 429 {"code":"RESEND_COOLDOWN","retryAfterSeconds":60}
    // So asking for a verification code blocked the next real sign-in-code
    // request for a minute, on a request that produced nothing to protect.
    const email = uniqueEmail("type-gate");
    const since = output.length;
    const first = await sendCode(email, "email-verification");
    expect(first.status).toBe(200);
    // SAFETY: the plugin's send route answers { success: true } on acceptance.
    expect(await first.json()).toEqual({ success: true });
    // Nothing was minted or delivered: the dev console sink is the only channel
    // this child has, and it stayed silent.
    expect(output.slice(since)).not.toMatch(/\[otp\] sign-in code/);

    // The very next sign-in-code request is admitted.
    const signInSince = output.length;
    const second = await sendCode(email, "sign-in");
    expect(second.status, "a send that minted no code must not price a cooldown").toBe(200);
    const code = await harvestCode(email, signInSince);
    expect(code).toMatch(/^\d{6}$/);

    // And a genuine sign-in send still arms it — the fix is keyed on the
    // sender's verdict, not on weakening the cooldown.
    const third = await sendCode(email, "sign-in");
    expect(third.status).toBe(429);
    // SAFETY: the cooldown gate answers { code, message, retryAfterSeconds }.
    expect(((await third.json()) as { code?: string }).code).toBe("RESEND_COOLDOWN");

    // The admitted code is the one that works.
    expect((await verifyCode(email, code, "Type Gate")).status).toBe(200);
  }, 45_000);

  it("treats an OTP-verified mailbox as an email identity, never a verified Google identity", async () => {
    // (a) An account created by proving a mailbox carries NO provider link at
    // all. emailVerified=1 is an inbox proof, not an OAuth proof: there is no
    // google accountId for anything downstream to treat as a Google subject
    // (server/installation-enrollment-identity.ts currentAccount reads exactly
    // that row and refuses with "provider-subject" without it).
    const fresh = await signInByCode("no-google");
    const db = authDb();
    try {
      const userId = userIdOf(db, fresh.email)!;
      expect(verifiedFlagOf(db, fresh.email)).toBe(1);
      expect(accountRowsOf(db, userId)).toEqual([]);
    } finally {
      db.close();
    }

    // (b) A pre-registered UNPROVEN mailbox that already carries a linked
    // Google account row loses that link when the real owner proves the inbox
    // by code — so an OTP proof can never leave a Google identity standing on
    // a mailbox whose owner just took custody of it.
    const victim = uniqueEmail("google-unproven");
    const googleSubject = `google-sub-${randomBytes(8).toString("hex")}`;
    const password = randomBytes(24).toString("base64url");
    const signup = await api(SIGN_UP_PATH, "POST", { email: victim, password, name: "Unproven Google" }, "");
    expect(signup.status).toBe(200);
    const standingCookie = sessionCookie(signup);
    expect(standingCookie).not.toBe("");

    const seed = authDb();
    try {
      const now = new Date().toISOString();
      const userId = userIdOf(seed, victim)!;
      // SAFETY: the INSERT names exactly the columns server/auth.ts's
      // migrate() declares for "account"; providerId is the literal 'google'.
      seed
        .prepare(
          'INSERT INTO "account" ("id", "accountId", "providerId", "userId", "accessToken", "refreshToken", "idToken", "accessTokenExpiresAt", "refreshTokenExpiresAt", "scope", "password", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)',
        )
        .run(`acc_${randomBytes(12).toString("hex")}`, googleSubject, "google", userId, password, now, now);
      expect(accountRowsOf(seed, userId)).toHaveLength(2);
    } finally {
      seed.close();
    }

    // The owner's mailbox proof ends both the unproven password session and
    // the Google link that predated it.
    const since = output.length;
    expect((await sendCode(victim)).status).toBe(200);
    const code = await harvestCode(victim, since);
    const proof = await verifyCode(victim, code);
    expect(proof.status).toBe(200);
    const ownerCookie = sessionCookie(proof);
    expect(ownerCookie).not.toBe("");
    await assertSessionDead(standingCookie);

    const after = authDb();
    try {
      const userId = userIdOf(after, victim)!;
      expect(verifiedFlagOf(after, victim)).toBe(1);
      expect(accountRowsOf(after, userId), "the pre-proof Google link does not survive an OTP proof").toEqual([]);
      expect(accountRowsOf(after, userId).some((row) => row.accountId === googleSubject)).toBe(false);
    } finally {
      after.close();
    }
    // …while the owner's own session is live and the attacker password is dead.
    await assertSessionLiveAs(ownerCookie, victim);
    expect((await api(PASSWORD_SIGN_IN_PATH, "POST", { email: victim, password }, "")).status).toBe(401);
  }, 60_000);
});

/** One message the stub transport was actually handed, as the child saw it. */
const transportRecord = z.object({ to: z.string(), subject: z.string(), body: z.string() });
const sendReceipt = z.object({ code: z.string().optional(), retryAfterSeconds: z.number().optional() });

describe.skipIf(process.platform === "win32")("with a configured mailer: code hygiene in the log, and the bound that actually holds", () => {
  let dir = "";
  let url = "";
  let transportLog = "";
  let controlPath = "";
  let releasePath = "";
  const children: ChildProcess[] = [];
  let output = "";

  const uniqueEmail = (label: string) => `${label}-${randomBytes(5).toString("hex")}@example.test`;
  let ipCounter = 0;
  const nextIp = () => `198.51.100.${(ipCounter += 1) % 250}`;

  const transported = (): z.infer<typeof transportRecord>[] =>
    (existsSync(transportLog) ? readFileSync(transportLog, "utf8") : "")
      .split("\n")
      .filter(Boolean)
      .map((line) => transportRecord.parse(JSON.parse(line)));

  const forMailbox = (email: string) => transported().filter((record) => record.to === email);

  /** Send with an explicit source-IP header, the way a proxied deployment
   * presents one. `id` lets a caller rotate the claimed IP on purpose. */
  const sendCode = (email: string, id?: string, idempotencyKey?: string, type = "sign-in") => {
    const headers = new Headers({ "content-type": "application/json", origin: url });
    if (id) headers.set("x-forwarded-for", id);
    if (idempotencyKey) headers.set("idempotency-key", idempotencyKey);
    return fetch(`${url}${SEND_PATH}`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
      headers,
      body: JSON.stringify({ email, type }),
    });
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "muster-otp-accept-mailer-"));
    const dataDirectory = join(dir, "data");
    const home = join(dir, "home");
    const companion = join(dir, "companion");
    const ui = join(dir, "ui");
    for (const path of [dataDirectory, home, companion, ui]) {
      mkdirSync(path, { recursive: true, mode: 0o700 });
    }
    transportLog = join(dir, "transport.log");
    controlPath = join(dir, "transport-mode.txt");
    releasePath = join(dir, "release-transport");
    writeFileSync(controlPath, "accept");
    // A stub transport with no production seam: it replaces global fetch in
    // the child only, answers Resend's URL, and refuses every other
    // destination so the fixture cannot reach the real provider.
    const preload = join(dir, "stub-transport.mjs");
    writeFileSync(
      preload,
      [
        `import { appendFileSync, readFileSync, existsSync } from "node:fs";`,
        `import { setTimeout as delay } from "node:timers/promises";`,
        `const log = ${JSON.stringify(transportLog)};`,
        `const control = ${JSON.stringify(controlPath)};`,
        `const release = ${JSON.stringify(releasePath)};`,
        `globalThis.fetch = async (input, init) => {`,
        `  const target = typeof input === "string" ? input : (input && input.url) || String(input);`,
        `  if (target !== "https://api.resend.com/emails") throw new Error("Owned fixture refuses outbound traffic");`,
        `  let payload = {};`,
        `  try { payload = JSON.parse(init && init.body ? String(init.body) : "{}"); } catch {}`,
        `  const mode = readFileSync(control, "utf8");`,
        `  appendFileSync(log, JSON.stringify({ to: (payload.to || []).join(","), subject: payload.subject || "", body: payload.text || "" }) + "\\n");`,
        `  if (mode === "hold" || mode === "hold-reject") { appendFileSync(control + ".entered", mode); while (!existsSync(release)) await delay(5); }`,
        `  const rejected = mode === "reject" || mode === "hold-reject";`,
        `  return new Response(JSON.stringify(rejected ? { message: "Owned refusal" } : { id: "stub-message" }), { status: rejected ? 500 : 200, headers: { "content-type": "application/json" } });`,
        `};`,
      ].join("\n"),
    );

    const port = await freePortBlock([0, 1, 2], 48500, 9000);
    const env = pairingServerEnvironment({
      home,
      dataDirectory,
      companionDirectory: companion,
      staticDir: ui,
      port,
      webhookPort: port + 1,
      secret: randomBytes(32).toString("hex"),
    });
    // A configured mailer is the whole point of this child: the code goes to a
    // transport instead of the console sink, so "did it leak to the log" is a
    // real question rather than a tautology.
    Object.assign(env, { OMB_ALLOW_SIGNUPS: "true", RESEND_API_KEY: `re-stub-${randomBytes(12).toString("hex")}` });
    const child = spawn(
      process.execPath,
      ["--import", preload, "--experimental-strip-types", join(ROOT, "server/index.ts")],
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
  }, 45_000);

  afterAll(async () => {
    await Promise.all(children.map((child) => waitForExit(child, { signal: "SIGTERM" })));
    await removeTempDir(dir);
  });

  it("keeps the code out of the server's own output once a mailer is configured", async () => {
    const email = uniqueEmail("log-hygiene");
    const since = output.length;
    const res = await sendCode(email, nextIp());
    expect(res.status).toBe(200);

    // The transport really was handed the code — without this, the assertions
    // below would pass simply because nothing was ever sent.
    const delivered = forMailbox(email);
    expect(delivered).toHaveLength(1);
    const code = delivered[0]!.body.match(/\b\d{6}\b/)?.[0];
    expect(code, "the stub transport received a 6-digit code").toMatch(/^\d{6}$/);

    // The receipt the caller gets back carries no code either.
    const receiptText = await res.clone().text();
    expect(receiptText).not.toContain(code);
    expect(JSON.stringify([...res.headers.entries()])).not.toContain(code);

    // And the server's own stdout/stderr never received it. This is the
    // production-log half of "no codes in responses or logs": with a mailer
    // configured the dev [otp] console sink is unreachable, so the code exists
    // only in the provider's hands and the hashed verification row.
    expect(output.slice(since)).not.toContain(code);
    expect(output).not.toContain(code);
    expect(output.slice(since)).not.toMatch(/\[otp\] sign-in code/);
    expect(output).not.toMatch(/sign-in code for/);
  }, 45_000);

  it("holds the per-mailbox cooldown when the caller rotates the claimed source IP", async () => {
    // What actually bounds one mailbox. The per-IP window keys on
    // clientIpOf() (server/email-otp-login.ts), which prefers cf-connecting-ip
    // then x-forwarded-for then the socket — so a deployment that does not
    // strip those headers cannot rely on it for a single mailbox. The
    // per-mailbox cooldown is keyed on the normalized address alone, and this
    // is the test that says so: nine sends, nine different claimed IPs, one
    // code out the door.
    const email = uniqueEmail("rotating-ip");
    const key = `k-${randomBytes(8).toString("hex")}`;

    const first = await sendCode(email, nextIp(), key);
    expect(first.status).toBe(200);

    // Eight more sends, each from a brand-new claimed IP and a brand-new key.
    for (let index = 0; index < 8; index++) {
      const repeat = await sendCode(email, nextIp(), `k-${randomBytes(8).toString("hex")}`);
      // SAFETY: the cooldown gate answers { code, message, retryAfterSeconds }.
      const body = sendReceipt.parse(await repeat.json());
      expect(repeat.status).toBe(429);
      expect(body.code).toBe("RESEND_COOLDOWN");
      expect(body.retryAfterSeconds).toBeGreaterThan(0);
    }

    // Exactly one message ever reached the transport for this mailbox.
    expect(forMailbox(email)).toHaveLength(1);

    // The accepted key still replays its recorded answer rather than mailing a
    // second code: the cooldown did not cost the caller its retry either.
    const replay = await sendCode(email, nextIp(), key);
    expect(replay.status).toBe(200);
    expect(replay.headers.get("x-otp-replay")).toBe("1");
    expect(forMailbox(email)).toHaveLength(1);
  }, 60_000);

  it("T1 bounds a registered mailbox across non-sign-in code kinds and rotating IPs", async () => {
    const email = uniqueEmail("registered-flood");
    const signup = await fetch(`${url}${SIGN_UP_PATH}`, {
      method: "POST", headers: { "content-type": "application/json", origin: url },
      body: JSON.stringify({ email, password: "owned-synthetic-password", name: "Owned Flood Fixture" }),
      signal: AbortSignal.timeout(20_000),
    });
    expect(signup.status).toBe(200);
    const beforeSend = forMailbox(email).length; // signup's own verification mail is separate
    const key = `flood-${randomBytes(8).toString("hex")}`;
    const first = await sendCode(email, nextIp(), key, "email-verification");
    expect(first.status).toBe(200);
    expect(forMailbox(email)).toHaveLength(beforeSend + 1);
    for (let index = 0; index < 20; index += 1) {
      const response = await sendCode(email, nextIp(), `different-${index}`, index % 2 ? "sign-in" : "forget-password");
      expect(response.status).toBe(429);
      expect(sendReceipt.parse(await response.json()).code).toBe("RESEND_COOLDOWN");
    }
    expect(forMailbox(email)).toHaveLength(beforeSend + 1);
    const replay = await sendCode(email, nextIp(), key, "email-verification");
    expect(replay.status).toBe(200);
    expect(replay.headers.get("x-otp-replay")).toBe("1");
    expect(forMailbox(email)).toHaveLength(beforeSend + 1);
  }, 60_000);

  it("T2 stores no accepted replay or cooldown when the plugin never invokes a sender", async () => {
    const email = uniqueEmail("unknown-no-sender");
    const key = `no-sender-${randomBytes(8).toString("hex")}`;
    for (let index = 0; index < 2; index += 1) {
      const empty = await sendCode(email, nextIp(), key, "email-verification");
      expect(empty.status).toBe(200);
      expect(empty.headers.get("x-otp-replay")).toBeNull();
      expect(forMailbox(email)).toEqual([]);
    }
    const real = await sendCode(email, nextIp(), key);
    expect(real.status).toBe(200);
    expect(real.headers.get("x-otp-replay")).toBeNull();
    expect(forMailbox(email)).toHaveLength(1);
    const replay = await sendCode(email, nextIp(), key);
    expect(replay.status).toBe(200);
    expect(replay.headers.get("x-otp-replay")).toBe("1");
    expect(forMailbox(email)).toHaveLength(1);
  }, 60_000);

  it("T7 hides password reset after transport refusal and restores it after an actual accepted send", async () => {
    const capabilities = async () => z.object({ emailOtp: z.boolean(), passwordReset: z.boolean() }).parse(
      await (await fetch(`${url}/api/auth-capabilities`, { signal: AbortSignal.timeout(15_000) })).json(),
    );
    expect((await capabilities()).passwordReset).toBe(true);
    const email = uniqueEmail("transport-recovery");
    const key = `recovery-${randomBytes(8).toString("hex")}`;
    writeFileSync(controlPath, "reject");
    try {
      const failed = await sendCode(email, nextIp(), key);
      expect(failed.status).toBe(503);
      expect(sendReceipt.parse(await failed.json()).code).toBe("EMAIL_DELIVERY_FAILED");
      expect(failed.headers.get("x-otp-replay")).toBeNull();
      expect(await capabilities()).toEqual({ emailOtp: true, passwordReset: false });
    } finally {
      writeFileSync(controlPath, "accept");
    }
    const retry = await sendCode(email, nextIp(), key);
    expect(retry.status).toBe(200);
    expect(retry.headers.get("x-otp-replay")).toBeNull();
    expect(forMailbox(email)).toHaveLength(2);
    expect(await capabilities()).toEqual({ emailOtp: true, passwordReset: true });
  }, 60_000);

  it.each([
    { heldMode: "hold", resetMode: "reject", expected: 200 },
    { heldMode: "hold-reject", resetMode: "accept", expected: 503 },
  ])("binds a $heldMode wrapped verdict during a $resetMode unwrapped same-mailbox reset", async ({ heldMode, resetMode, expected }) => {
    const email = uniqueEmail("parallel-verdict");
    const signup = await fetch(`${url}${SIGN_UP_PATH}`, {
      method: "POST", headers: { "content-type": "application/json", origin: url },
      body: JSON.stringify({ email, password: "owned-synthetic-password", name: "Owned Parallel Fixture" }),
      signal: AbortSignal.timeout(20_000),
    });
    expect(signup.status).toBe(200);
    const beforeSend = forMailbox(email).length;
    rmSync(releasePath, { force: true });
    rmSync(controlPath + ".entered", { force: true });
    writeFileSync(controlPath, heldMode);
    const wrapped = sendCode(email, nextIp(), "owned-held-send", "email-verification");
    try {
      await expect.poll(() => forMailbox(email).length).toBe(beforeSend + 1);
      await expect.poll(() => existsSync(controlPath + ".entered") ? readFileSync(controlPath + ".entered", "utf8") : "").toBe(heldMode);
      writeFileSync(controlPath, resetMode);
      const reset = await fetch(`${url}/api/auth/email-otp/request-password-reset`, {
        method: "POST", headers: { "content-type": "application/json", origin: url },
        body: JSON.stringify({ email }), signal: AbortSignal.timeout(20_000),
      });
      expect(reset.status).toBe(200); // plugin acknowledgement is not a delivery receipt
      expect(forMailbox(email)).toHaveLength(beforeSend + 2);
    } finally {
      writeFileSync(controlPath, "accept");
      writeFileSync(releasePath, "release");
    }
    const accepted = await wrapped;
    expect(accepted.status, "the other route cannot replace this request's verdict").toBe(expected);
    const next = await sendCode(email, nextIp(), "after-held-send");
    if (expected === 200) {
      expect(next.status).toBe(429);
      expect(sendReceipt.parse(await next.json()).code).toBe("RESEND_COOLDOWN");
      expect(forMailbox(email)).toHaveLength(beforeSend + 2);
    } else {
      expect(sendReceipt.parse(await accepted.json()).code).toBe("EMAIL_DELIVERY_FAILED");
      expect(next.status).toBe(200);
      expect(next.headers.get("x-otp-replay")).toBeNull();
      expect(forMailbox(email)).toHaveLength(beforeSend + 3);
    }
  }, 60_000);
});
