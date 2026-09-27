// The v2 Telegram transport (POST /api/workspace/v2/telegram/push|push and
// /pull): the backup and recovery cards move the same portable v2 bundle
// over Telegram that the Drive routes move, and this file pins that the two
// routes exist at all — the client's call sites named these paths while the
// family table only carried the v1 telegram pair, so every click was a 404.
//
// Environment: the module is imported after the env stubs auth.ts resolves
// SELF_HOSTED with, a real http server dispatches into the real family table
// (a 404 here is the harness's "no route claimed it", not a mock), and one
// fetch router answers the Telegram Bot API (sendDocument / getUpdates /
// getFile / the file download) so no request leaves the process.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR, loadConfig } from "./config.ts";
import type { JsonValue } from "./schema.ts";

const PASSPHRASE = "correct-horse-battery-staple";
const PUSH_ROUTE = "/api/workspace/v2/telegram/push";
const PULL_ROUTE = "/api/workspace/v2/telegram/pull";
// Shape BotFather issues: 8–12 digits, a colon, then hash characters.
const BOT_TOKEN = "1234567890:AAEfixtureFixtureFixtureFixtureFixture1234";
const CHAT_ID = 4242;
const V2_FILE_NAME = "muster-workspace-v2.enc";
const FILE_ID = "telegram-file-v2";
const FILE_PATH = `documents/${V2_FILE_NAME}`;

type RoutesModule = typeof import("./workspace-backup-routes.ts");
type BundleModule = typeof import("./workspace-bundle-v2.ts");

interface Reply {
  status: number;
  body: string;
  // SAFETY: every response asserted here is JSON; each test reads only the
  // fields it checks.
  json: any;
}

let routes: RoutesModule;
let bundle: BundleModule;
let server: Server;
let port = 0;

/** The document the fixture bot chat holds, and what the router was asked. */
interface TelegramTrace {
  calls: string[];
  uploads: number;
  downloads: number;
  sentFileName: string;
  sentPayload: string;
  stored: string | null;
  documentFileId: string | null;
}

let trace: TelegramTrace;

function installTelegram(): void {
  trace = { calls: [], uploads: 0, downloads: 0, sentFileName: "", sentPayload: "", stored: null, documentFileId: null };
  const fetchMock = vi.fn<typeof fetch>();
  fetchMock.mockImplementation(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const base = `https://api.telegram.org/bot${BOT_TOKEN}/`;
    if (url.startsWith(`${base}sendDocument`)) {
      trace.calls.push("sendDocument");
      trace.uploads += 1;
      // SAFETY: this fetch was issued by the push route under test, whose
      // contract is a one-part FormData body carrying the bundle document.
      const document = (init?.body as FormData).get("document") as File;
      trace.sentFileName = document.name;
      trace.sentPayload = await document.text();
      trace.stored = trace.sentPayload;
      trace.documentFileId = FILE_ID;
      return Response.json({ ok: true, result: { document: { file_id: FILE_ID } } });
    }
    if (url.startsWith(`${base}getUpdates`)) {
      trace.calls.push("getUpdates");
      // A fresh install has no cached file id: the newest document in recent
      // messages is the only thing that can answer.
      const result = trace.documentFileId === null ? [] : [
        { update_id: 7, message: { chat: { id: CHAT_ID, title: "Fixture chat" }, document: { file_id: trace.documentFileId, file_name: V2_FILE_NAME } } },
      ];
      return Response.json({ ok: true, result });
    }
    if (url.startsWith(`${base}getFile`)) {
      trace.calls.push("getFile");
      return Response.json({ ok: true, result: { file_path: FILE_PATH } });
    }
    if (url.startsWith(`https://api.telegram.org/file/bot${BOT_TOKEN}/`)) {
      trace.calls.push("download");
      trace.downloads += 1;
      if (trace.stored === null) throw new Error("fixture: download before any upload");
      return new Response(trace.stored);
    }
    throw new Error(`fixture: unexpected fetch ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

/** Fresh installation config each test: nothing a previous push cached. */
function writeTelegramConfig(connected = true): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(join(DATA_DIR, "config.json"), JSON.stringify(connected
    ? { telegramSync: { botToken: BOT_TOKEN, chatId: CHAT_ID, chatLabel: "Fixture chat" } }
    : { telegramSync: { botToken: "", chatId: 0, chatLabel: "" } }), { mode: 0o600 });
}

const ctx = {
  config: () => loadConfig(),
  appVersion: () => "0.0.0-test",
  dataDir: () => DATA_DIR,
  session: async () => null,
};

function call(method: string, path: string, body?: JsonValue): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = payload === undefined
      ? { connection: "close" }
      : {
          connection: "close",
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(payload)),
        };
    const outgoing = httpRequest({ host: "127.0.0.1", port, path, method, headers }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => {
        let json: any = null;
        try {
          json = JSON.parse(text);
        } catch {
          /* non-JSON bodies stay in `text` only */
        }
        resolve({ status: response.statusCode ?? 0, body: text, json });
      });
    });
    outgoing.on("error", reject);
    if (payload !== undefined) outgoing.write(payload);
    outgoing.end();
  });
}

beforeAll(async () => {
  vi.stubEnv("OMB_HOST", "127.0.0.1");
  vi.stubEnv("OMB_PUBLIC_HOST", "");
  // auth.ts resolves its secret at module load; the hosted re-import later in
  // this file would throw without it (SELF_HOSTED requires the env form).
  vi.stubEnv("BETTER_AUTH_SECRET", "fixture-secret-0123456789abcdef0123456789abcdef0123456789abcdef");
  mkdirSync(DATA_DIR, { recursive: true });
  routes = await import("./workspace-backup-routes.ts");
  bundle = await import("./workspace-bundle-v2.ts");
  server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      // requestUserId stays null on purpose: these routes are
      // installation-scoped, exactly like their Drive siblings.
      const handled = await routes.handleWorkspaceBackupRoute(req, res, req.method ?? "GET", url.pathname, null, ctx);
      if (!handled) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
      }
    })();
  });
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  // SAFETY: a TCP listener bound to 127.0.0.1 always reports AddressInfo; the
  // string form comes only from pipe:/unix: listeners, which this fixture
  // never creates.
  const address = server.address() as AddressInfo | null;
  if (address === null) throw new Error("fixture server did not bind an ephemeral port");
  port = address.port;
});

beforeEach(async () => {
  const restore = await import("./restore-apply.ts");
  restore.clearPendingRestore(DATA_DIR);
  rmSync(restore.stagingPathFor(DATA_DIR), { recursive: true, force: true });
  rmSync(join(DATA_DIR, "sync-state"), { recursive: true, force: true });
  writeTelegramConfig();
  installTelegram();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await new Promise<void>((resolve) => { server.close(() => resolve()); });
  vi.unstubAllEnvs();
});

describe("v2 Telegram bundle transport", () => {
  it("push uploads the v2 bundle as one document and caches its v2 file id", async () => {
    const reply = await call("POST", PUSH_ROUTE, { passphrase: PASSPHRASE });
    expect(reply.status).toBe(200);
    // The real skip list rides along, exactly like the v2 Drive push: auth.db
    // and friends are outside-subset BY DESIGN, and that is the guarantee the
    // response documents.
    expect(reply.json).toMatchObject({ uploaded: FILE_ID, skipped: expect.any(Array) });
    expect(reply.json.skipped.some((entry: { path: string }) => entry.path === "auth.db")).toBe(true);
    expect(reply.json.counts).toMatchObject({ files: expect.any(Number), messages: expect.any(Number) });
    expect(trace.uploads).toBe(1);
    expect(trace.sentFileName).toBe(V2_FILE_NAME);
    // The uploaded bytes are a real v2 envelope, not the v1 bundle the
    // v1 telegram route sends.
    const verified = bundle.verifyBundleV2(Buffer.from(trace.sentPayload, "utf8"), { passphrase: PASSPHRASE });
    expect(verified.status).toBe("ok");
    // Cached in the v2 field only — the v1 file id stays the v1 bundle's.
    expect(loadConfig().telegramSync?.lastFileIdV2).toBe(FILE_ID);
    expect(loadConfig().telegramSync?.lastFileId ?? "").toBe("");
  });

  it("pull stages the pushed bundle for the next launch and stamps the pull", async () => {
    expect((await call("POST", PUSH_ROUTE, { passphrase: PASSPHRASE })).status).toBe(200);
    const pulled = await call("POST", PULL_ROUTE, { passphrase: PASSPHRASE, confirm: true });
    expect(pulled.status).toBe(200);
    expect(pulled.json).toMatchObject({ staged: true, restartRequired: true, reconsentRequired: [] });
    expect(pulled.json.counts).toMatchObject({ files: expect.any(Number), messages: expect.any(Number) });
    // The cached file id answers the pull — no getUpdates discovery needed.
    expect(trace.calls).toEqual(["sendDocument", "getFile", "download"]);
    const restore = await import("./restore-apply.ts");
    expect(restore.readPendingRestore(DATA_DIR)).toMatchObject({ source: "telegram" });
    const sync = await import("./sync-state.ts");
    expect(sync.readSyncState("local").lastPull).toMatchObject({ channel: "telegram" });
  });

  it("pull discovers a document in the chat when no v2 file id is cached yet", async () => {
    // Seed the chat the way an owner who forwarded the backup to the bot
    // would have left it: a document, and no remembered id on this machine.
    const sealed = bundle.encryptBundleV2(
      bundle.buildPayloadV2({ dataDir: DATA_DIR, appVersion: "0.0.0-test" }),
      { passphrase: PASSPHRASE },
    );
    trace.stored = sealed.toString("utf8");
    trace.documentFileId = FILE_ID;
    const reply = await call("POST", PULL_ROUTE, { passphrase: PASSPHRASE, confirm: true });
    expect(reply.status).toBe(200);
    expect(reply.json).toMatchObject({ staged: true, restartRequired: true });
    expect(trace.calls).toEqual(["getUpdates", "getFile", "download"]);
    const restore = await import("./restore-apply.ts");
    expect(restore.readPendingRestore(DATA_DIR)).toMatchObject({ source: "telegram" });
  });

  it("an empty chat answers 404 and stages nothing", async () => {
    const reply = await call("POST", PULL_ROUTE, { passphrase: PASSPHRASE, confirm: true });
    expect(reply.status).toBe(404);
    expect(String(reply.json.error)).toContain("no workspace bundle in the Telegram chat yet");
    const restore = await import("./restore-apply.ts");
    expect(restore.readPendingRestore(DATA_DIR)).toBeNull();
  });

  it("rejects a short passphrase before any Telegram call", async () => {
    const pushed = await call("POST", PUSH_ROUTE, { passphrase: "brief" });
    expect(pushed.status).toBe(400);
    expect(String(pushed.json.error)).toContain("at least 8 characters");
    const pulled = await call("POST", PULL_ROUTE, { passphrase: "brief" });
    expect(pulled.status).toBe(400);
    expect(trace.calls).toEqual([]);
  });

  it("an unconnected installation says so instead of pretending to have a bus", async () => {
    writeTelegramConfig(false);
    const pushed = await call("POST", PUSH_ROUTE, { passphrase: PASSPHRASE });
    expect(pushed.status).toBe(400);
    expect(String(pushed.json.error)).toContain("Telegram is not connected yet");
    const pulled = await call("POST", PULL_ROUTE, { passphrase: PASSPHRASE });
    expect(pulled.status).toBe(400);
    expect(String(pulled.json.error)).toContain("Telegram is not connected yet");
    expect(trace.calls).toEqual([]);
  });

  it("a wrong passphrase stages nothing and keeps the live workspace", async () => {
    expect((await call("POST", PUSH_ROUTE, { passphrase: PASSPHRASE })).status).toBe(200);
    const pulled = await call("POST", PULL_ROUTE, { passphrase: "a-different-passphrase", confirm: true });
    expect(pulled.status).toBe(400);
    // The envelope's AEAD rejects a wrong key — the v2 wording is
    // "did not authenticate", matching the v2 Drive pull's error verbatim.
    expect(String(pulled.json.error)).toContain("did not authenticate");
    const restore = await import("./restore-apply.ts");
    expect(restore.readPendingRestore(DATA_DIR)).toBeNull();
  });

  // LAST on purpose: it rebuilds the module registry with SELF_HOSTED on.
  it("the hosted wall claims both v2 Telegram routes", async () => {
    try {
      vi.stubEnv("OMB_HOST", "0.0.0.0");
      vi.resetModules();
      routes = await import("./workspace-backup-routes.ts");
      for (const path of [PUSH_ROUTE, PULL_ROUTE]) {
        const reply = await call("POST", path, { passphrase: PASSPHRASE });
        expect(reply.status).toBe(403);
        expect(reply.json.code).toBe("WORKSPACE_BACKUP_UNAVAILABLE");
      }
      expect(trace.calls).toEqual([]);
    } finally {
      vi.stubEnv("OMB_HOST", "127.0.0.1");
      vi.resetModules();
      routes = await import("./workspace-backup-routes.ts");
    }
  });
});
