// HTTP surface for the stable installation authority
// (server/installation-authority.ts). Registration, listing, rotation and
// revocation — every route reads the OWNER from the SESSION binding, never
// from the body, and the view re-filters by that owner server-side
// (installation-authority.ts list/revoke already drop foreign rows; the
// cross-account pin is server/installation-harness.test.ts).
//
// Deliberately minimal: the credential's CONSUMER is a future runner/endpoint
// adapter, not this route table. No route accepts a credential here —
// registration attaches a machine the owner can see; authenticating WITH the
// credential is a later slice's decision, so nothing in this file can leak a
// bearer into a response it does not already own.
import type { IncomingMessage, ServerResponse } from "node:http";

import { z } from "zod";

import { InstallationRegistry, platformWire } from "./installation-authority.ts";
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
      if (!registry.isDurable) {
        return json(res, 503, { error: "The installation registry could not be saved — nothing was registered." });
      }
      // Same public shape as the list view, so clients parse one wire form.
      const { id, label, platform, capabilities, createdAt, lastSeenAt, revokedAt } = outcome.record;
      const response: RegistrationResponse = {
        installation: { id, label, platform, capabilities, createdAt, lastSeenAt, revokedAt },
        reactivated: outcome.reactivated,
      };
      if (outcome.credential !== undefined) response.credential = outcome.credential;
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
      if (!registry.isDurable) {
        return json(res, 503, { error: "The installation registry could not be saved — the old credential still works." });
      }
      if (!outcome) return json(res, 404, { error: "No such installation under this account." });
      return json(res, 200, { credential: outcome.credential! });
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
