// Self-hosted docs at pretty URLs, end to end: boots the real server with a
// throwaway marketing dir and asserts the /docs contract — the hub resolves
// from docs/index.html, content pages resolve with or without their .html
// suffix, docs.css serves as a static asset, an unknown docs path gets the
// docs-styled 404 (never the app SPA), /api stays untouched, and no route
// regresses into a directory listing.
//
// POSIX-gated like the other boot-a-real-server suites.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const posixOnly = describe.skipIf(process.platform === "win32");

async function get(path: string): Promise<{ status: number; type: string; text: string }> {
  const res = await fetch(`${BASE}${path}`);
  return { status: res.status, type: res.headers.get("content-type") ?? "", text: await res.text() };
}

posixOnly("docs pretty-URL serving", () => {
  let child: ChildProcess;
  let home: string;
  let stderr = "";

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "omb-docs-test-"));
    mkdirSync(join(home, ".muster"), { recursive: true });
    writeFileSync(join(home, ".muster", "config.json"), JSON.stringify({ instances: {} }));

    // a minimal marketing tree: hub at docs/index.html, one content page,
    // the shared stylesheet, and a regular landing file at the root.
    const www = join(home, "www");
    mkdirSync(join(www, "docs"), { recursive: true });
    writeFileSync(join(www, "index.html"), "<!doctype html><html><body>landing</body></html>");
    writeFileSync(join(www, "docs", "index.html"), "<!doctype html><html><body>docs hub</body></html>");
    writeFileSync(join(www, "docs", "quick-start.html"), "<!doctype html><html><body>quick start</body></html>");
    writeFileSync(join(www, "docs", "docs.css"), "body{color:#fff}");

    const env: NodeJS.ProcessEnv = {
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(PORT),
      OMB_MARKETING_DIR: www,
    };
    if (process.env.PATH) env.PATH = process.env.PATH;
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));

    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        const res = await fetch(`${BASE}/api/health`);
        if (res.ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }, 30_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it("serves the hub at /docs and /docs/", async () => {
    for (const path of ["/docs", "/docs/"]) {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(res.type).toContain("text/html");
      expect(res.text).toContain("docs hub");
    }
  });

  it("resolves content pages with and without the .html suffix", async () => {
    for (const path of ["/docs/quick-start", "/docs/quick-start.html"]) {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(res.text).toContain("quick start");
    }
  });

  it("serves docs assets through the marketing handler", async () => {
    const res = await get("/docs/docs.css");
    expect(res.status).toBe(200);
    expect(res.type).toContain("text/css");
    expect(res.text).toContain("body{color:#fff}");
  });

  it("404s unknown docs paths with the docs 404, not the app SPA", async () => {
    const res = await get("/docs/no-such-page");
    expect(res.status).toBe(404);
    expect(res.type).toContain("text/html");
    expect(res.text).toContain("Page not found");
    expect(res.text).not.toContain("id=\"root\"");
  });

  it("keeps the landing and /api untouched", async () => {
    const landing = await get("/");
    expect(landing.status).toBe(200);
    expect(landing.text).toContain("landing");

    const health = await get("/api/health");
    expect(health.status).toBe(200);
  });

  it("never falls into the marketing handler for a docs directory traversal", async () => {
    // ".." is stripped server-side; a stripped path that misses must 404
    // rather than serve anything outside the marketing dir.
    const res = await get("/docs/..%2f..%2fconfig.json");
    expect(res.status).toBe(404);
  });
});
