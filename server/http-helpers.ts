// Shared HTTP plumbing for route modules — moved here from server/index.ts
// so extracted route families import one definition instead of re-inlining
// index.ts's private helpers. index.ts imports these too.

import { gzipSync } from "node:zlib";
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";

// Below this, gzip wins nothing but costs a CPU pass and a `Vary` header, so
// tiny error bodies ship plain. ~1 KiB is where JSON responses start to earn
// their keep on a slow link.
const GZIP_MIN_BYTES = 1024;

/** Send a JSON response. The single serialization point for every API route.
 *
 * Negotiates gzip from `Accept-Encoding`: the client opted in AND the
 * serialized body is worth compressing, so the wire carries a much smaller
 * body on exactly the links where it helps (mobile, long-haul). Everything
 * else — no header, `identity` only, tiny payloads — is byte-for-byte the old
 * path, so a client that cannot or will not decompress is never surprised.
 * The response is a fresh writeHead (this is the only writer on the route),
 * so `Vary: Accept-Encoding` is set alongside the encoding and shared caches
 * key the two variants separately. */
export function json<B>(res: ServerResponse, status: number, body: B) {
  const data = JSON.stringify(body);
  if (res.headersSent) {
    res.end(data);
    return;
  }
  const accept = String(res.req.headers["accept-encoding"] ?? "");
  if (acceptsGzip(accept) && data.length >= GZIP_MIN_BYTES) {
    const compressed = gzipSync(data);
    res.writeHead(status, {
      "content-type": "application/json",
      "content-encoding": "gzip",
      "content-length": compressed.length,
      "vary": "Accept-Encoding",
    });
    res.end(compressed);
    return;
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(data);
}

// ── static asset compression ────────────────────────────────────────────
// The JSON API compresses, but the other half of every page load did not:
// the Vite bundle, the docs CSS and the marketing HTML all went out raw.
// These decide whether one static body is worth compressing.

/** Does this client actually want a gzip body? Same rule `json()` applies, so
 * an API response and the bundle it was fetched next to never disagree. */
export function acceptsGzip(acceptEncoding: string | string[] | undefined): boolean {
  const accept = (Array.isArray(acceptEncoding) ? acceptEncoding.join(",") : String(acceptEncoding ?? ""))
    .toLowerCase();
  return accept.includes("gzip") && !accept.includes("identity");
}

/** Text-ish media worth compressing. Fonts, images, archives and wasm are
 * already deflated — gzipping those burns a CPU pass and usually grows the
 * body. `type` may carry parameters (`text/markdown; charset=utf-8`). */
export function isCompressibleType(type: string): boolean {
  const bare = type.split(";", 1)[0].trim().toLowerCase();
  if (bare.startsWith("text/")) return true;
  if (bare === "image/svg+xml") return true;
  return (
    bare === "application/javascript" ||
    bare === "application/json" ||
    bare === "application/xml" ||
    bare === "application/manifest+json"
  );
}

/** Compress one static body when the client asked for gzip and the bytes earn
 * it. Returns null to mean "send it exactly as given".
 *
 * A request carrying `Range` is never compressed: a ranged read addresses the
 * *uncompressed* representation's byte offsets — that is exactly how
 * electron-updater's blockmap delta downloader reassembles an installer — so
 * compressing would hand back offsets into the wrong byte stream and silently
 * corrupt the update. */
export function negotiateStaticGzip(
  req: { headers: Record<string, string | string[] | undefined> },
  type: string,
  body: Buffer,
): Buffer | null {
  if (req.headers.range !== undefined) return null;
  if (body.length < GZIP_MIN_BYTES) return null;
  if (!isCompressibleType(type)) return null;
  if (!acceptsGzip(req.headers["accept-encoding"])) return null;
  const compressed = gzipSync(body);
  // Already-dense bytes (a tiny minified file, a random-looking blob) can come
  // out larger; sending the original is then both smaller and cheaper.
  return compressed.length < body.length ? compressed : null;
}

/** Headers that mark the body as the gzip variant of this resource.
 * `Vary` is what keeps a shared cache from handing the compressed bytes to a
 * client that never asked for them. */
export function applyGzipHeaders(headers: OutgoingHttpHeaders, compressedLength: number): void {
  headers["content-encoding"] = "gzip";
  headers.vary = "Accept-Encoding";
  // Always overwrite: callers that precomputed content-length from the plain
  // body would otherwise declare the wrong number of bytes and hang the client.
  headers["content-length"] = compressedLength;
}

/** True only for primitive strings — what JSON decoding yields for text fields. */
export const isText = <T>(value: T): value is T & string => String(value) === value;
/** Parse the request body as JSON. Semantics match the original inline
 * index.ts version exactly: same 1 MB ceiling with the pause-then-destroy
 * drain guard, same `{ status }`-tagged rejections for the handler's
 * catch-all to map onto HTTP statuses, empty body parses to `{}`. */
export function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    let bytes = 0;
    let done = false;
    const fail = (status: number, msg: string) => {
      if (done) return;
      done = true;
      const err = Object.assign(new Error(msg), { status });
      reject(err);
    };
    req.on("data", (c) => {
      if (done) return;
      bytes += Buffer.isBuffer(c) ? c.length : Buffer.byteLength(c);
      if (bytes > 1_000_000) {
        // Stop retaining attacker-controlled bytes and stop draining: pause
        // the stream so the caller's 413 can flush, then destroy so an
        // unauthenticated peer can't stream forever on a rejected body
        // (mirrors companion/src/proxy.ts, which destroys outright). The
        // delay must comfortably outlast the client reading the 413 — under
        // load a fast destroy can RST before the client's socket drains,
        // which surfaces as "other side closed" instead of the 413. The
        // cap itself already bounds this at ~1MB, so a few seconds only
        // matters for a peer that keeps pushing bytes.
        req.pause();
        setTimeout(() => req.destroy(), 5_000).unref();
        return fail(413, "body too large");
      }
      data += c;
    });
    req.on("end", () => {
      if (done) return;
      let body: any;
      try {
        body = data ? JSON.parse(data) : {};
      } catch {
        return fail(400, "invalid JSON body");
      }
      done = true;
      resolve(body);
    });
    req.on("error", (e) => fail(400, e instanceof Error ? e.message : String(e)));
  });
}
