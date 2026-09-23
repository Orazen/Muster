import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { combinePermissionRead, thumbnailIndicatesCapture } from "./desktop-permission-probe.mjs";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// IHDR data lands at byte 16 (signature + chunk length + type); these are the
// byte offsets of the fields the probe rejects on.
const DEPTH_BYTE = 24;
const COLOR_TYPE_BYTE = 25;
const INTERLACE_BYTE = 28;

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  // CRC-32 stays zeroed on purpose: the probe decodes pixels and never
  // verifies chunk checksums.
  return Buffer.concat([length, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]);
}

function paethPredictor(a, b, c) {
  const estimate = a + b - c;
  const distanceA = Math.abs(estimate - a);
  const distanceB = Math.abs(estimate - b);
  const distanceC = Math.abs(estimate - c);
  if (distanceA <= distanceB && distanceA <= distanceC) return a;
  return distanceB <= distanceC ? b : c;
}

function rgbaSolid(width, height, red, green, blue, alpha = 255) {
  const pixels = Buffer.alloc(width * height * 4);
  for (let index = 0; index < pixels.length; index += 4) {
    pixels[index] = red;
    pixels[index + 1] = green;
    pixels[index + 2] = blue;
    pixels[index + 3] = alpha;
  }
  return pixels;
}

// RGBA pixels plus per-row filter types → a PNG the probe can decode. Kept
// independent of the probe on purpose: it filters forward, the probe unfilters.
function encodeRgbaPng(width, height, rgba, filters = []) {
  const channels = 4;
  const stride = width * channels;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let row = 0; row < height; row++) {
    const filter = filters[row] ?? 0;
    const start = row * (stride + 1);
    raw[start] = filter;
    for (let column = 0; column < stride; column++) {
      const value = rgba[row * stride + column];
      const left = column >= channels ? rgba[row * stride + column - channels] : 0;
      const up = row > 0 ? rgba[(row - 1) * stride + column] : 0;
      const upLeft = row > 0 && column >= channels ? rgba[(row - 1) * stride + column - channels] : 0;
      let encoded;
      if (filter === 0) encoded = value;
      else if (filter === 1) encoded = value - left;
      else if (filter === 2) encoded = value - up;
      else if (filter === 3) encoded = value - ((left + up) >> 1);
      else encoded = value - paethPredictor(left, up, upLeft);
      raw[start + 1 + column] = encoded & 0xff;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth NativeImage never exceeds
  header[9] = 6; // RGBA
  return Buffer.concat([SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const pngDataUrl = (png) => `data:image/png;base64,${png.toString("base64")}`;

describe("thumbnailIndicatesCapture", () => {
  it("accepts BGRA pixels above the floor", () => {
    const bitmap = rgbaSolid(2, 2, 0, 0, 0, 255);
    bitmap[6] = 40; // one red byte inside the second BGRA group; alpha never counts
    expect(thumbnailIndicatesCapture({ toBitmap: () => bitmap })).toBe(true);
  });
  it("rejects an all-zero BGRA bitmap whose alpha bytes are 255", () => {
    expect(thumbnailIndicatesCapture({ toBitmap: () => rgbaSolid(3, 3, 0, 0, 0, 255) })).toBe(false);
    expect(thumbnailIndicatesCapture({ toBitmap: () => Buffer.alloc(16) })).toBe(false);
  });
  it("rejects an empty bitmap", () => {
    expect(thumbnailIndicatesCapture({ toBitmap: () => Buffer.alloc(0) })).toBe(false);
  });
  it("treats a readable bitmap as authoritative over the data URL", () => {
    const thumbnail = {
      toBitmap: () => Buffer.alloc(8),
      toDataURL: () => pngDataUrl(encodeRgbaPng(1, 1, rgbaSolid(1, 1, 200, 30, 40))),
    };
    expect(thumbnailIndicatesCapture(thumbnail)).toBe(false);
  });
  it("falls back to the data URL when the bitmap read throws", () => {
    const thumbnail = {
      toBitmap: () => { throw new Error("bitmap unavailable"); },
      toDataURL: () => pngDataUrl(encodeRgbaPng(1, 1, rgbaSolid(1, 1, 200, 30, 40))),
    };
    expect(thumbnailIndicatesCapture(thumbnail)).toBe(true);
  });
  it("reads real pixels from a PNG data URL", () => {
    const thumbnail = { toDataURL: () => pngDataUrl(encodeRgbaPng(2, 2, rgbaSolid(2, 2, 200, 30, 40))) };
    expect(thumbnailIndicatesCapture(thumbnail)).toBe(true);
  });
  it("rejects a PNG whose pixels are all zero even with opaque alpha", () => {
    const thumbnail = { toDataURL: () => pngDataUrl(encodeRgbaPng(2, 2, rgbaSolid(2, 2, 0, 0, 0, 255))) };
    expect(thumbnailIndicatesCapture(thumbnail)).toBe(false);
  });
  it("unfilters rows so a rising near-black frame still counts as captured", () => {
    // RGB rows step 0 → 6 → 12 under the Up filter, so every stored byte (row
    // deltas 6, filter tags 2) sits at or below the floor until the rows are
    // reconstructed — only a real unfilter can see the 12.
    const width = 2;
    const height = 3;
    const pixels = Buffer.alloc(width * height * 4);
    for (let row = 0; row < height; row++) {
      const level = row * 6;
      for (let column = 0; column < width; column++) {
        const index = (row * width + column) * 4;
        pixels[index] = level;
        pixels[index + 1] = level;
        pixels[index + 2] = level;
        pixels[index + 3] = 0;
      }
    }
    const thumbnail = { toDataURL: () => pngDataUrl(encodeRgbaPng(width, height, pixels, [0, 2, 2])) };
    expect(thumbnailIndicatesCapture(thumbnail)).toBe(true);
  });
  it.each([
    ["an empty payload", "data:image/png;base64,"],
    ["a non-data URL", "not-a-data-url"],
    ["garbage base64", "data:image/png;base64,@@@@not-image"],
    ["a percent-encoded payload", "data:image/png,%89PNG"],
  ])("rejects %s", (_, dataUrl) => {
    expect(thumbnailIndicatesCapture({ toDataURL: () => dataUrl })).toBe(false);
  });
  it("rejects a PNG whose compressed data cannot inflate", () => {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(1, 0);
    header.writeUInt32BE(1, 4);
    header[8] = 8;
    header[9] = 6;
    const broken = Buffer.concat([SIGNATURE, chunk("IHDR", header), chunk("IDAT", Buffer.from("not a deflate stream")), chunk("IEND", Buffer.alloc(0))]);
    expect(thumbnailIndicatesCapture({ toDataURL: () => pngDataUrl(broken) })).toBe(false);
  });
  it("rejects truncated PNG bytes", () => {
    const png = encodeRgbaPng(2, 2, rgbaSolid(2, 2, 200, 30, 40));
    expect(thumbnailIndicatesCapture({ toDataURL: () => pngDataUrl(png.subarray(0, 30)) })).toBe(false);
  });
  it.each([[DEPTH_BYTE, 16], [COLOR_TYPE_BYTE, 3], [INTERLACE_BYTE, 1]])(
    "fails closed on the PNG variant with byte %i set to %i",
    (offset, value) => {
      // Real pixels sit behind an encoding the probe does not decode
      // (16-bit samples, palette, Adam7 interlace); never guess at them.
      const png = encodeRgbaPng(1, 1, rgbaSolid(1, 1, 200, 30, 40));
      png[offset] = value;
      expect(thumbnailIndicatesCapture({ toDataURL: () => pngDataUrl(png) })).toBe(false);
    },
  );
  it.each([null, undefined, 42, "evidence", true])("rejects %s as unreadable evidence", (value) => {
    expect(thumbnailIndicatesCapture(value)).toBe(false);
  });
  it("rejects objects whose capture methods are unusable", () => {
    expect(thumbnailIndicatesCapture({})).toBe(false);
    expect(thumbnailIndicatesCapture({ toBitmap: 7 })).toBe(false);
    expect(thumbnailIndicatesCapture({ toBitmap: 7, toDataURL: "nope" })).toBe(false);
    expect(thumbnailIndicatesCapture({ toBitmap: () => "garbage" })).toBe(false);
    expect(thumbnailIndicatesCapture({ toDataURL: () => undefined })).toBe(false);
    expect(thumbnailIndicatesCapture({ toDataURL: () => 12345 })).toBe(false);
    expect(thumbnailIndicatesCapture({ toDataURL: () => { throw new Error("no evidence"); } })).toBe(false);
  });
});

describe("combinePermissionRead", () => {
  const full = { accessibility: true, screenRecording: true };
  const none = { accessibility: false, screenRecording: false };

  it("grants on the SDK preflight alone", () => {
    expect(combinePermissionRead({ sdk: full, empirical: none }))
      .toEqual({ granted: true, reason: "SDK preflight reported Accessibility and Screen Recording" });
  });
  it("grants fresh empirical proof over a preflight stuck denied", () => {
    expect(combinePermissionRead({ sdk: none, empirical: full }))
      .toEqual({ granted: true, reason: "fresh desktop probe reported Accessibility and Screen Recording" });
  });
  it("takes the SDK path when both sources report both permissions", () => {
    expect(combinePermissionRead({ sdk: full, empirical: full }).reason)
      .toBe("SDK preflight reported Accessibility and Screen Recording");
  });
  it("withholds both permissions when neither source proves them", () => {
    expect(combinePermissionRead({ sdk: none, empirical: none }))
      .toEqual({ granted: false, reason: "Accessibility and Screen Recording" });
  });
  it.each([
    [{ accessibility: true, screenRecording: false }, { accessibility: true, screenRecording: false }, "Screen Recording"],
    [{ accessibility: false, screenRecording: false }, { accessibility: false, screenRecording: true }, "Accessibility"],
    [{ accessibility: false, screenRecording: false }, { accessibility: true, screenRecording: false }, "Screen Recording"],
  ])("names only the unproven permission for sdk %j with empirical %j", (sdk, empirical, missing) => {
    expect(combinePermissionRead({ sdk, empirical })).toEqual({ granted: false, reason: missing });
  });
  it("treats absent or partial reads as unproven", () => {
    expect(combinePermissionRead({})).toEqual({ granted: false, reason: "Accessibility and Screen Recording" });
    expect(combinePermissionRead({ sdk: null, empirical: null })).toEqual({ granted: false, reason: "Accessibility and Screen Recording" });
    expect(combinePermissionRead({ sdk: { accessibility: true } })).toEqual({ granted: false, reason: "Screen Recording" });
    expect(combinePermissionRead({ empirical: { screenRecording: true } })).toEqual({ granted: false, reason: "Accessibility" });
  });
  it("withholds when each source attests only the other's half", () => {
    // Neither grant clause holds: the SDK clause needs both SDK flags and the
    // fresh-proof override needs both probe flags. Accessibility reads are
    // monotonic within a process, so this split cannot occur in production.
    expect(combinePermissionRead({
      sdk: { accessibility: true, screenRecording: false },
      empirical: { accessibility: false, screenRecording: true },
    })).toEqual({ granted: false, reason: "macOS permissions" });
  });
});
