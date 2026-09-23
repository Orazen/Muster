// Pure evidence readers for the injected desktop-permission probe. This
// module imports nothing from electron: callers hand in every native surface
// (thumbnail, SDK preflight, empirical read), so each branch stays
// unit-testable outside a live Mac session.
//
// Why fresh evidence exists: the Screen Recording comment in
// electron/main.mjs documents that on macOS 15+ every pre-grant/preflight
// mechanism caches per-process and keeps reporting denied after the user
// grants mid-session. The first real in-process capture is the one reliable
// witness; this module decides whether a witness is real, and whether the
// stale preflight or fresh proof carries the grant.

import { inflateSync } from "node:zlib";

// A denied capture is an empty image or exact zeros — never dim noise — so
// any color byte above this floor is a real captured pixel. The floor stays
// small so a dark desktop still counts as captured.
const PIXEL_FLOOR = 8;
const PNG_SIGNATURE = 0x89504e47;

// NativeImage's bitmap layout is BGRA: walk four bytes at a time and read the
// first three, never the alpha byte (every opaque frame carries 255 there).
function bgraExceedsFloor(bitmap) {
  for (let index = 0; index + 2 < bitmap.length; index += 4) {
    if (bitmap[index] > PIXEL_FLOOR || bitmap[index + 1] > PIXEL_FLOOR || bitmap[index + 2] > PIXEL_FLOOR) return true;
  }
  return false;
}

function paethPredictor(a, b, c) {
  const estimate = a + b - c;
  const distanceA = Math.abs(estimate - a);
  const distanceB = Math.abs(estimate - b);
  const distanceC = Math.abs(estimate - c);
  if (distanceA <= distanceB && distanceA <= distanceC) return a;
  return distanceB <= distanceC ? b : c;
}

// Reverse PNG's per-row filters so the floor reads actual pixels. A filtered
// row of near-uniform content stores tiny deltas that would miss the floor,
// and a stale "denied" verdict must never survive a genuinely captured frame.
function unfilter(raw, width, height, channels) {
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);
  let source = 0;
  for (let row = 0; row < height; row++) {
    const filter = raw[source];
    source += 1;
    if (filter > 4) return null;
    const target = row * stride;
    const previous = target - stride;
    for (let column = 0; column < stride; column++) {
      const encoded = raw[source + column];
      const left = column >= channels ? pixels[target + column - channels] : 0;
      const up = row > 0 ? pixels[previous + column] : 0;
      const upLeft = row > 0 && column >= channels ? pixels[previous + column - channels] : 0;
      let decoded;
      if (filter === 0) decoded = encoded;
      else if (filter === 1) decoded = encoded + left;
      else if (filter === 2) decoded = encoded + up;
      else if (filter === 3) decoded = encoded + ((left + up) >> 1);
      else decoded = encoded + paethPredictor(left, up, upLeft);
      pixels[target + column] = decoded & 0xff;
    }
    source += stride;
  }
  return pixels;
}

function colorTypeChannels(colorType) {
  if (colorType === 0) return 1; // grayscale: the luminance byte is evidence
  if (colorType === 2) return 3; // RGB
  if (colorType === 4) return 2; // grayscale + alpha: keep the gray byte
  if (colorType === 6) return 4; // RGBA — what NativeImage's encoder emits
  return undefined;              // palette never carries pixel magnitude; fail closed
}

function pixelsExceedsFloor(pixels, channels) {
  const colorChannels = channels === 4 ? 3 : channels === 2 ? 1 : channels;
  for (let index = 0; index < pixels.length; index++) {
    if (index % channels >= colorChannels) continue; // alpha never proves capture
    if (pixels[index] > PIXEL_FLOOR) return true;
  }
  return false;
}

// Minimal PNG reader: signature, IHDR, concatenated IDAT, inflate, unfilter.
// Anything this does not understand (truncation, bad compression, 16-bit or
// interlaced encodings) fails closed instead of guessing.
function pngExceedsFloor(png) {
  if (png.length < 8 || png.readUInt32BE(0) !== PNG_SIGNATURE) return false;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  let interlace = 0;
  let sawHeader = false;
  const idat = [];
  let offset = 8;
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > png.length) return false;
    const type = png.toString("latin1", offset + 4, offset + 8);
    if (type === "IHDR") {
      if (length !== 13) return false;
      width = png.readUInt32BE(offset + 8);
      height = png.readUInt32BE(offset + 12);
      depth = png[offset + 16];
      colorType = png[offset + 17];
      interlace = png[offset + 20];
      sawHeader = true;
    } else if (type === "IDAT") {
      idat.push(png.subarray(offset + 8, offset + 8 + length));
    } else if (type === "IEND") {
      break;
    }
    offset = end;
  }
  const channels = colorTypeChannels(colorType);
  if (!sawHeader || width < 1 || height < 1 || depth !== 8 || channels === undefined || interlace !== 0 || idat.length === 0) return false;
  let raw;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    return false;
  }
  if (raw.length < height * (width * channels + 1)) return false;
  const pixels = unfilter(raw, width, height, channels);
  if (pixels === null) return false;
  return pixelsExceedsFloor(pixels, channels);
}

function dataUrlExceedsFloor(dataUrl) {
  if (!dataUrl.startsWith("data:")) return false;
  const separator = dataUrl.indexOf(",");
  if (separator < 0) return false;
  if (!dataUrl.slice(0, separator).includes("base64")) return false;
  const png = Buffer.from(dataUrl.slice(separator + 1), "base64");
  if (png.length === 0) return false; // the denied capture: no image at all
  return pngExceedsFloor(png);
}

// True only when the thumbnail proves a real in-process capture. Empty
// buffers, all-zero pixels, malformed input and unreadable evidence all read
// false: a denied Screen Recording capture must never pass this gate.
export function thumbnailIndicatesCapture(thumbnail) {
  try {
    const bitmap = thumbnail?.toBitmap?.();
    // A readable bitmap is the authoritative pixel read; NativeImage keeps it
    // in step with the data URL, so its verdict stands without consulting it.
    if (bitmap instanceof Uint8Array) return bgraExceedsFloor(bitmap);
  } catch {
    // A thumbnail that cannot produce pixels offers its data URL instead.
  }
  try {
    const dataUrl = thumbnail?.toDataURL?.();
    if (dataUrl !== undefined && dataUrl !== null) return dataUrlExceedsFloor(String(dataUrl));
  } catch {
    // Fail closed: unreadable evidence never proves a capture.
  }
  return false;
}

// Decide desktop-permission state from the SDK preflight plus fresh empirical
// evidence. The SDK reading both permissions grants outright; otherwise the
// fresh probe's both-true reading overrides the macOS 15+ preflight that
// caches per-process and stays denied after a mid-session grant. When neither
// clause holds, the reason names the permission no source has proven —
// measured per permission, so a stale half never re-blocks a proven half.
export function combinePermissionRead({ sdk, empirical } = {}) {
  const attests = (source) => ({
    accessibility: source?.accessibility === true,
    screenRecording: source?.screenRecording === true,
  });
  const sdkRead = attests(sdk);
  const empiricalRead = attests(empirical);
  if (sdkRead.accessibility && sdkRead.screenRecording) {
    return { granted: true, reason: "SDK preflight reported Accessibility and Screen Recording" };
  }
  if (empiricalRead.accessibility && empiricalRead.screenRecording) {
    return { granted: true, reason: "fresh desktop probe reported Accessibility and Screen Recording" };
  }
  const missing = [
    !(sdkRead.accessibility || empiricalRead.accessibility) && "Accessibility",
    !(sdkRead.screenRecording || empiricalRead.screenRecording) && "Screen Recording",
  ].filter(Boolean).join(" and ");
  return { granted: false, reason: missing || "macOS permissions" };
}
