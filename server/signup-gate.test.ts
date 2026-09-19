// HTTP-level coverage for open-by-default sign-up and the operator
// closure/allowlist gate before the generic /api/auth/ dispatch.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { pairingServerEnvironment, waitForOwnedServer } from "../e2e/pairing-harness.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));

async function bootServer(extraEnv: Record<string, string>): Promise<{
  child: ChildProcess;
  base: string;
  home: string;
  stop: () => Promise<void>;
}> {
  const port = await freePortBlock([0, 1000], 19800, 5000);
  const base = `http://127.0.0.1:${port}`;
  const home = mkdtempSync(join(tmpdir(), "muster-signup-gate-"));
  mkdirSync(join(home, ".muster"), { recursive: true });

  const env = {
    ...pairingServerEnvironment({
      home,
      dataDirectory: join(home, ".muster"),
      companionDirectory: join(home, "companion"),
      staticDir: join(home, "ui"),
      port,
      webhookPort: port + 1000,
      secret: "test-secret-at-least-32-chars-long-ok",
    }),
    ...extraEnv,
  };

  const child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stop = async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  };
  try {
    // Keep the existing 15s budget, but require this child's listener and
    // include its bounded output if startup fails rather than hiding the cause.
    await waitForOwnedServer(child, base, { timeoutMs: 15_000 });
    child.stdout?.resume();
    child.stderr?.resume();
  } catch (error) {
    await stop();
    throw error;
  }

  return { child, base, home, stop };
}

describe("sign-up gate", () => {
  it("opens sign-up by default (isolation landed — ownerId guards + filtered streams)", async () => {
    const server = await bootServer({});
    try {
      const res = await fetch(`${server.base}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: server.base },
        body: JSON.stringify({ name: "Anyone", email: "stranger@example.com", password: "testpassword12345" }),
      });
      expect(res.status).toBe(200);
      // SAFETY: better-auth sign-up response envelope; only user.email is asserted.
      const body = (await res.json()) as { user?: { email?: string } };
      expect(body.user?.email).toBe("stranger@example.com");
    } finally {
      await server.stop();
    }
  });

  it("OMB_SIGNUPS_CLOSED=true closes sign-up for everyone", async () => {
    const server = await bootServer({ OMB_SIGNUPS_CLOSED: "true" });
    try {
      const res = await fetch(`${server.base}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: server.base },
        body: JSON.stringify({ name: "Nope", email: "stranger@example.com", password: "testpassword12345" }),
      });
      expect(res.status).toBe(403);
      // SAFETY: the gate's fixed rejection body; only the code field is asserted.
      const body = (await res.json()) as { code?: string };
      expect(body.code).toBe("SIGNUPS_CLOSED");
    } finally {
      await server.stop();
    }
  });

  it("allowlisted email still gets through while closed", async () => {
    const server = await bootServer({ OMB_SIGNUPS_CLOSED: "true", OMB_SIGNUP_ALLOWLIST: "allowed@example.com, Other@Example.com" });
    try {
      const res = await fetch(`${server.base}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: server.base },
        // allowlist match must be case-insensitive
        body: JSON.stringify({ name: "Allowed", email: "ALLOWED@example.com", password: "testpassword12345" }),
      });
      expect(res.status).toBe(200);
      // SAFETY: better-auth sign-up response envelope; only user.email is asserted.
      const body = (await res.json()) as { user?: { email?: string } };
      expect(body.user?.email).toBe("allowed@example.com");
    } finally {
      await server.stop();
    }
  });

  it("still rejects an email not on the allowlist while closed", async () => {
    const server = await bootServer({ OMB_SIGNUPS_CLOSED: "true", OMB_SIGNUP_ALLOWLIST: "allowed@example.com" });
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

  it("does not touch sign-in — an existing account can still authenticate", async () => {
    const server = await bootServer({});
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
