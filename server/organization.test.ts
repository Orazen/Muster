// The organization plugin's own tables (organization/member/invitation) and
// the activeOrganizationId column it adds to session must be created by
// getDb()'s hand-rolled migrate() in auth.ts, same as every other table —
// there is no separate migration step anywhere in the deploy pipeline (see
// the "no such table: user" incident this session's earlier fix addressed).
// Reproduces and guards against the exact regression found while adding
// this plugin: organization/list 500ing with "no such table: member" on a
// fresh database, and confirms a full server restart doesn't lose data
// (idempotent CREATE TABLE IF NOT EXISTS, not a one-shot migration).
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));

async function bootServer(): Promise<{
  child: ChildProcess;
  base: string;
  home: string;
  port: number;
  stop: () => Promise<void>;
}> {
  const port = 19980 + Math.floor(Math.random() * 5000);
  const base = `http://127.0.0.1:${port}`;
  const home = mkdtempSync(join(tmpdir(), "muster-org-plugin-"));
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
      OMB_ALLOW_SIGNUPS: "true",
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
    port,
    stop: async () => {
      child.kill();
      await waitForExit(child);
    },
  };
}

describe("organization plugin migration", () => {
  it("organization/list does not 500 on a fresh database (the exact regression this plugin addition first hit)", async () => {
    const server = await bootServer();
    try {
      const signup = await fetch(`${server.base}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: server.base },
        body: JSON.stringify({ email: "org-mig@example.com", password: "testpassword12345", name: "Org Mig" }),
      });
      expect(signup.status).toBe(200);
      const cookie = signup.headers.get("set-cookie")?.split(";")[0] ?? "";

      const list = await fetch(`${server.base}/api/auth/organization/list`, {
        headers: { cookie },
      });
      expect(list.status).toBe(200);
      expect(await list.json()).toEqual([]);
    } finally {
      await server.stop();
      removeTempDir(server.home);
    }
  });

  it("creates an organization with an owner member row, and both survive a full restart", async () => {
    const home = mkdtempSync(join(tmpdir(), "muster-org-plugin-restart-"));
    mkdirSync(join(home, ".muster"), { recursive: true });
    const port = 19990 + Math.floor(Math.random() * 5000);
    const base = `http://127.0.0.1:${port}`;

    const boot = async () => {
      const child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
        cwd: join(SERVER_DIR, ".."),
        env: {
          ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
          HOME: home,
          USERPROFILE: home,
          OMB_PORT: String(port),
          OMB_WEBHOOK_PORT: String(port + 1000),
          BETTER_AUTH_SECRET: "test-secret-at-least-32-chars-long-ok",
          OMB_ALLOW_SIGNUPS: "true",
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
      return child;
    };

    let child = await boot();
    try {
      const signup = await fetch(`${base}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: base },
        body: JSON.stringify({ email: "org-restart@example.com", password: "testpassword12345", name: "Restart" }),
      });
      const cookie = signup.headers.get("set-cookie")?.split(";")[0] ?? "";

      const created = await fetch(`${base}/api/auth/organization/create`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: base, cookie },
        body: JSON.stringify({ name: "Restart Org", slug: "restart-org" }),
      });
      expect(created.status).toBe(200);
      const org = (await created.json()) as { id: string; members: Array<{ role: string }> };
      expect(org.members).toHaveLength(1);
      expect(org.members[0].role).toBe("owner");

      child.kill();
      await waitForExit(child);
      child = await boot();

      const list = await fetch(`${base}/api/auth/organization/list`, { headers: { cookie } });
      const orgs = (await list.json()) as Array<{ slug: string }>;
      expect(orgs.map((o) => o.slug)).toContain("restart-org");
    } finally {
      child.kill();
      await waitForExit(child);
      removeTempDir(home);
    }
  });
});
