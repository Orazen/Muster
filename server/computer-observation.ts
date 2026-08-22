import { createHash } from "node:crypto";

import { parseJson } from "./schema.ts";

/** True only for primitive strings — what JSON decoding yields for text fields. */
const isText = <T>(value: T): value is T & string => String(value) === value;

/** Provider-neutral policy for deciding when a computer observation needs vision. */
export interface ObservationMetrics {
  screenshotsCaptured: number;
  screenshotsSentToModel: number;
  fullScreenObservations: number;
  croppedObservations: number;
  structuredBrowserObservations: number;
  computerActions: number;
  retries: number;
  verificationSuccesses: number;
  verificationFailures: number;
}

export interface CropRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserTarget {
  id: string;
  title: string;
  /** Safe for a model or log: credentials, query, and fragment removed. */
  url: string;
  /** Internal-only comparison value. Never include this in tool output. */
  comparisonUrl: string;
}

export const emptyObservationMetrics = (): ObservationMetrics => ({
  screenshotsCaptured: 0,
  screenshotsSentToModel: 0,
  fullScreenObservations: 0,
  croppedObservations: 0,
  structuredBrowserObservations: 0,
  computerActions: 0,
  retries: 0,
  verificationSuccesses: 0,
  verificationFailures: 0,
});

/** Crop region arguments from a computer-tool call; coordinates may be absent or junk. */
interface CropInput {
  x?: unknown;
  y?: unknown;
  width?: unknown;
  height?: unknown;
}

export function normalizeCrop(
  raw: CropInput | null | undefined,
  maxWidth: number,
  maxHeight: number,
): CropRegion | null {
  if (!raw) return null;
  const x = Math.round(Number(raw.x));
  const y = Math.round(Number(raw.y));
  const width = Math.round(Number(raw.width));
  const height = Math.round(Number(raw.height));
  if (
    ![x, y, width, height, maxWidth, maxHeight].every(Number.isFinite) ||
    maxWidth <= 0 ||
    maxHeight <= 0 ||
    x < 0 ||
    y < 0 ||
    width < 32 ||
    height < 32
  ) {
    return null;
  }
  if (x + width > maxWidth || y + height > maxHeight) return null;
  return { x, y, width, height };
}

/** Canonical value for internal navigation checks. Credentials are never
 * needed for equality and are removed here; query and fragment remain so
 * two distinct application states cannot verify as the same destination. */
export function normalizeBrowserUrl<M>(value: M): string | null {
  if (!isText(value) || !value || value.length > 8_192) return null;
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) return null;
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return null;
  }
}

/** Removes credentials, query, and fragment before browser state reaches a model or log. */
export function safeBrowserUrl<M>(value: M): string | null {
  const normalized = normalizeBrowserUrl(value);
  if (!normalized) return null;
  const url = new URL(normalized);
  url.search = "";
  url.hash = "";
  const safe = url.toString();
  return safe.length <= 2_048 ? safe : null;
}

/** One row of Chrome's /json/list response; only these fields are read. */
interface ChromeTargetRecord {
  id?: unknown;
  type?: unknown;
  title?: unknown;
  url?: unknown;
}

/** Parses Chrome's /json/list response into a small, safe structured observation. */
export function parseBrowserTargets(raw: string): BrowserTarget[] {
  if (raw.length > 1_000_000) return [];
  try {
    const parsed = parseJson(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, 20).flatMap((item) => {
      // SAFETY: /json/list rows are JSON objects keyed by id/type/title/url
      const value = item as ChromeTargetRecord | null | undefined;
      if (!value || !(value instanceof Object)) return [];
      const comparisonUrl = normalizeBrowserUrl(value.url);
      const url = safeBrowserUrl(value.url);
      if (value.type !== "page" || !url || !comparisonUrl || !isText(value.id)) return [];
      const title = isText(value.title) ? value.title.replace(/\s+/g, " ").trim().slice(0, 200) : "";
      return [{ id: value.id.slice(0, 100), title, url, comparisonUrl }];
    });
  } catch {
    return [];
  }
}

/**
 * Keeps observations cheap without claiming the screen is immutable. Every
 * requested observation still captures fresh pixels (pages can change without
 * an input action), while byte-identical frames are not sent to the model twice.
 */
export class ObservationCoordinator {
  metrics = emptyObservationMetrics();
  private lastObservation: string | null = null;

  noteAction(count = 1) {
    this.metrics.computerActions += Math.max(0, Math.trunc(count));
  }

  noteRetry() {
    this.metrics.retries += 1;
  }

  /** canonicalFrame must describe the full screenshot, even when the image
   * returned to the model is cropped. A box-provided full-frame hash works. */
  observeFrame(canonicalFrame: string | null, crop: CropRegion | null) {
    this.metrics.screenshotsCaptured += 1;
    const hash = canonicalFrame
      ? createHash("sha256").update(canonicalFrame).digest("hex")
      : null;
    const view = crop ? `${crop.x},${crop.y},${crop.width},${crop.height}` : "full";
    const signature = hash ? `${hash}:${view}` : null;
    // If the box cannot provide a full-frame hash, fail open and send the
    // valid image. Suppressing a possibly-new crop would be worse.
    const changed = signature === null || signature !== this.lastObservation;
    if (signature) this.lastObservation = signature;
    if (changed) {
      this.metrics.screenshotsSentToModel += 1;
      if (crop) this.metrics.croppedObservations += 1;
      else this.metrics.fullScreenObservations += 1;
    }
    return { changed, hash };
  }

  noteStructuredObservation() {
    this.metrics.structuredBrowserObservations += 1;
  }

  noteVerification(ok: boolean) {
    if (ok) this.metrics.verificationSuccesses += 1;
    else this.metrics.verificationFailures += 1;
  }
}
