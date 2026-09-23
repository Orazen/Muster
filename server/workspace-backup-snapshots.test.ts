// Snapshot automation routes (B1): the Settings policy view, the policy
// edit, a manual run through the SAME runner the scheduler uses, and the
// passphrase-store decision — plus the hosted wall's desktop-only 403 over
// all of them.
//
// Environment: GOOGLE_*/OMB_*/BETTER_AUTH_SECRET stubbed BEFORE the dynamic
// import (drive-sync reads the client and auth.ts resolves SELF_HOSTED +
// its secret at module load), a real http server on an ephemeral port with
// RAW http.request clients (global fetch is stubbed for the Drive router),
// a stateful fake passphrase store injected through the runner's seam so no
// test ever touches a real Keychain, and one fetch router answering oauth /
// upload / download / list / delete by URL for the run-success path.
//
// Why http.request instead of fetch: this file stubs global fetch for Drive,
// so the client side must not go through the same global.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR, loadConfig } from "./config.ts";
import type { PassphraseStore } from "./keychain-store.ts";
import type { JsonValue } from "./schema.ts";
import { RETENTION_DEFAULTS } from "./snapshot-state.ts";

const PASSPHRASE = "correct-horse-battery-staple";
const PASSPHRASE_ROUTE = "/api/workspace/snapshots/passphrase";
const POLICY_ROUTE = "/api/workspace/snapshots/policy";
const RUN_ROUTE = "/api/workspace/snapshots/run";

type RoutesModule = typeof import("./workspace-backup-routes.ts");
type RunnerModule = typeof import("./snapshot-runner.ts");
type StateModule = typeof import("./snapshot-state.ts");

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
  // SAFETY: every response asserted here is JSON; each test reads only the
  // fields it checks (the same shape server/index.test.ts types replies to).
  json: any;
}

let routes: RoutesModule;
let runner: RunnerModule;
let state: StateModule;
let server: Server;
let port = 0;

// Stateful fake store — closure vars are reset per test, the store instance
// reads them live, so one install serves every case (re-installed after any
// resetModules so the current runner module holds it).
let stored: string | null;
let storeAvailableFlag: boolean;
let failSet: boolean;
let failClear: boolean;

function installFakeStore(): void {
  const store: PassphraseStore = {
    status: () => (storeAvailableFlag ? "available" : "unavailable"),
    get: async () => stored,
    getSync: () => stored,
    has: async () => stored !== null,
    set: async (value: string) => {
      if (failSet) return false;
      stored = value;
      return true;
    },
    clear: async () => {
      if (failClear) return false;
      stored = null;
      return true;
    },
  };
  runner.overrideSnapshotPassphraseStore(store);
}

function writeDriveConfig(): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(join(DATA_DIR, "config.json"), JSON.stringify({ driveSync: { refreshToken: "refresh-token-fixture" } }), { mode: 0o600 });
}

/** Per-test isolation: the automation state file and the drive config (NOT
 * the whole dir — auth.ts holds auth.db open across this file's lifetime). */
function resetAutomationState(): void {
  rmSync(join(DATA_DIR, "snapshot-state"), { recursive: true, force: true });
  rmSync(join(DATA_DIR, "config.json"), { force: true });
}

interface RemoteFile {
  id: string;
  name: string;
  createdTime: string;
}

interface RouterOptions {
  uploaded?: RemoteFile;
  uploadStatus?: number;
}

interface RouterTrace {
  deleted: string[];
  downloads: number;
  uploads: number;
}

function installRouter(options: RouterOptions = {}): RouterTrace {
  const trace: RouterTrace = { deleted: [], downloads: 0, uploads: 0 };
  let uploadedPayload: string | null = null;
  const fetchMock = vi.fn<typeof fetch>();
  fetchMock.mockImplementation(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.startsWith("https://oauth2.googleapis.com/")) {
      return Response.json({ access_token: "access-token-fixture", expires_in: 3600 });
    }
    if (method === "POST" && url.startsWith("https://www.googleapis.com/upload/drive/v3/files")) {
      trace.uploads += 1;
      const body = String(init?.body ?? "");
      const marker = "Content-Type: application/octet-stream\r\n\r\n";
      const start = body.indexOf(marker);
      const end = body.lastIndexOf("\r\n--");
      if (start < 0 || end < start) throw new Error("fixture: payload part not found in the upload body");
      uploadedPayload = body.slice(start + marker.length, end);
      if (options.uploadStatus !== undefined && options.uploadStatus !== 200) {
        return new Response("upload rejected", { status: options.uploadStatus });
      }
      return Response.json({ id: "snap-new", name: "muster-workspace-v2-1730000000000-cafebabe.enc" });
    }
    if (method === "DELETE") {
      const id = decodeURIComponent(url.split("/files/")[1]?.split("?")[0] ?? "");
      trace.deleted.push(id);
      return Response.json({ id });
    }
    if (url.includes("alt=media")) {
      trace.downloads += 1;
      if (uploadedPayload === null) throw new Error("fixture: download happened before any upload");
      return new Response(uploadedPayload);
    }
    if (url.includes("/drive/v3/files?")) {
      const files: RemoteFile[] = [];
      if (options.uploaded !== undefined) files.push(options.uploaded);
      return Response.json({ files });
    }
    throw new Error(`fixture: unexpected fetch ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return trace;
}

const uploadedFile = (): RemoteFile => ({
  id: "snap-new",
  name: "muster-workspace-v2-1730000000000-cafebabe.enc",
  createdTime: new Date().toISOString(),
});

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
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body: text, json });
      });
    });
    outgoing.on("error", reject);
    if (payload !== undefined) outgoing.write(payload);
    outgoing.end();
  });
}

beforeAll(async () => {
  vi.stubEnv("GOOGLE_CLIENT_ID", "fixture-client-id");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "fixture-client-secret");
  vi.stubEnv("OMB_HOST", "127.0.0.1");
  vi.stubEnv("OMB_PUBLIC_HOST", "");
  // auth.ts resolves its secret at module load; the hosted re-import later
  // in this file would throw without it (SELF_HOSTED requires the env form).
  vi.stubEnv("BETTER_AUTH_SECRET", "fixture-secret-0123456789abcdef0123456789abcdef0123456789abcdef");
  mkdirSync(DATA_DIR, { recursive: true });
  routes = await import("./workspace-backup-routes.ts");
  runner = await import("./snapshot-runner.ts");
  state = await import("./snapshot-state.ts");
  server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        // requestUserId stays null on purpose: these routes are
        // installation-scoped — no session, exact push/pull parity.
        const handled = await routes.handleWorkspaceBackupRoute(req, res, req.method ?? "GET", url.pathname, null, ctx);
        if (!handled) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "not found" }));
        }
      } catch (error) {
        // index.ts maps its own { status } rejections; this harness reports
        // the rest loudly as 500 so a throwing handler cannot pass silently.
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        }
      }
    })();
  });
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  // SAFETY: a TCP listener bound to 127.0.0.1 always reports AddressInfo; the
  // string form comes only from pipe:/unix: listeners, which this fixture never creates.
  const address = server.address() as AddressInfo | null;
  if (address === null) throw new Error("fixture server did not bind an ephemeral port");
  port = address.port;
});

beforeEach(() => {
  stored = null;
  storeAvailableFlag = true;
  failSet = false;
  failClear = false;
  resetAutomationState();
  installFakeStore();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await new Promise<void>((resolve) => { server.close(() => resolve()); });
  vi.unstubAllEnvs();
});

describe("snapshot automation routes", () => {
  it("GET policy answers the default view with no session and no caching", async () => {
    const reply = await call("GET", POLICY_ROUTE);
    expect(reply.status).toBe(200);
    expect(reply.headers["cache-control"]).toBe("no-store");
    expect(reply.json.policy).toEqual({ nightlyEnabled: true, retention: { ...RETENTION_DEFAULTS } });
    expect(reply.json.store).toEqual({ status: "available", hasPassphrase: false });
    expect(reply.json.driveConnected).toBe(false);
    expect(reply.json.health).toBeNull();
    expect(reply.json.runs).toMatchObject({ lastAttemptAt: null, lastOutcome: null, consecutiveFailures: 0 });
    expect(reply.json.history).toEqual([]);
    expect(reply.json.nextNightlyAt).toBeGreaterThanOrEqual(Date.now());
    // no session, requestUserId null — the view still answers (installation
    // scope, exact parity with v2/drive/push|pull)
    expect(reply.body).not.toContain(PASSPHRASE);
  });

  it("POST policy merges only the named fields and persists for a later GET", async () => {
    const posted = await call("POST", POLICY_ROUTE, { nightlyEnabled: false, retention: { daily: 12 } });
    expect(posted.status).toBe(200);
    expect(posted.json.policy).toEqual({ nightlyEnabled: false, retention: { recent: 7, daily: 12, weekly: 4, monthly: 6 } });
    expect(posted.headers["cache-control"]).toBe("no-store");

    const fetched = await call("GET", POLICY_ROUTE);
    expect(fetched.json.policy).toEqual(posted.json.policy);
    expect(state.readSnapshotState().policy).toEqual(posted.json.policy);
  });

  it.each([
    ["an unknown key", { unexpected: true }],
    ["a non-boolean toggle", { nightlyEnabled: "yes" }],
    ["an out-of-range bucket", { retention: { daily: 61 } }],
    ["a negative bucket", { retention: { weekly: -1 } }],
    ["a fractional bucket", { retention: { recent: 1.5 } }],
    ["a non-object body", "just a string"],
  ])("POST policy rejects %s with per-field issues and leaves state untouched", async (_label, body) => {
    const reply = await call("POST", POLICY_ROUTE, body);
    expect(reply.status).toBe(400);
    expect(reply.json.error).toBe("invalid snapshot policy");
    expect(Array.isArray(reply.json.issues)).toBe(true);
    expect(reply.json.issues.length).toBeGreaterThan(0);
    expect(reply.json.issues[0]).toMatchObject({ path: expect.any(String), message: expect.any(String) });
    expect(state.readSnapshotState().policy).toEqual({ nightlyEnabled: true, retention: { ...RETENTION_DEFAULTS } });
  });

  it.each([
    ["drive-not-connected", false, true, "Google Drive is not connected"],
    ["store-unavailable", true, false, "trusted passphrase store"],
    ["no-passphrase", true, true, "No snapshot passphrase"],
  ])("POST run closes at the %s gate with an explanation and no run-log entry", async (reason, withDrive, available, expectedText) => {
    if (withDrive) writeDriveConfig();
    storeAvailableFlag = available;
    const reply = await call("POST", RUN_ROUTE);
    expect(reply.status).toBe(409);
    expect(reply.json).toMatchObject({ ok: false, skipped: reason });
    expect(String(reply.json.error)).toContain(expectedText);
    // a manual attempt that never fired stays OFF the disk — the wire already
    // told the operator (only nightly gate-skips are recorded)
    expect(state.readSnapshotState().history).toEqual([]);
    expect(state.readSnapshotState().runs.lastAttemptAt).toBeNull();
  });

  it("POST run ships a verified snapshot, marks health and records the run", async () => {
    writeDriveConfig();
    stored = PASSPHRASE;
    const trace = installRouter({ uploaded: uploadedFile() });
    const reply = await call("POST", RUN_ROUTE);
    expect(reply.status).toBe(200);
    expect(reply.json).toMatchObject({ ok: true, snapshotId: "snap-new", pruned: 0, pruneFailed: 0 });
    expect(trace.uploads).toBe(1);
    expect(trace.downloads).toBe(1);
    const after = state.readSnapshotState();
    expect(after.health).toMatchObject({ snapshotId: "snap-new", name: uploadedFile().name });
    expect(after.history[0]).toMatchObject({ reason: "manual", outcome: "success", uploadedId: "snap-new" });
    expect(after.runs.lastOutcome).toBe("success");
    expect(after.runs.consecutiveFailures).toBe(0);
  });

  it("POST run reports a failed upload as 502 and moves no health marker", async () => {
    writeDriveConfig();
    stored = PASSPHRASE;
    installRouter({ uploadStatus: 500 });
    const reply = await call("POST", RUN_ROUTE);
    expect(reply.status).toBe(502);
    expect(reply.json.ok).toBe(false);
    expect(String(reply.json.error)).toContain("the snapshot failed:");
    const after = state.readSnapshotState();
    expect(after.health).toBeNull();
    expect(after.history[0]).toMatchObject({ reason: "manual", outcome: "failed" });
    expect(after.runs.lastOutcome).toBe("failed");
  });

  it("POST policy surfaces a blocked state write as 500 instead of a silent success", async () => {
    // automation.json as a DIRECTORY: every read degrades to defaults, every
    // atomic rename fails — the route must SAY so.
    mkdirSync(join(DATA_DIR, "snapshot-state", "automation.json"), { recursive: true });
    const reply = await call("POST", POLICY_ROUTE, { nightlyEnabled: false });
    expect(reply.status).toBe(500);
    expect(String(reply.json.error)).toContain("could not be saved");
  });

  it("passphrase set → view reports stored → DELETE clears, and no reply ever carries the passphrase", async () => {
    const set = await call("POST", PASSPHRASE_ROUTE, { passphrase: PASSPHRASE });
    expect(set.status).toBe(200);
    expect(set.json).toEqual({ stored: true });
    expect(set.body).not.toContain(PASSPHRASE);

    const view = await call("GET", POLICY_ROUTE);
    expect(view.json.store).toEqual({ status: "available", hasPassphrase: true });
    expect(view.body).not.toContain(PASSPHRASE);

    const cleared = await call("DELETE", PASSPHRASE_ROUTE);
    expect(cleared.status).toBe(200);
    expect(cleared.json).toEqual({ cleared: true });
    expect(cleared.body).not.toContain(PASSPHRASE);

    const after = await call("GET", POLICY_ROUTE);
    expect(after.json.store).toEqual({ status: "available", hasPassphrase: false });
    expect(after.body).not.toContain(PASSPHRASE);
    expect(stored).toBeNull();
  });

  it("POST passphrase rejects a short or missing passphrase with 400 and stores nothing", async () => {
    const short = await call("POST", PASSPHRASE_ROUTE, { passphrase: "brief" });
    expect(short.status).toBe(400);
    expect(String(short.json.error)).toContain("at least 8 characters");
    const missing = await call("POST", PASSPHRASE_ROUTE, {});
    expect(missing.status).toBe(400);
    expect(stored).toBeNull();
    expect((await call("GET", POLICY_ROUTE)).json.store.hasPassphrase).toBe(false);
  });

  it("answers 501 on both verbs before the body matters when no store exists", async () => {
    storeAvailableFlag = false;
    // deliberately invalid body: the 501 must win (checked before the body)
    const post = await call("POST", PASSPHRASE_ROUTE, { passphrase: "x" });
    expect(post.status).toBe(501);
    expect(String(post.json.error)).toContain("not available");
    const del = await call("DELETE", PASSPHRASE_ROUTE);
    expect(del.status).toBe(501);
    expect(String(del.json.error)).toContain("not available");
  });

  it("reports store failures as a generic 502 that never echoes the passphrase", async () => {
    failSet = true;
    const set = await call("POST", PASSPHRASE_ROUTE, { passphrase: PASSPHRASE });
    expect(set.status).toBe(502);
    expect(set.body).not.toContain(PASSPHRASE);
    expect(stored).toBeNull();

    failSet = false;
    expect((await call("POST", PASSPHRASE_ROUTE, { passphrase: PASSPHRASE })).status).toBe(200);
    failClear = true;
    const del = await call("DELETE", PASSPHRASE_ROUTE);
    expect(del.status).toBe(502);
    expect(del.body).not.toContain(PASSPHRASE);
    // the clear did not happen — the view still says stored
    expect((await call("GET", POLICY_ROUTE)).json.store.hasPassphrase).toBe(true);
  });

  it("claims nothing for unknown paths and mismatched methods", async () => {
    expect((await call("GET", RUN_ROUTE)).status).toBe(404);
    expect((await call("DELETE", POLICY_ROUTE)).status).toBe(404);
    expect((await call("PUT", POLICY_ROUTE, {})).status).toBe(404);
    expect((await call("POST", "/api/workspace/snapshots/nope", {})).status).toBe(404);
  });

  // LAST on purpose: it rebuilds the module registry with SELF_HOSTED on.
  it("the hosted wall answers every snapshot route with the desktop-only 403", async () => {
    try {
      vi.stubEnv("OMB_HOST", "0.0.0.0");
      vi.resetModules();
      routes = await import("./workspace-backup-routes.ts");
      runner = await import("./snapshot-runner.ts");
      installFakeStore();

      const view = await call("GET", POLICY_ROUTE);
      expect(view.status).toBe(403);
      expect(view.json.code).toBe("WORKSPACE_BACKUP_UNAVAILABLE");
      expect((await call("POST", POLICY_ROUTE, { nightlyEnabled: false })).status).toBe(403);
      expect((await call("POST", RUN_ROUTE)).status).toBe(403);
      expect((await call("POST", PASSPHRASE_ROUTE, { passphrase: PASSPHRASE })).status).toBe(403);
      expect((await call("DELETE", PASSPHRASE_ROUTE)).status).toBe(403);
      // the wall fired before any handler: nothing was stored or run
      expect(stored).toBeNull();
      expect(state.readSnapshotState().history).toEqual([]);
    } finally {
      vi.stubEnv("OMB_HOST", "127.0.0.1");
      vi.resetModules();
      routes = await import("./workspace-backup-routes.ts");
      runner = await import("./snapshot-runner.ts");
      state = await import("./snapshot-state.ts");
      installFakeStore();
    }
  });
});
