// Live acceptance for the storage-sovereignty gate (decision 14,
// docs/plans/cloud-relay-strategy-2026-09-18.md): on a hosted deployment a
// fresh signup's workspace is locked until they connect their OWN Google
// Drive; on a local desktop install nothing is gated. The hosted boot uses
// the owned synthetic Google transport (no outbound network, credentials
// pinned by the fixture) exactly like server/account-drive-roundtrip.test.ts.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { pairingServerEnvironment, waitForOwnedServer } from "../e2e/pairing-harness.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { createWorkspaceDriveFixture } from "./testing/workspace-drive-fixture.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
/** The callback answers 302; undici with redirect:"error" surfaces exactly this. */
const REDIRECTED = "Error: unexpected redirect";

interface Booted {
  url: string;
  directory: string;
  dataDirectory: string;
  cookie: string;
  userId: string;
}

describe.skipIf(process.platform === "win32")("storage sovereignty gate", () => {
  let rootDirectory = "";
  const children: ChildProcess[] = [];
  let transport: ReturnType<typeof createWorkspaceDriveFixture>;
  let hosted: Booted;
  let local: Booted;
  let createdBotId = "";

  const api = (server: Booted, path: string, opts: RequestInit = {}) =>
    fetch(`${server.url}${path}`, { redirect: "error", signal: AbortSignal.timeout(15_000), ...opts });

  const expectRedirect = async (server: Booted, path: string) => {
    try {
      const response = await api(server, path, { headers: { cookie: server.cookie } });
      throw new Error(`expected a redirect, got ${response.status}: ${(await response.text()).slice(0, 200)}`);
    } catch (error) {
      // SAFETY: undici raises TypeError with a `cause` when redirect:"error"
      // fires; other rejections propagate unchanged below.
      const cause = String((error as { cause?: unknown }).cause);
      if (cause === REDIRECTED) return true;
      throw error;
    }
  };

  const gate = async (server: Booted) => {
    const response = await api(server, "/api/config", { headers: { cookie: server.cookie } });
    expect(response.status).toBe(200);
    return z.object({ storageGate: z.object({ required: z.boolean(), satisfied: z.boolean() }) })
      .parse(await response.json()).storageGate;
  };

  const boot = async (kind: "hosted" | "local", port: number, withTransport: boolean) => {
    const directory = join(rootDirectory, `${kind}-${randomBytes(4).toString("hex")}`);
    const dataDirectory = join(directory, "data");
    const home = join(directory, "home"), companion = join(directory, "companion"), ui = join(directory, "ui");
    for (const p of [dataDirectory, home, companion, ui]) mkdirSync(p, { recursive: true, mode: 0o700 });
    writeFileSync(join(ui, "index.html"), `<!doctype html><title>Storage-gate ${kind} fixture</title>`);
    // No telegramSync anywhere: the Drive connect is the only path that can
    // satisfy the gate in this fixture.
    writeFileSync(join(dataDirectory, "config.json"), JSON.stringify({
      instances: { ghost: { driver: "not-a-real-driver", displayName: "Offline storage-gate fixture" } },
    }), { mode: 0o600 });
    const env = pairingServerEnvironment({ home, dataDirectory, companionDirectory: companion, staticDir: ui, port, webhookPort: port + 1, secret: randomBytes(32).toString("hex") });
    Object.assign(env, { OMB_ALLOW_SIGNUPS: "true" });
    if (kind === "hosted") {
      // Explicit public-host configuration makes SELF_HOSTED true while the
      // owned listener itself remains confined to loopback.
      env.OMB_PUBLIC_HOST = `127.0.0.1:${port}`;
    }
    const child = spawn(
      process.execPath,
      withTransport
        ? ["--import", transport.preloadPath, "--experimental-strip-types", join(ROOT, "server/index.ts")]
        : ["--experimental-strip-types", join(ROOT, "server/index.ts")],
      { cwd: ROOT, env: withTransport ? Object.assign(env, transport.env) : env, stdio: ["ignore", "pipe", "pipe"] },
    );
    children.push(child);
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", () => {});
    const url = `http://127.0.0.1:${port}`;
    await waitForOwnedServer(child, url);

    const signup = await fetch(`${url}/api/auth/sign-up/email`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { "content-type": "application/json", origin: url },
      body: JSON.stringify({ email: `gate-${randomBytes(6).toString("hex")}@example.test`, password: randomBytes(24).toString("base64url"), name: `Gate ${kind}` }),
    });
    expect(signup.status).toBe(200);
    // SAFETY: better-auth always sets this cookie name on email signup.
    const cookie = (signup.headers.getSetCookie?.() ?? []).find((c) => c.startsWith("better-auth.session_token="))?.split(";")[0] ?? "";
    expect(cookie).not.toBe("");
    // SAFETY: the sign-up endpoint answers {user:{id}}; emptiness is asserted.
    const userId = ((await signup.json()) as { user?: { id?: string } }).user?.id ?? "";
    expect(userId).not.toBe("");
    return { url, directory, dataDirectory, cookie, userId };
  };

  beforeAll(async () => {
    rootDirectory = mkdtempSync(join(tmpdir(), "muster-storage-gate-"));
    transport = createWorkspaceDriveFixture(join(rootDirectory, "google"));
    const hostedPort = await freePortBlock([0], 47000, 9000);
    const localPort = await freePortBlock([1], 47000, 9000);
    hosted = await boot("hosted", hostedPort, true);
    local = await boot("local", localPort, false);
  }, 60_000);

  afterAll(async () => {
    transport?.setMode("ok");
    await Promise.all(children.map((c) => waitForExit(c, { signal: "SIGTERM" })));
    const exited = children.every((c) => c.exitCode !== null || c.signalCode !== null);
    const noOutbound = !existsSync(transport.networkLog);
    const noCredentialMismatch = transport.entries().every((entry) => entry.credentialsMatch);
    if (rootDirectory && exited) await removeTempDir(rootDirectory);
    const rootRemoved = !rootDirectory || !existsSync(rootDirectory);
    expect({ exited, noOutbound, noCredentialMismatch, rootRemoved }).toEqual({ exited: true, noOutbound: true, noCredentialMismatch: true, rootRemoved: true });
  }, 20_000);

  it("locks a fresh hosted workspace until the user's own Drive is connected", async () => {
    // The gate is advertised honestly…
    expect(await gate(hosted)).toEqual({ required: true, satisfied: false });
    // …and enforced where durable state is created.
    const denied = await api(hosted, "/api/bots", {
      method: "POST", headers: { "content-type": "application/json", cookie: hosted.cookie }, body: JSON.stringify({}),
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: "STORAGE_GATE_REQUIRED" });

    // A local desktop signup has NO gate: the machine is the storage.
    expect(await gate(local)).toEqual({ required: false, satisfied: true });
    const localBot = await api(local, "/api/bots", {
      method: "POST", headers: { "content-type": "application/json", cookie: local.cookie }, body: JSON.stringify({}),
    });
    expect(localBot.status).toBe(201);

    // The real connect flow: a Google account row (Drive grants attach to an
    // existing row) without tokens, the signed consent URL, the exchange —
    // then the gate opens and the same create succeeds.
    const db = new DatabaseSync(join(hosted.dataDirectory, "auth.db"));
    try {
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO account (id,accountId,providerId,userId,accessToken,refreshToken,scope,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(randomBytes(16).toString("hex"), randomBytes(16).toString("hex"), "google", hosted.userId,
          null, null, "", now, now);
    } finally { db.close(); }
    expect(await gate(hosted)).toEqual({ required: true, satisfied: false });

    const connect = await api(hosted, "/api/workspace/google/connect", { headers: { cookie: hosted.cookie } });
    expect(connect.status).toBe(200);
    const { url: consent } = z.object({ url: z.string() }).parse(await connect.json());
    const parsed = new URL(consent);
    expect(parsed.origin + parsed.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(parsed.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/drive.appdata");
    const state = parsed.searchParams.get("state") ?? "";
    expect(state.split(".")[0]).toBe(hosted.userId);
    expect(await expectRedirect(hosted, `/api/workspace/google/callback?code=owned-consent-code&state=${encodeURIComponent(state)}`)).toBe(true);

    expect(await gate(hosted)).toEqual({ required: true, satisfied: true });
    const created = await api(hosted, "/api/bots", {
      method: "POST", headers: { "content-type": "application/json", cookie: hosted.cookie }, body: JSON.stringify({}),
    });
    expect(created.status).toBe(201);
    // SAFETY: the wire bot carries its id on every create response.
    createdBotId = ((await created.json()) as { bot?: { id?: string } }).bot?.id ?? "";
    expect(createdBotId).not.toBe("");

    // The work surface carries the same gate before storage exists: a bot
    // that predates the gate (e.g. an install-level seed) cannot be tasked
    // by a gated user. Drive here is the owned fixture transport.
    const roster = await api(hosted, "/api/bots", { headers: { cookie: hosted.cookie } });
    expect(roster.status).toBe(200);
  }, 30_000);

  it("sends the same refusal for work on a gated user's thread", async () => {
    // Re-close the gate at its honest pre-consent shape (row exists, no
    // Drive grant) and prove the SEND surface refuses too — a bot created
    // before the gate closed cannot be tasked.
    const db = new DatabaseSync(join(hosted.dataDirectory, "auth.db"));
    try {
      db.prepare(`UPDATE "account" SET "refreshToken" = NULL WHERE "userId" = ?`).run(hosted.userId);
    } finally { db.close(); }
    expect(await gate(hosted)).toEqual({ required: true, satisfied: false });
    const send = await api(hosted, `/api/bots/${createdBotId}/messages`, {
      method: "POST", headers: { "content-type": "application/json", cookie: hosted.cookie }, body: JSON.stringify({ text: "hello" }),
    });
    expect(send.status).toBe(403);
    expect(await send.json()).toMatchObject({ code: "STORAGE_GATE_REQUIRED" });
  }, 20_000);
});
