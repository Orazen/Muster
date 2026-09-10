// Real HTTP coverage for the isolated browser fixture. These tests do not
// authenticate with Google or run a native desktop application.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { pairingServerEnvironment, startPairingHarness, waitForOwnedServer } from "../e2e/pairing-harness.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const posixOnly = describe.skipIf(process.platform === "win32");
const children: ChildProcess[] = [];

function childScript(script: string): ChildProcess {
  const child = spawn(process.execPath, ["--eval", script], { stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  return child;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(children.splice(0).map((child) => waitForExit(child, { signal: "SIGTERM" })));
});

describe("pairing fixture boundaries", () => {
  it("builds child configuration without inheriting provider secrets or Node injection", () => {
    const token = randomBytes(24).toString("hex");
    for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_CLIENT_SECRET", "NODE_OPTIONS", "OMB_PAIR_CLOUD_URL", "HTTP_PROXY"]) {
      vi.stubEnv(key, token);
    }
    const env = pairingServerEnvironment({
      home: "/fixture/home",
      dataDirectory: "/fixture/data",
      companionDirectory: "/fixture/companion",
      staticDir: "/fixture/ui",
      port: 45001,
      webhookPort: 45002,
      secret: randomBytes(32).toString("hex"),
    });
    expect(Object.values(env)).not.toContain(token);
    expect(env.HOME).toBe("/fixture/home");
    expect(env.OMB_DATA_DIR).toBe("/fixture/data");
    expect(env.OMB_COMPANION_DIR).toBe("/fixture/companion");
    expect(env.OMB_HOST).toBe("127.0.0.1");
    expect(env.OMB_PORT).toBe("45001");
    expect(env.OMB_WEBHOOK_PORT).toBe("45002");
    expect(env.OMB_PUBLIC_URL).toBe("http://127.0.0.1:45001");
  });

  it("does not accept a healthy unrelated listener before its owned child announces readiness", async () => {
    const child = childScript("setInterval(() => {}, 1000)");
    const health = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ app: "muster" }), { status: 200 }));
    await expect(waitForOwnedServer(child, "http://127.0.0.1:45001", { timeoutMs: 250, fetch: health })).rejects.toThrow();
    expect(health).not.toHaveBeenCalled();
  });

  it("reports a child that exits during startup instead of accepting an unrelated health response", async () => {
    const child = childScript("process.stderr.write('fixture startup rejected'); process.exit(7)");
    const health = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ app: "muster" }), { status: 200 }));
    await expect(waitForOwnedServer(child, "http://127.0.0.1:45001", { timeoutMs: 1000, fetch: health })).rejects.toThrow(/fixture startup rejected|exited/);
    expect(health).not.toHaveBeenCalled();
  });
});

posixOnly("real cloud to desktop pairing fixture", () => {
  let harness: Awaited<ReturnType<typeof startPairingHarness>>;
  let staticDirectory: string;
  let cloudCookie: string;

  interface FixtureBody { email?: string; password?: string; code?: string; text?: string }
  const request = (base: string, path: string, body?: FixtureBody, cookie?: string) => {
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
  const sessionCookie = (response: Response): string => {
    const cookie = response.headers.getSetCookie().find((value) => value.startsWith("better-auth.session_token="));
    expect(cookie).toBeDefined();
    return cookie!.split(";")[0]!;
  };
  const pairDesktop = async () => {
    const create = await request(harness.cloudUrl, "/api/pair/create", {}, cloudCookie);
    expect(create.status).toBe(201);
    // SAFETY: the owned server's successful create route returns these fields;
    // the assertions below verify the credential shape and live deadline.
    const pairing = await create.json() as { code: string; expiresAt: number };
    expect(pairing.code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
    expect(pairing.expiresAt).toBeGreaterThan(Date.now());
    const redeem = await request(harness.desktopUrl, "/api/pair/redeem", { code: pairing.code });
    expect(redeem.status).toBe(200);
    expect(await redeem.json()).toMatchObject({ ok: true, email: harness.email });
    return { code: pairing.code, cookie: sessionCookie(redeem) };
  };

  beforeAll(async () => {
    staticDirectory = mkdtempSync(join(tmpdir(), "muster-pairing-test-ui-"));
    writeFileSync(join(staticDirectory, "index.html"), "<!doctype html><title>Pairing fixture</title>");
    // Seed hostile inherited settings before spawning. The fake engine's
    // own dump below proves that these never reach its process.
    vi.stubEnv("OPENAI_API_KEY", randomBytes(24).toString("hex"));
    vi.stubEnv("ANTHROPIC_API_KEY", randomBytes(24).toString("hex"));
    vi.stubEnv("NODE_OPTIONS", "--definitely-not-a-node-option");
    vi.stubEnv("FAKE_ACP_MODE", "hang");
    try {
      harness = await startPairingHarness({ staticDir: staticDirectory });
    } finally {
      vi.unstubAllEnvs();
    }
    const signin = await request(harness.cloudUrl, "/api/auth/sign-in/email", { email: harness.email, password: harness.password });
    expect(signin.status).toBe(200);
    cloudCookie = sessionCookie(signin);
  }, 45_000);

  afterAll(async () => {
    await harness?.stop();
    if (staticDirectory) await removeTempDir(staticDirectory);
  });

  it("requires cloud authentication to create a pairing code", async () => {
    const response = await request(harness.cloudUrl, "/api/pair/create", {});
    expect(response.status).toBe(401);
    expect(response.headers.getSetCookie()).toHaveLength(0);
  });

  it("redeems a cloud code into a working desktop session for the exact synthetic owner", async () => {
    const { cookie } = await pairDesktop();
    const session = await request(harness.desktopUrl, "/api/auth/get-session", undefined, cookie);
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({ user: { email: harness.email } });
  });

  it("rejects reuse of a consumed code without minting another desktop session", async () => {
    const { code } = await pairDesktop();
    const response = await request(harness.desktopUrl, "/api/pair/redeem", { code });
    expect(response.status).toBe(400);
    expect(response.headers.getSetCookie()).toHaveLength(0);
    expect(await response.json()).toMatchObject({ error: expect.any(String) });
  });

  it("runs the deterministic local engine without inherited provider credentials", async () => {
    const { cookie: desktopCookie } = await pairDesktop();
    const create = await request(harness.desktopUrl, "/api/bots", {}, desktopCookie);
    expect(create.status).toBe(201);
    // SAFETY: this owned server's successful bot-create route returns a BotRecord.
    const { bot } = await create.json() as { bot: { id: string; threadId: string } };
    const text = `pairing HTTP fixture ${randomBytes(12).toString("hex")}`;
    const send = await request(harness.desktopUrl, `/api/bots/${bot.id}/messages`, { text }, desktopCookie);
    expect(send.status).toBe(202);
    await expect.poll(async () => {
      const response = await request(harness.desktopUrl, `/api/threads/${bot.threadId}/messages`, undefined, desktopCookie);
      // SAFETY: the owned messages route returns the stored Message array.
      const { messages } = await response.json() as { messages: Array<{ role: string; text?: string }> };
      return messages.filter((message) => message.role === "bot").map((message) => message.text).join("\n");
    }, { timeout: 15_000 }).toContain("hello from fake acp");
    // SAFETY: fake-acp-cli.ts writes this fixture-owned {argv, env} JSON dump.
    const dump = JSON.parse(readFileSync(join(harness.rootDirectory, "desktop", "fake-acp.json"), "utf8")) as { env: Record<string, string> };
    expect(dump.env.OPENAI_API_KEY).toBeUndefined();
    expect(dump.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(dump.env.FAKE_ACP_MODE).toBe("happy");
    expect(dump.env.HOME).toContain(harness.rootDirectory);
  });

  it("stops both servers and removes the fixture when startup readiness fails", async () => {
    let failedDirectory: string | undefined;
    const owned: Array<{ child: ChildProcess; base: string }> = [];
    const waitForServer: typeof waitForOwnedServer = async (child, base, options) => {
      owned.push({ child, base });
      const preload = child.spawnargs.find((argument) => argument.endsWith("/cloud/block-outbound.mjs"));
      if (preload) failedDirectory = dirname(dirname(preload));
      await waitForOwnedServer(child, base, options);
      if (owned.length === 2) throw new Error("injected desktop readiness failure");
    };
    await expect(startPairingHarness({ staticDir: staticDirectory }, { waitForServer })).rejects.toThrow("injected desktop readiness failure");
    expect(failedDirectory).toBeDefined();
    expect(existsSync(failedDirectory!)).toBe(false);
    expect(owned).toHaveLength(2);
    for (const { child, base } of owned) {
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      await expect(request(base, "/api/health")).rejects.toThrow();
    }
    // The first independent fixture must remain healthy throughout failure
    // and cleanup of the second fixture.
    expect((await request(harness.cloudUrl, "/api/health")).status).toBe(200);
    expect((await request(harness.desktopUrl, "/api/health")).status).toBe(200);
  });

  it("awaits both owned server exits and removes every fixture directory on repeated stop", async () => {
    const directory = harness.rootDirectory;
    expect(existsSync(directory)).toBe(true);
    expect(harness.cloudUrl).not.toBe(harness.desktopUrl);
    await Promise.all([harness.stop(), harness.stop()]);
    expect(existsSync(directory)).toBe(false);
    for (const base of [harness.cloudUrl, harness.desktopUrl]) {
      await expect(request(base, "/api/health")).rejects.toThrow();
    }
  });
});
