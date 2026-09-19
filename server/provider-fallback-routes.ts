import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { json, readBody } from "./http-helpers.ts";
import { getProviderFallbackConsent, setProviderFallbackConsent } from "./provider-fallback-consent.ts";

export interface ProviderFallbackRouteContext {
  db(): DatabaseSync;
  session(): Promise<{ userId: string; sessionId: string } | null>;
  origin: string;
}

export async function handleProviderFallbackRoute(req: IncomingMessage, res: ServerResponse, method: string, path: string, ctx: ProviderFallbackRouteContext): Promise<boolean> {
  if (path !== "/api/provider-fallback") return false;
  res.setHeader("Cache-Control", "no-store");
  const session = await ctx.session();
  if (method === "GET") {
    json(res, 200, session
      ? { ...getProviderFallbackConsent(ctx.db(), session.userId), requiresSignIn: false }
      : { enabled: false, generation: 0, requiresSignIn: true });
    return true;
  }
  if (!session) { json(res, 401, { error: "Sign in to change provider fallback." }); return true; }
  if (method !== "PATCH") { json(res, 405, { error: "Method not allowed." }); return true; }
  if (req.headers.origin !== ctx.origin) { json(res, 403, { error: "Open provider settings in Muster to try again." }); return true; }
  let enabled: boolean;
  try { enabled = z.object({ enabled: z.boolean() }).strict().parse(await readBody(req)).enabled; }
  catch { json(res, 400, { error: "Choose whether to allow provider fallback." }); return true; }
  // Reading a streaming body is an async boundary; the original session must still own this write.
  const current = await ctx.session();
  if (current?.userId !== session.userId || current.sessionId !== session.sessionId) {
    json(res, 409, { error: "Your session changed. Reload provider settings and try again." }); return true;
  }
  json(res, 200, { ...setProviderFallbackConsent(ctx.db(), session.userId, enabled), requiresSignIn: false });
  return true;
}
