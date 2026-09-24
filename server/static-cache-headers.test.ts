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
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const posixOnly = describe.skipIf(process.platform === "win32");
/** A strong ETag is the sha256 of the served bytes, base64url, in quotes. */
const STRONG_ETAG = /^"[A-Za-z0-9_-]+"$/;
const IMMUTABLE = "public, max-age=31536000, immutable";

/** Both clear the 1 KiB compression floor by a wide margin, and both are
 * repetitive enough that gzip genuinely shrinks them — without an asset this
 * size the negotiated-gzip path is never reached and the encoding contract
 * below would pass vacuously. */
const BIG_JS = `console.log(${JSON.stringify("owned entry chunk ".repeat(200))});\n`;
const BIG_CSS = `body{color:#fff}\n${".owned-rule{margin:0}\n".repeat(120)}`;

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

/** The wire, not the decoded body. `fetch` transparently negotiates and
 * decodes gzip, which would hide the very headers under test — this issues the
 * request over node:http so content-encoding, content-length and the raw bytes
 * are exactly what the server wrote. */
function raw(path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port: PORT, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
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
    writeFileSync(join(www, "docs", "big.css"), BIG_CSS);
    writeFileSync(join(www, "logo.png"), "v1-logo-bytes");

    // a packaged app tree: app shell, an explicit HTML file, hashed build
    // output under /assets, and one non-hashed file beside it.
    const dist = join(home, "dist");
    mkdirSync(join(dist, "assets"), { recursive: true });
    writeFileSync(join(dist, "index.html"), '<!doctype html><html><body><div id="root">owned app shell</div></body></html>');
    writeFileSync(join(dist, "local.html"), "<!doctype html><html><body>local document</body></html>");
    writeFileSync(join(dist, "assets", "entry.js"), 'console.log("owned entry");');
    writeFileSync(join(dist, "assets", "big.js"), BIG_JS);
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

// The compression half of the same contract. Everything above is about *how
// long* a browser may keep a file; this is about *how many bytes cross the
// wire* on the first visit — the Vite bundle, the docs stylesheet and the
// marketing HTML are the heaviest bytes in a cold load and all ship as plain
// text, so the API's gzip had to reach them too.
posixOnly("static asset compression", () => {
  let child: ChildProcess;
  let home: string;
  let stderr = "";

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "omb-static-gzip-test-"));
    mkdirSync(join(home, ".muster"), { recursive: true });
    writeFileSync(join(home, ".muster", "config.json"), JSON.stringify({ instances: {} }));

    const www = join(home, "www");
    mkdirSync(join(www, "docs"), { recursive: true });
    writeFileSync(join(www, "index.html"), `<!doctype html><html><body>${"landing prose ".repeat(200)}</body></html>`);
    writeFileSync(join(www, "docs", "index.html"), "<!doctype html><html><body>docs hub</body></html>");
    writeFileSync(join(www, "docs", "big.css"), BIG_CSS);

    const dist = join(home, "dist");
    mkdirSync(join(dist, "assets"), { recursive: true });
    writeFileSync(join(dist, "index.html"), "<!doctype html><html><body><div id=\"root\">shell</div></body></html>");
    writeFileSync(join(dist, "assets", "big.js"), BIG_JS);

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

  it("compresses the packaged bundle and round-trips to the exact source bytes", async () => {
    const res = await raw("/assets/big.js", { "accept-encoding": "gzip, deflate, br" });
    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBe("gzip");
    expect(res.headers.vary).toBe("Accept-Encoding");
    // content-length must describe the bytes actually on the wire, not the
    // decompressed size the client will see
    expect(Number(res.headers["content-length"])).toBe(res.body.length);
    expect(res.body.length).toBeLessThan(BIG_JS.length);
    expect(gunzipSync(res.body).toString("utf8")).toBe(BIG_JS);
  });

  it("compresses a large docs stylesheet through the /docs handler", async () => {
    const res = await raw("/docs/big.css", { "accept-encoding": "gzip" });
    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBe("gzip");
    expect(gunzipSync(res.body).toString("utf8")).toBe(BIG_CSS);
  });

  it("compresses a large marketing HTML page", async () => {
    const res = await raw("/", { "accept-encoding": "gzip" });
    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBe("gzip");
    expect(gunzipSync(res.body).toString("utf8")).toContain("landing prose");
  });

  it("serves plain bytes to a client that does not ask for gzip", async () => {
    const res = await raw("/assets/big.js", { "accept-encoding": "identity" });
    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(res.body.toString("utf8")).toBe(BIG_JS);
  });

  // The whole reason the ETag carries an encoding marker: a shared cache that
  // stored the compressed body under the identity tag would hand bytes no
  // non-gzip client can read. The two variants must be distinct entries, and
  // neither one's validator may satisfy the other's revalidation.
  it("gives the two encodings distinct validators", async () => {
    const zipped = await raw("/assets/big.js", { "accept-encoding": "gzip" });
    const plain = await raw("/assets/big.js", { "accept-encoding": "identity" });
    expect(zipped.headers.etag).toMatch(STRONG_ETAG);
    expect(plain.headers.etag).toMatch(STRONG_ETAG);
    expect(zipped.headers.etag).not.toBe(plain.headers.etag);
  });

  it("revalidates each encoding against its own validator", async () => {
    const zipped = await raw("/assets/big.js", { "accept-encoding": "gzip" });
    const revalidated = await raw("/assets/big.js", {
      "accept-encoding": "gzip",
      "if-none-match": String(zipped.headers.etag),
    });
    expect(revalidated.status).toBe(304);
    expect(revalidated.body.length).toBe(0);
    expect(revalidated.headers.etag).toBe(zipped.headers.etag);
  });

  it("does not let the identity validator satisfy a gzip request", async () => {
    const plain = await raw("/assets/big.js", { "accept-encoding": "identity" });
    const res = await raw("/assets/big.js", {
      "accept-encoding": "gzip",
      "if-none-match": String(plain.headers.etag),
    });
    // a 304 here would tell the client to reuse a representation it never
    // received — the exact cache-poisoning the per-encoding ETag prevents
    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBe("gzip");
  });

  // electron-updater reassembles a delta from byte offsets declared against the
  // UNCOMPRESSED installer. A ranged read must therefore never be compressed.
  it("never compresses a request that carries Range", async () => {
    const res = await raw("/assets/big.js", { "accept-encoding": "gzip", range: "bytes=0-255" });
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(res.body.toString("utf8")).toBe(BIG_JS);
  });

  it("still rides HEAD with the negotiated encoding headers and no body", async () => {
    const res = await raw("/assets/big.js", { "accept-encoding": "gzip" });
    expect(res.headers["content-encoding"]).toBe("gzip");
    const head = await new Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port: PORT, path: "/assets/big.js", method: "HEAD", headers: { "accept-encoding": "gzip" } }, (r) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => resolve({ status: r.statusCode ?? 0, headers: r.headers, body: Buffer.concat(chunks) }));
      });
      req.on("error", reject);
      req.end();
    });
    expect(head.status).toBe(200);
    expect(head.headers["content-encoding"]).toBe("gzip");
    expect(head.headers.etag).toBe(res.headers.etag);
    expect(head.body.length).toBe(0);
  });
});
