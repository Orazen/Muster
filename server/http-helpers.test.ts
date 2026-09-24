// json() is the single serialization point for every API route, so its
// negotiation is tested at the boundary: what a client that CAN and CANNOT
// decompress actually receives, and that the compressed bytes round-trip to
// the exact JSON. A mock ServerResponse captures the headers + body instead
// of touching a socket.
import { gunzipSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import type { OutgoingHttpHeaders } from "node:http";
import { describe, expect, it } from "vitest";

import { applyGzipHeaders, isCompressibleType, json, negotiateStaticGzip } from "./http-helpers.ts";

// One self-mutating object (no spread of a side-copy) so writeHead/end land
// where the assertions read. Typed any: json() only needs req.headers,
// headersSent, writeHead and end, and standing up a real socket is not the
// point of this boundary test.
function mockRes(acceptEncoding?: string): any {
  return {
    status: undefined,
    headers: {},
    body: "",
    ended: false,
    req: { headers: { "accept-encoding": acceptEncoding ?? "" } },
    headersSent: false,
    writeHead(status: number, headers: Record<string, string | number>) {
      this.status = status;
      Object.assign(this.headers, headers);
      this.headersSent = true;
    },
    end(body?: string | Buffer) {
      this.body = body ?? this.body;
      this.ended = true;
    },
  };
}

const big = { rows: Array.from({ length: 60 }, (_, i) => ({ id: i, label: `agent-${i}`, note: "x".repeat(40) })) };

describe("json() content negotiation", () => {
  it("compresses a large body when the client asks for gzip", () => {
    const res = mockRes("gzip, deflate, br");
    json(res, 200, big);
    expect(res.headers["content-encoding"]).toBe("gzip");
    expect(res.headers["vary"]).toBe("Accept-Encoding");
    const buf = Buffer.isBuffer(res.body) ? res.body : Buffer.from(res.body);
    // the round-tripped bytes must be the exact same JSON the route sent
    expect(gunzipSync(buf).toString("utf8")).toBe(JSON.stringify(big));
    // content-length advertises the COMPRESSED size, not the plain size
    expect(res.headers["content-length"]).toBe(buf.length);
    expect(buf.length).toBeLessThan(JSON.stringify(big).length);
  });

  it("leaves a small body plain even when gzip is offered", () => {
    const res = mockRes("gzip");
    json(res, 400, { error: "no such bot" });
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(res.body).toBe(JSON.stringify({ error: "no such bot" }));
  });

  it("stays plain when the client sends no Accept-Encoding", () => {
    const res = mockRes();
    json(res, 200, big);
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(res.body).toBe(JSON.stringify(big));
  });

  it("stays plain when the client only accepts identity", () => {
    const res = mockRes("identity");
    json(res, 200, big);
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(res.body).toBe(JSON.stringify(big));
  });

  it("does not double-write when headers are already on the wire", () => {
    const res: any = {
      req: { headers: { "accept-encoding": "gzip" } },
      headersSent: true,
      written: "",
      end(body?: string | Buffer) {
        this.written = body;
      },
    };
    json(res, 200, big);
    // a partial response is already streaming; just finish with the plain body
    expect(res.written).toBe(JSON.stringify(big));
  });
});

// A stand-in for the minified bundle/docs CSS the marketing, /docs and
// packaged-app handlers all read off disk and send verbatim.
const asset = Buffer.from(`const app=()=>{${"return 1;".repeat(400)}};\n`);

// negotiateStaticGzip only reads `.headers`, so a plain object is the whole
// request surface it needs.
const req = (headers: Record<string, string | string[]>) => ({ headers });

describe("negotiateStaticGzip()", () => {
  it("compresses a large text asset and round-trips it byte-for-byte", () => {
    const out = negotiateStaticGzip(req({ "accept-encoding": "gzip, deflate, br" }), "text/javascript", asset);
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThan(asset.length);
    expect(gunzipSync(out!)).toEqual(asset);
  });

  it("compresses the content types the docs and marketing dirs actually serve", () => {
    for (const type of ["text/html", "text/css", "text/plain", "text/markdown; charset=utf-8", "image/svg+xml", "application/json"]) {
      expect(negotiateStaticGzip(req({ "accept-encoding": "gzip" }), type, asset), type).not.toBeNull();
    }
  });

  // The updater's blockmap delta downloader addresses byte offsets in the
  // UNCOMPRESSED installer. Compressing a ranged read would hand back offsets
  // into the wrong byte stream and silently corrupt the assembled update.
  it("never compresses a request carrying Range", () => {
    expect(negotiateStaticGzip(req({ "accept-encoding": "gzip", range: "bytes=0-1023" }), "text/javascript", asset)).toBeNull();
    // even a suffix range, and even the multi-range form serveStaticRange ignores
    expect(negotiateStaticGzip(req({ "accept-encoding": "gzip", range: "bytes=-512" }), "text/javascript", asset)).toBeNull();
  });

  it("leaves already-compressed media alone", () => {
    for (const type of ["font/woff2", "image/png", "image/webp", "application/zip", "application/wasm", "application/octet-stream"]) {
      expect(negotiateStaticGzip(req({ "accept-encoding": "gzip" }), type, asset), type).toBeNull();
    }
  });

  it("leaves a sub-threshold body alone", () => {
    expect(negotiateStaticGzip(req({ "accept-encoding": "gzip" }), "text/html", Buffer.from("<p>hi</p>"))).toBeNull();
  });

  it("stays plain when the client sends no Accept-Encoding, or identity only", () => {
    expect(negotiateStaticGzip(req({}), "text/javascript", asset)).toBeNull();
    expect(negotiateStaticGzip(req({ "accept-encoding": "identity" }), "text/javascript", asset)).toBeNull();
    // br/deflate-only clients must not be handed gzip
    expect(negotiateStaticGzip(req({ "accept-encoding": "br, deflate" }), "text/javascript", asset)).toBeNull();
  });

  it("keeps the original when gzip would make the body bigger", () => {
    // random bytes are incompressible: the gzip framing would only add overhead
    const noise = randomBytes(4096);
    expect(negotiateStaticGzip(req({ "accept-encoding": "gzip" }), "application/octet-stream", noise)).toBeNull();
  });

  it("reads a repeated accept-encoding header as one list", () => {
    expect(negotiateStaticGzip({ headers: { "accept-encoding": ["deflate", "gzip"] } }, "text/css", asset)).not.toBeNull();
  });
});

describe("isCompressibleType()", () => {
  it("ignores content-type parameters", () => {
    expect(isCompressibleType("text/markdown; charset=utf-8")).toBe(true);
    expect(isCompressibleType("APPLICATION/JSON; charset=UTF-8")).toBe(true);
  });

  it("rejects media that is already compressed", () => {
    expect(isCompressibleType("image/jpeg")).toBe(false);
    expect(isCompressibleType("font/woff2")).toBe(false);
    expect(isCompressibleType("application/gzip")).toBe(false);
  });
});

describe("applyGzipHeaders()", () => {
  it("overwrites a content-length computed from the plain body", () => {
    // the marketing handler precomputes content-length before deciding to
    // compress; leaving it would hang the client waiting for absent bytes
    const headers: OutgoingHttpHeaders = { "content-type": "text/javascript", "content-length": asset.length };
    applyGzipHeaders(headers, 42);
    expect(headers["content-encoding"]).toBe("gzip");
    expect(headers.vary).toBe("Accept-Encoding");
    expect(headers["content-length"]).toBe(42);
  });
});
