// Unit tests for the attachment store. The vitest setup redirects HOME (and
// therefore DATA_DIR) at a throwaway directory per file, so these write real
// files without ever touching a real ~/.muster.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ATTACHMENTS_DIR,
  AttachmentError,
  MAX_ATTACHMENT_BYTES,
  isAttachmentName,
  readAttachment,
  saveAttachment,
} from "./attachments.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

function statusOf(fn: () => void): number {
  try {
    fn();
  } catch (e) {
    if (e instanceof AttachmentError) return e.status;
    throw e;
  }
  throw new Error("expected the call to throw an AttachmentError");
}

afterEach(async () => {
  // The data dir is per-file here (no per-test env swap), so clean once the
  // suite wrote its files rather than leak them into the temp HOME.
  if (existsSync(ATTACHMENTS_DIR)) await removeTempDir(ATTACHMENTS_DIR);
});

describe("saveAttachment", () => {
  it("writes the bytes under a UUID name and returns both handles", () => {
    const saved = saveAttachment("image/png", PNG);
    expect(isAttachmentName(saved.name)).toBe(true);
    expect(saved.name.endsWith(".png")).toBe(true);
    expect(saved.size).toBe(PNG.length);
    expect(saved.path).toBe(join(ATTACHMENTS_DIR, saved.name));
    expect(readFileSync(saved.path)).toEqual(PNG);
  });

  it("canonicalises jpeg and keeps gif/webp distinct", () => {
    expect(saveAttachment("image/jpeg", JPEG).name.endsWith(".jpg")).toBe(true);
    expect(saveAttachment("image/JPEG; charset=binary", JPEG).name.endsWith(".jpg")).toBe(true);
    expect(saveAttachment("image/gif", Buffer.from("GIF8")).name.endsWith(".gif")).toBe(true);
    expect(saveAttachment("image/webp", Buffer.from("RIFF")).name.endsWith(".webp")).toBe(true);
  });

  it("rejects non-image mimes with 415 and empty bodies with 400", () => {
    expect(statusOf(() => saveAttachment("text/plain", PNG))).toBe(415);
    expect(statusOf(() => saveAttachment("application/pdf", PNG))).toBe(415);
    expect(statusOf(() => saveAttachment("", PNG))).toBe(415);
    expect(statusOf(() => saveAttachment("image/png", Buffer.alloc(0)))).toBe(400);
  });

  it("rejects bodies past the cap with 413", () => {
    const huge = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1);
    expect(statusOf(() => saveAttachment("image/png", huge))).toBe(413);
    // exactly at the cap is fine
    expect(saveAttachment("image/png", Buffer.alloc(MAX_ATTACHMENT_BYTES)).size).toBe(
      MAX_ATTACHMENT_BYTES,
    );
  });
});

describe("readAttachment", () => {
  it("round-trips what save wrote, with the right mime", () => {
    const saved = saveAttachment("image/png", PNG);
    const read = readAttachment(saved.name);
    expect(read).toMatchObject({ found: true, mime: "image/png" });
    // SAFETY: the matchObject above pinned `found`; narrow for the buffer.
    if (!read.found) throw new Error("unreachable");
    expect(read.data).toEqual(PNG);
    expect(statSync(join(ATTACHMENTS_DIR, saved.name)).size).toBe(PNG.length);
  });

  it("404s traversal shapes, junk names, and missing files alike", () => {
    saveAttachment("image/png", PNG);
    expect(readAttachment("../config.json")).toMatchObject({ found: false });
    expect(readAttachment("sub/../../etc.png")).toMatchObject({ found: false });
    expect(readAttachment("not-a-uuid.png")).toMatchObject({ found: false });
    expect(readAttachment(`${"0".repeat(36)}.png`)).toMatchObject({ found: false });
    expect(readAttachment("")).toMatchObject({ found: false });
  });
});
