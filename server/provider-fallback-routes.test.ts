import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createServer, type Server } from "node:http";
import { z } from "zod";
import type { JsonValue } from "./schema.ts";
import { handleProviderFallbackRoute, type ProviderFallbackRouteContext } from "./provider-fallback-routes.ts";
import { getProviderFallbackConsent } from "./provider-fallback-consent.ts";
let db: DatabaseSync;
let server: Server;
let origin: string;
let ctx: ProviderFallbackRouteContext;
beforeEach(async () => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE user (id TEXT PRIMARY KEY); INSERT INTO user VALUES ('alice'), ('bob')");
  ctx = { db: () => db, origin: "", session: async () => ({ userId: "alice", sessionId: "session-a" }) };
  server = createServer((req, res) => { void handleProviderFallbackRoute(req, res, req.method!, new URL(req.url!, origin).pathname, ctx)
    .then(handled => { if (!handled) { res.writeHead(404); res.end(); } })
    .catch(() => { res.writeHead(500); res.end(); }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${z.object({ port: z.number() }).parse(server.address()).port}`;
  ctx.origin = origin;
});
afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); db.close(); });
const patch = (body: JsonValue, requestOrigin: string | null = origin) => {
  const headers = new Headers({ "content-type": "application/json" });
  if (requestOrigin !== null) headers.set("origin", requestOrigin);
  return fetch(`${origin}/api/provider-fallback`, { method: "PATCH", headers, body: JSON.stringify(body) });
};
it("returns default off and explicit choices without credentials", async () => {
  const result = await fetch(`${origin}/api/provider-fallback`);
  expect(result.headers.get("cache-control")).toBe("no-store");
  expect(await result.json()).toEqual({ enabled: false, generation: 0, requiresSignIn: false });
  expect(await (await patch({ enabled: true })).json()).toEqual({ enabled: true, generation: 1, requiresSignIn: false });
  expect(await (await patch({ enabled: false })).json()).toEqual({ enabled: false, generation: 2, requiresSignIn: false });
});
it("advertises sign-in without triggering GET 401 on paired local clients", async () => {
  ctx.session = async () => null;
  const response = await fetch(`${origin}/api/provider-fallback`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ enabled: false, generation: 0, requiresSignIn: true });
  expect((await patch({ enabled: true })).status).toBe(401);
});
it.each([null, "https://foreign.example", "null"])("rejects mutation origin %s", async foreignOrigin => {
  expect((await patch({ enabled: true }, foreignOrigin)).status).toBe(403);
  expect(getProviderFallbackConsent(db, "alice").enabled).toBe(false);
});
it.each<JsonValue>([{}, { enabled: "true" }, { enabled: 1 }, { enabled: null }, { enabled: true, userId: "bob" }, []])("rejects non-strict choice %j", async body => {
  expect((await patch(body)).status).toBe(400);
  expect(getProviderFallbackConsent(db, "alice").generation).toBe(0);
});
it.each([null, { userId: "bob", sessionId: "session-b" }, { userId: "alice", sessionId: "new-session" }])("rejects changed session after body read %j", async changed => {
  ctx.session = vi.fn().mockResolvedValueOnce({ userId: "alice", sessionId: "session-a" }).mockResolvedValue(changed);
  expect((await patch({ enabled: true })).status).toBe(409);
  expect(getProviderFallbackConsent(db, "alice").enabled).toBe(false);
  expect(getProviderFallbackConsent(db, "bob").enabled).toBe(false);
});
it("does not grant another account fallback", async () => {
  await patch({ enabled: true });
  ctx.session = async () => ({ userId: "bob", sessionId: "session-b" });
  expect(await (await fetch(`${origin}/api/provider-fallback`)).json()).toEqual({ enabled: false, generation: 0, requiresSignIn: false });
});
it("rejects unsupported methods and leaves unrelated paths alone", async () => {
  expect((await fetch(`${origin}/api/provider-fallback`, { method: "POST" })).status).toBe(405);
  expect((await fetch(`${origin}/api/other`)).status).toBe(404);
});
