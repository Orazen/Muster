// Tests for the locally-owned image header reader.
//
// Fixtures are embedded as base64 so this file needs no image encoder and no
// network. Every fixture is a real 2x4 image: the PNG, GIF, BMP and JPEG
// dimensions were confirmed with `sips -g pixelWidth -g pixelHeight`, and the
// three WebP variants with `ffprobe -show_entries stream=width,height`. The
// app's own assets were confirmed the same way.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const imageSize = require("./index.js");
const here = fileURLToPath(new URL(".", import.meta.url));
const asset = (name) => fileURLToPath(new URL(`../../assets/${name}`, import.meta.url));

const fixtures = {
  png: {
    base64:
      "iVBORw0KGgoAAAANSUhEUgAAAAIAAAAECAYAAACk7+45AAAAEUlEQVR4nGP40KXyH4QZcDMAeWcU6TNNhmAAAAAASUVORK5CYII=",
  },
  jpg: {
    base64:
      "/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAAqADAAQAAAABAAAABAAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgABAACAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQAAf/aAAwDAQACEQMRAD8A90ooor/O8/uw/9k=",
  },
  gif: { base64: "R0lGODdhAgAEAJEAAAAAAPCKJP///wAAACH5BAkAAAMALAAAAAACAAQAAAIDjG8FADs=" },
  bmp: {
    base64:
      "Qk2qAAAAAAAAAIoAAAB8AAAAAgAAAPz///8BACAAAwAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAD/AAD/AAAAAAAA/0JHUnMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJIrw/ySK8P8kivD/JIrw/ySK8P8kivD/JIrw/ySK8P8=",
  },
  webp: {
    base64:
      "UklGRjoAAABXRUJQVlA4IC4AAADQAQCdASoCAAQAAgA0JaACdLoB+AADsAD+6wf//U4/Jx+Tj+vt/89M15g/wsAA",
  },
  "webp lossless": {
    base64: "UklGRh4AAABXRUJQVlA4TBEAAAAvAcAAAAdQxcKXpP+BiOh/AAA=",
  },
  "webp extended": {
    base64:
      "UklGRmAAAABXRUJQVlA4WAoAAAAQAAAAAQAAAwAAQUxQSAkAAAAAgICAgICAgIAAVlA4IDAAAAAQAgCdASoCAAQAAgA0JaACdLoB+AH4AAPIAP7nMP/7WgODVf6dn/1v+Y4c/AAAAAA=",
  },
};

const bytes = (base64) => Buffer.from(base64, "base64");

// The exact inputs the two advisories are about. None of these may be parsed.
const refused = {
  // GHSA-w3rx-r6r6-pgpr: the ICNS entry declares a length of zero, so upstream
  // advances by zero and never leaves the loop.
  icns: "69636e73000000106963703400000000",
  // GHSA-5p2g-fcmc-qvqq: a containerised JXL stream.
  jxl: "0000000c4a584c200d0a870a00000010667479706a786c2000000000000000006a786c70",
  // GHSA-5p2g-fcmc-qvqq: an HEIF/HEIC `ftyp` box.
  heif: "0000000c66747970686569630000000066726565",
  // The JP2 signature box followed by a `jp2 ` brand.
  jp2: "0000000c6a5020200d0a870a00000014667479706a703220000000006a703220",
};

test("exports the shape Metro and the app's image policy expect", () => {
  assert.equal(typeof imageSize, "function");
  assert.equal(imageSize.default, imageSize);
  assert.equal(imageSize.imageSize, imageSize);
  for (const name of ["disableFS", "disableTypes", "setConcurrency"]) {
    assert.equal(typeof imageSize[name], "function", `${name} must be exported`);
  }
  assert.deepEqual([...imageSize.types], ["png", "jpg", "gif", "bmp", "webp"]);
});

test("reads the real dimensions of every supported format", () => {
  for (const [format, fixture] of Object.entries(fixtures)) {
    assert.deepEqual(
      imageSize(bytes(fixture.base64)),
      { width: 2, height: 4, type: format.startsWith("webp") ? "webp" : format },
      `${format} must parse to 2x4`,
    );
  }
});

test("reads the app's own assets at their true pixel dimensions", () => {
  // Ground truth from `sips -g pixelWidth -g pixelHeight`, not from this parser.
  for (const name of ["icon.png", "splash.png", "adaptive-icon.png"]) {
    const path = asset(name);
    assert.deepEqual(imageSize(readFileSync(path)), { width: 1024, height: 1024, type: "png" });
    assert.deepEqual(imageSize(path), { width: 1024, height: 1024, type: "png" });
  }
});

test("reads a file path and a buffer to the same dimensions", () => {
  const path = asset("icon.png");
  assert.deepEqual(imageSize(path), imageSize(readFileSync(path)));
});

test("refuses the advisory formats without parsing them", () => {
  for (const [format, hex] of Object.entries(refused)) {
    const buffer = Buffer.from(hex, "hex");
    assert.ok(!imageSize.types.includes(format), `${format} must not be a supported type`);
    // Refused by name, which is only reachable through the signature check --
    // so the bytes were inspected and then deliberately not handed to a parser.
    assert.throws(
      () => imageSize(buffer),
      { name: "TypeError", message: new RegExp(`unsupported file type: ${format} \\(file: undefined\\)`) },
      `${format} must be refused by name`,
    );
  }
});

test("refuses the advisory's ICNS entry promptly instead of looping", () => {
  const started = performance.now();
  assert.throws(() => imageSize(Buffer.from(refused.icns, "hex")), /unsupported file type: icns/);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 250, `expected a prompt refusal, took ${elapsed.toFixed(1)}ms`);

  // The same input in a child process under a hard timeout, so that a
  // reintroduced infinite loop fails this test instead of hanging the runner.
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      [
        'const imageSize = require("./index.js");',
        `const buffer = Buffer.from(${JSON.stringify(refused.icns)}, "hex");`,
        "const started = Date.now();",
        "try { imageSize(buffer); } catch { /* refused */ }",
        'console.log("refused in " + (Date.now() - started) + "ms");',
      ].join("\n"),
    ],
    { cwd: here, encoding: "utf8", timeout: 2000 },
  );
  assert.equal(child.signal, null, "the child had to be killed: the parser did not return");
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /^refused in \d+ms$/m);
});

test("rejects empty, truncated and non-image buffers with a clear error", () => {
  const cases = {
    "zero-length buffer": [Buffer.alloc(0), /Empty file/],
    "truncated PNG header": [bytes(fixtures.png.base64).subarray(0, 18), /truncated image: need 4 bytes/],
    "signature-only PNG": [bytes(fixtures.png.base64).subarray(0, 8), /Invalid PNG/],
    "truncated GIF header": [Buffer.from("GIF89a", "ascii"), /truncated image: need 2 bytes/],
    "truncated JPEG": [Buffer.from("ffd8ff", "hex"), /Invalid JPG, no size found/],
    "plain text": [Buffer.from("this is not an image at all", "utf8"), /unsupported file type/],
    "empty-ish PNG signature only in name": [Buffer.from("PNG", "utf8"), /unsupported file type/],
  };
  for (const [name, [buffer, expected]] of Object.entries(cases)) {
    assert.throws(() => imageSize(buffer), expected, name);
  }
});

test("disableTypes refuses the four types the app's Metro policy disables", () => {
  const disabled = ["icns", "heif", "jxl", "jxl-stream"];
  imageSize.disableTypes(disabled);
  try {
    for (const format of disabled) {
      const buffer =
        format === "jxl-stream"
          ? Buffer.from("ff0a", "hex")
          : format === "icns"
            ? Buffer.from(refused.icns, "hex")
            : Buffer.from(refused[format], "hex");
      assert.throws(
        () => imageSize(buffer),
        { name: "TypeError", message: `disabled file type: ${format}` },
        `${format} must report the message metro-image-policy depends on`,
      );
    }
    // A supported format still parses while other types are disabled.
    assert.deepEqual(imageSize(bytes(fixtures.png.base64)), {
      width: 2,
      height: 4,
      type: "png",
    });
  } finally {
    imageSize.disableTypes([]);
  }
});

test("refuses paths that are not known image files", () => {
  const notAnImage = fileURLToPath(new URL("./README.md", import.meta.url));
  assert.throws(() => imageSize(notAnImage), /refusing to read a path that is not a known image/);
  assert.throws(() => imageSize(here), /refusing to read a path that is not a known image/);
  assert.throws(() => imageSize(asset("icon.png").replace(/\.png$/, ".svg")), /refusing to read/);
});

test("disableFS removes the path-taking form entirely", () => {
  imageSize.disableFS(true);
  try {
    assert.throws(() => imageSize(asset("icon.png")), /invalid invocation/);
  } finally {
    imageSize.disableFS(false);
  }
  assert.deepEqual(imageSize(asset("icon.png")), { width: 1024, height: 1024, type: "png" });
});
