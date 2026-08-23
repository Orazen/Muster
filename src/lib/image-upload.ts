// What.
// One image file (from a paste or a pathless browser drop) to a stored
// attachment. The server writes it under ~/.muster/attachments and returns
// both handles: `path` for the prompt tag, `name` for display URLs.
//
// Why.
// Kept out of composer-attachments.ts on purpose — that module is pure logic
// shared with server-side tests, and this one does network I/O against the
// same relative /api base every other client call uses.

import { imageAttachment, type ImageAttachment } from "./composer-attachments";

/** Mirrors MAX_ATTACHMENT_BYTES on the server; the client checks first so an
 * oversized paste fails with a friendly chip notice instead of a 413. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export async function uploadImageAttachment(file: File): Promise<ImageAttachment> {
  const res = await fetch("/api/attachments", {
    method: "POST",
    headers: { "content-type": file.type || "application/octet-stream" },
    body: file,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return imageAttachment(body.name ?? file.name, body.path, body.size ?? file.size);
}
