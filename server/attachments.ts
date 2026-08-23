// What.
// Image attachments: the server-side half of "paste a screenshot into the
// composer". The client uploads the bytes, we store them under the data dir,
// and hand back an absolute path that goes into the prompt as
// <attached-image path="…"/> — every CLI engine opens files by path, so no
// per-driver encoding exists anywhere in this feature.
//
// Why.
// The transcript also renders those messages, and the renderer (a browser
// context) cannot read ~/.muster directly. The same stored file is therefore
// served back over GET /api/attachments/:name for display. Storage and
// serving share one module so the name rules cannot drift apart: what save()
// writes is exactly what read() accepts, and nothing else.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR } from "./config.ts";

export const ATTACHMENTS_DIR = join(DATA_DIR, "attachments");

/** The spec cap: a full-resolution screenshot fits comfortably; past it the
 * user meant to send a file, not an image. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** Image mimes we accept, mapped to their canonical extension. Deliberately
 * short: these are the formats every vision-capable CLI reads natively, and
 * each entry doubles as the allow-list for what GET may serve back. */
const IMAGE_TYPES = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
} as const;

export type SavedAttachment = {
  /** Absolute path on disk — the prompt-facing handle the CLI will open. */
  path: string;
  /** Bare filename — the HTTP-facing handle the transcript renderer uses. */
  name: string;
  size: number;
};

/** What save rejected, with the HTTP status the route should return. */
export class AttachmentError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function extFor(mime: string): string | null {
  // Strip parameters ("image/png; charset=binary") before matching.
  const base = mime.split(";")[0].trim().toLowerCase();
  return Object.entries(IMAGE_TYPES).find(([m]) => m === base)?.[1] ?? null;
}

/** Store one uploaded image. Throws AttachmentError with a ready status for
 * every rejection the client can cause; only genuine I/O failures escape as
 * raw errors (they are 500s, and the route has nothing to add). */
export function saveAttachment(mime: string, bytes: Buffer): SavedAttachment {
  const ext = extFor(mime);
  if (!ext) {
    throw new AttachmentError(415, `unsupported attachment type: ${mime || "(none)"}`);
  }
  if (bytes.length === 0) throw new AttachmentError(400, "empty attachment body");
  if (bytes.length > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentError(413, "attachment too large (10 MB max)");
  }
  if (!existsSync(ATTACHMENTS_DIR)) mkdirSync(ATTACHMENTS_DIR, { recursive: true });
  const name = `${randomUUID()}${ext}`;
  const path = join(ATTACHMENTS_DIR, name);
  writeFileSync(path, bytes);
  return { path, name, size: bytes.length };
}

/** Only names saveAttachment could have produced. This is the whole path-
 * traversal defense for GET: no separators means nothing can climb out of
 * ATTACHMENTS_DIR, whatever the URL looked like. */
const NAME_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|gif|webp)$/;

export function isAttachmentName(name: string): boolean {
  return NAME_PATTERN.test(name);
}

export type ReadAttachment =
  | { found: true; data: Buffer; mime: string }
  | { found: false };

/** Read one stored image back for display. Unknown or malformed names are
 * indistinguishable from deleted files (`found: false` → 404) — probing the
 * endpoint must not reveal which names exist. */
export function readAttachment(name: string): ReadAttachment {
  if (!isAttachmentName(name)) return { found: false };
  const ext = `.${name.split(".").pop()}`;
  const mime = Object.entries(IMAGE_TYPES).find(([, e]) => e === ext)?.[0];
  if (!mime) return { found: false };
  try {
    return { found: true, data: readFileSync(join(ATTACHMENTS_DIR, name)), mime };
  } catch {
    return { found: false };
  }
}
