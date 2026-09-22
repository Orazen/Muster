// The Windows icon is a build input, not a decoration: electron-builder hands
// build/icon.ico to resedit, which parses the directory and throws
// "Offset is outside the bounds of the DataView" on a malformed one — failing
// the whole Windows NSIS leg. The committed ICO had every entry's byte count
// and image offset written big-endian, so all seven pointed far past EOF.
//
// The entries are also DIB (BITMAPINFOHEADER + 32bpp BGRA), not PNG: resedit
// passes each entry's raw bytes straight through to RT_ICON, and Windows
// expects DIB there. A PNG-entry ICO builds fine but ships a blank exe icon,
// so the format is asserted here too.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const ICO = readFileSync(join(ROOT, "build", "icon.ico"));
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const DIRECTORY_START = 6 + SIZES.length * 16;
const DIB_HEADER = 40;

interface Entry {
  width: number;
  height: number;
  bytes: number;
  offset: number;
}

function directory(): Entry[] {
  const count = ICO.readUInt16LE(4);
  return Array.from({ length: count }, (_, i) => {
    const at = 6 + i * 16;
    return {
      // 0 means 256 in the directory; the real size lives in the DIB header
      width: ICO[at] || 256,
      height: ICO[at + 1] || 256,
      bytes: ICO.readUInt32LE(at + 8),
      offset: ICO.readUInt32LE(at + 12),
    };
  });
}

const payload = (entry: Entry) => ICO.subarray(entry.offset, entry.offset + entry.bytes);

describe("build/icon.ico", () => {
  it("is an icon container with one entry per declared size", () => {
    expect(ICO.readUInt16LE(0)).toBe(0); // reserved
    expect(ICO.readUInt16LE(2)).toBe(1); // type: icon
    expect(ICO.readUInt16LE(4)).toBe(SIZES.length);
    expect(directory().map((e) => e.width)).toEqual(SIZES);
  });

  it("keeps every directory entry inside the file", () => {
    for (const entry of directory()) {
      expect(entry.bytes).toBeGreaterThan(DIB_HEADER);
      expect(entry.offset).toBeGreaterThanOrEqual(DIRECTORY_START);
      expect(entry.offset + entry.bytes).toBeLessThanOrEqual(ICO.length);
    }
  });

  it("packs the entries back to back and ends exactly at EOF", () => {
    let expected = DIRECTORY_START;
    for (const entry of directory()) {
      expect(entry.offset).toBe(expected);
      expected += entry.bytes;
    }
    expect(expected).toBe(ICO.length);
  });

  it("embeds a 32bpp DIB per size, with no PNG entry in sight", () => {
    for (const entry of directory()) {
      const dib = payload(entry);
      // A PNG entry is the shape that builds but leaves the exe icon blank.
      expect(dib.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(false);
      expect(dib.readUInt32LE(0)).toBe(DIB_HEADER); // biSize
      expect(dib.readInt32LE(4)).toBe(entry.width); // biWidth
      expect(dib.readInt32LE(8)).toBe(entry.height); // biHeight, positive = bottom-up
      expect(dib.readUInt16LE(12)).toBe(1); // biPlanes
      expect(dib.readUInt16LE(14)).toBe(32); // biBitCount
      expect(dib.readUInt32LE(16)).toBe(0); // biCompression: BI_RGB
      // 40-byte header plus one BGRA quad per pixel, and nothing else
      expect(entry.bytes).toBe(DIB_HEADER + entry.width * entry.height * 4);
      expect(dib.readUInt32LE(20)).toBe(entry.width * entry.height * 4); // biSizeImage
    }
  });

  it("writes the directory little-endian and DIB-encoded in the generator", () => {
    // The artifact checks above only bite after a regeneration, so guard the
    // two properties that were wrong at the source as well.
    const source = readFileSync(join(ROOT, "scripts", "make-brand-icons.mjs"), "utf8");
    const encoder = source.slice(source.indexOf("function encodeIco"));
    expect(encoder).toContain("writeUInt32LE(data.length");
    expect(encoder).toContain("writeUInt32LE(offset");
    expect(encoder).not.toContain("writeUInt32BE");
    expect(encoder).toContain("encodeDib(");
  });
});
