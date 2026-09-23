import { DatabaseSync } from "node:sqlite";
import { betterAuth } from "better-auth";
import { emailOTP, organization } from "better-auth/plugins";
import { join } from "node:path";
import { mkdirSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { createHmac, randomBytes } from "node:crypto";
import { z } from "zod";
import { DATA_DIR } from "./config.ts";
import { writeFileAtomic } from "./atomic.ts";
import { GOOGLE_SIGNIN_SCOPES, googleCredentials } from "./google-auth.ts";
import {
  isEmailConfigured,
  sendLoginCodeEmail,
  sendPasswordResetEmail,
  sendVerificationEmail,
} from "./email.ts";

/**
 * Self-hosting is opt-in and mirrors the same signal server/index.ts uses:
 * binding beyond loopback, or naming a public host, means this deployment is
 * meant to be reached over a network. Kept local to avoid an import cycle —
 * index.ts imports this module, not the other way round.
 */
export const SELF_HOSTED =
  (process.env.OMB_HOST ?? "127.0.0.1") !== "127.0.0.1" || Boolean(process.env.OMB_PUBLIC_HOST);

/**
 * Where this deployment is reachable from a browser. Emailed links and OAuth
 * callbacks are absolute, so a wrong value here mails production users a
 * localhost link. OMB_PUBLIC_URL wins (it can carry a scheme and a path);
 * OMB_PUBLIC_HOST is the friendlier form and assumes https on the default
 * port, which is what sits behind a reverse proxy in practice.
 */
/** Whether an operator explicitly pinned the deployment's public URL via
 * OMB_PUBLIC_URL or OMB_PUBLIC_HOST. Drives the baseURL strategy: pinned →
 * static baseURL; unpinned → per-request resolution from proxy headers. */
export const OMB_PUBLIC_BASE_URL_SET =
  Boolean(process.env.OMB_PUBLIC_URL?.trim()) || Boolean(process.env.OMB_PUBLIC_HOST?.trim());

export const PUBLIC_BASE_URL = (() => {
  const explicit = process.env.OMB_PUBLIC_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");

  const publicHost = process.env.OMB_PUBLIC_HOST?.trim();
  if (publicHost) return `https://${publicHost}`;

  const loopback = `http://127.0.0.1:${process.env.OMB_PORT ?? "8799"}`;
  // A self-hosted deploy behind a proxy without a public-host override gets
  // a loopback PUBLIC_BASE_URL. Same-origin sign-in still works — the
  // trustedOrigins function trusts the request's own Host — but emailed
  // verification/reset links would point at the loopback, so warn: those
  // flows need OMB_PUBLIC_HOST (or OMB_PUBLIC_URL) to be useful.
  const selfHosted =
    (process.env.OMB_HOST ?? "127.0.0.1") !== "127.0.0.1" || Boolean(process.env.OMB_PUBLIC_HOST);
  if (selfHosted) {
    console.warn(
      "[auth] OMB_HOST is non-loopback but neither OMB_PUBLIC_URL nor OMB_PUBLIC_HOST is set — " +
        `PUBLIC_BASE_URL defaults to ${loopback}. Sign-in works (same-origin trust), but emailed ` +
        "links will carry this loopback base. Set OMB_PUBLIC_HOST (e.g. muster.example.com) to fix.",
    );
  }
  return loopback;
})();

/**
 * Better Auth signs session tokens with this. It must be stable across
 * restarts, or every session is invalidated on boot; and it must be secret,
 * or sessions can be forged.
 *
 * Self-hosted deployments have to supply it explicitly — a generated one would
 * differ per replica and silently break sessions behind a load balancer. The
 * single-user desktop install has no operator to configure anything, so we
 * generate once and persist to ~/.muster/auth.secret with 0600.
 */
function resolveSecret(): string {
  const fromEnv = process.env.BETTER_AUTH_SECRET?.trim();
  if (fromEnv) return fromEnv;

  if (SELF_HOSTED) {
    throw new Error(
      "BETTER_AUTH_SECRET is required when self-hosting (OMB_HOST/OMB_PUBLIC_HOST are set). " +
        "Generate one with `openssl rand -base64 32` and set it in the environment.",
    );
  }

  mkdirSync(DATA_DIR, { recursive: true });
  const secretPath = join(DATA_DIR, "auth.secret");
  if (existsSync(secretPath)) {
    const existing = readFileSync(secretPath, "utf8").trim();
    if (existing) return existing;
  }
  const generated = randomBytes(32).toString("base64");
  writeFileAtomic(secretPath, generated);
  try {
    chmodSync(secretPath, 0o600);
  } catch {
    // best effort — Windows has no POSIX mode bits
  }
  return generated;
}

/** The deployment's signing secret, for HMACs beyond auth (signed job
 * receipts). Same material as session signing: stable across restarts,
 * never leaves the server. */
export function deploymentSigningSecret(): string {
  return resolveSecret();
}

let _db: DatabaseSync | null = null;

/**
 * Better Auth's schema, applied idempotently on every boot. There is no
 * separate migration step anywhere in the deploy pipeline (no CLI run in
 * Docker, no init container), so a fresh `auth.db` had zero tables and every
 * sign-up/sign-in failed with "no such table: user" until an operator ran
 * this by hand. CREATE TABLE IF NOT EXISTS makes re-running safe on every
 * restart; ALTER TABLE additions are individually guarded since SQLite has
 * no "ADD COLUMN IF NOT EXISTS".
 */
function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS "user" (
      "id" text not null primary key,
      "name" text not null,
      "email" text not null unique,
      "emailVerified" integer not null,
      "image" text,
      "createdAt" date not null,
      "updatedAt" date not null
    );
    CREATE TABLE IF NOT EXISTS "session" (
      "id" text not null primary key,
      "expiresAt" date not null,
      "token" text not null unique,
      "createdAt" date not null,
      "updatedAt" date not null,
      "ipAddress" text,
      "userAgent" text,
      "userId" text not null references "user" ("id") on delete cascade
    );
    CREATE TABLE IF NOT EXISTS "account" (
      "id" text not null primary key,
      "accountId" text not null,
      "providerId" text not null,
      "userId" text not null references "user" ("id") on delete cascade,
      "accessToken" text,
      "refreshToken" text,
      "idToken" text,
      "accessTokenExpiresAt" date,
      "refreshTokenExpiresAt" date,
      "scope" text,
      "password" text,
      "createdAt" date not null,
      "updatedAt" date not null
    );
    CREATE TABLE IF NOT EXISTS "verification" (
      "id" text not null primary key,
      "identifier" text not null,
      "value" text not null,
      "expiresAt" date not null,
      "createdAt" date not null,
      "updatedAt" date not null
    );
    CREATE INDEX IF NOT EXISTS "session_userId_idx" on "session" ("userId");
    CREATE INDEX IF NOT EXISTS "account_userId_idx" on "account" ("userId");
    CREATE INDEX IF NOT EXISTS "verification_identifier_idx" on "verification" ("identifier");

    -- Viral loop ledger (server/viral.ts). One code per user; redemptions
    -- are single-use per referee. Banked days convert to local Pro days
    -- through the pairing/tier bridge on the inviter's own install.
    CREATE TABLE IF NOT EXISTS "referral" (
      "userId" text not null primary key references "user" ("id") on delete cascade,
      "code" text not null unique,
      "bankedDays" integer not null default 0,
      "createdAt" date not null
    );
    CREATE TABLE IF NOT EXISTS "referralRedemption" (
      "id" text not null primary key,
      "codeUsed" text not null,
      "ownerUserId" text not null references "user" ("id") on delete cascade,
      "refereeUserId" text not null unique references "user" ("id") on delete cascade,
      "createdAt" date not null
    );
    CREATE INDEX IF NOT EXISTS "referralRedemption_owner_idx" on "referralRedemption" ("ownerUserId");

    -- organization plugin (docs/plans/multi-tenancy-design.md's identity
    -- foundation) — schema confirmed via @better-auth/cli migrate against
    -- this exact auth config, same verification method as every table
    -- above.
    CREATE TABLE IF NOT EXISTS "organization" (
      "id" text not null primary key,
      "name" text not null,
      "slug" text not null unique,
      "logo" text,
      "createdAt" date not null,
      "metadata" text
    );
    CREATE TABLE IF NOT EXISTS "member" (
      "id" text not null primary key,
      "organizationId" text not null references "organization" ("id") on delete cascade,
      "userId" text not null references "user" ("id") on delete cascade,
      "role" text not null,
      "createdAt" date not null
    );
    CREATE TABLE IF NOT EXISTS "invitation" (
      "id" text not null primary key,
      "organizationId" text not null references "organization" ("id") on delete cascade,
      "email" text not null,
      "role" text,
      "status" text not null,
      "expiresAt" date not null,
      "createdAt" date not null,
      "inviterId" text not null references "user" ("id") on delete cascade
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "organization_slug_uidx" on "organization" ("slug");
    CREATE INDEX IF NOT EXISTS "member_organizationId_idx" on "member" ("organizationId");
    CREATE INDEX IF NOT EXISTS "member_userId_idx" on "member" ("userId");
    CREATE INDEX IF NOT EXISTS "invitation_organizationId_idx" on "invitation" ("organizationId");
    CREATE INDEX IF NOT EXISTS "invitation_email_idx" on "invitation" ("email");
  `);

  // Columns added after the tables above first shipped. Each ALTER is
  // guarded individually because SQLite has no IF NOT EXISTS for columns,
  // and a fresh CREATE TABLE above already includes them going forward.
  const columnAdditions: Array<[table: string, column: string, ddl: string]> = [
    ["account", "issuer", 'ALTER TABLE "account" ADD COLUMN "issuer" text'],
    ["session", "activeOrganizationId", 'ALTER TABLE "session" ADD COLUMN "activeOrganizationId" text'],
  ];
  for (const [table, column, ddl] of columnAdditions) {
    // SAFETY: PRAGMA table_info always yields rows with a text "name" column
    const cols = db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === column)) db.exec(ddl);
  }
}

export function getDb(): DatabaseSync {
  if (!_db) {
    mkdirSync(DATA_DIR, { recursive: true });
    _db = new DatabaseSync(join(DATA_DIR, "auth.db"));
    _db.exec("PRAGMA journal_mode = WAL");
    _db.exec("PRAGMA foreign_keys = ON");
    migrate(_db);
  }
  return _db;
}

/** The deployment's first account — the primary user. The boot migration
 * stamps pre-ownership bots/groups with this id, so everything that existed
 * before per-user ownership lands on the operator's account rather than
 * staying visible to every signed-in account. */
export function primaryUserId(): string | null {
  try {
    // SAFETY: the SELECT projects only the users table's id column
    const row = getDb().prepare("SELECT id FROM \"user\" ORDER BY \"createdAt\" ASC LIMIT 1").get() as
      | { id: string }
      | undefined;
    return row?.id ?? null;
  } catch {
    return null;
  }
}

/** Look up a user by email — the pairing bridge resolves a cloud identity
 * against the local account list before deciding to provision. */
export function findUserByEmail(email: string): { id: string; name: string; email: string } | null {
  try {
    // SAFETY: the SELECT projects exactly the id/name/email columns returned here
    const row = getDb()
      .prepare('SELECT "id", "name", "email" FROM "user" WHERE lower("email") = lower(?) LIMIT 1')
      .get(email.trim().toLowerCase()) as { id: string; name: string; email: string } | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

/** Look up a user by id — the pairing verify endpoint resolves a consumed
 * code's owner back to their identity. */
export function findUserById(id: string): { id: string; name: string; email: string } | null {
  try {
    // SAFETY: the SELECT projects exactly the id/name/email columns returned here
    const row = getDb()
      .prepare('SELECT "id", "name", "email" FROM "user" WHERE "id" = ? LIMIT 1')
      .get(id) as { id: string; name: string; email: string } | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

/** Provision a local account from a cloud-verified identity (pairing
 * bridge). Direct inserts for the same reason provisionOrganizationFor
 * is: Better Auth's route handlers require a request context that doesn't
 * exist in server-to-server flows. The org hook fires here explicitly —
 * the databaseHooks.user.create.after path only covers Better Auth's own
 * sign-up routes. */
export function createBridgedUser(email: string, name: string): string {
  const db = getDb();
  const normalized = email.trim().toLowerCase();
  const existing = findUserByEmail(normalized);
  if (existing) return existing.id;
  const userId = `usr_${randomBytes(12).toString("base64url")}`;
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO "user" ("id", "name", "email", "emailVerified", "image", "createdAt", "updatedAt") VALUES (?, ?, ?, 1, NULL, ?, ?)',
  ).run(userId, name || normalized.split("@")[0], normalized, now, now);
  provisionOrganizationFor(userId, name || normalized);
  return userId;
}

/** What. The exact Set-Cookie value Better Auth itself would write for this
 * session token: `<token>.<base64(hmac-sha256(secret, token))>`, URI-encoded.
 * Why. get-session verifies the signature with the secret before it ever
 * looks at the DB — a bare token in the cookie verified to null on EVERY
 * redeem, so desktop pairing "succeeded" while logging nobody in. */
export function signedSessionCookieValue(token: string): string {
  const signature = createHmac("sha256", resolveSecret()).update(token).digest("base64");
  return encodeURIComponent(`${token}.${signature}`);
}

/** Mint a real session row + token for an already-provisioned user. The
 * token goes into the standard Better Auth session cookie on the response;
 * getSession() resolves it exactly like any other login. */
export function mintSession(
  userId: string,
  meta?: { ip?: string; userAgent?: string },
) {
  const db = getDb();
  const token = randomBytes(32).toString("base64url");
  // Match better-auth's session.expiresIn (7 days): a bridged session that
  // outlives the configured policy escapes refresh handling entirely.
  const expiresAt = new Date(Date.now() + 60 * 60 * 24 * 7 * 1000);
  db.prepare(
    'INSERT INTO "session" ("id", "expiresAt", "token", "createdAt", "updatedAt", "ipAddress", "userAgent", "userId") VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    `ses_${randomBytes(12).toString("base64url")}`,
    expiresAt.toISOString(),
    token,
    new Date().toISOString(),
    new Date().toISOString(),
    meta?.ip ?? null,
    meta?.userAgent ?? null,
    userId,
  );
  return { token, expiresAt };
}

/** Extra origins a self-hosted deployment opts into, same var index.ts reads. */
const EXTRA_TRUSTED_ORIGINS = (process.env.OMB_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

/**
 * The origin the request itself came in on, derived from Host + the scheme
 * better-auth's own origin checks are willing to trust. Returned as a
 * trusted origin so same-origin browser requests pass even when the static
 * PUBLIC_BASE_URL doesn't match the deployment (self-hosts that never set
 * OMB_PUBLIC_HOST). Scheme comes from X-Forwarded-Proto when the proxy sent
 * it (validated), else https behind a non-loopback Host, else http — the
 * loopback desktop/dev case. undefined when there is no usable Host.
 */
export function requestOwnOrigin(request?: Request): string | undefined {
  const headers = request?.headers;
  if (!headers) return undefined;
  const host = headers.get("x-forwarded-host") ?? headers.get("host");
  if (!host) return undefined;
  // Header-injection guard: a Host is one authority token, never a list or
  // a URL. Anything past the first comma, or carrying a scheme, is not a
  // Host this server was addressed by.
  const candidate = host.split(",")[0]?.trim() ?? "";
  if (!/^[\w.-]+(:\d{1,5})?$/.test(candidate)) return undefined;
  // Loopback by exact hostname match — a prefix test would let
  // "127.0.0.1.evil.com" claim the http dev scheme.
  const hostname = candidate.replace(/:\d{1,5}$/, "").toLowerCase();
  const isLoopback = hostname === "127.0.0.1" || hostname === "localhost" || hostname.endsWith(".localhost");
  const proto = headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const scheme = proto === "http" || proto === "https"
    ? proto
    : isLoopback
      ? "http"
      : "https";
  return `${scheme}://${candidate}`;
}

/**
 * Social sign-in is opt-in per provider: configured only when both halves of
 * the credential pair are present. A half-configured provider would render a
 * button that always errors, so an incomplete pair is treated as absent.
 */
function socialProviders() {
  const providers: Record<
    string,
    { clientId: string; clientSecret: string; scope?: string[]; accessType?: string; prompt?: string }
  > = {};

  const githubId = process.env.GITHUB_CLIENT_ID?.trim();
  const githubSecret = process.env.GITHUB_CLIENT_SECRET?.trim();
  if (githubId && githubSecret) {
    providers.github = { clientId: githubId, clientSecret: githubSecret };
  }

  // One credential pair serves both Google surfaces (this sign-in config
  // and the account-linked Drive connect), so capability-on/off can never
  // disagree between them; a half pair counts as absent.
  const google = googleCredentials();
  if (google) {
    providers.google = {
      clientId: google.clientId,
      clientSecret: google.clientSecret,
      // Sign-in stays basic-scope on purpose (GOOGLE_SIGNIN_SCOPES in
      // server/google-auth.ts is the one home for that list): drive.appdata
      // is a RESTRICTED scope, and requesting it at login makes Google show
      // every new user the "Google hasn't verified this app" interstitial
      // (scope verification is separate from branding — restricted scopes
      // need a security assessment). Accounts that granted Drive earlier
      // keep their stored refresh token, so workspace Drive backup still
      // works for them; a separate opt-in Drive connect is the follow-up
      // for everyone else.
      scope: [...GOOGLE_SIGNIN_SCOPES],
    };
  }

  return providers;
}

/** Which optional auth features are live, so the UI can render accordingly. */
/** The cloud this install pairs desktop Google sign-in against. Desktop
 * installs default to Muster Cloud so the flow works out of the box; a
 * self-host must opt in explicitly (it has no business silently trusting
 * an external identity source). */
export function pairCloudUrl(): string | null {
  const explicit = process.env.OMB_PAIR_CLOUD_URL?.trim() || null;
  if (explicit) return explicit;
  return SELF_HOSTED ? null : "https://muster.today";
}

/** Lifetime of a sign-in one-time code, in seconds (10 minutes). One value,
 * consumed by the emailOTP plugin below (code expiry) and by the dev-mode
 * delivery log in server/email.ts so the message can restate it. */
export const OTP_TTL_SECONDS = 600;

export function authCapabilities() {
  const pairingCloudUrl = pairCloudUrl();
  return {
    emailVerification: isEmailConfigured() && SELF_HOSTED,
    passwordReset: isEmailConfigured(),
    socialProviders: Object.keys(socialProviders()),
    // Manual sign-UP is off; existing accounts still sign in with a
    // password exactly as before — see the /api/auth/sign-up/email gate
    // in server/index.ts for the enforcement, this is only the UI signal.
    googleOnlySignup: process.env.OMB_GOOGLE_ONLY_SIGNUP === "true",
    // Desktop Google sign-in: when the local server knows which cloud to
    // pair against, the login page offers the code flow — and, first-class,
    // the real OAuth handoff (cloud does the Google dance, desktop receives
    // a one-time code over loopback).
    cloudPairing: Boolean(pairingCloudUrl),
    desktopOAuth: Boolean(pairingCloudUrl),
    pairingCloudUrl,
    // Email + 6-digit one-time-code sign-in (better-auth's emailOTP plugin,
    // policy-wrapped by server/email-otp-login.ts). Always available: with
    // no mailer configured the code is logged for local finishing rather
    // than dropped, so this does not depend on RESEND_API_KEY the way
    // passwordReset does.
    emailOtp: true,
  };
}

const organizationIdRowSchema = z.object({ id: z.string() }).optional();

/** Create this user's own organization + owner membership, directly
 * against the same tables server/auth.ts's own migration SQL defines
 * above — not through the organization plugin's HTTP-route-style API
 * functions (auth.api.createOrganization / setActiveOrganization), which
 * turned out to require an authenticated session in the request context
 * (found reading routes/crud-org.mjs: requestOnlySessionMiddleware reads
 * ctx.context.session.user.id). That session doesn't exist yet inside a
 * user.create.after hook — a brand-new user has no session at the point
 * their own account row is being created — so the route handlers can't
 * be called from here at all, only the tables they read/write. */
function provisionOrganizationFor(userId: string, displayName: string): string {
  const db = getDb();
  const now = new Date().toISOString();
  const orgId = `org_${randomBytes(12).toString("base64url")}`;
  const slug = `org-${userId}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  // better-auth can run user.create.after more than once per user; the slug
  // is deterministic per user, so treat an existing row as already
  // provisioned instead of riding the UNIQUE constraint into the catch below.
  const existing = organizationIdRowSchema.parse(db.prepare('SELECT id FROM "organization" WHERE slug = ?').get(slug));
  if (existing) return existing.id;
  // The org and its owner membership are one mutation: an org row whose
  // membership insert failed would leave the user org-less with no owner.
  // A SAVEPOINT, not BEGIN: this hook fires inside better-auth's own
  // transaction around sign-up, where a nested BEGIN would throw and
  // silently kill the provisioning. And when this savepoint IS outermost,
  // ROLLBACK TO alone would leave its transaction open — every later write
  // on this connection would silently join a transaction nobody commits —
  // so the catch RELEASES the savepoint too (a no-op pop when nested in an
  // outer transaction, a commit-to-nothing when it was the outermost).
  db.exec("SAVEPOINT provision_org");
  try {
    db.prepare('INSERT INTO "organization" ("id", "name", "slug", "createdAt") VALUES (?, ?, ?, ?)').run(
      orgId,
      `${displayName}'s workspace`,
      slug,
      now,
    );
    db.prepare('INSERT INTO "member" ("id", "organizationId", "userId", "role", "createdAt") VALUES (?, ?, ?, ?, ?)').run(
      `mem_${randomBytes(12).toString("base64url")}`,
      orgId,
      userId,
      "owner",
      now,
    );
    db.exec("RELEASE SAVEPOINT provision_org");
  } catch (error) {
    db.exec("ROLLBACK TO SAVEPOINT provision_org");
    db.exec("RELEASE SAVEPOINT provision_org");
    throw error;
  }
  return orgId;
}

export const auth = betterAuth({
  database: getDb(),
  secret: resolveSecret(),
  socialProviders: socialProviders(),
  // First real piece of the multi-tenancy foundation
  // (docs/plans/multi-tenancy-design.md), not the full fix: every new user
  // — through any auth method, this hook fires for all of them — gets their
  // own organization automatically. The active session created right after
  // (session.create.before, below) picks it up as activeOrganizationId.
  // Nothing reads activeOrganizationId to actually scope
  // cfg/store/registry/bus yet (that's the real rewrite the design doc
  // describes and deliberately does not rush); this is what makes a tenant
  // ID exist to resolve in the first place, which every later step needs
  // before it can do anything. Additive and inert on its own — an org a
  // tenant ID is never read from doesn't change any current behavior.
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          try {
            provisionOrganizationFor(user.id, user.name || user.email);
          } catch {
            // Never block sign-up over this — an org-less account is
            // exactly today's status quo (this hook is what changes that
            // going forward for new accounts), not a broken one.
          }
        },
      },
    },
    session: {
      create: {
        before: async (session) => {
          try {
            const db = getDb();
            // SAFETY: the SELECT projects only member rows' organizationId column
            const existing = db
              .prepare('SELECT "organizationId" FROM "member" WHERE "userId" = ? ORDER BY "createdAt" ASC LIMIT 1')
              .get(session.userId) as { organizationId?: string } | undefined;
            if (existing?.organizationId) return { data: { ...session, activeOrganizationId: existing.organizationId } };
            // Live-tested finding: a brand-new user's very first session is
            // sometimes created before user.create.after's org-provisioning
            // has finished — a real race, not hypothetical (reproduced: the
            // first session after sign-up had no activeOrganizationId, a
            // second session from a subsequent sign-in did). Provisioning
            // right here too closes that race without needing hook
            // ordering guarantees: provisionOrganizationFor()'s slug is
            // deterministic per user, so if user.create.after's own
            // attempt is still in flight or already succeeded, the
            // redundant insert here just hits the same unique constraint
            // and is swallowed — never a duplicate organization.
            // SAFETY: the SELECT projects exactly the name/email columns read below
            const user = db.prepare('SELECT "name", "email" FROM "user" WHERE "id" = ?').get(session.userId) as
              | { name?: string; email?: string }
              | undefined;
            const orgId = provisionOrganizationFor(session.userId, user?.name || user?.email || session.userId);
            return { data: { ...session, activeOrganizationId: orgId } };
          } catch {
            /* fall through — a session without an org is today's status quo */
          }
          return undefined;
        },
      },
    },
  },
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 12,
    // Only advertise reset when mail can actually be delivered — a reset
    // button that silently drops the message is worse than none.
    sendResetPassword: isEmailConfigured()
      ? async ({ user, url }) => {
          await sendPasswordResetEmail(user.email, url);
        }
      : undefined,
    resetPasswordTokenExpiresIn: 60 * 60,
  },
  emailVerification: {
    sendVerificationEmail: isEmailConfigured()
      ? async ({ user, url }) => {
          await sendVerificationEmail(user.email, url);
        }
      : undefined,
    sendOnSignUp: isEmailConfigured(),
    autoSignInAfterVerification: true,
    expiresIn: 60 * 60,
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
  },
  // Throttles credential stuffing against /api/auth/sign-in. Better Auth
  // applies the window per IP; sign-in gets a tighter budget than the rest.
  rateLimit: {
    enabled: true,
    window: 60,
    max: 60,
    customRules: {
      "/sign-in/email": { window: 60, max: 5 },
      "/sign-up/email": { window: 3600, max: 10 },
      // Email one-time codes (keys are relative to /api/auth, same as every
      // rule above): send is the expensive one — it writes a verification
      // row and, when a mailer is configured, an outbound email — so it
      // gets the tightest per-IP budget; check (non-consuming validation)
      // and the OTP sign-in itself sit comfortably above it so a legitimate
      // user retrying a typo'd code is never locked out by the IP window
      // before their attempt budget (3, in the plugin) can speak.
      "/email-otp/send-verification-otp": { window: 60, max: 8 },
      "/email-otp/check-verification-otp": { window: 60, max: 15 },
      "/sign-in/email-otp": { window: 60, max: 15 },
    },
  },
  // Verification links, reset links, and OAuth callbacks are absolute URLs, so
  // Better Auth needs to know where it is actually reachable. Getting this
  // wrong sends users a link to localhost from a production deployment.
  // When the operator pinned the deployment's public URL, pass it through.
  // When not (Dokploy runs the Dockerfile directly, so compose env like
  // OMB_PUBLIC_HOST never arrives), leave baseURL UNSET: Better Auth then
  // re-resolves the origin from every request's proxy headers, so the
  // OAuth redirect_uri matches the host the browser actually used instead
  // of baking the loopback default into Google's redirect_uri_mismatch.
  // trustedProxyHeaders only takes effect in that unset case.
  ...(OMB_PUBLIC_BASE_URL_SET
    ? { baseURL: PUBLIC_BASE_URL }
    : { advanced: { trustedProxyHeaders: true as const } }),
  trustedOrigins: (request?: Request): Array<string | undefined | null> => {
    // The request's own origin is always trusted. This rescues deployments
    // where OMB_PUBLIC_HOST never made it into the container (e.g. Dokploy
    // building the Dockerfile directly, not docker-compose.prod.yml): the
    // static list above only knows PUBLIC_BASE_URL, which collapses to a
    // loopback URL, and every same-origin sign-in failed with 403
    // INVALID_ORIGIN. The rule is the same-host check Django/Rails use: a
    // browser sets Host from the URL it is talking to and Origin from the
    // page it is on, so a cross-site request's Origin can never equal its
    // Host — trusting the request's own host keeps the CSRF check honest.
    // Only the origin-header check re-invokes this with a live request;
    // callbackURL validation uses the boot-time list.
    const own = requestOwnOrigin(request);
    return [
      "http://127.0.0.1:5199",
      "http://localhost:5199",
      "http://127.0.0.1:8799",
      "http://localhost:8799",
      // Self-hosted deployments must trust their own public origin, or every
      // same-origin browser request gets rejected as untrusted — this was
      // previously only reachable by manually setting OMB_ALLOWED_ORIGINS.
      PUBLIC_BASE_URL,
      ...EXTRA_TRUSTED_ORIGINS,
      own,
    ];
  },
  // First concrete step toward per-tenant data isolation (see
  // docs/plans/multi-tenancy-design.md): the organization/member/invitation
  // primitives, additive only. Nothing downstream reads
  // session.activeOrganizationId yet — cfg/store/registry/bus stay the
  // module-level singletons they already are. This deliberately does NOT
  // claim to fix the tenant-isolation bug that design doc documents; it's
  // the identity foundation the real scoping work builds on next.
  plugins: [
    organization(),
    // Email + 6-digit one-time-code sign-in. The plugin owns code
    // generation/hash/expiry/attempt budgeting and mints the SAME session
    // every other sign-in path mints; Muster-specific policy (sign-up
    // gates, resend cooldown, and the unverified-user promotion that keeps
    // password accounts intact) lives in server/email-otp-login.ts, which
    // intercepts the two public routes before Better Auth sees them.
    emailOTP({
      expiresIn: OTP_TTL_SECONDS,
      allowedAttempts: 3,
      storeOTP: "hashed",
      sendVerificationOTP: async ({ email, otp }) => {
        await sendLoginCodeEmail(email, otp, OTP_TTL_SECONDS);
      },
    }),
  ],
});

/** The request scheme behind a reverse proxy: the first entry of
 * X-Forwarded-Proto when the proxy sent one (Node's IncomingHttpHeaders
 * types it string | string[] | undefined), else http — the loopback
 * desktop/dev case where the scheme really is plain http. Shared by
 * toWebRequest and the desktop-auth Google handoff. */
export function forwardedProtoOf(req: import("node:http").IncomingMessage): string {
  // Node's IncomingHttpHeaders types X-Forwarded-Proto as string | string[]
  // | undefined; zod is overkill for one scheme token, so parse the
  // representation explicitly at this boundary.
  const parsed = z.union([z.string(), z.array(z.string()), z.undefined()]).safeParse(req.headers["x-forwarded-proto"]);
  if (!parsed.success) return "http";
  const entries = parsed.data === undefined ? [] : Array.isArray(parsed.data) ? parsed.data : [parsed.data];
  const first = entries.map((value) => value.split(",")[0]?.trim() ?? "").find((value) => value.length > 0);
  return first ?? "http";
}

/** Convert a Node.js IncomingMessage to a Web Request for Better Auth. */
export function toWebRequest(req: import("node:http").IncomingMessage): Request {
  const host = req.headers.host ?? "localhost";
  // Scheme from X-Forwarded-Proto when the proxy sent one: behind a reverse
  // proxy the container itself speaks http, and a request URL that says
  // http:// while the browser used https:// would resolve the wrong origin
  // wherever Better Auth derives the base URL from the request itself.
  const proto = forwardedProtoOf(req);
  const url = `${proto}://${host}${req.url ?? "/"}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value !== undefined) {
      headers.set(key, Array.isArray(value) ? value.join(", ") : value);
    }
  }
  const method = req.method ?? "GET";
  // GET/HEAD must not carry a body (the Fetch API rejects it). Every other
  // method needs the raw request stream forwarded, or Better Auth sees an
  // empty body and rejects every sign-up/sign-in with a validation error —
  // this was previously dropped entirely, silently breaking every POST.
  const hasBody = method !== "GET" && method !== "HEAD";
  const init: RequestInit & { duplex?: "half" } = { method, headers };
  if (hasBody) {
    // The raw request stream becomes the fetch body verbatim; a streaming
    // body must declare duplex "half" or the Request constructor rejects it.
    Object.assign(init, { body: req, duplex: "half" });
  }
  return new Request(url, init);
}

/** Resolved session for a request, or null when unauthenticated. */
export async function getSession(
  req: import("node:http").IncomingMessage,
): Promise<{ userId: string } | null> {
  try {
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value !== undefined) {
        headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      }
    }
    const result = await auth.api.getSession({ headers });
    const userId = result?.user?.id;
    return userId ? { userId } : null;
  } catch {
    return null;
  }
}

/**
 * Paths that must stay reachable without a session: the auth endpoints
 * themselves (otherwise nobody could ever sign in), and an unauthenticated
 * liveness probe for load balancers and the packaged-server smoke test.
 *
 * `/api/internal/*` is deliberately absent — it carries its own loopback +
 * COMMS_TOKEN check in index.ts and is not a user-facing route.
 */
export function isPublicApiPath(path: string): boolean {
  return (
    path.startsWith("/api/auth/") ||
    path === "/api/health" ||
    path === "/api/build-identity" ||
    // The sign-in screen reads this before a session exists, to know which
    // providers to show and whether to offer "forgot password".
    path === "/api/auth-capabilities" ||
    // Stripe posts here with a signed payload, not a session cookie. The
    // handler verifies the signature itself.
    path === "/api/billing/webhook" ||
    // Pairing redemption is server-to-server: the desktop's local server
    // presents a short-lived single-use code instead of a session. The
    // code's entropy + TTL + per-IP attempt limits are the gate here —
    // see server/pairing.ts. Creating codes still requires a session.
    path === "/api/pair/verify" ||
    // the desktop's local redeem endpoint — same code-as-credential story
    path === "/api/pair/redeem" ||
    // Self-host claim redeem: the phone that scanned the `muster up` QR has
    // no session yet — the single-use, 10-minute, per-IP-throttled code IS
    // the credential (see server/claim.ts). Minting codes is NOT public:
    // /api/pair/claim/create self-gates to loopback in its handler.
    path === "/api/pair/claim" ||
    // The public team-directory feed (/bots page): read-only catalog of
    // installable teams, deliberately consumable without an account so
    // agents and aggregators can index it (server/viral.ts rationale).
    // The /teams directory detail view reads one team's manifest + README
    // through the same public surface.
    path === "/api/directory/teams" ||
    path.startsWith("/api/directory/teams/") ||
    // The public agent-directory feed (server/social.ts): only profiles
    // their owners set public, only the fields they chose to share.
    path === "/api/directory/agents" ||
    // WhatsApp Business channel: authenticated by Meta's own signature
    // (X-Hub-Signature-256 over the raw body, timing-safe compare) plus the
    // subscription handshake token — not by a user session.
    path === "/api/whatsapp/webhook" ||
    // Receipt verification is the whole point of signed receipts: an
    // external verifier (hiring manager, another agent, an auditor) has no
    // session on this deployment. The endpoint is rate-limited and does
    // exactly one thing — compare an HMAC over the posted payload. It
    // returns nothing but valid/malformed/signature-mismatch, so it leaks
    // no data even to a flood (see server/receipt-signing.ts).
    path === "/api/receipts/verify"
  );
}

/** Hard-delete one auth user; FK cascades clear their sessions and linked
 * accounts. Only caller: account-merge, AFTER vault keys and bot ownership
 * have already migrated — ownership of both halves is proven by the token
 * exchange, so this is bookkeeping, not a destructive surprise. */
export function deleteAuthUser(userId: string): void {
  getDb().prepare('DELETE FROM "user" WHERE "id" = ?').run(userId);
}
