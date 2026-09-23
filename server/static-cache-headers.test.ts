// Static cache policy, end to end (performance-heavy-users-study, slice A1):
// boots the real server against throwaway marketing + packaged trees and
// pins the headers-only contract — content-addressed /assets answers a
// validator match with an empty 304, every other static file revalidates
// through a strong content ETag (weak form and * included, and the
// validator follows a content change), while HTML keeps exactly the no-cache
// behavior it had before (no validator, never a 304) on all four of its
// surfaces: marketing landing, docs, explicit .html files, and the app SPA
// fallback. HEAD rides the GET branches with identical headers and no body.
// The other half of the contract — bytes and body transforms unchanged — is
// pinned by docs-static.test.ts, which must keep passing untouched.
//
// POSIX-gated like the other boot-a-real-server suites.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const posixOnly = describe.skipIf(process.platform === "win32");
/** A strong ETag is the sha256 of the served bytes, base64url, in quotes. */
const STRONG_ETAG = /^"[A-Za-z0-9_-]+"$/;
const IMMUTABLE = "public, max-age=31536000, immutable";

interface StaticReply {
  status: number;
  type: string;
  cache: string | null;
  etag: string | null;
  text: string;
}

async function get(path: string, headers?: Record<string, string>): Promise<StaticReply> {
  const res = await fetch(`${BASE}${path}`, { headers });
  return {
    status: res.status,
    type: res.headers.get("content-type") ?? "",
    cache: res.headers.get("cache-control"),
    etag: res.headers.get("etag"),
    text: await res.text(),
  };
}

posixOnly("static cache headers", () => {
  let child: ChildProcess;
  let home: string;
  let www: string;
  let stderr = "";

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "omb-static-cache-test-"));
    mkdirSync(join(home, ".muster"), { recursive: true });
    writeFileSync(join(home, ".muster", "config.json"), JSON.stringify({ instances: {} }));

    // a minimal marketing tree: landing, docs hub + stylesheet, one image.
    www = join(home, "www");
    mkdirSync(join(www, "docs"), { recursive: true });
    writeFileSync(join(www, "index.html"), "<!doctype html><html><body>landing</body></html>");
    writeFileSync(join(www, "docs", "index.html"), "<!doctype html><html><body>docs hub</body></html>");
    writeFileSync(join(www, "docs", "docs.css"), "body{color:#fff}");
    writeFileSync(join(www, "logo.png"), "v1-logo-bytes");

    // a packaged app tree: app shell, an explicit HTML file, hashed build
    // output under /assets, and one non-hashed file beside it.
    const dist = join(home, "dist");
    mkdirSync(join(dist, "assets"), { recursive: true });
    writeFileSync(join(dist, "index.html"), '<!doctype html><html><body><div id="root">owned app shell</div></body></html>');
    writeFileSync(join(dist, "local.html"), "<!doctype html><html><body>local document</body></html>");
    writeFileSync(join(dist, "assets", "entry.js"), 'console.log("owned entry");');
    writeFileSync(join(dist, "packaged.svg"), "<svg></svg>");

    // an empty PATH keeps installed agent CLIs out of the registry probes.
    const bin = join(home, "empty-bin");
    mkdirSync(bin);

    const env: NodeJS.ProcessEnv = {
      HOME: home,
      USERPROFILE: home,
      PATH: bin,
      OMB_PORT: String(PORT),
      OMB_MARKETING_DIR: www,
      OMB_STATIC_DIR: dist,
    };
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
    expect(existsSync(home)).toBe(false);
  });

  it("marks hashed build assets immutable and hands out a strong ETag", async () => {
    const res = await get("/assets/entry.js", { accept: "*/*" });
    expect(res.status).toBe(200);
    expect(res.type).toContain("javascript");
    expect(res.text).toBe('console.log("owned entry");');
    expect(res.cache).toBe(IMMUTABLE);
    expect(res.etag).toMatch(STRONG_ETAG);
  });

  it("answers a matching validator with an empty 304 that keeps the headers", async () => {
    const first = await get("/assets/entry.js", { accept: "*/*" });
    const res = await get("/assets/entry.js", { accept: "*/*", "if-none-match": first.etag ?? "" });
    expect(res.status).toBe(304);
    expect(res.text).toBe("");
    expect(res.etag).toBe(first.etag);
    expect(res.cache).toBe(IMMUTABLE);
  });

  it("treats the weak form and the wildcard of the validator as the same", async () => {
    const first = await get("/assets/entry.js", { accept: "*/*" });
    const weak = await get("/assets/entry.js", { accept: "*/*", "if-none-match": `W/${first.etag}` });
    expect(weak.status).toBe(304);
    const wildcard = await get("/assets/entry.js", { accept: "*/*", "if-none-match": "*" });
    expect(wildcard.status).toBe(304);
  });

  it("revalidates marketing files with no-cache and follows a content change", async () => {
    const first = await get("/logo.png");
    expect(first.status).toBe(200);
    expect(first.cache).toBe("no-cache");
    expect(first.etag).toMatch(STRONG_ETAG);

    const revalidated = await get("/logo.png", { "if-none-match": first.etag ?? "" });
    expect(revalidated.status).toBe(304);
    expect(revalidated.text).toBe("");
    expect(revalidated.cache).toBe("no-cache");

    // a changed file must not answer 304 to the old validator — the
    // path+mtime+size keyed cache has to notice, even within one mtime tick
    writeFileSync(join(www, "logo.png"), "v2-logo-bytes-with-a-different-size");
    const changed = await get("/logo.png", { "if-none-match": first.etag ?? "" });
    expect(changed.status).toBe(200);
    expect(changed.text).toBe("v2-logo-bytes-with-a-different-size");
    expect(changed.etag).not.toBe(first.etag);
  });

  it("revalidates docs assets with no-cache", async () => {
    const first = await get("/docs/docs.css");
    expect(first.status).toBe(200);
    expect(first.type).toContain("text/css");
    expect(first.cache).toBe("no-cache");
    expect(first.etag).toMatch(STRONG_ETAG);

    const revalidated = await get("/docs/docs.css", { "if-none-match": first.etag ?? "" });
    expect(revalidated.status).toBe(304);
    expect(revalidated.text).toBe("");
  });

  it("keeps non-hashed packaged files on no-cache revalidation, not immutable", async () => {
    // /packaged.svg misses the marketing dir and resolves in the packaged
    // tree — only /assets/* may claim the immutable year.
    const first = await get("/packaged.svg");
    expect(first.status).toBe(200);
    expect(first.type).toContain("image/svg+xml");
    expect(first.cache).toBe("no-cache");
    expect(first.etag).toMatch(STRONG_ETAG);

    const revalidated = await get("/packaged.svg", { "if-none-match": first.etag ?? "" });
    expect(revalidated.status).toBe(304);
    expect(revalidated.text).toBe("");
  });

  it("rides HEAD with identical status and headers and no body", async () => {
    for (const path of ["/assets/entry.js", "/docs/docs.css"]) {
      const res = await fetch(`${BASE}${path}`, { method: "HEAD" });
      expect(res.status).toBe(200);
      expect(res.headers.get("etag")).toMatch(STRONG_ETAG);
      expect(res.headers.get("cache-control")).toBeTruthy();
      expect(await res.text()).toBe("");
    }
    const validator = (await fetch(`${BASE}/assets/entry.js`, { method: "HEAD" })).headers.get("etag");
    const notModified = await fetch(`${BASE}/assets/entry.js`, { method: "HEAD", headers: { "if-none-match": validator ?? "" } });
    expect(notModified.status).toBe(304);
    expect(await notModified.text()).toBe("");
  });

  it("leaves every HTML surface on its old contract: no-cache, no validator, never a 304", async () => {
    const documentHeaders = {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "sec-fetch-dest": "document",
    };
    // marketing landing, docs hub, an explicit .html file (which resolves
    // through the packaged tree after the marketing miss), and the app SPA
    // fallback — the wildcard validator would match anything, so a 200 here
    // proves HTML never enters the revalidate path at all.
    const surfaces: Array<[string, string]> = [
      ["/", "landing"],
      ["/docs", "docs hub"],
      ["/local.html", "local document"],
      ["/app", "owned app shell"],
    ];
    for (const [path, marker] of surfaces) {
      const res = await get(path, { ...documentHeaders, "if-none-match": "*" });
      expect(res.status).toBe(200);
      expect(res.type).toContain("text/html");
      expect(res.text).toContain(marker);
      expect(res.cache).toBe("no-cache");
      expect(res.etag).toBeNull();
    }
  });
});
