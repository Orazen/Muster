import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { ForegroundCallRegistry } from "./foreground-call.ts";
import { handleForegroundCallRoute, type ForegroundCallRouteContext } from "./foreground-call-routes.ts";
import type { JsonValue } from "./schema.ts";
let server: Server;
let origin: string;
let ctx: ForegroundCallRouteContext;
let owner = "alice", threadId = "thread-a", callId: string;
const token = "a".repeat(64);
let dispatch = vi.fn();
const base = "/api/bots/bot-a/calls";
beforeEach(async () => {
  owner = "alice"; threadId = "thread-a"; callId = randomUUID(); dispatch = vi.fn();
  ctx = { registry: new ForegroundCallRegistry({ dispatch }), origin: "", allowOriginless: false,
    authorizeBot: async botId => botId === "bot-a" ? { ownerId: owner, threadId } : null };
  server = createServer((req, res) => { void handleForegroundCallRoute(req, res, req.method ?? "GET", new URL(req.url!, origin).pathname, ctx)
    .then(handled => { if (!handled) { res.writeHead(404); res.end(); } })
    .catch(() => { res.writeHead(500); res.end(); }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${z.object({ port: z.number() }).parse(server.address()).port}`; ctx.origin = origin;
});
afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
async function request(path = base, method = "POST", body: JsonValue = {}, capability = token, requestOrigin: string | null = origin) {
  const headers = new Headers({ "content-type": "application/json", "x-muster-call-token": capability });
  if (requestOrigin !== null) headers.set("origin", requestOrigin);
  const options: RequestInit = { method, headers };
  if (method !== "GET") options.body = JSON.stringify(body);
  return fetch(origin + path, options);
}
async function ring() { return request(base, "POST", { requestId: callId, threadId }); }
it("rings and accepts without dispatch, then returns one receipt for duplicate messages", async () => {
  const response = await ring();
  expect(response.status).toBe(201); expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toMatchObject({ call: { id: callId, botId: "bot-a", threadId, state: "ringing" } });
  expect((await ring()).status).toBe(201);
  expect((await request(`${base}/${callId}/accept`)).status).toBe(200);
  expect((await request(`${base}/${callId}/accept`)).status).toBe(200);
  expect(dispatch).not.toHaveBeenCalled();
  const message = { requestId: randomUUID(), text: "  Plan my day  " };
  const first = await request(`${base}/${callId}/messages`, "POST", message);
  expect(first.status).toBe(202);
  const firstCall = z.object({ call: z.object({ turn: z.object({ requestId: z.string() }) }) }).parse(await first.json());
  const duplicate = await request(`${base}/${callId}/messages`, "POST", message);
  expect(duplicate.status).toBe(202);
  expect(await duplicate.json()).toMatchObject(firstCall);
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(dispatch.mock.calls[0][0].text).toBe("Plan my day");
  expect((await request(`${base}/${callId}/messages`, "POST", { ...message, text: "Different" })).status).toBe(409);
});
it("does not start messages before accept", async () => {
  await ring();
  expect((await request(`${base}/${callId}/messages`, "POST", { requestId: randomUUID(), text: "Hello" })).status).toBe(409);
  expect(dispatch).not.toHaveBeenCalled();
});
it("isolates call ownership and capability without returning secrets", async () => {
  await ring();
  for (const method of ["GET", "POST"]) {
    const path = `${base}/${callId}${method === "POST" ? "/end" : ""}`;
    expect((await request(path, method, {}, "b".repeat(64))).status).toBe(404);
  }
  owner = "bob";
  expect((await request(`${base}/${callId}`, "GET")).status).toBe(404);
  owner = "alice";
  const response = await request(`${base}/${callId}`, "GET");
  expect(response.status).toBe(200); expect(await response.text()).not.toContain(token);
});
it.each(["", "A".repeat(64), "a".repeat(63), "a".repeat(65)])("rejects malformed capability %s", async capability => {
  expect((await request(base, "POST", { requestId: callId, threadId }, capability)).status).toBe(400);
  expect(dispatch).not.toHaveBeenCalled();
});
it.each<JsonValue>([{}, { requestId: "not-uuid", threadId: "thread-a" }, { requestId: "00000000-0000-4000-8000-000000000001", threadId: "thread-a", extra: true }])("requires a strict ring body %j", async body => {
  expect((await request(base, "POST", body)).status).toBe(400);
});
it.each<JsonValue>([{}, { requestId: "invalid", text: "Hello" }, { requestId: "00000000-0000-4000-8000-000000000001", text: "  " }, { requestId: "00000000-0000-4000-8000-000000000001", text: "x".repeat(8001) }])("requires a bounded message body", async body => {
  await ring(); await request(`${base}/${callId}/accept`);
  expect((await request(`${base}/${callId}/messages`, "POST", body)).status).toBe(400);
  expect(dispatch).not.toHaveBeenCalled();
});
it("requires same origin except explicit installation loopback trust", async () => {
  const body = { requestId: callId, threadId };
  expect((await request(base, "POST", body, token, null)).status).toBe(403);
  ctx.allowOriginless = true;
  expect((await request(base, "POST", body, token, "https://foreign.test")).status).toBe(403);
  expect((await request(base, "POST", body, token, null)).status).toBe(201);
});
it("rejects account change across body reading", async () => {
  ctx.authorizeBot = vi.fn().mockResolvedValueOnce({ ownerId: "alice", threadId }).mockResolvedValue({ ownerId: "bob", threadId });
  expect((await ring()).status).toBe(404); expect(dispatch).not.toHaveBeenCalled();
});
it("blocks changed threads for accept/messages but permits status and end cleanup", async () => {
  await ring(); threadId = "thread-b";
  expect((await request(`${base}/${callId}/accept`)).status).toBe(409);
  expect((await request(`${base}/${callId}/messages`, "POST", { requestId: randomUUID(), text: "Hello" })).status).toBe(409);
  expect((await request(`${base}/${callId}`, "GET")).status).toBe(200);
  for (let i = 0; i < 2; i++) expect(await (await request(`${base}/${callId}/end`)).json()).toMatchObject({ call: { state: "ended" } });
  expect(dispatch).not.toHaveBeenCalled();
});
it("rejects changed thread during ring body read", async () => {
  ctx.authorizeBot = vi.fn().mockResolvedValueOnce({ ownerId: "alice", threadId }).mockResolvedValue({ ownerId: "alice", threadId: "new-thread" });
  expect((await ring()).status).toBe(409);
});
it("returns safe errors for unexpected dependencies and unknown bot ownership", async () => {
  ctx.authorizeBot = async () => { throw new Error("private-provider-token"); };
  const failed = await ring(); expect(failed.status).toBe(500); expect(await failed.text()).not.toContain("private-provider-token");
  ctx.authorizeBot = async () => null;
  expect((await ring()).status).toBe(404);
});
it("denies unlisted methods, extended paths and nonempty accept/end bodies", async () => {
  await ring();
  expect((await request(base, "GET")).status).toBe(405);
  expect((await request(`${base}/${callId}/accept`, "GET")).status).toBe(405);
  expect((await request(`${base}/${callId}/end/again`)).status).toBe(404);
  expect((await request(`${base}/not-uuid`, "GET")).status).toBe(404);
  expect((await request(`${base}/${callId}/accept`, "POST", { text: "unexpected" })).status).toBe(400);
  expect((await request(`${base}/${callId}/end`, "POST", { requestId: randomUUID() })).status).toBe(400);
});

const planningDetails = { date: "2040-01-02", timeZone: "UTC", workStart: "09:00", workEnd: "17:00", commitments: [{ title: "Report", minutes: 30 }] };
async function prepareCalendar(body: JsonValue = planningDetails, calendarToken = "c".repeat(64), callToken = token) {
  return fetch(`${origin}${base}/${callId}/prepare-calendar`, { method: "POST", headers: {
    origin, "content-type": "application/json", "x-muster-call-token": callToken, "x-muster-calendar-token": calendarToken,
  }, body: JSON.stringify(body) });
}
async function connectedCall() { await ring(); await request(`${base}/${callId}/accept`); }
it("prepares a calendar draft without dispatch or lease renewal", async () => {
  await connectedCall();
  const before = ctx.registry.peek({ ownerId: owner, botId: "bot-a", token }, callId);
  ctx.prepareCalendar = vi.fn(async (input, guard) => {
    await guard(); expect(input).toEqual({ ...planningDetails, capability: "c".repeat(64) });
    return { draft: "A reviewed proposal", date: input.date, timeZone: input.timeZone, calendarId: "selected" };
  });
  const response = await prepareCalendar(); expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ draft: "A reviewed proposal", date: "2040-01-02", timeZone: "UTC", calendarId: "selected" });
  expect(ctx.registry.peek({ ownerId: owner, botId: "bot-a", token }, callId)).toEqual(before);
  expect(dispatch).not.toHaveBeenCalled();
});
it("requires both capabilities and rejects body-supplied authority", async () => {
  await connectedCall(); ctx.prepareCalendar = vi.fn();
  expect((await prepareCalendar(planningDetails, "")).status).toBe(400);
  expect((await prepareCalendar(planningDetails, "c".repeat(64), "b".repeat(64))).status).toBe(404);
  expect((await prepareCalendar({ ...planningDetails, capability: "d".repeat(64) })).status).toBe(400);
  expect((await prepareCalendar({ ...planningDetails, calendarId: "foreign" })).status).toBe(400);
  expect(ctx.prepareCalendar).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled();
});
it("requires an accepted idle call before reading any calendar", async () => {
  await ring(); ctx.prepareCalendar = vi.fn();
  expect((await prepareCalendar()).status).toBe(409);
  await request(`${base}/${callId}/accept`);
  await request(`${base}/${callId}/messages`, "POST", { requestId: randomUUID(), text: "Work" });
  expect((await prepareCalendar()).status).toBe(409);
  expect(ctx.prepareCalendar).not.toHaveBeenCalled();
});
it.each(["end", "thread", "owner", "new-message"])("discards prepared calendar data after %s changes during retrieval", async change => {
  await connectedCall();
  ctx.prepareCalendar = vi.fn(async (input) => {
    if (change === "end") await ctx.registry.end({ ownerId: owner, botId: "bot-a", token }, callId);
    if (change === "thread") threadId = "replacement";
    if (change === "owner") owner = "bob";
    if (change === "new-message") ctx.registry.message({ ownerId: owner, botId: "bot-a", token }, callId, { requestId: randomUUID(), text: "New work" });
    return { draft: "private-calendar-evidence", date: input.date, timeZone: input.timeZone, calendarId: "selected" };
  });
  const response = await prepareCalendar(); expect(response.status).toBe(409);
  expect(await response.text()).not.toContain("private-calendar-evidence");
});
it("reports unsupported hosts before calendar retrieval", async () => {
  await connectedCall(); expect((await prepareCalendar()).status).toBe(503);
  expect(dispatch).not.toHaveBeenCalled();
});
