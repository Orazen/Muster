// Diagnostics export — the JSON behind GET /api/diagnostics.
//
// A bug report should carry facts, not credentials. Three layers keep it
// that way: versions are constants, the config summary keeps ONLY boolean
// flags (strings and numbers can carry names, URLs or counts someone
// considers private, so they never ship), and the native log tail goes
// through the same content redaction pass the transcripts use
// (server/redact.ts) right before it is attached. Pure string/JSON work
// lives here so redaction stays unit-testable away from the HTTP layer;
// index.ts owns the route.
import { closeSync, fstatSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { redactSecretsInText } from "./redact.ts";

export interface DiagnosticsVersions {
  app: string;
  node: string;
  platform: string;
}

export interface DiagnosticsReport {
  versions: DiagnosticsVersions;
  /** Flattened config flags — every value is a boolean, nothing else ships. */
  config: Record<string, boolean>;
  logTail: string;
}

/** Bounded tail of the newest native protocol log, in bytes. Diagnostics is
 * a bug-report aid, not an archive — 32 KB of the freshest activity is what
 * a pasted report actually gets read for. */
const LOG_TAIL_BYTES = 32 * 1024;

/** A decoded JSON subtree: booleans are the leaves the walker keeps,
 * nested objects are the branches it recurses into. Values that can never
 * reach the report (strings, numbers, arrays, null) are filtered at runtime. */
interface JsonBranch {
  [key: string]: boolean | JsonBranch;
}

/** Deep walk that keeps only boolean leaves, flattened to dotted paths.
 * Objects recurse; arrays are skipped wholesale (a list's entries have no
 * stable meaning once flattened); strings and numbers are dropped even when
 * their key looks harmless — profile.name proves why.
 *
 * `branch` is a JSON subtree already decoded by the caller (collectDiagnostics
 * receives configStatus from the config module's own parse). */
function booleanFlagsOnly(
  branch: JsonBranch,
  prefix = "",
  depth = 0,
  out: Record<string, boolean> = {},
): Record<string, boolean> {
  if (depth > 4) return out;
  for (const [key, entry] of Object.entries(branch)) {
    const path = prefix ? `${prefix}.${key}` : key;
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- JSON leaves carry no tag; typeof is the only discriminator for a bare boolean leaf.
    if (typeof entry === "boolean") {
      out[path] = entry;
      continue;
    }
    // nested objects only — arrays and scalars never reach the report
    if (entry !== null && !Array.isArray(entry) && entry instanceof Object) {
      booleanFlagsOnly(entry, path, depth + 1, out);
    }
  }
  return out;
}

/** The native tee writes one .ndjson per thread; diagnostics tails whichever
 * saw activity most recently. A missing dir means the feature never ran yet. */
function newestNativeLog(nativeDir: string): string | null {
  let names: string[] = [];
  try {
    names = readdirSync(nativeDir);
  } catch {
    return null;
  }
  let newest: { file: string; mtimeMs: number } | null = null;
  for (const name of names) {
    if (!name.endsWith(".ndjson")) continue;
    try {
      const mtimeMs = statSync(join(nativeDir, name)).mtimeMs;
      if (!newest || mtimeMs > newest.mtimeMs) newest = { file: join(nativeDir, name), mtimeMs };
    } catch {
      /* raced away mid-walk — skip it */
    }
  }
  return newest?.file ?? null;
}

function tailBytes(file: string, bytes: number) {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    // SAFETY: readSync reads into exactly the space allocated above; a short
    // read shrinks the window, it cannot write past buffer.length.
    const read = readSync(fd, buffer, 0, buffer.length, start);
    return { buffer: buffer.subarray(0, read), truncated: start > 0 };
  } finally {
    closeSync(fd);
  }
}

function logTailFrom(nativeDir: string): string {
  const file = newestNativeLog(nativeDir);
  if (!file) return "(no native protocol logs yet)";
  const { buffer, truncated } = tailBytes(file, LOG_TAIL_BYTES);
  let raw = buffer.toString("utf8");
  // A byte-bounded tail can begin mid-record; like the transcript inspector,
  // drop the partial first line rather than export half a message.
  if (truncated) {
    const newline = raw.indexOf("\n");
    raw = newline < 0 ? "" : raw.slice(newline + 1);
  }
  const redacted = redactSecretsInText(raw).trimEnd();
  return redacted || "(native log tail was empty after truncation)";
}

export function collectDiagnostics(input: { nativeDir: string; configStatus: unknown; appVersion?: string }): DiagnosticsReport {
  return {
    versions: {
      app: input.appVersion ?? "unknown",
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
    },
    // SAFETY: configStatus() assembles this object locally from known keys; the walker
    // keeps only boolean leaves, so any other value type is dropped, never read.
    config: booleanFlagsOnly(input.configStatus as JsonBranch),
    logTail: logTailFrom(input.nativeDir),
  };
}
