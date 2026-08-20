// HTTP-level test for the sign-up stopgap: server-side state (config, bots,
// threads) has no per-user isolation yet, so new sign-ups are closed by
// default until real multi-tenancy exists — see the gate in index.ts, right
// before the generic /api/auth/ dispatch.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));

async function bootServer(extraEnv: Record<string, string>): Promise<{
  child: ChildProcess;
  base: string;
  home: string;
  stop: () => Promise<void>;
}> {
  const port = 19800 + Math.floor(Math.random() * 5000);
  const base = `http://127.0.0.1:${port}`;
  const home = mkdtempSync(join(tmpdir(), "muster-signup-gate-"));
  mkdirSync(join(home, ".muster"), { recursive: true });

  const child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(port),
      OMB_WEBHOOK_PORT: String(port + 1000),
      BETTER_AUTH_SECRET: "test-secret-at-least-32-chars-long-ok",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("server did not come up");
    await new Promise((r) => setTimeout(r, 100));
  }

  return {
    child,
    base,
    home,
    stop: async () => {
      child.kill();
      await waitForExit(child);
      removeTempDir(home);
    },
  };
}

describe("sign-up stopgap gate", () => {
  it("rejects sign-up by default (no OMB_ALLOW_SIGNUPS, no allowlist match)", async () => {
    const server = await bootServer({});
    try {
      const res = await fetch(`${server.base}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: server.base },
        body: JSON.stringify({ name: "Nope", email: "stranger@example.com", password: "testpassword12345" }),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { code?: string };
      expect(body.code).toBe("SIGNUPS_CLOSED");
    } finally {
      await server.stop();
    }
  });

  it("allows a sign-up whose email is on OMB_SIGNUP_ALLOWLIST", async () => {
    const server = await bootServer({ OMB_SIGNUP_ALLOWLIST: "allowed@example.com, Other@Example.com" });
    try {
      const res = await fetch(`${server.base}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: server.base },
        // allowlist match must be case-insensitive
        body: JSON.stringify({ name: "Allowed", email: "ALLOWED@example.com", password: "testpassword12345" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { user?: { email?: string } };
      expect(body.user?.email).toBe("allowed@example.com");
    } finally {
      await server.stop();
    }
  });

  it("still rejects an email not on the allowlist", async () => {
    const server = await bootServer({ OMB_SIGNUP_ALLOWLIST: "allowed@example.com" });
    try {
      const res = await fetch(`${server.base}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: server.base },
        body: JSON.stringify({ name: "Nope", email: "someone-else@example.com", password: "testpassword12345" }),
      });
      expect(res.status).toBe(403);
    } finally {
      await server.stop();
    }
  });

  it("OMB_ALLOW_SIGNUPS=true reopens sign-up for everyone", async () => {
    const server = await bootServer({ OMB_ALLOW_SIGNUPS: "true" });
    try {
      const res = await fetch(`${server.base}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: server.base },
        body: JSON.stringify({ name: "Anyone", email: "anyone@example.com", password: "testpassword12345" }),
      });
      expect(res.status).toBe(200);
    } finally {
      await server.stop();
    }
  });

  it("does not touch sign-in — an existing/allowed account can still authenticate", async () => {
    const server = await bootServer({ OMB_SIGNUP_ALLOWLIST: "allowed@example.com" });
    try {
      await fetch(`${server.base}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: server.base },
        body: JSON.stringify({ name: "Allowed", email: "allowed@example.com", password: "testpassword12345" }),
      });
      const res = await fetch(`${server.base}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: server.base },
        body: JSON.stringify({ email: "allowed@example.com", password: "testpassword12345" }),
      });
      expect(res.status).toBe(200);
    } finally {
      await server.stop();
    }
  });
});
