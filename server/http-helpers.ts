// Shared HTTP plumbing for route modules — moved here from server/index.ts
// so extracted route families import one definition instead of re-inlining
// index.ts's private helpers. index.ts imports these too.

import { gzipSync } from "node:zlib";
import type { IncomingMessage, ServerResponse } from "node:http";

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
  const wantsGzip = accept.includes("gzip") && !accept.includes("identity");
  if (wantsGzip && data.length >= GZIP_MIN_BYTES) {
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
