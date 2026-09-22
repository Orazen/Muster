// json() is the single serialization point for every API route, so its
// negotiation is tested at the boundary: what a client that CAN and CANNOT
// decompress actually receives, and that the compressed bytes round-trip to
// the exact JSON. A mock ServerResponse captures the headers + body instead
// of touching a socket.
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { json } from "./http-helpers.ts";

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
