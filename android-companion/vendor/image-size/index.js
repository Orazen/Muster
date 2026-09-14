"use strict";

/**
 * A minimal, locally-owned replacement for the upstream `image-size` package.
 *
 * Why this file exists. Two open advisories cover **every published release**
 * of upstream, `GHSA-w3rx-r6r6-pgpr` (ICNS) and `GHSA-5p2g-fcmc-qvqq`
 * (JXL/HEIF): both are unbounded loops in parsers this project never wanted,
 * both have an affected range of `<=2.0.2`, and 2.0.2 is the newest publish,
 * so there is no version to upgrade to. Metro 0.87.1 dropped the dependency
 * outright, but this app is pinned to Expo SDK 52 / react-native 0.76.7 and
 * taking that Metro would be a framework migration rather than a bump, so the
 * vulnerable code is removed from the tree by overriding the package with
 * this file instead.
 *
 * What is here: header readers for PNG, JPEG, GIF, BMP and WebP -- the formats
 * this app's assets use and the ones Metro asks for dimensions on.
 *
 * What is deliberately absent: **no ICNS, JXL, HEIF/HEIC, JP2/J2C, AVIF, PSD,
 * TIFF, KTX, ICO/CUR, DDS, TGA, PNM or SVG parser exists in this file**. Those
 * are precisely the code paths the advisories describe, so they are not
 * ported, not stubbed and not reachable. The signatures we still recognise are
 * refused by name, so an error says which format was rejected; anything else
 * is refused as unknown.
 *
 * Safety shape: every loop below advances by at least one byte or returns, and
 * every multi-byte read is bounds-checked before it happens, so no input can
 * spin or read past the end. That is the property the advisories' proof of
 * concept inputs target, and it is asserted in test.mjs.
 *
 * Trust model for the path-taking form. `imageSize("path.png")` exists only
 * because the package it replaces has that signature: Metro calls it with the
 * absolute path of an asset it has already resolved out of its own registry,
 * and nothing in this app passes end-user input here. The file that may be
 * opened is nonetheless constrained by construction: the extension must be one
 * of the five formats below, and the target must be a regular file. No other
 * path is opened, and no path is ever written to. A caller that wants no
 * filesystem access at all can remove the form entirely with
 * `disableFS(true)`, which makes it throw.
 */

const fs = require("node:fs");
const path = require("node:path");

// Upstream reads at most 512 KiB of a file to find a header. The same ceiling
// is kept so a large asset still gets a header-only read.
const MaxInputSize = 512 * 1024;

// The only formats this reader understands. Everything else is refused; see
// `refusedSignatures` for the formats that are recognised just well enough to
// be named in the refusal.
const SUPPORTED_TYPES = Object.freeze(["png", "jpg", "gif", "bmp", "webp"]);

// The only file extensions the path-taking form will open, checked on the
// basename before any descriptor exists. Metro's asset registry only ever
// hands over a path whose extension is one of these.
const READABLE_EXTENSIONS = Object.freeze(["png", "jpg", "jpeg", "gif", "bmp", "webp"]);

const HEIF_BRANDS = Object.freeze(["avif", "mif1", "msf1", "heic", "heix", "hevc", "hevx"]);

const PNG_SIGNATURE = Object.freeze([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_CHUNK_IHDR = "IHDR";
// "fried" PNGs from the Apple toolchain put CgBI where IHDR belongs.
const PNG_CHUNK_CGBI = "CgBI";

const globalOptions = {
  disabledFS: false,
  disabledTypes: [],
};

function toAscii(input, start, end) {
  if (start < 0 || end < start || end > input.length) return undefined;
  let text = "";
  for (let index = start; index < end; index += 1) {
    text += String.fromCharCode(input[index]);
  }
  return text;
}

function toHex(input, start, end) {
  const text = toAscii(input, start, end);
  if (text === undefined) return undefined;
  let hex = "";
  for (let index = 0; index < text.length; index += 1) {
    hex += text.charCodeAt(index).toString(16).padStart(2, "0");
  }
  return hex;
}

/** Refuse to read past the end instead of producing NaN from `undefined`. */
function requireBytes(input, offset, length) {
  if (offset < 0 || !Number.isInteger(offset) || input.length - offset < length) {
    throw new Error(
      `truncated image: need ${length} bytes at offset ${offset} but only ${input.length} are present`,
    );
  }
}

function readUInt16BE(input, offset) {
  requireBytes(input, offset, 2);
  return input[offset] * 0x100 + input[offset + 1];
}

function readUInt16LE(input, offset) {
  requireBytes(input, offset, 2);
  return input[offset] + input[offset + 1] * 0x100;
}

function readUInt24LE(input, offset) {
  requireBytes(input, offset, 3);
  return input[offset] + input[offset + 1] * 0x100 + input[offset + 2] * 0x10000;
}

function readUInt32BE(input, offset) {
  requireBytes(input, offset, 4);
  return (
    input[offset] * 0x1000000 +
    input[offset + 1] * 0x10000 +
    input[offset + 2] * 0x100 +
    input[offset + 3]
  );
}

function readUInt32LE(input, offset) {
  requireBytes(input, offset, 4);
  return (
    input[offset] +
    input[offset + 1] * 0x100 +
    input[offset + 2] * 0x10000 +
    input[offset + 3] * 0x1000000
  );
}

function readInt16LE(input, offset) {
  const value = readUInt16LE(input, offset);
  return value >= 0x8000 ? value - 0x10000 : value;
}

function readInt32LE(input, offset) {
  const value = readUInt32LE(input, offset);
  return value >= 0x80000000 ? value - 0x100000000 : value;
}

/**
 * Walk the ISO-BMFF box list far enough to name a format.
 *
 * The loop is bounded twice over: a box header is 8 bytes, and any declared
 * size below that is treated as 8, so every iteration moves forward. A box
 * that claims to run past the end of the input ends the walk.
 */
function findBox(input, name, start) {
  let offset = start;
  while (input.length - offset >= 8) {
    const size = readUInt32BE(input, offset);
    if (toAscii(input, offset + 4, offset + 8) === name) return { offset, size };
    const step = size >= 8 ? size : 8;
    if (step > input.length - offset) return undefined;
    offset += step;
  }
  return undefined;
}

/** The one gate every path-taking read passes through, before any descriptor. */
function assertReadableImagePath(filepath) {
  const extension = path.extname(filepath).toLowerCase();
  const bare = extension.startsWith(".") ? extension.slice(1) : extension;
  if (!READABLE_EXTENSIONS.includes(bare)) {
    throw new TypeError(`refusing to read a path that is not a known image: ${filepath}`);
  }
}

const png = {
  validate(input) {
    if (input.length < PNG_SIGNATURE.length) return false;
    for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
      if (input[index] !== PNG_SIGNATURE[index]) return false;
    }
    let chunk = toAscii(input, 12, 16);
    if (chunk === PNG_CHUNK_CGBI) chunk = toAscii(input, 28, 32);
    if (chunk !== PNG_CHUNK_IHDR) throw new TypeError("Invalid PNG");
    return true;
  },
  calculate(input) {
    if (toAscii(input, 12, 16) === PNG_CHUNK_CGBI) {
      return { width: readUInt32BE(input, 32), height: readUInt32BE(input, 36) };
    }
    return { width: readUInt32BE(input, 16), height: readUInt32BE(input, 20) };
  },
};

const jpg = {
  validate: (input) => toHex(input, 0, 2) === "ffd8",
  calculate(input) {
    requireBytes(input, 0, 2);
    let offset = 2;
    // Every branch below either returns or moves `offset` forward, so the walk
    // cannot stall on a malformed stream.
    while (offset + 1 < input.length) {
      if (input[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = input[offset + 1];
      if (marker === 0xff) {
        offset += 1;
      } else if (
        marker === 0x01 ||
        marker === 0xd8 ||
        marker === 0xd9 ||
        (marker >= 0xd0 && marker <= 0xd7)
      ) {
        offset += 2;
      } else {
        const length = readUInt16BE(input, offset + 2);
        if (length < 2) throw new TypeError("Invalid JPG, segment length below 2");
        // SOF0/SOF1/SOF2 carry the dimensions. The extended and differential
        // SOFs are not required to read this app's assets.
        if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
          return {
            width: readUInt16BE(input, offset + 7),
            height: readUInt16BE(input, offset + 5),
          };
        }
        offset += 2 + length;
      }
    }
    throw new TypeError("Invalid JPG, no size found");
  },
};

const gif = {
  validate: (input) => {
    const header = toAscii(input, 0, 6);
    return header === "GIF87a" || header === "GIF89a";
  },
  calculate: (input) => ({
    width: readUInt16LE(input, 6),
    height: readUInt16LE(input, 8),
  }),
};

const bmp = {
  validate: (input) => toAscii(input, 0, 2) === "BM",
  // Field layout follows upstream exactly, including its use of the 32-bit
  // offsets for the less common BITMAPCOREHEADER, so dimensions do not move.
  calculate: (input) => ({
    width: readUInt32LE(input, 18),
    height: Math.abs(readInt32LE(input, 22)),
  }),
};

const webp = {
  validate: (input) =>
    toAscii(input, 0, 4) === "RIFF" &&
    toAscii(input, 8, 12) === "WEBP" &&
    toAscii(input, 12, 15) === "VP8",
  calculate(input) {
    const chunk = toAscii(input, 12, 16);
    if (chunk === "VP8X") {
      requireBytes(input, 20, 10);
      const flags = input[20];
      if ((flags & 0xc0) !== 0 || (flags & 0x01) !== 0) throw new TypeError("Invalid WebP");
      return { width: 1 + readUInt24LE(input, 24), height: 1 + readUInt24LE(input, 27) };
    }
    if (chunk === "VP8 " && input[20] !== 0x2f) {
      return {
        width: readInt16LE(input, 26) & 0x3fff,
        height: readInt16LE(input, 28) & 0x3fff,
      };
    }
    if (chunk === "VP8L" && toHex(input, 23, 26) !== "9d012a") {
      requireBytes(input, 20, 5);
      return {
        width: 1 + (((input[22] & 0x3f) << 8) | input[21]),
        height: 1 + (((input[24] & 0xf) << 10) | (input[23] << 2) | ((input[22] & 0xc0) >> 6)),
      };
    }
    throw new TypeError("Invalid WebP");
  },
};

const supportedHandlers = { png, jpg, gif, bmp, webp };

/**
 * Formats that are recognised only so the refusal can name them. There is no
 * parser behind any of these entries: `calculate` does not exist, and the
 * dispatch below never reaches one because `supportedHandlers` has no key.
 */
const refusedSignatures = [
  { type: "icns", validate: (input) => toAscii(input, 0, 4) === "icns" },
  {
    type: "jxl",
    validate: (input) => toAscii(input, 4, 8) === "JXL " && toHex(input, 8, 12) === "0d0a870a",
  },
  {
    type: "jxl-stream",
    validate: (input) => input.length >= 2 && input[0] === 0xff && input[1] === 0x0a,
  },
  {
    type: "heif",
    validate(input) {
      if (toAscii(input, 4, 8) !== "ftyp") return false;
      const box = findBox(input, "ftyp", 0);
      return (
        box !== undefined && HEIF_BRANDS.includes(toAscii(input, box.offset + 8, box.offset + 12))
      );
    },
  },
  {
    type: "jp2",
    validate(input) {
      if (toAscii(input, 4, 8) !== "jP  ") return false;
      const box = findBox(input, "ftyp", 0);
      return box !== undefined && toAscii(input, box.offset + 8, box.offset + 12) === "jp2 ";
    },
  },
  { type: "j2c", validate: (input) => toHex(input, 0, 4) === "ff4fff51" },
  { type: "psd", validate: (input) => toAscii(input, 0, 4) === "8BPS" },
  { type: "dds", validate: (input) => toHex(input, 0, 4) === "44445320" },
  { type: "tiff", validate: (input) => ["49492a00", "4d4d002a"].includes(toHex(input, 0, 4)) },
  { type: "ktx", validate: (input) => ["KTX 11", "KTX 20"].includes(toAscii(input, 1, 7)) },
  {
    type: "ico",
    validate: (input) =>
      input.length >= 6 &&
      readUInt16LE(input, 0) === 0 &&
      readUInt16LE(input, 4) !== 0 &&
      (input[2] === 1 || input[2] === 2),
  },
  { type: "pnm", validate: (input) => /^P[1-6]$/.test(toAscii(input, 0, 2) ?? "") },
  { type: "svg", validate: (input) => input[0] === 0x3c },
];

// A validator must never turn a refusal into a crash: these run only to pick a
// name for the error, so a signature that cannot be read is simply not a match.
const safe = (validate) => (input) => {
  try {
    return validate(input);
  } catch {
    return false;
  }
};

const signatures = [
  ...SUPPORTED_TYPES.map((type) => ({ type, validate: supportedHandlers[type].validate })),
  ...refusedSignatures.map(({ type, validate }) => ({ type, validate: safe(validate) })),
];

function detector(input) {
  for (const candidate of signatures) {
    if (candidate.validate(input)) return candidate.type;
  }
  return undefined;
}

function lookup(input, filepath) {
  if (input.length === 0) throw new Error("Empty file");
  const type = detector(input);
  if (type !== undefined) {
    if (globalOptions.disabledTypes.includes(type)) {
      throw new TypeError(`disabled file type: ${type}`);
    }
    const handler = supportedHandlers[type];
    if (handler !== undefined) {
      const size = handler.calculate(input, filepath);
      return { width: size.width, height: size.height, type: size.type ?? type };
    }
  }
  throw new TypeError(`unsupported file type: ${type} (file: ${filepath})`);
}

/**
 * The asynchronous form is unused by Metro, but it is part of the surface this
 * file replaces, so it is kept -- with a bounded number of parallel reads
 * rather than an unbounded fan-out of file descriptors.
 */
let concurrency = 100;
let active = 0;
const waiting = [];

function release() {
  active -= 1;
  const next = waiting.shift();
  if (next !== undefined) next();
}

function schedule(task) {
  return new Promise((resolve, reject) => {
    const start = () => {
      active += 1;
      task().then(
        (value) => {
          release();
          resolve(value);
        },
        (error) => {
          release();
          reject(error);
        },
      );
    };
    if (active < concurrency) start();
    else waiting.push(start);
  });
}

/** A header-only read of at most `MaxInputSize`, and only of a regular file. */
function headerOf(stat) {
  if (!stat.isFile()) throw new Error("not a regular file");
  if (stat.size <= 0) throw new Error("Empty file");
  return Math.min(stat.size, MaxInputSize);
}

async function readFileAsync(filepath) {
  assertReadableImagePath(filepath);
  const handle = await fs.promises.open(filepath, "r");
  try {
    const inputSize = headerOf(await handle.stat());
    const input = new Uint8Array(inputSize);
    await handle.read(input, 0, inputSize, 0);
    return input;
  } finally {
    await handle.close();
  }
}

function readFileSync(filepath) {
  assertReadableImagePath(filepath);
  const descriptor = fs.openSync(filepath, "r");
  try {
    const inputSize = headerOf(fs.fstatSync(descriptor));
    const input = new Uint8Array(inputSize);
    fs.readSync(descriptor, input, 0, inputSize, 0);
    return input;
  } finally {
    fs.closeSync(descriptor);
  }
}

/**
 * @param {Uint8Array|string} input - image bytes, or the path of an image file
 * @param {Function=} [callback] - optional callback for the asynchronous form
 */
function imageSize(input, callback) {
  if (input instanceof Uint8Array) return lookup(input);
  if (typeof input !== "string" || globalOptions.disabledFS) {
    throw new TypeError("invalid invocation. input should be a Uint8Array");
  }
  // The caller's path goes to the filesystem unchanged: `fs` resolves a
  // relative path against the working directory exactly as upstream's
  // `path.resolve` did, and the extension gate above runs first.
  if (typeof callback === "function") {
    void schedule(() => readFileAsync(input)).then(
      (bytes) => {
        let result;
        let failure = null;
        try {
          result = lookup(bytes, input);
        } catch (error) {
          failure = error;
        }
        process.nextTick(callback, failure, result);
      },
      (error) => {
        process.nextTick(callback, error);
      },
    );
    return undefined;
  }
  return lookup(readFileSync(input), input);
}

const disableFS = (value) => {
  globalOptions.disabledFS = Boolean(value);
};

const disableTypes = (values) => {
  globalOptions.disabledTypes = [...values];
};

const setConcurrency = (value) => {
  concurrency = value;
};

// `module.exports = imageSize` keeps `require("image-size")(buffer)` working,
// which is how Metro calls this package.
module.exports = imageSize;
module.exports.default = imageSize;
module.exports.imageSize = imageSize;
module.exports.disableFS = disableFS;
module.exports.disableTypes = disableTypes;
module.exports.setConcurrency = setConcurrency;
module.exports.types = SUPPORTED_TYPES;
