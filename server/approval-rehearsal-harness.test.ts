// Actual HTTP -> ACP -> runtime journal -> approval-card evidence. Tool events
// come from an owned deterministic engine, never injected journal records.
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startPairingHarness, type PairingHarness } from "../e2e/pairing-harness.ts";
import type { RuntimeEvent } from "./contracts.ts";
import type { BotRecord, Message } from "./store.ts";
import type { InspectorPage } from "./thread-events.ts";
import { removeTempDir } from "./testing/cleanup.ts";

type FixtureBot = Pick<BotRecord, "id" | "threadId" | "busy"> & { messages: Message[] };
type PendingTurn = { bot: FixtureBot; card: Message; turnId: string };
interface FixtureBody {
  email?: string;
  password?: string;
  code?: string;
  text?: string;
  requestId?: string;
  behavior?: "allow" | "deny";
}

describe.skipIf(process.platform === "win32")("approval rehearsal from owned runtime history", () => {
  let harness: PairingHarness;
  let staticDirectory: string;
  let desktopCookie: string;

  const request = (base: string, path: string, body?: FixtureBody, cookie?: string) => {
    const headers = new Headers({ origin: base });
    if (body) headers.set("content-type", "application/json");
    if (cookie) headers.set("cookie", cookie);
    return fetch(`${base}${path}`, {
      method: body ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(10_000), headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  };
  const responseBody = async <T>(response: Response, status = 200): Promise<T> => {
    expect(response.status).toBe(status);
    // SAFETY: callers name the owned endpoint's wire contract and assert the
    // fields relevant to evidence, decisions and persistence below.
    return await response.json() as T;
  };
  const cookie = (response: Response) => {
    const session = response.headers.getSetCookie().find((value) => value.startsWith("better-auth.session_token="));
    expect(session).toBeDefined();
    return session!.split(";")[0]!;
  };
  const desktop = (path: string, body?: FixtureBody) => request(harness.desktopUrl, path, body, desktopCookie);
  const bots = async () => (await responseBody<{ bots: FixtureBot[] }>(await desktop("/api/bots"))).bots;
  const state = async (bot: FixtureBot) => {
    const found = (await bots()).find((candidate) => candidate.id === bot.id);
    expect(found).toBeDefined();
    expect(found!.threadId).toBe(bot.threadId);
    return found!;
  };
  const events = async (bot: FixtureBot): Promise<RuntimeEvent[]> => {
    const page = await responseBody<InspectorPage>(await desktop(`/api/threads/${bot.threadId}/events?limit=2000`));
    return page.entries.flatMap((entry) => entry.kind === "runtime" ? [entry.data] : []);
  };
  const turnEvents = async (turn: PendingTurn) => (await events(turn.bot)).filter((event) => event.turnId === turn.turnId);
  const pending = async (bot: FixtureBot): Promise<PendingTurn> => {
    const text = `Rehearsal fixture ${randomBytes(12).toString("hex")}`;
    const sent = await responseBody<{ message: Message }>(await desktop(`/api/bots/${bot.id}/messages`, { text }), 202);
    expect(sent.message).toMatchObject({ role: "user", kind: "text", text });
    await expect.poll(async () => (await state(bot)).messages.some((message) => message.card?.requestId && !message.card.answered), { timeout: 15_000 }).toBe(true);
    const waiting = await state(bot);
    expect(waiting.busy).toBe(true);
    const card = waiting.messages.find((message) => message.card?.requestId && !message.card.answered)!;
    expect(card.card?.rehearsal?.plannedSteps).toBe(2);
    const journal = await events(bot);
    const opened = journal.findLast((event) => event.type === "request.opened" && event.requestId === card.card?.requestId);
    expect(opened?.turnId).toBeTruthy();
    const beforeDecision = journal.filter((event) => event.turnId === opened!.turnId);
    expect(beforeDecision.some((event) => event.type === "content.delta" && event.streamKind === "assistant_text"
      && event.delta.endsWith("PLAN TOOLS:\n- browser_open\n- screenshot"))).toBe(true);
    expect(beforeDecision.filter((event) => event.type === "item.started" && event.itemType === "tool")).toHaveLength(0);
    expect(beforeDecision.some((event) => event.type === "turn.completed")).toBe(false);
    return { bot, card, turnId: opened!.turnId! };
  };
  const answer = async (turn: PendingTurn, behavior: "allow" | "deny") => {
    expect(await responseBody(await desktop(`/api/threads/${turn.bot.threadId}/respond`, {
      requestId: turn.card.card!.requestId, behavior,
    }))).toEqual({ ok: true, outcome: behavior === "allow" ? "allowed-once" : "rejected" });
    await expect.poll(async () => (await state(turn.bot)).busy, { timeout: 15_000 }).toBe(false);
    const journal = await turnEvents(turn);
    expect(journal.findLast((event) => event.type === "turn.completed")).toMatchObject({ ok: true });
    const reply = journal.findLast((event) => event.type === "item.completed" && event.itemType === "assistant_text");
    expect(reply).toMatchObject({ text: expect.stringContaining(behavior === "allow" ? "hello from fake acp" : "permission denied by fake acp") });
    expect(reply).not.toMatchObject({ text: expect.stringContaining(behavior === "allow" ? "permission denied by fake acp" : "hello from fake acp") });
    expect(JSON.parse(readFileSync(harness.permissionOutcomePath!, "utf8"))).toEqual({
      outcome: "selected", optionId: behavior === "allow" ? "allow-once" : "reject",
    });
    return journal;
  };
  const persistedCard = (turn: PendingTurn) => {
    const db = new DatabaseSync(join(harness.rootDirectory, "desktop", "data", "messages.db"), { readOnly: true });
    try {
      const row = db.prepare("SELECT json_extract(json, '$.card') AS card FROM messages WHERE thread_id = ? AND id = ?").get(turn.bot.threadId, turn.card.id);
      expect(row).toBeDefined();
      return JSON.parse(String(row!.card));
    } finally { db.close(); }
  };

  beforeEach(async () => {
    staticDirectory = mkdtempSync(join(tmpdir(), "muster-rehearsal-test-ui-"));
    writeFileSync(join(staticDirectory, "index.html"), "<!doctype html><title>Rehearsal fixture</title>");
    harness = await startPairingHarness({ staticDir: staticDirectory, engineMode: "rehearsal-gated" });
    const signIn = await request(harness.cloudUrl, "/api/auth/sign-in/email", { email: harness.email, password: harness.password });
    await responseBody(signIn);
    const pair = await responseBody<{ code: string }>(await request(harness.cloudUrl, "/api/pair/create", {}, cookie(signIn)), 201);
    const redeemed = await request(harness.desktopUrl, "/api/pair/redeem", { code: pair.code });
    expect(await responseBody(redeemed)).toMatchObject({ ok: true, email: harness.email });
    desktopCookie = cookie(redeemed);
  }, 45_000);

  afterEach(async () => {
    await harness?.stop();
    if (staticDirectory) await removeTempDir(staticDirectory);
  });

  it("rehearses the next card from two actual ordered tool successes and persists its snapshot after decision", async () => {
    const [bot] = await bots();
    expect(bot).toBeDefined();
    const first = await pending(bot!);
    expect(first.card.card?.rehearsal).toMatchObject({ plannedSteps: 2, matchedSteps: 0, matchedRuns: 0, reviewedRuns: 0 });
    expect(first.card.card?.why).toBeUndefined();
    const completed = await answer(first, "allow");
    expect(completed.filter((event) => (event.type === "item.started" || event.type === "item.completed") && event.itemType === "tool")).toMatchObject([
      { type: "item.started", itemId: "rehearsal-browser_open", title: "browser_open" },
      { type: "item.completed", itemId: "rehearsal-browser_open", ok: true },
      { type: "item.started", itemId: "rehearsal-screenshot", title: "screenshot" },
      { type: "item.completed", itemId: "rehearsal-screenshot", ok: true },
    ]);
    const second = await pending(bot!);
    expect(second.turnId).not.toBe(first.turnId);
    expect(second.card.card?.rehearsal).toMatchObject({ plannedSteps: 2, matchedSteps: 2, matchedRuns: 1, reviewedRuns: 1 });
    expect(second.card.card?.rehearsal?.summary).toContain("arguments and screen states were not checked");
    expect(second.card.card?.why).toMatchObject({
      source: "previous-run", runId: expect.any(String), botId: bot!.id, threadId: bot!.threadId,
      at: expect.any(Number), outcome: "done",
      intent: "Exercise an owned approval rehearsal fixture.",
      decisions: ["Wait for Allow once before emitting simulated tool successes.", "Record browser_open then screenshot in the fixture journal."],
      hypothesis: "Two ordered successful fixture tools will match the next stated plan.",
      findings: "The fixture emitted browser_open and screenshot in order; no real browser action was performed.",
    });
    await answer(second, "deny");
    const expected = { answered: "deny", rehearsal: second.card.card!.rehearsal, why: second.card.card!.why };
    expect((await state(bot!)).messages.find((message) => message.id === second.card.id)?.card).toMatchObject(expected);
    expect(persistedCard(second)).toMatchObject(expected);
    expect(persistedCard(first)).toMatchObject({ answered: "allow", rehearsal: first.card.card!.rehearsal });
  });

  it("never turns a denied plan into matching tool evidence on the next approval", async () => {
    const [bot] = await bots();
    expect(bot).toBeDefined();
    const denied = await pending(bot!);
    const journal = await answer(denied, "deny");
    expect(journal.filter((event) => (event.type === "item.started" || event.type === "item.completed") && event.itemType === "tool")).toHaveLength(0);
    const next = await pending(bot!);
    // A completed denied turn is reviewed, but supplies zero matching tools.
    expect(next.card.card?.rehearsal).toMatchObject({ plannedSteps: 2, matchedSteps: 0, matchedRuns: 0, reviewedRuns: 1 });
    expect(next.card.card?.why).toBeUndefined();
    await answer(next, "deny");
    expect(persistedCard(next)).toMatchObject({ answered: "deny", rehearsal: next.card.card!.rehearsal });
  });
});
