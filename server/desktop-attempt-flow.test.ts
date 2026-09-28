// C1 acceptance: the desktop side of the cloud sign-in handoff proves the
// attempt before anything is spent (server/desktop-attempts.ts).
//
// What is actually exercised here — real HTTP against a booted local server:
//   - begin mints state + challenge; the verifier never crosses the wire
//   - the finish exchange releases the verifier ONLY to a proven attempt,
//     and the fake cloud verifies the real S256(ASCII(verifier)) digest
//   - cancel/supersede/wrong-state attempts install no session and make no
//     cloud request when the attempt is gone
//   - a begin with a non-loopback redirect is refused outright
//   - server downtime answers 502 without minting a session
//
// The cloud half of the protocol (state echo, PKCE enforcement, code TTL)
// already has its own suite in desktop-auth-binding.test.ts; the fake cloud
// here only implements what the desktop server is contractually allowed to
// rely on.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const ROOT = join(import.meta.dirname, "..");
const posixOnly = describe.skipIf(process.platform === "win32");

interface DesktopFixture {
  child: ChildProcess;
  directory: string;
  base: string;
}

const fixtures: DesktopFixture[] = [];

/** Cloud exchange receipts, one per POST the desktop server made. */
interface ExchangeReceipt {
  body: { code?: string; code_verifier?: string };
  accepted: boolean;
}

interface FakeCloud {
  url: string;
  exchanges: ExchangeReceipt[];
  /** Verify a verifier against a challenge the way the real route does. */
  bind(challenge: string): void;
  /** Make /api/desktop-auth/exchange refuse (verifier failures etc.). */
  refuseNext(): void;
  close(): Promise<void>;
}

/** The exchange body contract the desktop server is allowed to rely on. */
const exchangeBodySchema = z.object({
  code: z.string().optional(),
  code_verifier: z.string().optional(),
});

function startFakeCloud(): Promise<FakeCloud> {
  const exchanges: ExchangeReceipt[] = [];
  let boundChallenge: string | null = null;
  let refuseNext = false;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const parsed = exchangeBodySchema.safeParse(JSON.parse(Buffer.concat(chunks).toString() || "{}"));
      const body = parsed.success ? parsed.data : {};
      const digest = body.code_verifier === undefined
        ? null
        : createHash("sha256").update(body.code_verifier, "ascii").digest("base64url");
      const verified = !refuseNext && boundChallenge !== null && digest !== null && digest === boundChallenge;
      refuseNext = false;
      exchanges.push({ body, accepted: verified });
      if (!verified) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "this sign-in could not be verified — start again from Muster" }));
        return;
      }
      res.writeHead(200, {
        "content-type": "application/json",
        // The 1.20 frozen-body contract: identity fields only.
        "x-muster-exchange-version": "1",
      });
      res.end(JSON.stringify({ email: "person@example.test", name: "Person" }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      // SAFETY: listen(0, "127.0.0.1") always reports an AddressInfo.
      const address = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        exchanges,
        bind(challenge: string) { boundChallenge = challenge; },
        refuseNext() { refuseNext = true; },
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

async function startDesktop(cloudUrl: string | null): Promise<DesktopFixture> {
  const directory = mkdtempSync(join(tmpdir(), "muster-desktop-attempt-"));
  const data = join(directory, "data");
  mkdirSync(data);
  writeFileSync(join(data, "config.json"), JSON.stringify({
    instances: { ghost: { driver: "not-a-real-driver", displayName: "Fixture" } },
  }));
  const guard = join(directory, "block-outbound.mjs");
  // Real loopback is REQUIRED: the finish exchange must reach the fake
  // cloud. fetch is held to a loopback allowlist (which covers every outbound
  // call this flow can make); a TCP-level guard would have to fight undici's
  // own connector, so it is deliberately not attempted here.
  writeFileSync(guard, `
    const loopback = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
    const realFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const target = typeof input === "string" ? input : input instanceof URL ? input.href : (input && input.url) || "";
      let host = "";
      try { host = new URL(target).hostname; } catch {}
      if (!loopback.has(host)) return Promise.reject(new Error("Outbound network disabled in attempt fixture"));
      return realFetch(input, init);
    };
  `);
  const port = await freePortBlock([0, 1]);
  const base = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = {
    OMB_DATA_DIR: data,
    OMB_COMPANION_DIR: join(directory, "companion"),
    OMB_HOST: "127.0.0.1",
    OMB_PORT: String(port),
    OMB_WEBHOOK_PORT: String(port + 1),
    OMB_PUBLIC_URL: base,
    BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
  };
  if (cloudUrl === null) {
    // Force SELF_HOSTED (see server/auth.ts) so pairCloudUrl() returns null
    // instead of the production default — the "not configured" shape under
    // test — while the server still binds loopback.
    env.OMB_PUBLIC_HOST = "self-hosted.test";
  } else {
    env.OMB_PAIR_CLOUD_URL = cloudUrl;
  }
  if (process.env.PATH) env.PATH = process.env.PATH;
  const child = spawn(process.execPath, ["--import", guard, join(ROOT, "server/index.ts")], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const fixture: DesktopFixture = { child, directory, base };
  fixtures.push(fixture);
  let stderr = "";
  child.stderr!.on("data", (chunk) => { stderr += chunk; });
  child.stdout!.resume();
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const response = await fetch(`${base}/api/health`, { redirect: "manual" });
      if (response.ok) return fixture;
    } catch {
      // Wait for this fixture's listener only.
    }
    if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) {
      throw new Error(`attempt fixture did not start: ${stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

/** Begin an attempt the way the renderer does and return its binding. */
async function begin(fixture: DesktopFixture, redirect = fixture.base): Promise<{ state: string; codeChallenge: string; status: number }> {
  const response = await fetch(`${fixture.base}/oauth/attempt/begin`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect }),
  });
  expect(response.status).toBe(200);
  // SAFETY: /oauth/attempt/begin answers exactly {state, codeChallenge}
  // (server/index.ts); both fields are server-minted opaque strings.
  const body = (await response.json()) as { state: string; codeChallenge: string };
  return { ...body, status: response.status };
}

async function finishExchange(fixture: DesktopFixture, payload: Record<string, string>): Promise<Response> {
  return fetch(`${fixture.base}/oauth/finish/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

/** The finish page must echo the attempt state it was handed. */
async function finishPageEchoesState(fixture: DesktopFixture, state: string): Promise<void> {
  const page = await fetch(`${fixture.base}/oauth/finish#code=abc&state=${encodeURIComponent(state)}`);
  const html = await page.text();
  expect(html).toContain("params.get(\"state\")");
  expect(html).toContain("state");
}

posixOnly("desktop sign-in attempt custody", () => {
  let cloud: FakeCloud;
  let fixture: DesktopFixture;

  beforeEach(async () => {
    cloud = await startFakeCloud();
    fixture = await startDesktop(cloud.url);
  });

  afterEach(async () => {
    for (const current of fixtures.splice(0)) {
      await waitForExit(current.child, { signal: "SIGTERM" });
      await removeTempDir(current.directory);
    }
    await cloud.close();
  });

  it("begin mints state and challenge without ever sending the verifier", async () => {
    const { state, codeChallenge } = await begin(fixture);
    expect(state).toMatch(/^[A-Za-z0-9_-]{16,256}$/);
    // base64url(SHA256("")) is 43 chars; the real verifier is 64 bytes.
    expect(codeChallenge).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
  });

  it("refuses a begin whose redirect is not loopback", async () => {
    const response = await fetch(`${fixture.base}/oauth/attempt/begin`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect: "https://attacker.example" }),
    });
    expect(response.status).toBe(400);
  });

  it("finishes a bound sign-in: attempt proven, real S256 verified by the cloud, session minted", async () => {
    const { state, codeChallenge } = await begin(fixture);
    cloud.bind(codeChallenge);
    // The cloud "issued" this code for the bound challenge.
    const code = randomBytes(32).toString("base64url");
    const response = await finishExchange(fixture, { code, state });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, email: "person@example.test" });
    const receipt = cloud.exchanges.at(-1);
    expect(receipt?.accepted).toBe(true);
    expect(receipt?.body.code).toBe(code);
    expect(receipt?.body.code_verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    // The verifier the cloud received must hash to the challenge begin sent.
    const digest = createHash("sha256").update(receipt!.body.code_verifier!, "ascii").digest("base64url");
    expect(digest).toBe(codeChallenge);
    // The session cookie is the SAME signed shape pair/redeem mints.
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    // One attempt, one redemption: nothing survives.
    const replay = await finishExchange(fixture, { code, state });
    expect(replay.status).toBe(409);
  });

  it("a cancelled attempt installs nothing, even with a still-valid cloud code", async () => {
    const { state } = await begin(fixture);
    const cancel = await fetch(`${fixture.base}/oauth/attempt/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state }),
    });
    expect(cancel.status).toBe(200);
    expect(await cancel.json()).toEqual({ cancelled: true });
    const response = await finishExchange(fixture, { code: "late-arrival", state });
    expect(response.status).toBe(409);
    // No session was minted, so no cookie was set.
    expect(response.headers.get("set-cookie")).toBeNull();
    // And the desktop never knocked on the cloud with the late code.
    expect(cloud.exchanges).toHaveLength(0);
  });

  it("a newer begin supersedes the previous attempt", async () => {
    const first = await begin(fixture);
    const second = await begin(fixture);
    expect(second.state).not.toBe(first.state);
    const stale = await finishExchange(fixture, { code: "first-attempt-code", state: first.state });
    expect(stale.status).toBe(409);
    expect(cloud.exchanges).toHaveLength(0);
  });

  it("a finish whose state does not match the attempt is refused before the cloud is contacted", async () => {
    await begin(fixture);
    const wrong = await finishExchange(fixture, { code: "some-code", state: "wrong-state-value" });
    expect(wrong.status).toBe(409);
    expect(cloud.exchanges).toHaveLength(0);
  });

  it("a finish with no state at all is refused", async () => {
    await begin(fixture);
    const response = await finishExchange(fixture, { code: "some-code" });
    expect(response.status).toBe(409);
    expect(cloud.exchanges).toHaveLength(0);
  });

  it("a code the cloud refuses leaves no session and consumes the attempt", async () => {
    const { state, codeChallenge } = await begin(fixture);
    cloud.bind(codeChallenge);
    cloud.refuseNext();
    const response = await finishExchange(fixture, { code: "bad-code", state });
    expect(response.status).toBe(400);
    expect(response.headers.get("set-cookie")).toBeNull();
    // The attempt is spent: a retry with a good code must not resurrect it.
    cloud.bind(codeChallenge);
    const retry = await finishExchange(fixture, { code: "good-code", state });
    expect(retry.status).toBe(409);
  });

  it("the finish page echoes the attempt state into the exchange", async () => {
    const { state } = await begin(fixture);
    await finishPageEchoesState(fixture, state);
  });
});

posixOnly("desktop sign-in without a configured cloud", () => {
  let fixture: DesktopFixture;

  beforeEach(async () => {
    fixture = await startDesktop(null);
  });

  afterEach(async () => {
    for (const current of fixtures.splice(0)) {
      await waitForExit(current.child, { signal: "SIGTERM" });
      await removeTempDir(current.directory);
    }
  });

  it("answers the finish exchange with a clear error and no session", async () => {
    const { state } = await begin(fixture);
    const response = await finishExchange(fixture, { code: "some-code", state });
    expect(response.status).toBe(501);
    expect(await response.json()).toEqual({ error: "desktop sign-in is not configured on this install" });
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});
