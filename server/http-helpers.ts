// Shared HTTP plumbing for route modules — moved here from server/index.ts
// so extracted route families import one definition instead of re-inlining
// index.ts's private helpers. index.ts imports these too.

import type { IncomingMessage, ServerResponse } from "node:http";

/** Send a JSON response. The single serialization point for every API route. */
export function json<B>(res: ServerResponse, status: number, body: B) {
  const data = JSON.stringify(body);
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
        // the stream just long enough for the caller's 413 to flush, then
        // destroy so an unauthenticated peer can't stream forever on a
        // rejected body (mirrors companion/src/proxy.ts, which destroys
        // outright).
        req.pause();
        setTimeout(() => req.destroy(), 1_000).unref();
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
