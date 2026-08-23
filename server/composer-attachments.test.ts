import { describe, expect, it } from "vitest";

import {
  PASTE_CHARS,
  PASTE_LINES,
  attachmentUrl,
  attachmentsFromDroppedFiles,
  byteLength,
  composeMessage,
  escapeAttribute,
  fileAttachment,
  imageAttachment,
  isAttachment,
  isLongPaste,
  pasteAttachment,
  pasteSummary,
  splitAttachedImages,
  unescapeAttribute,
} from "../src/lib/composer-attachments.ts";

describe("composer paste attachments", () => {
  it("classifies long character and line pastes without changing short text", () => {
    expect(isLongPaste("x".repeat(PASTE_CHARS - 1))).toBe(false);
    expect(isLongPaste("x".repeat(PASTE_CHARS))).toBe(true);
    expect(isLongPaste(Array.from({ length: PASTE_LINES }, () => "x").join("\n"))).toBe(true);
  });

  it("measures UTF-8 once and reports a useful summary", () => {
    const attachment = pasteAttachment("héllo\n世界");
    expect(attachment.size).toBe(byteLength(attachment.text));
    expect(attachment.size).toBeGreaterThan(attachment.text.length);
    expect(attachment.lines).toBe(2);
    expect(pasteSummary(attachment)).toMatch(/^2 lines, /);
  });

  it("composes attachment-only and mixed messages in a stable order", () => {
    const first = pasteAttachment("first");
    const second = pasteAttachment("second");
    expect(composeMessage("", [first])).toBe(
      '<pasted-text index="1">\nfirst\n</pasted-text>',
    );
    expect(composeMessage("  intro  ", [first, second])).toBe(
      'intro\n\n<pasted-text index="1">\nfirst\n</pasted-text>\n\n' +
        '<pasted-text index="2">\nsecond\n</pasted-text>',
    );
  });

  it("keeps unusual file paths inside the attachment attribute", () => {
    const file = fileAttachment("report.txt", '/tmp/a"&<>\t\n\r.txt', 42);
    expect(composeMessage("", [file])).toBe(
      '<attached-file path="/tmp/a&quot;&amp;&lt;&gt;&#9;&#10;&#13;.txt" />',
    );
  });

  it("preserves drop order and falls back to small pathless text", async () => {
    const dropped = [
      {
        name: "on-disk.md",
        size: 12,
        type: "text/markdown",
        path: "/tmp/on-disk.md",
        text: async () => "not read",
      },
      {
        name: "browser.txt",
        size: 7,
        type: "text/plain",
        path: "",
        text: async () => "browser",
      },
      {
        name: "image.png",
        size: 10,
        type: "image/png",
        path: "",
        text: async () => "not text",
      },
    ];

    const result = await attachmentsFromDroppedFiles(dropped, (file) => file.path);
    expect(result.attachments.map((attachment) => attachment.kind)).toEqual(["file", "paste"]);
    expect(result.attachments[0]).toMatchObject({
      kind: "file",
      name: "on-disk.md",
      path: "/tmp/on-disk.md",
    });
    expect(result.attachments[1]).toMatchObject({ kind: "paste", text: "browser" });
    expect(result.rejectedNames).toEqual(["image.png"]);
  });

  it("rejects malformed persisted attachments", () => {
    expect(isAttachment({ kind: "paste", id: "a", text: "ok", size: 2, lines: 1 })).toBe(true);
    expect(
      isAttachment({ kind: "file", id: "f", name: "notes.txt", path: "/tmp/notes.txt", size: 2 }),
    ).toBe(true);
    expect(isAttachment({ kind: "paste", id: "a", text: "missing size" })).toBe(false);
    expect(isAttachment({ kind: "file", id: "a", text: "wrong kind", size: 2 })).toBe(false);
    expect(isAttachment({ kind: "file", id: "f", name: "empty", path: "", size: 0 })).toBe(false);
  });
});

describe("image attachments", () => {
  it("validates the image kind like files and builds chips", () => {
    expect(
      isAttachment({ kind: "image", id: "i", name: "shot.png", path: "/tmp/shot.png", size: 5 }),
    ).toBe(true);
    expect(isAttachment({ kind: "image", id: "i", name: "no path", path: "", size: 5 })).toBe(false);
    const chip = imageAttachment("shot.png", "/tmp/shot.png", 5);
    expect(chip).toMatchObject({ kind: "image", name: "shot.png", path: "/tmp/shot.png", size: 5 });
    expect(chip.id).not.toBe(imageAttachment("b.png", "/tmp/b.png", 1).id);
  });

  it("emits a distinct tag for images that carries the escaped path", () => {
    const message = composeMessage("look at this", [
      imageAttachment("shot.png", "/tmp/shot.png", 5),
      imageAttachment("weird.png", '/tmp/a"b<c>.png', 5),
    ]);
    expect(message).toContain('<attached-image path="/tmp/shot.png" />');
    // quotes and angle brackets stay inside the attribute
    expect(message).toContain('path="/tmp/a&quot;b&lt;c&gt;.png"');
    expect(message.startsWith("look at this")).toBe(true);
  });

  it("round-trips tags back into segments, unescaping attributes", () => {
    const text = composeMessage(
      "before",
      [imageAttachment("shot.png", "/tmp/shot.png", 5), pasteAttachment("body")],
    );
    const segments = splitAttachedImages(text);
    // the parser eats the blank line the composer put AFTER the tag;
    // what precedes it stays byte-exact
    expect(segments[0]).toEqual({ type: "text", text: "before\n\n" });
    expect(segments[1]).toEqual({ type: "image", path: "/tmp/shot.png" });
    // pasted-text blocks are NOT image segments — they survive as text
    const tail = segments.slice(2).map((s) => (s.type === "text" ? s.text : "<image?>")).join("");
    expect(tail).toContain("<pasted-text");
  });

  it("renders half-formed or echoed tags as literal text", () => {
    const bot = 'here is your image <attached-image path="x.png"> (unclosed)';
    expect(splitAttachedImages(bot)).toEqual([{ type: "text", text: bot }]);
    expect(splitAttachedImages("no tags at all")).toEqual([{ type: "text", text: "no tags at all" }]);
    // an empty path attribute yields no image segment; with nothing else in
    // the message, the whole thing falls back to rendering literally
    expect(splitAttachedImages('<attached-image path="" />')).toEqual([
      { type: "text", text: '<attached-image path="" />' },
    ]);
  });

  it("only turns stored-upload basenames into display URLs", () => {
    expect(attachmentUrl("/home/u/.muster/attachments/01234567-89ab-cdef-0123-456789abcdef.png")).toBe(
      "/api/attachments/01234567-89ab-cdef-0123-456789abcdef.png",
    );
    expect(attachmentUrl("/etc/passwd")).toBeNull();
    expect(attachmentUrl("../../../.ssh/id_rsa.png")).toBeNull();
    expect(attachmentUrl("/tmp/not-a-uuid.png")).toBeNull();
  });

  it("unescapes every escape escapeAttribute emits", () => {
    const nasty = '/tmp/a&b"c<d>e\tf\rg\nh';
    expect(unescapeAttribute(escapeAttribute(nasty))).toBe(nasty);
  });
});
