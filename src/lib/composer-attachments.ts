// What is attached to the next message: text too long for the input or a
// file dropped onto the window. Chips fold back into a normal prompt on
// send, so every driver receives the same message shape.
export type PasteAttachment = {
  kind: "paste";
  id: string;
  text: string;
  size: number;
  lines: number;
};

export type FileAttachment = {
  kind: "file";
  id: string;
  path: string;
  name: string;
  size: number;
};

/** An image on disk, uploaded via POST /api/attachments (pathless pastes and
 * browser drops) or referenced straight from disk (Electron drops carry a
 * path). The prompt carries `<attached-image path="…"/>`; every vision-capable
 * CLI opens files by path itself, so no per-driver encoding exists. */
export type ImageAttachment = {
  kind: "image";
  id: string;
  path: string;
  name: string;
  size: number;
};

export type Attachment = PasteAttachment | FileAttachment | ImageAttachment;

// Wire decoders: attachments arrive untyped from the clipboard and
// drag-and-drop, so raw values are discriminated exactly here.
const isText = <T>(value: T): value is T & string => String(value) === value;
const isCount = <T>(value: T): value is T & number => Number.isInteger(value);

/** Raw attachment fields before validation; every field may be absent or any JSON scalar. */
type RawFields = {
  id?: unknown;
  kind?: unknown;
  text?: unknown;
  size?: unknown;
  lines?: unknown;
  path?: unknown;
  name?: unknown;
};

const isRawAttachment = <T>(value: T): value is T & RawFields =>
  value instanceof Object && value.constructor === Object;

export function isAttachment<T>(value: T): value is T & Attachment {
  if (!isRawAttachment(value)) return false;
  if (!isText(value.id) || !validSize(value.size)) return false;
  if (value.kind === "paste") {
    return isText(value.text) && isCount(value.lines) && value.lines >= 1;
  }
  if (value.kind === "file") {
    return isText(value.path) && value.path.length > 0 && isText(value.name);
  }
  if (value.kind === "image") {
    return isText(value.path) && value.path.length > 0 && isText(value.name);
  }
  return false;
}

function validSize<T>(value: T): value is T & number {
  return Number.isFinite(value) && Number(value) >= 0;
}

/** Past this, a paste stops reading as typing and becomes an attachment.
 * Long-but-narrow (a stack trace, a log) counts by line, not just chars. */
export const PASTE_CHARS = 900;
export const PASTE_LINES = 12;

export function isLongPaste(text: string): boolean {
  return text.length >= PASTE_CHARS || countLines(text) >= PASTE_LINES;
}

export function countLines(text: string): number {
  return text.split("\n").length;
}

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `a${Math.random().toString(36).slice(2)}`;
}

export function fileAttachment(name: string, path: string, size: number): FileAttachment {
  return { kind: "file", id: newId(), path, name, size };
}

export function imageAttachment(name: string, path: string, size: number): ImageAttachment {
  return { kind: "image", id: newId(), path, name, size };
}

export function pasteAttachment(text: string): PasteAttachment {
  const id = newId();
  // measured once, here: a chip re-renders on every keystroke in the
  // composer, and encoding half a megabyte each time would be felt
  return { kind: "paste", id, text, size: byteLength(text), lines: countLines(text) };
}

export const INLINE_DROP_LIMIT = 512 * 1024;

export type DroppedFile = Pick<File, "name" | "size" | "type" | "text">;

/** Turn a browser drop into composer attachments. Electron-backed files
 * keep their disk path; small pathless text drops keep their contents.
 * Promise.all preserves the user's drop order even when text reads finish
 * in a different order. */
export async function attachmentsFromDroppedFiles<T extends DroppedFile>(
  files: readonly T[],
  getPath: (file: T) => string,
): Promise<{ attachments: Attachment[]; rejectedNames: string[] }> {
  const results = await Promise.all(
    files.map(async (file) => {
      let path = "";
      try {
        path = getPath(file);
      } catch {
        // A browser or older desktop shell has no disk path to expose.
      }
      if (path) return { attachment: fileAttachment(file.name, path, file.size) };
      if (isInlineText(file) && file.size <= INLINE_DROP_LIMIT) {
        try {
          return { attachment: pasteAttachment(await file.text()) };
        } catch {
          // Treat an unreadable browser drag like any other pathless file.
        }
      }
      return { rejectedName: file.name };
    }),
  );

  return {
    attachments: results.flatMap((result) =>
      "attachment" in result && result.attachment ? [result.attachment] : [],
    ),
    rejectedNames: results.flatMap((result) =>
      "rejectedName" in result && result.rejectedName ? [result.rejectedName] : [],
    ),
  };
}

function isInlineText(file: DroppedFile): boolean {
  return file.type.startsWith("text/") || file.type === "application/json";
}

/** What the paste actually weighs — String#length counts UTF-16 units, so
 * it reads a third under on accented text and half under on CJK. */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** "12 lines, 3.4 KB" — what the chip says under the preview. */
export function pasteSummary(a: { lines: number; size: number }): string {
  return `${a.lines} lines, ${formatSize(a.size)}`;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The prompt the bot receives: what was typed, then one block per
 * attachment. Tagged blocks rather than fences — pasted code and markdown
 * carry fences of their own, and nesting them loses the boundary. A file
 * needs only its path: every driver here is an agent that can open it. An
 * image gets its own tag so engines that read images by path spot them at a
 * glance — and so the transcript can re-render them as thumbnails. */
export function composeMessage(text: string, attachments: Attachment[]): string {
  const parts = [text.trim()];
  attachments.forEach((a, i) => {
    if (a.kind === "paste") {
      parts.push(`<pasted-text index="${i + 1}">\n${a.text}\n</pasted-text>`);
    } else if (a.kind === "image") {
      parts.push(`<attached-image path="${escapeAttribute(a.path)}" />`);
    } else {
      parts.push(`<attached-file path="${escapeAttribute(a.path)}" />`);
    }
  });
  return parts.filter(Boolean).join("\n\n");
}

/** File paths are untrusted prompt content. Keep them inside the quoted
 * attribute even when a filename contains XML characters or line breaks. */
export function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\t", "&#9;")
    .replaceAll("\r", "&#13;")
    .replaceAll("\n", "&#10;");
}

/** Exact inverse of escapeAttribute — the transcript parser reads tags back
 * out of message text, so it has to undo every escape above. */
export function unescapeAttribute(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&#9;", "\t")
    .replaceAll("&#13;", "\r")
    .replaceAll("&#10;", "\n")
    .replaceAll("&amp;", "&"); // last: it escapes the others' syntax
}

export type TextOrImageSegment = { type: "text"; text: string } | { type: "image"; path: string };

const IMAGE_TAG = /<attached-image\s+path="([^"]*)"\s*\/>(?:\n\n|\n|$)?/g;

/** Split transcript text into plain segments and attached-image references,
 * left to right. Only exact well-formed tags become images — anything a bot
 * echoes back half-formed renders as the text it literally is. */
export function splitAttachedImages(text: string): TextOrImageSegment[] {
  const segments: TextOrImageSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(IMAGE_TAG)) {
    const index = match.index ?? 0;
    if (index > last) segments.push({ type: "text", text: text.slice(last, index) });
    const path = unescapeAttribute(match[1] ?? "");
    if (path) segments.push({ type: "image", path });
    last = index + match[0].length;
  }
  if (last < text.length) segments.push({ type: "text", text: text.slice(last) });
  return segments.length ? segments : [{ type: "text", text }];
}

/** The URL the renderer loads an attached image from — basename into the
 * GET route. Returns null for anything that is not a bare UUID filename, so
 * a hand-typed or malformed tag can never make the renderer fetch an
 * arbitrary path. */
export function attachmentUrl(path: string): string | null {
  const name = path.split(/[\\/]/).pop() ?? "";
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|gif|webp)$/i.exec(
    name,
  );
  return uuid ? `/api/attachments/${name}` : null;
}
