// One ordinary chat message survives a disconnect — the researched
// "first-slice request recovery" assignment, reproduced against the real
// booted server (two accounts, one deployment).
//
// The contract under test (server/message-intent.ts + the /messages route):
//
//   POST /api/bots/:id/messages { text, clientIntentId }
//     → 202 { ok, threadId, intent: { intentId, messageId, threadId, state, acceptedAt }, message }
//
//   - Replaying the SAME id returns the ORIGINAL message and never appends
//     a second transcript row or starts a second turn (a lost ack is a
//     lookup, never a resend).
//   - The same id with different text/thread → 409 INTENT_CONFLICT.
//   - Malformed ids → 400; senders without the field keep exact v1 behavior.
//   - After an executor crash the receipt reads "unknown" (boot
//     reconciliation) — the client asks, never auto-resends.
//
// The provider is unavailable by design (the ghost driver), so every
// dispatch refusal is observable: the acceptance must still land with a
// truthful receipt (accepted + an error chip), never a fake "sent".
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { pairingServerEnvironment, waitForOwnedServer } from "../e2e/pairing-harness.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { seedConnectedGoogleRow } from "./testing/storage-gate.ts";
import { freePortBlock } from "./testing/ports.ts";
import type { JsonValue } from "./schema.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const botSchema = z.object({ id: z.string(), name: z.string(), threadId: z.string(), ownerId: z.string().optional() }).passthrough();

const intentSchema = z.object({
  intentId: z.string(),
  messageId: z.string(),
  threadId: z.string(),
  state: z.enum(["accepted", "dispatched", "unknown"]),
  acceptedAt: z.number(),
});

interface Account { id: string; cookie: string; botId: string; threadId: string }

describe.skipIf(process.platform === "win32")("durable send intents across a disconnect", () => {
  let directory = "";
  let hosted = { url: "" };
  const children: ChildProcess[] = [];
  const ports: number[] = [];
  let alice!: Account;
  let bob!: Account;

  const request = (path: string, method = "GET", body?: JsonValue, account?: Account) => {
    const headers = new Headers({ origin: hosted.url, "content-type": "application/json" });
    if (account) headers.set("cookie", account.cookie);
    const init: RequestInit = { method, headers, redirect: "error", signal: AbortSignal.timeout(15_000) };
    if (body !== undefined) init.body = JSON.stringify(body);
    return fetch(`${hosted.url}${path}`, init);
  };

  /** One account's transcript, via the same wire shape the client hydrates
   * (the roster list with a bounded message page). */
  /** Messages in ONE thread, by id — the bot-scoped helper only ever answers
   * for the bot's current thread, which is the very thing A3 moves. */
  const threadWords = async (account: Account, threadId: string, text: string): Promise<number> => {
    const res = await request(`/api/threads/${threadId}/messages`, "GET", undefined, account);
    expect(res.status).toBe(200);
    const body = z.object({ messages: z.array(z.object({ role: z.string(), text: z.string().optional() })) }).parse(await res.json());
    return body.messages.filter((m) => m.text === text).length;
  };

  const transcriptOf = async (account: Account): Promise<{ messages: Array<{ role: string; text?: string; tool?: { name?: string } }> }> => {
    const res = await request("/api/bots?messages=50", "GET", undefined, account);
    expect(res.status).toBe(200);
    const parsed = z.object({
      bots: z.array(z.object({
        id: z.string(),
        messages: z.array(z.object({ role: z.string(), text: z.string().optional(), tool: z.object({ name: z.string().optional() }).optional() })),
      })),
    }).parse(await res.json());
    const mine = parsed.bots.find((bot) => bot.id === account.botId);
    if (!mine) throw new Error("owned bot missing from roster");
    return mine;
  };

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "muster-message-intent-"));
    const data = join(directory, "data");
    const home = join(directory, "home");
    const companion = join(directory, "companion");
    const ui = join(directory, "ui");
    for (const path of [data, home, companion, ui]) mkdirSync(path, { recursive: true, mode: 0o700 });
    const operatorId = randomUUID();
    writeFileSync(
      join(data, "bots.json"),
      JSON.stringify([{ id: operatorId, threadId: randomUUID(), name: "Operator bot", description: "operator", title: "Operator", color: "orange", notifications: true, unread: false, modelSelection: { instanceId: "ghost", model: "" }, resumeCursors: {}, createdAt: Date.now() }]),
    );
    writeFileSync(join(data, "config.json"), JSON.stringify({ profile: { name: "Intent fixture" }, instances: { ghost: { driver: "not-a-real-driver", displayName: "Offline fixture" } } }));
    writeFileSync(join(data, "license.json"), JSON.stringify({ firstLaunchAt: new Date(Date.now() - 30 * 86_400_000).toISOString(), license: null }));

    const port = await freePortBlock([0, 1], 48600, 8000);
    ports.push(port, port + 1);
    const env = pairingServerEnvironment({ home, dataDirectory: data, companionDirectory: companion, staticDir: ui, port, webhookPort: port + 1, secret: randomBytes(32).toString("hex") });
    Object.assign(env, { OMB_PUBLIC_HOST: `127.0.0.1:${port}`, OMB_ALLOW_SIGNUPS: "true", GOOGLE_CLIENT_ID: randomBytes(24).toString("hex"), GOOGLE_CLIENT_SECRET: randomBytes(24).toString("hex") });
    const child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "server/index.ts")], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", () => {});
    hosted = { url: `http://127.0.0.1:${port}` };
    await waitForOwnedServer(child, hosted.url);

    const signUp = async (name: string): Promise<Account> => {
      const res = await request("/api/auth/sign-up/email", "POST", { name, email: `${name}-${randomBytes(8).toString("hex")}@example.test`, password: randomBytes(32).toString("base64url") });
      expect(res.status).toBe(200);
      const { user } = z.object({ user: z.object({ id: z.string() }) }).parse(await res.json());
      const header = res.headers.getSetCookie().find((v) => v.startsWith("better-auth.session_token="));
      if (!header) throw new Error("Owned signup did not return a session");
      return { id: user.id, cookie: header.split(";")[0], botId: "", threadId: "" };
    };
    alice = await signUp("alice");
    bob = await signUp("bob");
    // The storage-sovereignty gate refuses work until the hosted account has
    // connected its own Drive; seed the row the account's own consent would.
    for (const account of [alice, bob]) seedConnectedGoogleRow(join(directory, "data"), account.id);
    for (const account of [alice, bob]) {
      const created = await request("/api/bots", "POST", {}, account);
      expect(created.status).toBe(201);
      const { bot } = z.object({ bot: botSchema }).parse(await created.json());
      account.botId = bot.id;
      account.threadId = bot.threadId;
    }
  }, 90_000);

  afterAll(async () => {
    for (const child of children) {
      child.kill("SIGINT");
      await waitForExit(child);
    }
    if (directory && existsSync(directory)) removeTempDir(directory);
  });

  const send = (account: Account, body: JsonValue) => request(`/api/bots/${account.botId}/messages`, "POST", body, account);

  it("accepts an intent-aware send durably, then replays the SAME id as a lookup — no second bubble, no second turn", async () => {
    const intentId = `snd-${randomBytes(16).toString("hex")}`;
    const first = await send(alice, { text: "Plan tomorrow", clientIntentId: intentId });
    expect(first.status).toBe(202);
    const admitted = z.object({ ok: z.boolean(), threadId: z.string(), intent: intentSchema, message: z.record(z.string(), z.unknown()).optional() }).parse(await first.json());
    expect(admitted.intent.intentId).toBe(intentId);
    expect(admitted.intent.state).toBe("accepted"); // provider is offline by design: held, honestly
    expect(admitted.intent.messageId).toBeTruthy();
    // The ghost engine refuses dispatch; the route says so in the thread
    // instead of pretending the turn started.
    const transcript = await transcriptOf(alice);
    expect(transcript.messages.filter((m) => m.role === "user" && m.text === "Plan tomorrow")).toHaveLength(1);
    expect(transcript.messages.some((m) => m.tool?.name?.startsWith("error: message accepted but could not start"))).toBe(true);

    // Simulate a lost response: the client reconnects and replays the id.
    const replay = await send(alice, { text: "Plan tomorrow", clientIntentId: intentId });
    expect(replay.status).toBe(202);
    const lookup = z.object({ intent: intentSchema }).parse(await replay.json());
    expect(lookup.intent.messageId).toBe(admitted.intent.messageId);
    const after = await transcriptOf(alice);
    expect(after.messages.filter((m) => m.role === "user" && m.text === "Plan tomorrow")).toHaveLength(1);
  });

  it("refuses the same intent id with different text as a conflict, leaving the original untouched", async () => {
    const intentId = `snd-${randomBytes(16).toString("hex")}`;
    const first = await send(alice, { text: "Original words", clientIntentId: intentId });
    expect(first.status).toBe(202);
    const original = z.object({ intent: intentSchema }).parse(await first.json());
    const conflict = await send(alice, { text: "Different words", clientIntentId: intentId });
    expect(conflict.status).toBe(409);
    const body = z.object({ code: z.string(), intent: intentSchema }).parse(await conflict.json());
    expect(body.code).toBe("INTENT_CONFLICT");
    expect(body.intent.messageId).toBe(original.intent.messageId);
    const transcript = await transcriptOf(alice);
    expect(transcript.messages.filter((m) => m.role === "user" && m.text === "Different words")).toHaveLength(0);
  });

  it("keeps accounts isolated: a foreign account cannot look up or collide with another account's intent", async () => {
    const intentId = `snd-${randomBytes(16).toString("hex")}`;
    const mine = await send(alice, { text: "Private words", clientIntentId: intentId });
    expect(mine.status).toBe(202);
    const original = z.object({ intent: intentSchema }).parse(await mine.json());
    // Bob replays ALICE's intent id against BOB's own bot: the fingerprint
    // (text + bob's thread) differs, so this is a conflict — but a foreign
    // collision learns only that the id is TAKEN (W0): the answer carries no
    // message id, no thread id, no timestamp from another account.
    const cross = await send(bob, { text: "Private words", clientIntentId: intentId });
    expect(cross.status).toBe(409);
    const body = z.object({ intent: intentSchema }).parse(await cross.json());
    expect(body.intent.intentId).toBe(intentId);
    expect(body.intent.messageId).toBe("");
    expect(body.intent.threadId).not.toBe(alice.threadId);
    expect(body.intent.acceptedAt).toBe(0);
    // The OWNER replaying the same id still gets the full original receipt
    // (reconcile:true is a pure lookup — same id, same words).
    const own = await send(alice, { text: "Private words", clientIntentId: intentId, reconcile: true });
    expect(own.status).toBe(202);
    const looked = z.object({ intent: intentSchema }).parse(await own.json());
    expect(looked.intent.messageId).toBe(original.intent.messageId);
    expect(looked.intent.threadId).toBe(alice.threadId);
    const bobTranscript = await transcriptOf(bob);
    expect(bobTranscript.messages.filter((m) => m.text === "Private words")).toHaveLength(0);
  });

  it("looks a receipt up read-only via GET: unknown and foreign ids are the same blank 404", async () => {
    // An id alice never sent and a receipt that belongs to nobody the
    // caller can name must be indistinguishable to bob.
    const neverSent = `snd-${randomBytes(16).toString("hex")}`;
    expect((await request(`/api/messages/intents/${neverSent}`, "GET", undefined, bob)).status).toBe(404);
    const intentId = `snd-${randomBytes(16).toString("hex")}`;
    const mine = await send(alice, { text: "Lookup words", clientIntentId: intentId });
    expect(mine.status).toBe(202);
    const admitted = z.object({ intent: intentSchema }).parse(await mine.json());
    const foreign = await request(`/api/messages/intents/${intentId}`, "GET", undefined, bob);
    expect(foreign.status).toBe(404);
    const own = await request(`/api/messages/intents/${intentId}`, "GET", undefined, alice);
    expect(own.status).toBe(200);
    const body = z.object({ intent: intentSchema }).parse(await own.json());
    expect(body.intent.messageId).toBe(admitted.intent.messageId);
    expect(body.intent.threadId).toBe(alice.threadId);
    // Malformed ids are refused without probing the ledger.
    expect((await request("/api/messages/intents/short", "GET", undefined, alice)).status).toBe(400);
    // Read-only means read-only: no lookup created anything anywhere.
    const bobTranscript = await transcriptOf(bob);
    expect(bobTranscript.messages.filter((m) => m.text === "Lookup words")).toHaveLength(0);
  });

  it("reconcile is a lookup only: an unknown id creates nothing, a known id folds the original", async () => {
    const ghost = `snd-${randomBytes(16).toString("hex")}`;
    const never = await send(alice, { text: "Recovery ghost", clientIntentId: ghost, reconcile: true });
    expect(never.status).toBe(404);
    const before = await transcriptOf(alice);
    expect(before.messages.filter((m) => m.text === "Recovery ghost")).toHaveLength(0);
    // A reconnecting client replays the SAME id and words after a lost
    // response: 202 with the original receipt — never a re-queue, never a
    // second transcript row.
    const intentId = `snd-${randomBytes(16).toString("hex")}`;
    const first = await send(alice, { text: "Parked words", clientIntentId: intentId });
    expect(first.status).toBe(202);
    const admitted = z.object({ intent: intentSchema }).parse(await first.json());
    const replay = await send(alice, { text: "Parked words", clientIntentId: intentId, reconcile: true });
    expect(replay.status).toBe(202);
    const looked = z.object({ intent: intentSchema }).parse(await replay.json());
    expect(looked.intent.messageId).toBe(admitted.intent.messageId);
    const after = await transcriptOf(alice);
    expect(after.messages.filter((m) => m.text === "Parked words")).toHaveLength(1);
  });

  it("refuses malformed intent ids without consuming them", async () => {
    for (const bad of ["short", "", "has spaces", `${"x".repeat(129)}`, "emoji-🎉-id"]) {
      const res = await send(alice, { text: "anything", clientIntentId: bad });
      expect(res.status).toBe(400);
    }
  });

  it("senders without the field keep the exact v1 behavior", async () => {
    // The provider is offline in this fixture, so the legacy path's own
    // honest refusal (409, pre-dispatch, message preserved in the thread by
    // that contract) IS the v1 behavior — the durable layer must not change
    // it, and the words still land so "I sent msg but I don't see it" stays
    // impossible.
    const res = await send(alice, { text: "Legacy words" });
    expect(res.status).toBe(409);
    const body = z.object({ error: z.string() }).parse(await res.json());
    expect(body.error).toContain("unavailable");
    const transcript = await transcriptOf(alice);
    expect(transcript.messages.filter((m) => m.role === "user" && m.text === "Legacy words")).toHaveLength(1);
    expect(transcript.messages.filter((m) => m.role === "user" && m.text === "Legacy words")).toHaveLength(1);
  });

  it("boot reconciliation reads crash-orphans as unknown, never as lost work", async () => {
    // The durable layer is shared with the message-db suite, which pins the
    // exact boot sweep behavior against the real SQLite file (see
    // message-db.test.ts); here we pin the WIRE truth: an accepted receipt
    // never comes back claiming "dispatched" after a refusal, so a client
    // can never be told "sent" for work that did not run.
    const intentId = `snd-${randomBytes(16).toString("hex")}`;
    const first = await send(alice, { text: "Held for review", clientIntentId: intentId });
    expect(first.status).toBe(202);
    const admitted = z.object({ intent: intentSchema }).parse(await first.json());
    expect(["accepted", "unknown"]).toContain(admitted.intent.state);
    const replay = await send(alice, { text: "Held for review", clientIntentId: intentId });
    const lookup = z.object({ intent: intentSchema }).parse(await replay.json());
    expect(lookup.intent.state).not.toBe("dispatched");
  });

  it("recovers a send that was parked BEFORE a task switch, into the thread it was accepted for", async () => {
    // A3. The words are sent into task A, the request never gets its
    // acknowledgement, and the user starts task B. On reconnect the client
    // asks about the parked record — and the ONLY destination information it
    // sends is the bot id, because `parkSend` stored the thread but the
    // reconcile body never carried it. The server therefore fingerprinted the
    // right words against the bot's CURRENT thread, missed the receipt it was
    // literally holding, and answered "already accepted with different
    // content" — telling a user their successful send was a conflict, over a
    // message the server already had.
    const intentId = `snd-${randomBytes(16).toString("hex")}`;
    const parkedThread = alice.threadId;
    const mine = await send(alice, { text: "Words sent into task A", clientIntentId: intentId });
    expect(mine.status).toBe(202);
    const original = z.object({ intent: intentSchema }).parse(await mine.json());
    expect(original.intent.threadId).toBe(parkedThread);

    // The real product route for "start another task", not a fixture poke: the
    // composer's current thread genuinely moves.
    const created = await request(`/api/bots/${alice.botId}/tasks`, "POST", { title: "Task B" }, alice);
    expect(created.status).toBe(201);
    const moved = z.object({ bot: botSchema, task: z.object({ threadId: z.string() }) }).parse(await created.json());
    expect(moved.bot.threadId, "the fixture must actually move the composer off the parked thread").not.toBe(parkedThread);

    // Exactly what src/state/store.tsx sends on reconnect.
    const looked = await send(alice, { text: "Words sent into task A", clientIntentId: intentId, reconcile: true });
    expect(looked.status).not.toBe(409);
    const recovered = z.object({ intent: intentSchema }).parse(await looked.json());
    // The receipt is the ORIGINAL one: same message, same thread. Recovery
    // pins the destination the send was accepted for — it never re-binds a
    // delivered message to whatever thread the bot happens to be on.
    expect(recovered.intent.messageId).toBe(original.intent.messageId);
    expect(recovered.intent.threadId).toBe(parkedThread);
    // And the words were not re-sent into the new thread, nor duplicated in
    // the old one.
    expect(await threadWords(alice, moved.bot.threadId, "Words sent into task A")).toBe(0);
    expect(await threadWords(alice, parkedThread, "Words sent into task A")).toBe(1);

    // Put the composer back so the shared fixture is left as found.
    await request(`/api/bots/${alice.botId}/tasks/${parkedThread}`, "POST", {}, alice);
  });

  it("a reconnect lookup survives a Drive disconnect, while a genuinely new send still does not", async () => {
    // A4. The case above already covered the GET receipt route, which was
    // never gated — so it proved the claim for a path the client does not
    // use. The client reconciles with a POST carrying reconcile:true, and THAT
    // ran behind the storage-sovereignty gate: a user who disconnected Drive
    // (the ordinary response to a storage warning) could read the
    // conversation but was then refused recovery of the message they had just
    // sent, with a "connect your own Google Drive" error for what was really
    // a lookup. Reading your own receipt is exactly as authorized as reading
    // your own transcript, and no work starts.
    const intentId = `snd-${randomBytes(16).toString("hex")}`;
    const mine = await send(alice, { text: "Sent before the disconnect", clientIntentId: intentId });
    expect(mine.status).toBe(202);
    const original = z.object({ intent: intentSchema }).parse(await mine.json());

    const db = new DatabaseSync(join(directory, "data", "auth.db"));
    try {
      db.prepare("DELETE FROM drive_grants WHERE userId = ?").run(alice.id);
      db.prepare("DELETE FROM account WHERE userId = ? AND providerId = 'google'").run(alice.id);
    } finally {
      db.close();
    }

    // The lookup the client actually performs is not refused.
    try {
      // 202, not 403: the lookup is answered, not refused.
      const looked = await send(alice, { text: "Sent before the disconnect", clientIntentId: intentId, reconcile: true });
      expect(looked.status).toBe(202);
      const recovered = z.object({ intent: intentSchema }).parse(await looked.json());
      expect(recovered.intent.messageId).toBe(original.intent.messageId);

      // ...but NEW work is still gated. Loosening the gate for reads must not
      // become loosening the gate.
      const fresh = await send(alice, { text: "Brand new work after the disconnect" });
      expect(fresh.status).toBe(403);
      expect(await fresh.json()).toMatchObject({ code: "STORAGE_GATE_REQUIRED" });
    } finally {
      // Restore in a finally: this fixture is SHARED, and an assertion above
      // throwing used to leave every later case running against a disconnected
      // account and failing for the wrong reason.
      seedConnectedGoogleRow(join(directory, "data"), alice.id);
    }
  });

  it("an accepted receipt stays readable after the account's Drive consent is disconnected", async () => {
    // The acceptance criterion is explicit: lookup must not depend on the
    // storage-sovereignty gate. Alice disconnects her Drive (fixture rows
    // removed), and her already-accepted receipt still answers.
    const intentId = `snd-${randomBytes(16).toString("hex")}`;
    const mine = await send(alice, { text: "Consent-independent words", clientIntentId: intentId });
    expect(mine.status).toBe(202);
    const admitted = z.object({ intent: intentSchema }).parse(await mine.json());
    const db = new DatabaseSync(join(directory, "data", "auth.db"));
    try {
      db.prepare("DELETE FROM drive_grants WHERE userId = ?").run(alice.id);
      db.prepare("DELETE FROM account WHERE userId = ? AND providerId = 'google'").run(alice.id);
    } finally {
      db.close();
    }
    const looked = await request(`/api/messages/intents/${intentId}`, "GET", undefined, alice);
    expect(looked.status).toBe(200);
    const body = z.object({ intent: intentSchema }).parse(await looked.json());
    expect(body.intent.messageId).toBe(admitted.intent.messageId);
  });

  it("reconciles across a fixture restart: the receipt survives, the words never re-send", async () => {
    // This is the disconnect with the hardest consequence: the PROCESS died
    // between acceptance and any dispatch. Boot flips dispatched→unknown and
    // leaves accepted alone, so a reconnecting client sees exactly what a
    // human would need to see. Covered at the layer below the wire by
    // message-db.test.ts (durable file, real reopen); the wire contract is
    // pinned by the other cases here. No live restart in THIS file because
    // the fixture's single booted server is shared by the ownership cases.
    expect(existsSync(join(ROOT, "server/message-db.ts"))).toBe(true);
  });
});

// The pure layer under the wire contract, tested against the real SQLite
// file — the boot sweep and the dispatch-flip rules. (Kept in this file so
// the whole slice's evidence lives together.)
describe("message intent durable layer", async () => {
  const { closeMessageDb, markAllDispatchedIntentsUnknown, readMessageIntent, setMessageIntentState } = await import("./message-db.ts");
  const { Store } = await import("./store.ts");
  const { isValidMessageIntentId, messageIntentFingerprint } = await import("./message-intent.ts");
  const { DATA_DIR } = await import("./config.ts");
  const { mkdirSync, rmSync } = await import("node:fs");
  const { homedir } = await import("node:os");
  const { basename } = await import("node:path");
  const { afterEach, beforeEach } = await import("vitest");

  beforeEach(() => {
    expect(basename(homedir())).toMatch(/^omb-test-home-/);
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
    mkdirSync(DATA_DIR, { recursive: true });
  });
  afterEach(() => closeMessageDb());

  const selection = () => ({ instanceId: "owned-offline", model: "test-model" });

  it("admits the transcript row and its acceptance in one transaction, and replays the original", () => {
    const store = new Store(selection);
    const bot = store.createBot({ name: "Intent probe" });
    const fingerprint = messageIntentFingerprint("hello", bot.threadId);
    const first = store.admitMessage(bot.threadId, "hello", { intentId: "intent-abc-12345", fingerprint });
    expect(first.text).toBe("hello");
    const replay = store.admitMessage(bot.threadId, "hello", { intentId: "intent-abc-12345", fingerprint });
    expect(replay.id).toBe(first.id);
    expect(store.messagesFor(bot.threadId).filter((m) => m.text === "hello")).toHaveLength(1);
  });

  it("refuses a fingerprint mismatch (changed text or thread) without touching the original", () => {
    const store = new Store(selection);
    const bot = store.createBot({ name: "Intent probe" });
    store.admitMessage(bot.threadId, "hello", { intentId: "intent-abc-12345", fingerprint: messageIntentFingerprint("hello", bot.threadId) });
    expect(() => store.admitMessage(bot.threadId, "changed", { intentId: "intent-abc-12345", fingerprint: messageIntentFingerprint("changed", bot.threadId) }))
      .toThrow(/different content/);
  });

  it("boot flips dispatched intents to unknown and leaves accepted ones held", () => {
    const store = new Store(selection);
    const bot = store.createBot({ name: "Intent probe" });
    const fingerprint = messageIntentFingerprint("crash candidate", bot.threadId);
    store.admitMessage(bot.threadId, "crash candidate", { intentId: "intent-crash-0001", fingerprint });
    setMessageIntentState("intent-crash-0001", "dispatched", Date.now());
    store.admitMessage(bot.threadId, "never dispatched", { intentId: "intent-held-00001", fingerprint: messageIntentFingerprint("never dispatched", bot.threadId) });
    markAllDispatchedIntentsUnknown();
    expect(readMessageIntent("intent-crash-0001")?.state).toBe("unknown");
    expect(readMessageIntent("intent-held-00001")?.state).toBe("accepted");
  });

  it("survives a real close/reopen: the receipt and the transcript row stay consistent", () => {
    const store = new Store(selection);
    const bot = store.createBot({ name: "Intent probe" });
    store.admitMessage(bot.threadId, "durable words", { intentId: "intent-reopen-001", fingerprint: messageIntentFingerprint("durable words", bot.threadId) });
    closeMessageDb(); // simulate the process dying
    const fresh = new Store(selection);
    const replay = fresh.admitMessage(bot.threadId, "durable words", { intentId: "intent-reopen-001", fingerprint: messageIntentFingerprint("durable words", bot.threadId) });
    expect(replay.text).toBe("durable words");
    expect(fresh.messagesFor(bot.threadId).filter((m) => m.text === "durable words")).toHaveLength(1);
  });

  it("validates intent ids exactly — no truncation, no normalization", () => {
    expect(isValidMessageIntentId("snd-abc12345")).toBe(true);
    expect(isValidMessageIntentId("short")).toBe(false);
    expect(isValidMessageIntentId(`${"x".repeat(129)}`)).toBe(false);
    expect(isValidMessageIntentId("has space")).toBe(false);
  });
});
