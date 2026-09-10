// Local HTTP integration coverage of the real approval routes and ACP adapter.
// The engine is deterministic and offline; these are not browser or model tests.
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startPairingHarness, type PairingHarness } from "../e2e/pairing-harness.ts";
import type { AuditPageResponse } from "./decision-log.ts";
import type { BotRecord, Message } from "./store.ts";
import { removeTempDir } from "./testing/cleanup.ts";

type FixtureBot = Pick<BotRecord, "id" | "threadId" | "busy" | "activity"> & { messages: Message[] };
type PendingTurn = { bot: FixtureBot; card: Message; text: string };
interface FixtureRequestBody {
  email?: string;
  password?: string;
  code?: string;
  text?: string;
  requestId?: string;
  behavior?: "allow" | "deny";
}

describe.skipIf(process.platform === "win32")("owned permission approval fixture", () => {
  let harness: PairingHarness;
  let staticDirectory: string;
  let desktopCookie: string;

  const request = (base: string, path: string, body?: FixtureRequestBody, cookie?: string) => {
    const headers = new Headers({ origin: base });
    if (body) headers.set("content-type", "application/json");
    if (cookie) headers.set("cookie", cookie);
    return fetch(`${base}${path}`, {
      method: body ? "POST" : "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  };
  const responseBody = async <T>(response: Response, status = 200): Promise<T> => {
    expect(response.status).toBe(status);
    // SAFETY: each call targets an owned real server endpoint and supplies its
    // wire type; the behavior assertions below verify the relevant fields.
    return await response.json() as T;
  };
  const sessionCookie = (response: Response): string => {
    const cookie = response.headers.getSetCookie().find((value) => value.startsWith("better-auth.session_token="));
    expect(cookie).toBeDefined();
    return cookie!.split(";")[0]!;
  };
  const desktop = (path: string, body?: FixtureRequestBody) => request(harness.desktopUrl, path, body, desktopCookie);
  const bots = async () => (await responseBody<{ bots: FixtureBot[] }>(await desktop("/api/bots"))).bots;
  const botState = async (bot: FixtureBot) => {
    const found = (await bots()).find((candidate) => candidate.id === bot.id);
    expect(found).toBeDefined();
    expect(found!.threadId).toBe(bot.threadId);
    return found!;
  };
  const createBot = async () => (await responseBody<{ bot: FixtureBot }>(await desktop("/api/bots", {}), 201)).bot;
  const textReplies = (bot: FixtureBot) => bot.messages.filter((message) => message.role === "bot" && message.kind === "text").map((message) => message.text);
  const audit = async (bot: FixtureBot) => responseBody<AuditPageResponse>(await desktop(`/api/bots/${bot.id}/audit?limit=20`));

  const pendingTurn = async (bot: FixtureBot): Promise<PendingTurn> => {
    const text = `approval fixture ${randomBytes(12).toString("hex")}`;
    const sent = await responseBody<{ message: Message }>(await desktop(`/api/bots/${bot.id}/messages`, { text }), 202);
    expect(sent.message).toMatchObject({ role: "user", kind: "text", text });
    await expect.poll(async () => {
      const state = await botState(bot);
      return state.messages.some((message) => message.kind === "options" && message.card?.requestId && !message.card.answered);
    }, { timeout: 15_000 }).toBe(true);
    const waiting = await botState(bot);
    const card = waiting.messages.find((message) => message.kind === "options" && message.card?.requestId && !message.card.answered)!;
    expect(waiting).toMatchObject({ id: bot.id, threadId: bot.threadId, busy: true, activity: "waiting-on-you" });
    expect(waiting.messages.filter((message) => message.text === text)).toHaveLength(1);
    expect(card.card).toMatchObject({ title: "Approval needed", subtitle: expect.stringContaining("echo hi"), requestId: expect.any(String) });
    expect(textReplies(waiting)).not.toContain("hello from fake acp");
    expect(textReplies(waiting)).not.toContain("permission denied by fake acp");
    expect((await audit(bot)).entries).toHaveLength(0);
    return { bot, card, text };
  };

  const answer = async (turn: PendingTurn, behavior: "allow" | "deny") => {
    // Match the composer's thread-targeted route rather than answering whichever
    // bot happens to be selected in the roster.
    const response = await desktop(`/api/threads/${turn.bot.threadId}/respond`, {
      requestId: turn.card.card!.requestId,
      behavior,
    });
    expect(await responseBody(response)).toEqual({ ok: true, outcome: behavior === "allow" ? "allowed-once" : "rejected" });
  };

  const settledTurn = async (turn: PendingTurn, behavior: "allow" | "deny") => {
    const reply = behavior === "allow" ? "hello from fake acp" : "permission denied by fake acp";
    await expect.poll(async () => {
      const state = await botState(turn.bot);
      return !state.busy && textReplies(state).includes(reply);
    }, { timeout: 15_000 }).toBe(true);
    const settled = await botState(turn.bot);
    expect(settled.messages.find((message) => message.id === turn.card.id)?.card).toMatchObject({
      requestId: turn.card.card!.requestId,
      answered: behavior,
      dismissed: false,
    });
    expect(settled.messages.some((message) => message.card?.requestId && !message.card.answered)).toBe(false);
    expect(settled.messages.filter((message) => message.text === turn.text)).toHaveLength(1);
    expect(textReplies(settled)).toContain(reply);
    expect(textReplies(settled)).not.toContain(behavior === "allow" ? "permission denied by fake acp" : "hello from fake acp");
    const ledger = await audit(turn.bot);
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]).toMatchObject({
      action: turn.card.card!.tool,
      decision: behavior === "allow" ? "approved" : "denied",
      summary: turn.card.card!.subtitle,
    });
    expect(harness.permissionOutcomePath).toBeDefined();
    // This file is written by the isolated fake engine after it receives the
    // actual ACP response, so a UI-only card update cannot satisfy the test.
    expect(JSON.parse(readFileSync(harness.permissionOutcomePath!, "utf8"))).toEqual({
      outcome: "selected", optionId: behavior === "allow" ? "allow-once" : "reject",
    });
  };

  beforeEach(async () => {
    staticDirectory = mkdtempSync(join(tmpdir(), "muster-approval-test-ui-"));
    writeFileSync(join(staticDirectory, "index.html"), "<!doctype html><title>Approval fixture</title>");
    harness = await startPairingHarness({ staticDir: staticDirectory, engineMode: "permission-gated" });
    const signIn = await request(harness.cloudUrl, "/api/auth/sign-in/email", { email: harness.email, password: harness.password });
    await responseBody(signIn);
    const cloudCookie = sessionCookie(signIn);
    const pairing = await responseBody<{ code: string; expiresAt: number }>(await request(harness.cloudUrl, "/api/pair/create", {}, cloudCookie), 201);
    expect(pairing.code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
    expect(pairing.expiresAt).toBeGreaterThan(Date.now());
    const redeem = await request(harness.desktopUrl, "/api/pair/redeem", { code: pairing.code });
    expect(await responseBody(redeem)).toMatchObject({ ok: true, email: harness.email });
    desktopCookie = sessionCookie(redeem);
    expect(await responseBody(await desktop("/api/auth/get-session"))).toMatchObject({ user: { email: harness.email } });
  }, 45_000);

  afterEach(async () => {
    await harness?.stop();
    if (staticDirectory) await removeTempDir(staticDirectory);
  });

  it("holds the exact task until Allow once reaches the engine, then records its approval", async () => {
    const turn = await pendingTurn(await createBot());
    expect(existsSync(harness.permissionOutcomePath!)).toBe(false);
    await answer(turn, "allow");
    await settledTurn(turn, "allow");
  });

  it("delivers Deny to the engine and settles without the successful reply", async () => {
    const turn = await pendingTurn(await createBot());
    expect(existsSync(harness.permissionOutcomePath!)).toBe(false);
    await answer(turn, "deny");
    await settledTurn(turn, "deny");
  });

  it("settles only the selected thread when two bots request permission", async () => {
    const [seeded] = await bots();
    expect(seeded).toBeDefined();
    const created = await createBot();
    const first = await pendingTurn(seeded!);
    const second = await pendingTurn(created);
    expect(first.bot.threadId).not.toBe(second.bot.threadId);
    await answer(first, "allow");
    await settledTurn(first, "allow");
    const stillWaiting = await botState(second.bot);
    expect(stillWaiting).toMatchObject({ busy: true, activity: "waiting-on-you" });
    expect(stillWaiting.messages.find((message) => message.id === second.card.id)?.card?.answered).toBeUndefined();
    expect(textReplies(stillWaiting)).not.toContain("hello from fake acp");
    expect((await audit(second.bot)).entries).toHaveLength(0);
    await answer(second, "deny");
    await settledTurn(second, "deny");
  });
});
