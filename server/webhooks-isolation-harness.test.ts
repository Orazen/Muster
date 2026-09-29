// Webhook account isolation against the real booted server — the
// ci-and-audit-repair finding #1 acceptance gate.
//
// Before this slice, EVERY /api/webhooks route was process-global: any
// signed-in account could list, read attempt history (payload previews
// included), rotate, test, re-point or delete another account's webhook,
// and every account's SSE stream carried every webhook's frames.
//
// Contract proven here, over real HTTP and a real SSE stream, with two
// accounts on one hosted deployment:
//   - alice's create is invisible to bob's list, and bob's to alice's;
//   - foreign ids answer the same blank 404 as unknown ids (update /
//     rotate / test / delete), leaving the foreign row untouched;
//   - attempts history is scoped: bob sees zero rows naming alice's hook;
//   - assigning a webhook to another account's bot is refused 403, both on
//     create and on reassignment via PATCH;
//   - a webhook delivery (real ingress) lands ONLY in the owner's SSE
//     stream; the other account's stream receives no webhook frame for it;
//   - desktop/no-session behavior is out of scope here (hosted fixture);
//     the unrestricted viewer is pinned by the unit harness.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
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
const botSchema = z.object({ id: z.string(), threadId: z.string() }).passthrough();
const webhookSchema = z.object({
  id: z.string(),
  endpointId: z.string(),
  name: z.string(),
  botId: z.string(),
  owner: z.string().optional(),
}).passthrough();

interface Account { id: string; cookie: string; botId: string }

describe.skipIf(process.platform === "win32")("webhook account isolation", () => {
  let directory = "";
  let hosted = { url: "" };
  const children: ChildProcess[] = [];
  let alice!: Account;
  let bob!: Account;

  const request = (path: string, method = "GET", body?: JsonValue, account?: Account) => {
    const headers = new Headers({ origin: hosted.url, "content-type": "application/json" });
    if (account) headers.set("cookie", account.cookie);
    const init: RequestInit = { method, headers, redirect: "error", signal: AbortSignal.timeout(15_000) };
    if (body !== undefined) init.body = JSON.stringify(body);
    return fetch(`${hosted.url}${path}`, init);
  };

  const createWebhook = async (account: Account, botId: string, name: string) => {
    const res = await request("/api/webhooks", "POST", { name, prompt: "Summarize the event", botId }, account);
    expect(res.status).toBe(201);
    const parsed = z.object({ webhook: webhookSchema }).parse(await res.json());
    return parsed.webhook;
  };

  /** Open a raw SSE stream for an account and collect webhook-related
   * frame kinds until `collectMs` elapses. Connect failures fail loudly:
   * an empty stream must mean "no frames", never "could not listen". */
  const collectSse = async (account: Account, collectMs: number): Promise<Array<{ kind: string; owner?: string }>> => {
    const frames: Array<{ kind: string; owner?: string }> = [];
    const controller = new AbortController();
    const res = await fetch(`${hosted.url}/api/events`, {
      headers: { cookie: account.cookie, accept: "text/event-stream" },
      redirect: "error",
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    void (async () => {
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? ""; // the last line may still be growing
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              // SAFETY: the SSE wire carries JSON objects per the server's
              // broadcast; unknown fields are read defensively and only the
              // named optional strings are used.
              const frame = JSON.parse(line.slice(6)) as { kind?: string; webhook?: { owner?: string }; attempt?: { owner?: string }; owner?: string };
              if (frame.kind?.startsWith("webhook")) {
                frames.push({ kind: frame.kind, owner: frame.webhook?.owner ?? frame.attempt?.owner ?? frame.owner });
              }
            } catch { /* keepalive comments and partial lines */ }
          }
        }
      } catch { /* aborted by the deadline below */ }
    })();
    await new Promise((resolve) => setTimeout(resolve, collectMs));
    controller.abort();
    return frames;
  };

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "muster-webhook-isolation-"));
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
    writeFileSync(join(data, "config.json"), JSON.stringify({ profile: { name: "Isolation fixture" }, instances: { ghost: { driver: "not-a-real-driver", displayName: "Offline fixture" } } }));
    writeFileSync(join(data, "license.json"), JSON.stringify({ firstLaunchAt: new Date(Date.now() - 30 * 86_400_000).toISOString(), license: null }));

    const port = await freePortBlock([0, 1], 49200, 8000);
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
      return { id: user.id, cookie: header.split(";")[0], botId: "" };
    };
    alice = await signUp("alice");
    bob = await signUp("bob");
    for (const account of [alice, bob]) seedConnectedGoogleRow(join(directory, "data"), account.id);
    for (const account of [alice, bob]) {
      const created = await request("/api/bots", "POST", {}, account);
      expect(created.status).toBe(201);
      const { bot } = z.object({ bot: botSchema }).parse(await created.json());
      account.botId = bot.id;
    }
  }, 90_000);

  afterAll(async () => {
    for (const child of children) {
      child.kill("SIGINT");
      await waitForExit(child);
    }
    if (directory && existsSync(directory)) removeTempDir(directory);
  });

  it("keeps each account's webhooks invisible to the other", async () => {
    const aliceHook = await createWebhook(alice, alice.botId, "Alice watcher");
    const bobHook = await createWebhook(bob, bob.botId, "Bob watcher");
    expect(aliceHook.owner).toBe(alice.id);
    expect(bobHook.owner).toBe(bob.id);

    const aliceList = z.object({ webhooks: z.array(webhookSchema) }).parse(await (await request("/api/webhooks", "GET", undefined, alice)).json());
    const bobList = z.object({ webhooks: z.array(webhookSchema) }).parse(await (await request("/api/webhooks", "GET", undefined, bob)).json());
    expect(aliceList.webhooks.map((w) => w.id)).toEqual([aliceHook.id]);
    expect(bobList.webhooks.map((w) => w.id)).toEqual([bobHook.id]);

    // Foreign mutation surface: every verb answers the same blank 404 an
    // unknown id would, and the foreign row survives untouched.
    for (const [method, path, body] of [
      ["PATCH", `/api/webhooks/${aliceHook.id}`, { name: "Hijacked" }],
      ["POST", `/api/webhooks/${aliceHook.id}/rotate`, {}],
      ["POST", `/api/webhooks/${aliceHook.id}/test`, {}],
      ["DELETE", `/api/webhooks/${aliceHook.id}`, undefined],
    ] as const) {
      // SAFETY: each body above is a JSON-literal test fixture.
      const res = await request(path, method, body as JsonValue, bob);
      expect(res.status).toBe(404);
      const still = z.object({ webhooks: z.array(webhookSchema) }).parse(await (await request("/api/webhooks", "GET", undefined, alice)).json());
      expect(still.webhooks.find((w) => w.id === aliceHook.id)?.name).toBe("Alice watcher");
    }
    // And the deletion attempt really did not delete.
    const final = z.object({ webhooks: z.array(webhookSchema) }).parse(await (await request("/api/webhooks", "GET", undefined, alice)).json());
    expect(final.webhooks).toHaveLength(1);
  });

  it("refuses pointing a webhook at another account's bot, on create and reassignment", async () => {
    const refused = await request("/api/webhooks", "POST", { name: "Cross steal", prompt: "x", botId: alice.botId }, bob);
    expect(refused.status).toBe(403);
    const mine = await createWebhook(bob, bob.botId, "Bob reassign probe");
    const flip = await request(`/api/webhooks/${mine.id}`, "PATCH", { botId: alice.botId }, bob);
    expect(flip.status).toBe(403);
    const after = z.object({ webhooks: z.array(webhookSchema) }).parse(await (await request("/api/webhooks", "GET", undefined, bob)).json());
    expect(after.webhooks.find((w) => w.id === mine.id)?.botId).toBe(bob.botId);
  });

  it("scopes attempt history so a foreign account learns nothing, not even existence", async () => {
    await createWebhook(alice, alice.botId, "Alice history probe");
    const aliceAttempts = z.object({ attempts: z.array(z.object({ webhookId: z.string(), preview: z.string().optional() })) }).parse(await (await request("/api/webhooks", "GET", undefined, alice)).json());
    const bobAttempts = z.object({ attempts: z.array(z.object({ webhookId: z.string() })) }).parse(await (await request("/api/webhooks", "GET", undefined, bob)).json());
    const aliceIds = new Set(z.object({ webhooks: z.array(webhookSchema) }).parse(await (await request("/api/webhooks", "GET", undefined, alice)).json()).webhooks.map((w) => w.id));
    for (const attempt of aliceAttempts.attempts) expect(aliceIds.has(attempt.webhookId)).toBe(true);
    for (const attempt of bobAttempts.attempts) expect(aliceIds.has(attempt.webhookId)).toBe(false);
  });

  it("delivers a real ingress event only into the owner's SSE stream", async () => {
    const hook = await createWebhook(alice, alice.botId, "Alice sse probe");
    const alicePromise = collectSse(alice, 6_000);
    const bobPromise = collectSse(bob, 6_000);
    await new Promise((resolve) => setTimeout(resolve, 800));
    // Fire the test delivery through the owner's own route.
    const test = await request(`/api/webhooks/${hook.id}/test`, "POST", { event: "muster.test", message: "isolation probe" }, alice);
    expect(test.status).toBe(202);
    const [aliceFrames, bobFrames] = await Promise.all([alicePromise, bobPromise]);
    expect(aliceFrames.some((f) => f.kind === "webhook.attempt" && f.owner === alice.id)).toBe(true);
    for (const frame of bobFrames) {
      expect(frame.owner, `bob's stream must carry no frame owned by alice (got ${frame.kind} owner=${frame.owner})`).not.toBe(alice.id);
    }
  });
});
