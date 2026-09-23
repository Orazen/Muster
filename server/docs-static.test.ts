// Self-hosted docs at pretty URLs, end to end: boots the real server with a
// throwaway marketing dir and asserts the /docs contract — the hub resolves
// from docs/index.html, content pages resolve with or without their .html
// suffix, docs.css serves as a static asset, an unknown docs path gets the
// docs-styled 404 (never the app SPA), /api stays untouched, and no route
// regresses into a directory listing.
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
// A release-binary fixture for the /downloads path: the non-UTF8 tail proves
// the marketing handler never stringifies update artifacts on the way out.
const UPDATE_ZIP = Buffer.concat([
  Buffer.from("PKowned-update-fixture "),
  Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x41, 0x0d, 0x0a]),
]);

async function get(path: string, headers?: Record<string, string> | Headers) {
  const res = await fetch(`${BASE}${path}`, { headers });
  return {
    status: res.status,
    type: res.headers.get("content-type") ?? "",
    cache: res.headers.get("cache-control"),
    nosniff: res.headers.get("x-content-type-options"),
    text: await res.text(),
  };
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
    mkdirSync(join(www, "downloads"), { recursive: true });
    writeFileSync(join(www, "downloads", "Muster-owned.zip"), UPDATE_ZIP);

    const dist = join(home, "dist");
    mkdirSync(join(dist, "assets"), { recursive: true });
    mkdirSync(join(dist, "empty-directory"));
    writeFileSync(join(dist, "index.html"), '<!doctype html><html><body><div id="root">owned app shell</div></body></html>');
    writeFileSync(join(dist, "local.html"), "<!doctype html><html><body>local document</body></html>");
    writeFileSync(join(dist, "assets", "entry.js"), 'console.log("owned entry");');
    writeFileSync(join(dist, "assets", "entry.css"), ".owned{color:green}");
    writeFileSync(join(dist, "assets", "flower.svg"), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    writeFileSync(join(dist, "assets", "two..dots.js"), 'console.log("exact filename");');
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
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(existsSync(home)).toBe(false);
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

  it.each(["/app", "/os", "/sign-in", "/app/bots/owned-bot/thread", "/os/workspace/owned-task"])(
    "serves the app document at %s with revalidation",
    async (path) => {
      const res = await get(path, {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,*/*;q=0.8",
        "sec-fetch-dest": "document",
      });
      expect(res.status).toBe(200);
      expect(res.type).toBe("text/html");
      expect(res.text).toContain("owned app shell");
      expect(res.cache).toBe("no-cache");
      expect(res.nosniff).toBe("nosniff");
    },
  );

  it("keeps generic document clients and explicit HTML files working", async () => {
    expect((await get("/app/reloaded")).text).toContain("owned app shell");
    const res = await get("/local.html");
    expect(res.status).toBe(200);
    expect(res.text).toContain("local document");
    expect(res.cache).toBe("no-cache");
    expect(res.nosniff).toBe("nosniff");
  });

  it.each([
    ["/assets/entry.js", "script", "*/*", "text/javascript", 'console.log("owned entry");'],
    ["/assets/%65ntry.js", "script", "*/*", "text/javascript", 'console.log("owned entry");'],
    ["/assets/entry.css", "style", "text/css,*/*;q=0.1", "text/css", ".owned{color:green}"],
    ["/assets/flower.svg", "image", "image/avif,image/webp,image/*,*/*;q=0.8", "image/svg+xml", '<svg xmlns="http://www.w3.org/2000/svg"></svg>'],
    ["/assets/two..dots.js", "script", "*/*", "text/javascript", 'console.log("exact filename");'],
  ])("serves exact asset bytes at %s", async (path, destination, accept, type, body) => {
    const res = await get(path, { accept, "sec-fetch-dest": destination });
    expect(res.status).toBe(200);
    expect(res.type).toBe(type);
    expect(res.text).toBe(body);
    expect(res.nosniff).toBe("nosniff");
  });

  it.each([
    ["/assets/missing.js", "script", "*/*"],
    ["/assets/missing.css", "style", "text/css,*/*;q=0.1"],
    ["/missing.png", "image", "image/avif,image/webp,image/*,*/*;q=0.8"],
    ["/missing.woff2", "font", "*/*"],
    ["/missing.js", "document", "text/html"],
    ["/assets/missing", "document", "text/html"],
    ["/assets", "document", "text/html"],
    ["/assets/missing/", "document", "text/html"],
    ["/missing.js/child", "document", "text/html"],
    ["/empty-directory", "document", "text/html"],
    ["/empty-directory/", "document", "text/html"],
    ["/extensionless-script", "script", "*/*"],
    ["/extensionless-fetch", "empty", "*/*"],
    ["/extensionless-json", "", "application/json"],
    ["/extensionless-html-refused", "document", "text/html;q=0"],
    ["/missing%2ejs", "document", "text/html"],
    ["/assets%2fmissing", "document", "text/html"],
    ["/assets/..%2flocal.html", "document", "text/html"],
    ["/assets/%5centry.js", "script", "*/*"],
    ["/assets/%00entry.js", "script", "*/*"],
    ["/assets/%zz", "document", "text/html"],
  ])("returns non-HTML 404 for %s", async (path, destination, accept) => {
    const headers = new Headers({ accept });
    if (destination) headers.set("sec-fetch-dest", destination);
    const res = await get(path, headers);
    expect(res.status).toBe(404);
    expect(res.type).toBe("text/plain; charset=utf-8");
    expect(res.text).toBe("Not found");
    expect(res.cache).toBe("no-store");
    expect(res.nosniff).toBe("nosniff");
  });

  it("serves download binaries with a content-length so the desktop updater can show progress", async () => {
    const res = await fetch(`${BASE}/downloads/Muster-owned.zip`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBeTruthy();
    // electron-updater only installs its progress transform when the response
    // carries a length; a chunked reply renders an endless "Starting
    // download…" with no percent. The bytes must survive intact too.
    expect(res.headers.get("content-length")).toBe(String(UPDATE_ZIP.length));
    const served = Buffer.from(await res.arrayBuffer());
    expect(served.equals(UPDATE_ZIP)).toBe(true);
  });

  it("answers a single Range request with 206 + Content-Range so the differential downloader can fetch blockmap slices", async () => {
    const res = await fetch(`${BASE}/downloads/Muster-owned.zip`, { headers: { Range: "bytes=2-6" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 2-6/${UPDATE_ZIP.length}`);
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-length")).toBe("5");
    const served = Buffer.from(await res.arrayBuffer());
    expect(served.equals(UPDATE_ZIP.subarray(2, 7))).toBe(true);
  });

  it("supports open-ended and suffix ranges exactly as the RFC and updater clients use them", async () => {
    const open = await fetch(`${BASE}/downloads/Muster-owned.zip`, { headers: { Range: "bytes=18-" } });
    expect(open.status).toBe(206);
    expect(open.headers.get("content-range")).toBe(`bytes 18-${UPDATE_ZIP.length - 1}/${UPDATE_ZIP.length}`);
    expect(Buffer.from(await open.arrayBuffer()).equals(UPDATE_ZIP.subarray(18))).toBe(true);
    const suffix = await fetch(`${BASE}/downloads/Muster-owned.zip`, { headers: { Range: "bytes=-7" } });
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get("content-range")).toBe(`bytes ${UPDATE_ZIP.length - 7}-${UPDATE_ZIP.length - 1}/${UPDATE_ZIP.length}`);
    expect(Buffer.from(await suffix.arrayBuffer()).equals(UPDATE_ZIP.subarray(-7))).toBe(true);
  });

  it("replies 416 with the complete size for an out-of-bounds range", async () => {
    const res = await fetch(`${BASE}/downloads/Muster-owned.zip`, { headers: { Range: `bytes=${UPDATE_ZIP.length + 10}-` } });
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe(`bytes */${UPDATE_ZIP.length}`);
  });

  it("falls back to a full 200 for multi-range or malformed Range headers (RFC-permitted, updater-safe)", async () => {
    for (const range of ["bytes=0-1,5-9", "bytes=abc", "chunks=0-5", "bytes=-"]) {
      const res = await fetch(`${BASE}/downloads/Muster-owned.zip`, { headers: { Range: range } });
      expect(res.status, range).toBe(200);
      expect(res.headers.get("content-length"), range).toBe(String(UPDATE_ZIP.length));
      expect(Buffer.from(await res.arrayBuffer()).equals(UPDATE_ZIP), range).toBe(true);
    }
  });

  it("keeps HTML out of the range path so the verification meta never desynchronizes the 200 body", async () => {
    const res = await fetch(`${BASE}/`, { headers: { Range: "bytes=0-9" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-range")).toBeNull();
  });

  it("sizes marketing HTML with a content-length that matches the bytes actually served", async () => {
    const res = await fetch(`${BASE}/`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("landing");
    expect(res.headers.get("content-length")).toBe(String(Buffer.byteLength(text)));
  });
});
