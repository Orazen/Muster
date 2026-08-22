import { DatabaseSync } from "node:sqlite";
import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";
import { join } from "node:path";
import { mkdirSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { DATA_DIR } from "./config.ts";
import { writeFileAtomic } from "./atomic.ts";
import { isEmailConfigured, sendPasswordResetEmail, sendVerificationEmail } from "./email.ts";

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
export const PUBLIC_BASE_URL = (() => {
  const explicit = process.env.OMB_PUBLIC_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");

  const publicHost = process.env.OMB_PUBLIC_HOST?.trim();
  if (publicHost) return `https://${publicHost}`;

  return `http://127.0.0.1:${process.env.OMB_PORT ?? "8799"}`;
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
    const cols = db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === column)) db.exec(ddl);
  }
}

function getDb(): DatabaseSync {
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

/** Mint a real session row + token for an already-provisioned user. The
 * token goes into the standard Better Auth session cookie on the response;
 * getSession() resolves it exactly like any other login. */
export function mintSession(
  userId: string,
  meta?: { ip?: string; userAgent?: string },
): { token: string; expiresAt: Date } {
  const db = getDb();
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60_000);
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
 * Social sign-in is opt-in per provider: configured only when both halves of
 * the credential pair are present. A half-configured provider would render a
 * button that always errors, so an incomplete pair is treated as absent.
 */
function socialProviders() {
  const providers: Record<string, { clientId: string; clientSecret: string }> = {};

  const githubId = process.env.GITHUB_CLIENT_ID?.trim();
  const githubSecret = process.env.GITHUB_CLIENT_SECRET?.trim();
  if (githubId && githubSecret) {
    providers.github = { clientId: githubId, clientSecret: githubSecret };
  }

  const googleId = process.env.GOOGLE_CLIENT_ID?.trim();
  const googleSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (googleId && googleSecret) {
    providers.google = { clientId: googleId, clientSecret: googleSecret };
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
  return SELF_HOSTED ? null : "https://muster.orazen.online";
}

export function authCapabilities(): {
  emailVerification: boolean;
  passwordReset: boolean;
  socialProviders: string[];
  googleOnlySignup: boolean;
  cloudPairing: boolean;
  pairingCloudUrl: string | null;
} {
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
    // pair against, the login page offers the code flow.
    cloudPairing: Boolean(pairingCloudUrl),
    pairingCloudUrl,
  };
}

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
    },
  },
  // Verification links, reset links, and OAuth callbacks are absolute URLs, so
  // Better Auth needs to know where it is actually reachable. Getting this
  // wrong sends users a link to localhost from a production deployment.
  baseURL: PUBLIC_BASE_URL,
  trustedOrigins: [
    "http://127.0.0.1:5199",
    "http://localhost:5199",
    "http://127.0.0.1:8799",
    "http://localhost:8799",
    // Self-hosted deployments must trust their own public origin, or every
    // same-origin browser request gets rejected as untrusted — this was
    // previously only reachable by manually setting OMB_ALLOWED_ORIGINS.
    PUBLIC_BASE_URL,
    ...EXTRA_TRUSTED_ORIGINS,
  ],
  // First concrete step toward per-tenant data isolation (see
  // docs/plans/multi-tenancy-design.md): the organization/member/invitation
  // primitives, additive only. Nothing downstream reads
  // session.activeOrganizationId yet — cfg/store/registry/bus stay the
  // module-level singletons they already are. This deliberately does NOT
  // claim to fix the tenant-isolation bug that design doc documents; it's
  // the identity foundation the real scoping work builds on next.
  plugins: [organization()],
});

/** Convert a Node.js IncomingMessage to a Web Request for Better Auth. */
export function toWebRequest(req: import("node:http").IncomingMessage): Request {
  const host = req.headers.host ?? "localhost";
  const url = `http://${host}${req.url ?? "/"}`;
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
  return new Request(url, {
    method,
    headers,
    ...(hasBody ? { body: req as unknown as ReadableStream, duplex: "half" } : {}),
  } as RequestInit);
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
    path === "/api/pair/redeem"
  );
}
