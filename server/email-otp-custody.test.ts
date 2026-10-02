// Unproven-account custody regression for email + one-time-code sign-in —
// the A0 slice of the managed-device program. Scenario: an attacker knows a
// mailbox ADDRESS only (no inbox access), pre-registers it with a password,
// and holds standing sessions where policy permits it. The real owner later
// proves control of the inbox by completing a valid OTP sign-in. Custody
// semantics after that proof:
//
//   • The attacker's sessions must die, the attacker's password must stop
//     authenticating, and account links the owner never proven must be gone
//     — exactly what better-auth's revokeUnprovenAccountAccess does, so the
//     wrapper must NOT pre-promote the account to emailVerified and must
//     delegate the sign-in untouched (the installed plugin runs the
//     revocation for any emailVerified: false user on sign-in).
//   • Ownership and data survive: same user row (canonical id), same email,
//     same name, same workspace binding, the owner's fresh session answers.
//   • A separate account — seeded BEFORE the owner's proof so collateral
//     revocation cannot hide — keeps its sessions, links and login.
//   • Wrong / expired / already-consumed / wrong-purpose codes cannot mint a
//     session, cannot verify an account, and cannot revoke standing access.
//   • The revocation must not be restorable: a later password sign-in and a
//     server restart leave the attacker's old session tokens dead.
//   • A previously VERIFIED legitimate account keeps its intended continuity
//     across an OTP sign-in: the plugin's revocation is scoped to unproven
//     (emailVerified: false) accounts and must not touch proven ones.
//   • Partial cleanup: a failure between the library's sequential deletions
//     must not promote the account while unproven authority survives — and
//     a retried, healthy proof must finish the revocation.
//
// Boot pattern mirrors server/email-otp-login.test.ts (owned child servers
// on free ports, throwaway data directories, codes harvested from the
// dev-mode [otp] console sink — no real mail, no production accounts, no
// Google account). Non-password pre-proof links (e.g. a Google OAuth link)
// are out of scope for this fixture — they need real provider clients — but
// the library's cleanup deletes ALL links for the unproven account, so the
// password link exercises the same deletion path. The wrapper's repair:
// validate-then-promote was removed so the plugin's locked, sequential
// revocation runs for unproven accounts; the "password account keeps its
// password" invariant the older suites encoded belongs to deployments
// WITHOUT an inbox-provable channel and is superseded here (independent
// review: docs/plans/a0-independent-review-2026-10-02.md).
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pairingServerEnvironment, waitForOwnedServer } from "../e2e/pairing-harness.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

const SIGN_UP_PATH = "/api/auth/sign-up/email";
const PASSWORD_SIGN_IN_PATH = "/api/auth/sign-in/email";
const SEND_PATH = "/api/auth/email-otp/send-verification-otp";
const SIGN_IN_PATH = "/api/auth/sign-in/email-otp";
const GET_SESSION_PATH = "/api/auth/get-session";

/** A code guaranteed different from the real one: only the exact digits
 * verify, so +1 mod 10^6 can never authenticate (and never collides with
 * the real code the way a constant like 000001 could by chance). */
const differentCode = (code: string) => String((parseInt(code, 10) + 1) % 1_000_000).padStart(6, "0");

/** The hash Better Auth's hashed OTP storage records (sha256, unpadded
 * base64url) — lets a fixture seed a known live code straight into the
 * verification table when the per-mailbox send cooldown would otherwise
 * price a second proof at sixty seconds. */
const hashOtp = (otp: string) => createHash("sha256").update(otp).digest().toString("base64url");

interface Harness {
  dir: string;
  dataDirectory: string;
  url: string;
  fixtureEnv: NodeJS.ProcessEnv;
  children: ChildProcess[];
  output: string;
}

interface BootOptions {
  preloadUrl?: string;
  extraEnv?: Record<string, string>;
}

async function bootHarness(dirPrefix: string, options?: BootOptions): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), dirPrefix));
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
    // The actual SELF_HOSTED gate input (server/auth.ts): a public host on a
    // loopback listener — the same hosted-gate semantics the house session
    // suites use, so /api/bots demands a live session and every non-public
    // route sits behind the session gate exactly as on muster.today.
    OMB_PUBLIC_HOST: `127.0.0.1:${port}`,
    ...options?.extraEnv,
  });
  const harness: Harness = { dir, dataDirectory, url: `http://127.0.0.1:${port}`, fixtureEnv: { ...env }, children: [], output: "" };
  const spawnArgs: string[] = options?.preloadUrl
    ? ["--import", options.preloadUrl, "--experimental-strip-types", join(ROOT, "server/index.ts")]
    : ["--experimental-strip-types", join(ROOT, "server/index.ts")];
  const child = spawn(process.execPath, spawnArgs, { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  harness.children.push(child);
  child.stdout?.on("data", (chunk: Buffer | string) => {
    harness.output += String(chunk);
  });
  child.stderr?.on("data", (chunk: Buffer | string) => {
    harness.output += String(chunk);
  });
  await waitForOwnedServer(child, harness.url);
  return harness;
}

async function shutdown(harness: Harness): Promise<void> {
  await Promise.all(harness.children.map((child) => waitForExit(child, { signal: "SIGTERM" })));
  await removeTempDir(harness.dir);
}

describe.skipIf(process.platform === "win32")("unproven-account custody after owner OTP proof", () => {
  let harness: Harness;
  let url = "";
  let dataDirectory = "";

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

  const sendCode = (email: string, type = "sign-in") => api(SEND_PATH, "POST", { email, type });
  const verifyCode = (email: string, otp: string) => api(SIGN_IN_PATH, "POST", { email, otp });

  // SAFETY: better-auth always sets this cookie name on a successful sign-in.
  const sessionCookie = (res: Response) =>
    (res.headers.getSetCookie() ?? [])
      .find((cookie) => cookie.startsWith("better-auth.session_token="))
      ?.split(";")[0] ?? "";

  const authDb = () => new DatabaseSync(join(dataDirectory, "auth.db"));

  /** Dev-mode delivery channel: no mailer in a fresh child env, so the code
   * is printed under the [otp] prefix. `since` must be captured BEFORE the
   * request that triggers the send. */
  async function harvestCode(email: string, since: number): Promise<string> {
    const escaped = email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`\\[otp\\] sign-in code for ${escaped}: (\\d{6})`);
    const liveOutput = () => harness.output;
    for (let attempt = 0; attempt < 400; attempt++) {
      const match = liveOutput().slice(since).match(pattern);
      if (match) return match[1];
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`no [otp] sign-in code for ${email} appeared in the server output`);
  }

  const userIdOf = (db: DatabaseSync, email: string): string | undefined => {
    // SAFETY: the SELECT projects exactly the column read below.
    const row = db.prepare('SELECT "id" FROM "user" WHERE "email" = ?').get(email) as
      | { id: string }
      | undefined;
    return row?.id;
  };

  const linksOf = (db: DatabaseSync, userId: string): Array<{ providerId: string }> => {
    // SAFETY: the SELECT projects the provider column asserted below.
    return db.prepare('SELECT "providerId" FROM "account" WHERE "userId" = ?').all(userId) as
      | Array<{ providerId: string }>;
  };

  const sessionCountOf = (db: DatabaseSync, userId: string): number => {
    // SAFETY: the SELECT counts live sessions for this user.
    return (db.prepare('SELECT "id" FROM "session" WHERE "userId" = ?').all(userId) as Array<{ id: string }>).length;
  };

  /** Session death, tested the way the house suites test it
   * (server/session-persistence-harness.test.ts): the session endpoint
   * answers 200 null (refresh disabled, so a dead token cannot be silently
   * renewed by the read) and a protected route refuses the cookie with 401. */
  const assertSessionDead = async (cookie: string) => {
    const dead = await api(`${GET_SESSION_PATH}?disableRefresh=true`, "GET", undefined, cookie);
    expect(dead.status).toBe(200);
    expect(await dead.json()).toBeNull();
    expect((await api("/api/bots", "GET", undefined, cookie)).status).toBe(401);
  };

  /** Session life on an actual protected route — not just get-session. */
  const assertSessionLive = async (cookie: string) => {
    expect((await api("/api/bots", "GET", undefined, cookie)).status).toBe(200);
  };

  /** Pre-register an unverified mailbox the way an attacker would: sign-up
   * (which mints a standing session where policy permits) plus a password
   * sign-in (a second standing session). Returns BOTH cookies so the proof
   * must end every pre-existing session, not just one. */
  const preRegisterUnverified = async (label: string) => {
    // The label seeds the EMAIL too, so it must survive better-auth's
    // lowercasing (rows are stored lowercase; queries below use the same
    // string) and must not carry spaces or punctuation.
    const email = `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}-${randomBytes(5).toString("hex")}@example.test`;
    const password = randomBytes(24).toString("base64url");
    const signup = await api(SIGN_UP_PATH, "POST", { email, password, name: label }, "");
    expect(signup.status).toBe(200);
    const cookieA = sessionCookie(signup);
    expect(cookieA).not.toBe("");
    const login = await api(PASSWORD_SIGN_IN_PATH, "POST", { email, password }, "");
    expect(login.status).toBe(200);
    const cookieB = sessionCookie(login);
    expect(cookieB).not.toBe("");
    return { email, password, cookieA, cookieB };
  };

  beforeAll(async () => {
    harness = await bootHarness("muster-otp-custody-");
    url = harness.url;
    dataDirectory = harness.dataDirectory;
  }, 45_000);

  afterAll(async () => {
    await shutdown(harness);
  });

  // Shared hand-offs; the bystander is seeded BEFORE the victim's proof —
  // creating it afterwards could never catch collateral revocation.
  let bystander: Awaited<ReturnType<typeof preRegisterUnverified>>;
  let bystanderUserId = "";
  let victim: Awaited<ReturnType<typeof preRegisterUnverified>>;
  let victimUserIdBefore = "";
  let victimOrgBefore = "";
  let proofCookie = "";

  it("seeds a bystander account with standing access before any proof happens", async () => {
    bystander = await preRegisterUnverified("Bystander");
    const db = authDb();
    try {
      bystanderUserId = userIdOf(db, bystander.email)!;
      expect(bystanderUserId).toBeTruthy();
      expect(sessionCountOf(db, bystanderUserId)).toBe(2);
      expect(linksOf(db, bystanderUserId).length).toBe(1);
    } finally {
      db.close();
    }
    await assertSessionLive(bystander.cookieA);
    await assertSessionLive(bystander.cookieB);
  }, 30_000);

  it("case 1 — an attacker's pre-registered mailbox holds two live sessions on a protected route", async () => {
    victim = await preRegisterUnverified("Mailbox Owner");
    const db = authDb();
    try {
      victimUserIdBefore = userIdOf(db, victim.email)!;
      expect(victimUserIdBefore).toBeTruthy();
    } finally {
      db.close();
    }
    // Pre-proof standing access, proven on the protected route itself.
    await assertSessionLive(victim.cookieA);
    await assertSessionLive(victim.cookieB);
    const view = await api(GET_SESSION_PATH, "GET", undefined, victim.cookieA);
    expect(view.status).toBe(200);
    // SAFETY: get-session answers { user, session } for a live cookie.
    const body = (await view.json()) as {
      user?: { email?: string } | null;
      session?: { activeOrganizationId?: string | null };
    } | null;
    expect(body?.user?.email).toBe(victim.email);
    victimOrgBefore = body?.session?.activeOrganizationId ?? "";
    expect(victimOrgBefore).toBeTruthy();
  }, 30_000);

  it("case 2 — wrong codes raced against a pre-registered mailbox leave its authority intact", async () => {
    // A dedicated mailbox, pre-registered with a standing session (the
    // sign-up mint) and a password link. Wrong answers must not touch it.
    const raced = await api(SIGN_UP_PATH, "POST", { email: `raced-${randomBytes(5).toString("hex")}@example.test`, password: randomBytes(24).toString("base64url"), name: "Raced" }, "");
    expect(raced.status).toBe(200);
    const racedCookie = sessionCookie(raced);
    expect(racedCookie).not.toBe("");
    const racedView = await api(GET_SESSION_PATH, "GET", undefined, racedCookie);
    expect(racedView.status).toBe(200);
    // SAFETY: get-session answers { user } for a live cookie; only the email column is read.
    const racedBody = (await racedView.json()) as { user?: { email?: string } | null } | null;
    const racedEmail = racedBody?.user?.email ?? "";

    const since = harness.output.length;
    expect((await sendCode(racedEmail)).status).toBe(200);
    const realCode = await harvestCode(racedEmail, since);
    // Better Auth's attempt budget: three wrong answers, then the row is
    // consumed by the lockout (403) — and NOT ONE of them touched the
    // standing session or the password link.
    const attempts: number[] = [];
    for (let index = 0; index < 4; index++) {
      const res = await verifyCode(racedEmail, differentCode(realCode));
      attempts.push(res.status);
    }
    expect(attempts).toEqual([400, 400, 400, 403]);

    const db = authDb();
    try {
      const userId = userIdOf(db, racedEmail)!;
      // SAFETY: the SELECT projects exactly the column asserted below.
      const verified = db.prepare('SELECT "emailVerified" FROM "user" WHERE "id" = ?').get(userId) as
        | { emailVerified: number }
        | undefined;
      expect(Number(verified?.emailVerified)).toBe(0);
      expect(sessionCountOf(db, userId)).toBe(1);
      expect(linksOf(db, userId).length).toBe(1);
    } finally {
      db.close();
    }
    await assertSessionLive(racedCookie);
  }, 30_000);

  it("case 3 — the real owner's OTP proof ends BOTH unproven sessions and the unproven password", async () => {
    const since = harness.output.length;
    expect((await sendCode(victim.email)).status).toBe(200);
    const proofCode = await harvestCode(victim.email, since);
    const proof = await verifyCode(victim.email, proofCode);
    expect(proof.status).toBe(200);
    proofCookie = sessionCookie(proof);
    expect(proofCookie).not.toBe("");

    // THE A0 regression: the owner's OTP proof must END the pre-registered
    // sessions — while the wrapper's check-then-promote bypass stands, the
    // plugin never sees an unverified user, skips
    // revokeUnprovenAccountAccess, and these attacker sessions keep
    // answering protected routes.
    await assertSessionDead(victim.cookieA);
    await assertSessionDead(victim.cookieB);

    const stalePassword = await api(PASSWORD_SIGN_IN_PATH, "POST", { email: victim.email, password: victim.password }, "");
    expect(stalePassword.status).toBe(401);

    const db = authDb();
    try {
      expect(linksOf(db, userIdOf(db, victim.email)!)).toEqual([]);
    } finally {
      db.close();
    }
  }, 30_000);

  it("case 4 — the bystander seeded before the proof keeps sessions, links and login", async () => {
    await assertSessionLive(bystander.cookieA);
    await assertSessionLive(bystander.cookieB);
    const db = authDb();
    try {
      const userId = userIdOf(db, bystander.email)!;
      expect(userId).toBe(bystanderUserId);
      expect(sessionCountOf(db, userId)).toBe(2);
      expect(linksOf(db, userId).length).toBe(1);
    } finally {
      db.close();
    }
  }, 30_000);

  it("case 5 — the owner's identity is preserved in place: same user id, name, workspace binding", async () => {
    const session = await api(GET_SESSION_PATH, "GET", undefined, proofCookie);
    expect(session.status).toBe(200);
    // SAFETY: get-session answers { user, session }; name and
    // activeOrganizationId are the observable halves of "same account".
    const body = (await session.json()) as {
      user?: { email?: string; name?: string } | null;
      session?: { activeOrganizationId?: string | null };
    } | null;
    expect(body?.user?.email).toBe(victim.email);
    expect(body?.user?.name).toBe("Mailbox Owner");
    expect(body?.session?.activeOrganizationId).toBe(victimOrgBefore);

    const db = authDb();
    try {
      const userId = userIdOf(db, victim.email)!;
      expect(userId).toBe(victimUserIdBefore);
      // SAFETY: the SELECT projects exactly the column asserted below.
      const user = db.prepare('SELECT "emailVerified" FROM "user" WHERE "id" = ?').get(userId) as
        | { emailVerified: number }
        | undefined;
      expect(Number(user?.emailVerified)).toBe(1);
      // SAFETY: the SELECT projects exactly the column asserted below.
      const member = db.prepare('SELECT "role" FROM "member" WHERE "userId" = ?').get(userId) as
        | { role: string }
        | undefined;
      expect(member?.role).toBe("owner");
    } finally {
      db.close();
    }
  }, 30_000);

  it("case 6 — a later password sign-in and a server restart do not restore revoked authority", async () => {
    // Still dead after intervening activity...
    await assertSessionDead(victim.cookieA);

    const child = harness.children[0];
    child.kill("SIGTERM");
    await waitForExit(child, { signal: "SIGTERM" });
    harness.children.length = 0;

    const restart = spawn(
      process.execPath,
      ["--experimental-strip-types", join(ROOT, "server/index.ts")],
      { cwd: ROOT, env: { ...harness.fixtureEnv }, stdio: ["ignore", "pipe", "pipe"] },
    );
    harness.children.push(restart);
    restart.stdout?.on("data", (chunk: Buffer | string) => {
      harness.output += String(chunk);
    });
    restart.stderr?.on("data", (chunk: Buffer | string) => {
      harness.output += String(chunk);
    });
    await waitForOwnedServer(restart, url);

    // The proven owner's freshly minted session survives the restart.
    expect((await api(GET_SESSION_PATH, "GET", undefined, proofCookie)).status).toBe(200);

    // The revoked authority stays revoked across the restart: the dead
    // sessions answer 200 null (never re-minted) and the protected route
    // still refuses them, and the attacker password stays rejected.
    await assertSessionDead(victim.cookieA);
    await assertSessionDead(victim.cookieB);
    const stalePasswordAfterRestart = await api(PASSWORD_SIGN_IN_PATH, "POST", { email: victim.email, password: victim.password }, "");
    expect(stalePasswordAfterRestart.status).toBe(401);
  }, 45_000);
});

describe.skipIf(process.platform === "win32")("OTP negatives: no failed proof may move custody", () => {
  let harness: Harness;
  let url = "";
  let dataDirectory = "";

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

  const sendCode = (email: string, type = "sign-in") => api(SEND_PATH, "POST", { email, type });
  const verifyCode = (email: string, otp: string) => api(SIGN_IN_PATH, "POST", { email, otp });

  const sessionCookie = (res: Response) =>
    (res.headers.getSetCookie() ?? [])
      .find((cookie) => cookie.startsWith("better-auth.session_token="))
      ?.split(";")[0] ?? "";

  const authDb = () => new DatabaseSync(join(dataDirectory, "auth.db"));

  async function harvestCode(email: string, since: number): Promise<string> {
    const escaped = email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`\\[otp\\] sign-in code for ${escaped}: (\\d{6})`);
    const liveOutput = () => harness.output;
    for (let attempt = 0; attempt < 400; attempt++) {
      const match = liveOutput().slice(since).match(pattern);
      if (match) return match[1];
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`no [otp] sign-in code for ${email} appeared in the server output`);
  }

  const userIdOf = (db: DatabaseSync, email: string): string | undefined => {
    // SAFETY: the SELECT projects exactly the column read below.
    const row = db.prepare('SELECT "id" FROM "user" WHERE "email" = ?').get(email) as
      | { id: string }
      | undefined;
    return row?.id;
  };

  const linksOf = (db: DatabaseSync, userId: string): Array<{ providerId: string }> => {
    // SAFETY: the SELECT projects the provider column asserted below.
    return db.prepare('SELECT "providerId" FROM "account" WHERE "userId" = ?').all(userId) as
      | Array<{ providerId: string }>;
  };

  const sessionCountOf = (db: DatabaseSync, userId: string): number => {
    // SAFETY: the SELECT counts live sessions for this user.
    return (db.prepare('SELECT "id" FROM "session" WHERE "userId" = ?').all(userId) as Array<{ id: string }>).length;
  };

  const assertSessionLive = async (cookie: string) => {
    expect((await api("/api/bots", "GET", undefined, cookie)).status).toBe(200);
  };

  const preRegisterUnverified = async (label: string) => {
    // The label seeds the EMAIL too, so it must survive better-auth's
    // lowercasing (rows are stored lowercase; queries below use the same
    // string) and must not carry spaces or punctuation.
    const email = `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}-${randomBytes(5).toString("hex")}@example.test`;
    const password = randomBytes(24).toString("base64url");
    const signup = await api(SIGN_UP_PATH, "POST", { email, password, name: label }, "");
    expect(signup.status).toBe(200);
    const cookieA = sessionCookie(signup);
    expect(cookieA).not.toBe("");
    const login = await api(PASSWORD_SIGN_IN_PATH, "POST", { email, password }, "");
    expect(login.status).toBe(200);
    const cookieB = sessionCookie(login);
    expect(cookieB).not.toBe("");
    return { email, password, cookieA, cookieB };
  };

  beforeAll(async () => {
    harness = await bootHarness("muster-otp-negative-");
    url = harness.url;
    dataDirectory = harness.dataDirectory;
  }, 45_000);

  afterAll(async () => {
    await shutdown(harness);
  });

  it("case 4a — a wrong code cannot mint a session, verify an account, or revoke standing access", async () => {
    const standing = await preRegisterUnverified("Wrong Code");
    const since = harness.output.length;
    expect((await sendCode(standing.email)).status).toBe(200);
    const realCode = await harvestCode(standing.email, since);
    const rejected = await verifyCode(standing.email, differentCode(realCode));
    expect(rejected.status).toBe(400);
    // SAFETY: the plugin answers { message, code } on OTP failures.
    expect(((await rejected.json()) as { code?: string }).code).toBe("INVALID_OTP");

    const db = authDb();
    try {
      const userId = userIdOf(db, standing.email)!;
      // SAFETY: the SELECT projects exactly the column asserted below.
      const verified = db.prepare('SELECT "emailVerified" FROM "user" WHERE "id" = ?').get(userId) as
        | { emailVerified: number }
        | undefined;
      expect(Number(verified?.emailVerified)).toBe(0);
      expect(sessionCountOf(db, userId)).toBe(2);
      expect(linksOf(db, userId).length).toBe(1);
    } finally {
      db.close();
    }
    await assertSessionLive(standing.cookieA);
    await assertSessionLive(standing.cookieB);
  }, 30_000);

  it("case 4b — an expired code verifies nothing and revokes nothing", async () => {
    const standing = await preRegisterUnverified("Expired Code");
    const since = harness.output.length;
    expect((await sendCode(standing.email)).status).toBe(200);
    await harvestCode(standing.email, since);

    const db = authDb();
    try {
      const identifier = `sign-in-otp-${standing.email}`;
      // SAFETY: the SELECT projects the expiry column this test rewrites.
      const row = db
        .prepare('SELECT "expiresAt" FROM "verification" WHERE "identifier" = ?')
        .get(identifier) as { expiresAt: string | number | bigint } | undefined;
      expect(row).toBeDefined();
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
      expect(Number(db.prepare('UPDATE "verification" SET "expiresAt" = ? WHERE "identifier" = ?').run(past, identifier).changes)).toBe(1);
    } finally {
      db.close();
    }

    const rejected = await verifyCode(standing.email, "000002");
    expect(rejected.status).toBe(400);
    // SAFETY: the plugin answers { message, code } on OTP failures.
    expect(((await rejected.json()) as { code?: string }).code).toBe("OTP_EXPIRED");

    const check = authDb();
    try {
      const userId = userIdOf(check, standing.email)!;
      // SAFETY: the SELECT projects exactly the column asserted below.
      const verified = check.prepare('SELECT "emailVerified" FROM "user" WHERE "id" = ?').get(userId) as
        | { emailVerified: number }
        | undefined;
      expect(Number(verified?.emailVerified)).toBe(0);
      expect(sessionCountOf(check, userId)).toBe(2);
      expect(linksOf(check, userId).length).toBe(1);
    } finally {
      check.close();
    }
    await assertSessionLive(standing.cookieA);
    await assertSessionLive(standing.cookieB);
  }, 30_000);

  it("case 4c — a replayed (already-consumed) code mints no second session", async () => {
    const email = `replay-${randomBytes(5).toString("hex")}@example.test`;
    const since = harness.output.length;
    expect((await sendCode(email)).status).toBe(200);
    const code = await harvestCode(email, since);
    const first = await verifyCode(email, code);
    expect(first.status).toBe(200);
    const firstCookie = sessionCookie(first);
    expect(firstCookie).not.toBe("");
    await assertSessionLive(firstCookie);

    const replay = await verifyCode(email, code);
    expect(replay.status).toBe(400);
    // SAFETY: the plugin answers { message, code } on OTP failures.
    expect(((await replay.json()) as { code?: string }).code).toBe("INVALID_OTP");
    // Exactly one live session exists for the winning request.
    const db = authDb();
    try {
      expect(sessionCountOf(db, userIdOf(db, email)!)).toBe(1);
    } finally {
      db.close();
    }
  }, 30_000);

  it("case 4d — a wrong-purpose (password-reset) code cannot authorize sign-in", async () => {
    const standing = await preRegisterUnverified("Purpose Code");

    // Mint a code for a DIFFERENT purpose — the OTP plugin's password-reset
    // route (this child has no mailer, so the code surfaces on the console
    // sink under the same [otp] prefix but is stored under the
    // forget-password identifier, never the sign-in one). The output window
    // opens BEFORE the request so the code's print can never fall ahead of it.
    const since = harness.output.length;
    const reset = await api("/api/auth/email-otp/request-password-reset", "POST", { email: standing.email });
    expect(reset.status).toBe(200);
    // SAFETY: the plugin's request-password-reset answers { success: true }.
    expect(await reset.json()).toEqual({ success: true });
    const resetCode = await harvestCode(standing.email, since);

    // The reset code must NOT complete a sign-in.
    const rejected = await verifyCode(standing.email, resetCode);
    expect(rejected.status).toBe(400);
    // SAFETY: the plugin answers { message, code } on OTP failures.
    expect(((await rejected.json()) as { code?: string }).code).toBe("INVALID_OTP");

    // … must not verify the account …
    const db = authDb();
    try {
      const userId = userIdOf(db, standing.email)!;
      // SAFETY: the SELECT projects exactly the column asserted below.
      const verified = db.prepare('SELECT "emailVerified" FROM "user" WHERE "id" = ?').get(userId) as
        | { emailVerified: number }
        | undefined;
      expect(Number(verified?.emailVerified)).toBe(0);
      // … and must not revoke the unproven access it failed to replace.
      expect(sessionCountOf(db, userId)).toBe(2);
      expect(linksOf(db, userId).length).toBe(1);
    } finally {
      db.close();
    }
    await assertSessionLive(standing.cookieA);
    await assertSessionLive(standing.cookieB);

    // The genuinely-minted sign-in code still opens the door afterwards.
    const sinceSignin = harness.output.length;
    expect((await sendCode(standing.email)).status).toBe(200);
    const signinCode = await harvestCode(standing.email, sinceSignin);
    expect((await verifyCode(standing.email, signinCode)).status).toBe(200);
  }, 30_000);

  it("case 5 — concurrent valid-code sign-ins mint exactly one session and one proof", async () => {
    const email = `concurrent-${randomBytes(5).toString("hex")}@example.test`;
    const since = harness.output.length;
    expect((await sendCode(email)).status).toBe(200);
    const code = await harvestCode(email, since);
    const [first, second] = await Promise.all([
      verifyCode(email, code),
      verifyCode(email, code),
    ]);
    const statuses = [first.status, second.status].sort();
    // The library's consume is locked and transactional: exactly one of the
    // two racing requests wins; the loser is rejected as already-consumed.
    expect(statuses).toEqual([200, 400]);
    // SAFETY: the plugin answers { message, code } on OTP failures.
    expect(((await (first.status === 200 ? second : first).json()) as { code?: string }).code).toBe("INVALID_OTP");

    const winner = sessionCookie(first.status === 200 ? first : second);
    expect(winner).not.toBe("");
    await assertSessionLive(winner);

    const db = authDb();
    try {
      const userId = userIdOf(db, email)!;
      expect(sessionCountOf(db, userId)).toBe(1);
      // SAFETY: the SELECT projects exactly the column asserted below.
      const verified = db.prepare('SELECT "emailVerified" FROM "user" WHERE "id" = ?').get(userId) as
        | { emailVerified: number }
        | undefined;
      expect(Number(verified?.emailVerified)).toBe(1);
    } finally {
      db.close();
    }
  }, 30_000);
});

describe.skipIf(process.platform === "win32")("verified continuity and partial-cleanup determinism", () => {
  let harness: Harness;
  let url = "";
  let dataDirectory = "";
  let breakerArm = "";

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

  const sendCode = (email: string, type = "sign-in") => api(SEND_PATH, "POST", { email, type });
  const verifyCode = (email: string, otp: string) => api(SIGN_IN_PATH, "POST", { email, otp });

  const sessionCookie = (res: Response) =>
    (res.headers.getSetCookie() ?? [])
      .find((cookie) => cookie.startsWith("better-auth.session_token="))
      ?.split(";")[0] ?? "";

  const authDb = () => new DatabaseSync(join(dataDirectory, "auth.db"));

  async function harvestCode(email: string, since: number): Promise<string> {
    const escaped = email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`\\[otp\\] sign-in code for ${escaped}: (\\d{6})`);
    const liveOutput = () => harness.output;
    for (let attempt = 0; attempt < 400; attempt++) {
      const match = liveOutput().slice(since).match(pattern);
      if (match) return match[1];
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`no [otp] sign-in code for ${email} appeared in the server output`);
  }

  const userIdOf = (db: DatabaseSync, email: string): string | undefined => {
    // SAFETY: the SELECT projects exactly the column read below.
    const row = db.prepare('SELECT "id" FROM "user" WHERE "email" = ?').get(email) as
      | { id: string }
      | undefined;
    return row?.id;
  };

  const linksOf = (db: DatabaseSync, userId: string): Array<{ providerId: string }> => {
    // SAFETY: the SELECT projects the provider column asserted below.
    return db.prepare('SELECT "providerId" FROM "account" WHERE "userId" = ?').all(userId) as
      | Array<{ providerId: string }>;
  };

  const sessionCountOf = (db: DatabaseSync, userId: string): number => {
    // SAFETY: the SELECT counts live sessions for this user.
    return (db.prepare('SELECT "id" FROM "session" WHERE "userId" = ?').all(userId) as Array<{ id: string }>).length;
  };

  const assertSessionLive = async (cookie: string) => {
    expect((await api("/api/bots", "GET", undefined, cookie)).status).toBe(200);
  };

  const preRegisterUnverified = async (label: string) => {
    // The label seeds the EMAIL too, so it must survive better-auth's
    // lowercasing (rows are stored lowercase; queries below use the same
    // string) and must not carry spaces or punctuation.
    const email = `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}-${randomBytes(5).toString("hex")}@example.test`;
    const password = randomBytes(24).toString("base64url");
    const signup = await api(SIGN_UP_PATH, "POST", { email, password, name: label }, "");
    expect(signup.status).toBe(200);
    const cookieA = sessionCookie(signup);
    expect(cookieA).not.toBe("");
    const login = await api(PASSWORD_SIGN_IN_PATH, "POST", { email, password }, "");
    expect(login.status).toBe(200);
    const cookieB = sessionCookie(login);
    expect(cookieB).not.toBe("");
    return { email, password, cookieA, cookieB };
  };

  const assertSessionDead = async (cookie: string) => {
    const dead = await api(`${GET_SESSION_PATH}?disableRefresh=true`, "GET", undefined, cookie);
    expect(dead.status).toBe(200);
    expect(await dead.json()).toBeNull();
    expect((await api("/api/bots", "GET", undefined, cookie)).status).toBe(401);
  };

  /** Seed a live sign-in code for a mailbox without paying the wrapper's
   * per-mailbox resend cooldown: the plugin stores codes as
   * sha256(code)/base64url + ":" + attempts, under the sign-in identifier. */
  const seedSignInCode = (email: string, code: string) => {
    const now = new Date();
    const db = authDb();
    try {
      db.prepare(
        'INSERT INTO "verification" ("id", "identifier", "value", "expiresAt", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?)',
      ).run(
        `ver_${randomBytes(12).toString("hex")}`,
        `sign-in-otp-${email}`,
        `${hashOtp(code)}:0`,
        new Date(now.getTime() + 10 * 60_000).toISOString(),
        now.toISOString(),
        now.toISOString(),
      );
    } finally {
      db.close();
    }
  };

  beforeAll(async () => {
    breakerArm = join(tmpdir(), `muster-otp-breaker-arm-${randomBytes(4).toString("hex")}`);
    harness = await bootHarness("muster-otp-continuity-", {
      preloadUrl: pathToFileURL(join(ROOT, "server/testing/sql-breaker-preload.mjs")).href,
      extraEnv: {
        OMB_TEST_SQL_BREAKER_FILE: breakerArm,
        OMB_TEST_SQL_BREAKER_PATTERN: 'DELETE FROM "session"',
      },
    });
    url = harness.url;
    dataDirectory = harness.dataDirectory;
  }, 45_000);

  afterAll(async () => {
    await shutdown(harness);
  });

  it("case C1 — a previously VERIFIED legitimate account keeps its password, links and sessions across an OTP sign-in", async () => {
    const email = `verified-${randomBytes(5).toString("hex")}@example.test`;
    const password = randomBytes(24).toString("base64url");

    // 1. Sign up (unverified), then prove the inbox through the
    //    email-VERIFICATION purpose — a route that never runs the
    //    unproven-access revocation.
    const signup = await api(SIGN_UP_PATH, "POST", { email, password, name: "Verified Member" }, "");
    expect(signup.status).toBe(200);
    const standingCookie = sessionCookie(signup);
    expect(standingCookie).not.toBe("");
    const since = harness.output.length;
    expect((await sendCode(email, "email-verification")).status).toBe(200);
    const verificationOtp = await harvestCode(email, since);
    const verified = await api("/api/auth/email-otp/verify-email", "POST", { email, otp: verificationOtp });
    expect(verified.status).toBe(200);

    // 2. The legitimate login method keeps working: password sign-in, and
    //    the standing sessions minted along the way stay live.
    const login = await api(PASSWORD_SIGN_IN_PATH, "POST", { email, password }, "");
    expect(login.status).toBe(200);
    const loginCookie = sessionCookie(login);
    expect(loginCookie).not.toBe("");
    await assertSessionLive(standingCookie);
    await assertSessionLive(loginCookie);
    const db = authDb();
    try {
      const userId = userIdOf(db, email)!;
      // SAFETY: the SELECT projects exactly the column asserted below.
      const user = db.prepare('SELECT "emailVerified" FROM "user" WHERE "id" = ?').get(userId) as
        | { emailVerified: number }
        | undefined;
      expect(Number(user?.emailVerified)).toBe(1);
      expect(linksOf(db, userId).length).toBe(1);
      expect(sessionCountOf(db, userId)).toBeGreaterThanOrEqual(2);
    } finally {
      db.close();
    }

    // 3. An OTP sign-in on this VERIFIED account must not revoke anything:
    //    the plugin's cleanup is scoped to emailVerified: false accounts.
    //    (The wrapper prices a second live send to the same mailbox at sixty
    //    seconds, so the fixture seeds the sign-in code into the verification
    //    table in the plugin's own hashed format instead of resending.)
    seedSignInCode(email, "770345");
    expect((await verifyCode(email, "770345")).status).toBe(200);

    await assertSessionLive(standingCookie);
    await assertSessionLive(loginCookie);
    expect((await api(PASSWORD_SIGN_IN_PATH, "POST", { email, password }, "")).status).toBe(200);
    const after = authDb();
    try {
      const userId = userIdOf(after, email)!;
      expect(linksOf(after, userId).length).toBe(1);
    } finally {
      after.close();
    }
  }, 45_000);

  it("case C2 — a cleanup failure leaves the account unverified with unproven authority intact (no promotion)", async () => {
    const victim = await preRegisterUnverified("Partial Custody");
    const db = authDb();
    try {
      expect(sessionCountOf(db, userIdOf(db, victim.email)!)).toBe(2);
      expect(linksOf(db, userIdOf(db, victim.email)!).length).toBe(1);
    } finally {
      db.close();
    }

    // Arm the breaker: the FIRST `DELETE FROM "session"` execution fails —
    // the revocation's second phase, after the account links are gone.
    writeFileSync(breakerArm, "1");
    const since = harness.output.length;
    expect((await sendCode(victim.email)).status).toBe(200);
    const proofCode = await harvestCode(victim.email, since);
    let proofStatus = 0;
    try {
      proofStatus = (await verifyCode(victim.email, proofCode)).status;
    } catch {
      // A propagated cleanup error is acceptable — the point is that the
      // proof must NOT succeed while the breaker eats the session delete.
      proofStatus = 500;
    }
    expect(proofStatus).toBeGreaterThanOrEqual(400);

    // Whatever the HTTP answer, the database must not claim a promotion
    // while unproven authority survives: links may be deleted (phase one
    // ran) but the account is NOT verified, the sessions are NOT deleted,
    // and both attacker cookies still answer protected routes.
    const check = authDb();
    try {
      const userId = userIdOf(check, victim.email)!;
      // SAFETY: the SELECT projects exactly the column asserted below.
      const user = check.prepare('SELECT "emailVerified" FROM "user" WHERE "id" = ?').get(userId) as
        | { emailVerified: number }
        | undefined;
      expect(Number(user?.emailVerified)).toBe(0);
      expect(sessionCountOf(check, userId)).toBe(2);
    } finally {
      check.close();
    }
    await assertSessionLive(victim.cookieA);
    await assertSessionLive(victim.cookieB);

    // The breaker spent its budget of one.
    expect(readFileSync(breakerArm, "utf8").trim()).toBe("0");
    // Hand-off for case C3's retry.
    brokenVictim = victim;
  }, 45_000);

  let brokenVictim: Awaited<ReturnType<typeof preRegisterUnverified>>;

  it("case C3 — a retried healthy proof finishes the revocation the broken attempt could not", async () => {
    // The broken attempt consumed its code, and the wrapper prices a resend
    // at sixty seconds per mailbox — so the fixture seeds a known live code
    // straight into the verification table (same sha256/base64url format
    // the plugin stores) instead of sleeping out the cooldown.
    const seededCode = "654321";
    seedSignInCode(brokenVictim.email, seededCode);

    const retry = await verifyCode(brokenVictim.email, seededCode);
    expect(retry.status).toBe(200);

    await assertSessionDead(brokenVictim.cookieA);
    await assertSessionDead(brokenVictim.cookieB);
    const stalePassword = await api(PASSWORD_SIGN_IN_PATH, "POST", { email: brokenVictim.email, password: brokenVictim.password }, "");
    expect(stalePassword.status).toBe(401);
    const final = authDb();
    try {
      const userId = userIdOf(final, brokenVictim.email)!;
      // SAFETY: the SELECT projects exactly the column asserted below.
      const user = final.prepare('SELECT "emailVerified" FROM "user" WHERE "id" = ?').get(userId) as
        | { emailVerified: number }
        | undefined;
      expect(Number(user?.emailVerified)).toBe(1);
      expect(linksOf(final, userId)).toEqual([]);
      expect(sessionCountOf(final, userId)).toBe(1);
    } finally {
      final.close();
    }
  }, 45_000);
});
