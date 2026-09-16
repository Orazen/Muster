// Real companion transport against a controlled upstream. Server recording and
// ownership semantics are verified separately against the actual server/SQLite.
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createProxyHandler } from "../src/proxy.ts";

const TOKEN = "owned-seed-answer-test";
const basePath = "/api/bots/bot_123/cards/card_456/answer";
const cardMessage = {
  id: "card_456", role: "bot", kind: "options",
  card: { purpose: "onboarding-v1", answered: "  Plan my day  ", seedAnswer: {
    messageId: "user_789", attempt: 1, status: "not-started", error: "Fixture engine unavailable",
  } },
};
const userMessage = { id: "user_789", role: "user", kind: "text", text: "  Plan my day  " };
interface SeedReply {
  ok: true;
  outcome?: string;
  cardMessage: typeof cardMessage;
  userMessage: typeof userMessage;
}
interface UpstreamSeedReply extends SeedReply {
  resumeCursors: { private: string };
}
const requests: Array<{ method: string; path: string; body: string; authorization?: string }> = [];
let upstream: Server;
let proxy: Server;
let url: string;

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = z.object({ port: z.number().int().positive() }).safeParse(server.address());
      if (!address.success) return reject(new Error("No owned listener address"));
      resolve(address.data.port);
    });
  });
}

beforeAll(async () => {
  upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({ method: req.method ?? "", path: req.url ?? "", body: Buffer.concat(chunks).toString(), authorization: req.headers.authorization });
      const response: UpstreamSeedReply = {
        ok: true,
        cardMessage, userMessage, resumeCursors: { private: "never-forward" },
      };
      if (req.method !== "GET") response.outcome = req.url?.endsWith("/start") ? "starting" : "recorded";
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(response));
    });
  });
  const harnessPort = await listen(upstream);
  proxy = createServer(createProxyHandler({
    harnessPort,
    authenticate: (token) => token === TOKEN ? { access: "full" as const, cloudDesktopAccess: false } : null,
    redeem: () => ({ error: "not used" }),
    serverName: () => "Owned seed fixture",
  }));
  url = `http://127.0.0.1:${await listen(proxy)}`;
});

afterAll(async () => {
  await Promise.all([proxy, upstream].filter(Boolean).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

describe("seed answer companion transport", () => {
  it.each([
    { method: "POST", path: basePath, body: { threadId: "thread_123", answer: "  Plan my day  " }, outcome: "recorded" },
    { method: "GET", path: `${basePath}?threadId=thread_123`, body: undefined, outcome: undefined },
    { method: "POST", path: `${basePath}/start`, body: { threadId: "thread_123", expectedAttempt: 1 }, outcome: "starting" },
  ])("forwards exact $method $path and retains durable answer metadata", async ({ method, path, body, outcome }) => {
    const before = requests.length;
    const init: RequestInit = {
      method, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      signal: AbortSignal.timeout(5_000),
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await fetch(url + path, init);
    expect(response.status).toBe(200);
    const json: unknown = await response.json();
    const expected: SeedReply = { ok: true, cardMessage, userMessage };
    if (outcome) expected.outcome = outcome;
    expect(json).toEqual(expected);
    expect(requests.slice(before)).toEqual([{ method, path, body: body === undefined ? "" : JSON.stringify(body), authorization: undefined }]);
  });

  it("rejects unpaired seed requests before any upstream read or write", async () => {
    const before = requests.length;
    for (const [method, path] of [["GET", `${basePath}?threadId=thread_123`], ["POST", basePath], ["POST", `${basePath}/start`]]) {
      const response = await fetch(url + path, { method, body: method === "POST" ? "{}" : undefined, signal: AbortSignal.timeout(5_000) });
      expect(response.status).toBe(401);
      await response.arrayBuffer();
    }
    expect(requests.length).toBe(before);
  });

  it("keeps generic PATCH and encoded or extended seed paths out of the upstream", async () => {
    const before = requests.length;
    for (const [method, path] of [
      ["PATCH", "/api/bots/bot_123/cards/card_456"],
      ["GET", `${basePath}/start`],
      ["POST", `${basePath}/start/again`],
      ["POST", "/api/bots/bot_123/cards/card%2Fother/answer"],
    ]) {
      const response = await fetch(url + path, { method, headers: { authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(5_000) });
      expect(response.status).toBe(404);
      await response.arrayBuffer();
    }
    expect(requests.length).toBe(before);
  });
});
