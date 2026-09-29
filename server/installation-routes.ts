// HTTP surface for the stable installation authority
// (server/installation-authority.ts). Registration, listing, rotation and
// revocation — every route reads the OWNER from the SESSION binding, never
// from the body, and the view re-filters by that owner server-side
// (installation-authority.ts list/revoke already drop foreign rows; the
// cross-account pin is server/installation-harness.test.ts).
//
// Deliberately split by proof: the SESSION routes (register/list/rotate/
// revoke) never accept a credential — registration attaches a machine the
// owner can see and control — and the CREDENTIAL routes (self/refresh) never
// accept a session — a machine proves itself with its bearer alone. Nothing
// in this file leaks a bearer into a response it does not already own: the
// credential appears in a body only at mint time (register/rotate/refresh).
import type { IncomingMessage, ServerResponse } from "node:http";

import { z } from "zod";

import { InstallationRegistry, platformWire, type InstallationRecord } from "./installation-authority.ts";
import { json, readBody, isText } from "./http-helpers.ts";

interface RegistryContext {
  registry(): InstallationRegistry | null;
  session?(): Promise<{ userId: string; sessionId: string } | null>;
}

const registerWire = z.object({
  clientKey: z.string().min(8).max(256),
  label: z.string().min(1).max(128),
  platform: platformWire,
});

interface Route {
  match(method: string, path: string): boolean;
  handle(req: IncomingMessage, res: ServerResponse, ctx: RegistryContext): Promise<void>;
}

/** The registration answer: the same public view the list route emits, plus
 * the one-time credential when one was minted. */
interface RegistrationResponse {
  installation: {
    id: string;
    label: string;
    platform: string;
    capabilities: string[];
    createdAt: number;
    lastSeenAt: number;
    revokedAt: number | null;
  };
  reactivated: boolean;
  credential?: string;
  /** The minted credential's absolute expiry, so the machine can renew in
   * time instead of guessing the TTL. Absent only from older servers. */
  credentialExpiresAt?: number;
}

/** The public wire shape of an installation row — never owner, never digest. */
function publicInstallationView(record: InstallationRecord): RegistrationResponse["installation"] {
  const { id, label, platform, capabilities, createdAt, lastSeenAt, revokedAt } = record;
  return { id, label, platform, capabilities, createdAt, lastSeenAt, revokedAt };
}

/** The bearer token from the Authorization header, or null. */
function bearerCredential(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  const match = /^Bearer\s+(\S+)$/i.exec(header?.trim() ?? "");
  return match?.[1] ?? null;
}

const routes: Route[] = [
  {
    // Idempotent registration for the SIGNED-IN account. Returns the stable
    // id every time; the one-time credential appears only when one was minted
    // (first registration, or re-attach after expiry/loss).
    match: (method, path) => method === "POST" && path === "/api/installations/register",
    handle: async (req, res, ctx) => {
      const session = await ctx.session?.();
      if (!session) return json(res, 401, { error: "Sign in to register an installation." });
      const registry = ctx.registry();
      if (!registry) return json(res, 503, { error: "The installation registry is unavailable." });
      const body = await readBody(req);
      const parsed = registerWire.safeParse(body);
      if (!parsed.success) {
        return json(res, 400, { error: "An installation needs a stable client key (8+ chars), a label, and a platform." });
      }
      const outcome = registry.register({
        ownerId: session.userId,
        clientKey: parsed.data.clientKey,
        label: parsed.data.label,
        platform: parsed.data.platform,
      });
      // `null` and `!isDurable` are the same event seen twice: the write did
      // not reach disk, so the registry discarded the change. Nothing was
      // registered, and the caller is told exactly that.
      if (!outcome || !registry.isDurable) {
        return json(res, 503, { error: "The installation registry could not be saved — nothing was registered." });
      }
      // Same public shape as the list view, so clients parse one wire form.
      const response: RegistrationResponse = {
        installation: publicInstallationView(outcome.record),
        reactivated: outcome.reactivated,
      };
      if (outcome.credential !== undefined) {
        response.credential = outcome.credential;
        // null expiry (older row shape) is omitted rather than sent as null,
        // so every client that parses the field sees a real number.
        if (outcome.record.credentialExpiresAt !== null) response.credentialExpiresAt = outcome.record.credentialExpiresAt;
      }
      return json(res, outcome.reactivated ? 200 : 201, response);
    },
  },
  {
    match: (method, path) => method === "GET" && path === "/api/installations",
    handle: async (_req, res, ctx) => {
      const session = await ctx.session?.();
      if (!session) return json(res, 401, { error: "Sign in to see your installations." });
      const registry = ctx.registry();
      if (!registry) return json(res, 503, { error: "The installation registry is unavailable." });
      res.setHeader("Cache-Control", "no-store");
      return json(res, 200, { installations: registry.list(session.userId) });
    },
  },
  {
    // New one-time credential for an existing installation; the previous one
    // stops working at that moment. The row (and its stable id) do not change.
    match: (method, path) => method === "POST" && path === "/api/installations/rotate",
    handle: async (req, res, ctx) => {
      const session = await ctx.session?.();
      if (!session) return json(res, 401, { error: "Sign in to rotate an installation credential." });
      const registry = ctx.registry();
      if (!registry) return json(res, 503, { error: "The installation registry is unavailable." });
      const body = await readBody(req);
      const id = isText(body?.id) ? body.id : "";
      if (!id) return json(res, 400, { error: "Which installation?" });
      const outcome = registry.rotate(session.userId, id);
      if (outcome === null) {
        // A 404 here is only right for a row that does not exist. When the
        // write failed the row does exist and its credential is untouched, so
        // the old credential still works and a retry is safe.
        if (!registry.isDurable) {
          return json(res, 503, { error: "The installation registry could not be saved — the old credential still works." });
        }
        return json(res, 404, { error: "No such installation under this account." });
      }
      return json(res, 200, { credential: outcome.credential!, credentialExpiresAt: outcome.record.credentialExpiresAt });
    },
  },
  {
    // The machine's own view of itself: proves the bearer, answers with the
    // same public shape the owner sees. No session is consulted — a machine
    // identity is not a login.
    match: (method, path) => method === "GET" && path === "/api/installations/self",
    handle: async (req, res, ctx) => {
      const registry = ctx.registry();
      if (!registry) return json(res, 503, { error: "The installation registry is unavailable." });
      const credential = bearerCredential(req);
      if (!credential) return json(res, 401, { error: "Present an installation credential as a bearer token." });
      const record = registry.authenticate(credential);
      if (!record) return json(res, 401, { error: "This installation credential is unknown, expired, or revoked." });
      res.setHeader("Cache-Control", "no-store");
      return json(res, 200, { installation: publicInstallationView(record) });
    },
  },
  {
    // The machine's renewal path: a CURRENT, UNEXPIRED credential proves the
    // installation and is exchanged for a fresh one-time credential (the old
    // one stops working at mint time). An expired credential refreshes
    // nothing — the owner re-registers through a session, same stable id.
    match: (method, path) => method === "POST" && path === "/api/installations/refresh",
    handle: async (req, res, ctx) => {
      const registry = ctx.registry();
      if (!registry) return json(res, 503, { error: "The installation registry is unavailable." });
      const credential = bearerCredential(req);
      if (!credential) return json(res, 401, { error: "Present an installation credential as a bearer token." });
      const record = registry.authenticate(credential);
      if (!record) return json(res, 401, { error: "This installation credential is unknown, expired, or revoked." });
      const outcome = registry.refresh(record.id, credential);
      if (!registry.isDurable || !outcome) {
        return json(res, 503, { error: "The installation registry could not be saved — keep presenting the current credential." });
      }
      return json(res, 200, { credential: outcome.credential!, credentialExpiresAt: outcome.record.credentialExpiresAt });
    },
  },
  {
    match: (method, path) => method === "POST" && path === "/api/installations/revoke",
    handle: async (req, res, ctx) => {
      const session = await ctx.session?.();
      if (!session) return json(res, 401, { error: "Sign in to revoke an installation." });
      const registry = ctx.registry();
      if (!registry) return json(res, 503, { error: "The installation registry is unavailable." });
      const body = await readBody(req);
      const id = isText(body?.id) ? body.id : "";
      if (!id) return json(res, 400, { error: "Which installation?" });
      const revoked = registry.revoke(session.userId, id);
      if (!registry.isDurable) {
        return json(res, 503, { error: "The installation registry could not be saved — do not trust this revocation yet." });
      }
      if (!revoked) return json(res, 404, { error: "No such installation under this account." });
      return json(res, 200, { revoked: true });
    },
  },
];

export async function handleInstallationRoute(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
  env: {
    registry(): InstallationRegistry | null;
    session(): Promise<{ userId: string; sessionId: string } | null>;
  },
): Promise<boolean> {
  const ctx: RegistryContext = { registry: env.registry, session: env.session };
  const route = routes.find((candidate) => candidate.match(method, path));
  if (!route) return false;
  await route.handle(req, res, ctx);
  return true;
}
