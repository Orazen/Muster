import { DatabaseSync } from "node:sqlite";
import { betterAuth } from "better-auth";
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

function getDb(): DatabaseSync {
  if (!_db) {
    mkdirSync(DATA_DIR, { recursive: true });
    _db = new DatabaseSync(join(DATA_DIR, "auth.db"));
    _db.exec("PRAGMA journal_mode = WAL");
    _db.exec("PRAGMA foreign_keys = ON");
  }
  return _db;
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
export function authCapabilities(): {
  emailVerification: boolean;
  passwordReset: boolean;
  socialProviders: string[];
} {
  return {
    emailVerification: isEmailConfigured() && SELF_HOSTED,
    passwordReset: isEmailConfigured(),
    socialProviders: Object.keys(socialProviders()),
  };
}

export const auth = betterAuth({
  database: getDb(),
  secret: resolveSecret(),
  socialProviders: socialProviders(),
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
    path === "/api/billing/webhook"
  );
}
