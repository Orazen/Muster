// Two accounts, one deployment: can Bob read or publish Alice's receipts?
//
// Reproduced from the 2026-09-26 bug sweep, finding 3. Both receipt handlers
// resolved a bot straight out of the shared store with no ownership check:
//
//   GET  /api/receipts/:botId/:threadId   — returns the bot name, task title,
//     usage, the final assistant message and the findings list
//   POST /api/receipts/share              — mints a PUBLIC, unauthenticated
//     /r/<token> link to the same content
//
// and the multi-tenant choke point only pattern-matched /api/bots/,
// /api/groups/ and /api/threads/, while its own comment claimed ownership was
// enforced "at this single choke point". The session gate covers anonymity, so
// the exposure was not "anyone on the internet" — it was any OTHER signed-in
// account, which is precisely the population a hosted deployment has.
//
// A receipt is a summary of someone's actual work: what they asked a computer
// to do, what it cost, and what came back. Reading another account's is a
// disclosure; publishing one turns that disclosure into an unlinkable public URL.
//
// The share half cannot be fixed at the choke point at all — it takes the bot id
// in the request BODY, which a URL matcher never sees — so both handlers carry
// their own check and the choke point's comment now says where it does and
// does not reach.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

interface Account { id: string; cookie: string; botId: string; threadId: string }
interface OwnedServer { url: string; networkLog: string }

const receipt = z.object({ receipt: z.record(z.string(), z.unknown()), text: z.string() }).passthrough();

describe.skipIf(process.platform === "win32")("receipt ownership across two hosted accounts", () => {
  let directory = "";
  let hosted: OwnedServer;
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

  /** A bot plus a named task, so the receipt has real content in it.
   *
   * A completed TURN is deliberately not attempted: a member with no model key
   * of their own is refused by the engine guard, which is correct product
   * behaviour and irrelevant here. What a receipt needs is a task, and
   * `POST /api/bots/:id/tasks` creates one without claiming an engine. The
   * marker goes in the task title, which is the field the receipt echoes back
   * as the job title, so a disclosure cannot hide in a field nobody asserted. */
  async function seedTask(account: Account, name: string, marker: string) {
    const created = await request("/api/bots", "POST", {}, account);
    expect(created.status).toBe(201);
    const { bot } = z.object({ bot: botSchema }).parse(await created.json());
    const titled = await request(`/api/bots/${bot.id}`, "PATCH", { name, description: `${marker}-private-description` }, account);
    expect(titled.status).toBe(200);
    const named = z.object({ bot: botSchema }).parse(await titled.json()).bot;
    const task = await request(`/api/bots/${named.id}/tasks`, "POST", { title: `${marker} private job` }, account);
    expect(task.status).toBe(201);
    // A task gets its OWN thread, and the receipt route is addressed by the
    // task's thread, not the bot's.
    const made = z.object({ task: z.object({ threadId: z.string() }) }).parse(await task.json());
    return { botId: named.id, threadId: made.task.threadId };
  }

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "muster-receipt-ownership-"));
    const data = join(directory, "data");
    const home = join(directory, "home");
    const companion = join(directory, "companion");
    const ui = join(directory, "ui");
    for (const path of [data, home, companion, ui]) mkdirSync(path, { recursive: true, mode: 0o700 });
    const networkLog = join(directory, "outbound.log");
    const preload = join(directory, "block-outbound.mjs");
    writeFileSync(
      preload,
      `import { Socket } from "node:net";\nimport { appendFileSync } from "node:fs";\nconst blocked = () => { appendFileSync(${JSON.stringify(networkLog)}, "blocked\\n"); throw new Error("Owned fixture refuses outbound traffic"); };\nglobalThis.fetch = blocked; Socket.prototype.connect = blocked;\n`,
    );
    const operatorId = randomUUID();
    writeFileSync(
      join(data, "bots.json"),
      JSON.stringify([{ id: operatorId, threadId: randomUUID(), name: "Operator bot", description: "operator", title: "Operator", color: "orange", notifications: true, unread: false, modelSelection: { instanceId: "ghost", model: "" }, resumeCursors: {}, createdAt: Date.now() }]),
    );
    writeFileSync(join(data, "config.json"), JSON.stringify({ profile: { name: "Receipt fixture" }, instances: { ghost: { driver: "not-a-real-driver", displayName: "Offline fixture" } } }));
    writeFileSync(join(data, "license.json"), JSON.stringify({ firstLaunchAt: new Date(Date.now() - 30 * 86_400_000).toISOString(), license: null }));

    const port = await freePortBlock([0, 1], 48600, 8000);
    ports.push(port, port + 1);
    const env = pairingServerEnvironment({ home, dataDirectory: data, companionDirectory: companion, staticDir: ui, port, webhookPort: port + 1, secret: randomBytes(32).toString("hex") });
    Object.assign(env, { OMB_PUBLIC_HOST: `127.0.0.1:${port}`, OMB_ALLOW_SIGNUPS: "true", GOOGLE_CLIENT_ID: randomBytes(24).toString("hex"), GOOGLE_CLIENT_SECRET: randomBytes(24).toString("hex") });
    const child = spawn(process.execPath, ["--import", preload, "--experimental-strip-types", join(ROOT, "server/index.ts")], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", () => {});
    hosted = { url: `http://127.0.0.1:${port}`, networkLog };
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
    // The storage-sovereignty gate (decision 14) refuses bot creation until a
    // hosted account connects its own Drive. That is a real product rule, not
    // something to bypass in a fixture, so the row is seeded the way the
    // account's own consent would leave it.
    for (const account of [alice, bob]) seedConnectedGoogleRow(join(directory, "data"), account.id);
    const aliceTask = await seedTask(alice, "Alice private bot", "ALICE-SECRET-MARKER");
    const bobTask = await seedTask(bob, "Bob private bot", "BOB-SECRET-MARKER");
    alice = { ...alice, ...aliceTask };
    bob = { ...bob, ...bobTask };
  }, 90_000);

  afterAll(async () => {
    await Promise.all(children.map((child) => waitForExit(child, { signal: "SIGTERM" })));
    const closed = await Promise.all(ports.map((port) => new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.setTimeout(2_000);
      socket.once("connect", () => { socket.destroy(); resolve(false); });
      socket.once("timeout", () => { socket.destroy(); resolve(false); });
      socket.once("error", (error) => { socket.destroy(); resolve("code" in error && error.code === "ECONNREFUSED"); });
    })));
    const noOutbound = !existsSync(hosted.networkLog);
    const exited = children.every((child) => child.exitCode !== null || child.signalCode !== null);
    if (directory && exited) await removeTempDir(directory);
    console.info(JSON.stringify({ scope: "receipt ownership cleanup", exited, noOutbound, closed: closed.every(Boolean) }));
    expect({ exited, noOutbound, closed: closed.every(Boolean) }).toEqual({ exited: true, noOutbound: true, closed: true });
  }, 20_000);

  it("still gives an account its OWN receipt", () => {
    // The control. Without it a blanket 404 would pass every other case here
    // while breaking the feature.
    return (async () => {
      const res = await request(`/api/receipts/${alice.botId}/${alice.threadId}`, "GET", undefined, alice);
      expect(res.status).toBe(200);
      const body = receipt.parse(await res.json());
      expect(body.text).toContain("Alice private bot");
    })();
  });

  it("still lets an account share its OWN receipt", async () => {
    const res = await request("/api/receipts/share", "POST", { botId: alice.botId, threadId: alice.threadId }, alice);
    expect(res.status).toBe(201);
    const { url } = z.object({ url: z.string() }).parse(await res.json());
    expect(url).toMatch(/^\/r\//);
  });

  it("refuses another account's receipt, and says nothing about it", async () => {
    const res = await request(`/api/receipts/${alice.botId}/${alice.threadId}`, "GET", undefined, bob);
    // 404 rather than 403: a 403 would confirm the receipt exists.
    expect(res.status).toBe(404);
    const raw = await res.text();
    // No content leaks through the refusal itself.
    expect(raw).not.toContain("ALICE-SECRET-MARKER");
    expect(raw).not.toContain("Alice private bot");
  });

  it("refuses to mint a public share link for another account's receipt", async () => {
    const res = await request("/api/receipts/share", "POST", { botId: alice.botId, threadId: alice.threadId }, bob);
    expect(res.status).toBe(404);
    const raw = await res.text();
    expect(raw).not.toContain("ALICE-SECRET-MARKER");
    // Critically: no token was minted, so there is nothing public to leak.
    expect(raw).not.toContain("/r/");
    expect(raw).not.toContain("token");
  });

  it("does not let a guessed thread id reach another account either", async () => {
    // The task exists and the bot is not the caller's: both halves must be
    // checked, so a valid thread under a foreign bot is still refused.
    const res = await request(`/api/receipts/${alice.botId}/${bob.threadId}`, "GET", undefined, bob);
    expect(res.status).toBe(404);
  });

  it("keeps an unauthenticated caller out", async () => {
    // The session gate already did this; asserted so the ownership fix cannot
    // be mistaken for the thing that was holding the door shut.
    expect((await request(`/api/receipts/${alice.botId}/${alice.threadId}`)).status).toBe(401);
    expect((await request("/api/receipts/share", "POST", { botId: alice.botId, threadId: alice.threadId })).status).toBe(401);
  });

  it("leaves an unowned record to the operator and the local install", async () => {
    // `ownsRecord` treats a record with no owner as the operator's, and a
    // desktop install has no session at all. Both are legitimate, so the
    // ownership check must not be written in a way that refuses them.
    //
    // On THIS hosted deployment the seeded operator record is anonymous to the
    // caller, so the session gate answers first — which is the right answer
    // and strictly better than a receipt. The operator-with-a-session path is
    // covered by server/team-ownership-harness.test.ts; what matters here is
    // that this route is refused for anonymity, not accidentally opened.
    const operatorBot = z
      .object({ id: z.string(), threadId: z.string() })
      .parse(JSON.parse(readFileSync(join(directory, "data", "bots.json"), "utf8"))[0]);
    const res = await request(`/api/receipts/${operatorBot.id}/${operatorBot.threadId}`, "GET");
    expect(res.status).toBe(401);
  });
});
