// Workspace file browser (the droppy feature ask, scoped to Muster's
// boundary): list / read / write / delete / download the real files under
// one bot's private workspace, not just its memory topics.
//
// The bot's workspace is where its work lives — notes, drafts, exports —
// and bots write these files autonomously. This module gives the human the
// other half of droppy's promise (browse + edit in the browser) while
// keeping every boundary the memory routes already enforce: one private dir
// per bot, ownership 404 at the route, and here a path layer that is
// validated BEFORE and AFTER resolution:
//
//   - relative path segments: printable, no leading dot (dotfiles and the
//     .memory-history/.browser-profiles internals stay invisible), no
//     backslash, no empty segment, bounded depth and count;
//   - resolve() must stay under workspaceDir(botId);
//   - realpath() (when the target exists) must ALSO stay under — a symlink
//     planted by any writer cannot escape;
//   - text reads are size-capped and refuse binary (NUL in the first 8 KiB)
//     — binary files download instead, never render;
//   - writes are atomic 0600 with the same byte cap as memory files.

import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

import { workspaceDir, ensureWorkspace, MEMORY_FILE_MAX_BYTES } from "./workspace.ts";
import { writeFileAtomic } from "./atomic.ts";

export const FILES_LIST_MAX = 500;
export const FILES_DEPTH_MAX = 6;
export const FILES_READ_MAX_BYTES = 1024 * 1024;
/** Files that drive the bot itself — editable surfaces with their own
 * routes and invariants. The browser must never delete them. */
const PROTECTED = new Set(["MEMORY.md", "SOUL.md"]);

/** True only for primitive strings — the domain of every caller-supplied
 * path or text field; untyped callers passing null/number/etc. fail here
 * instead of being coerced by the length checks below. */
const isText = <T>(value: T): value is T & string => String(value) === value;

export interface FileEntry {
  path: string;
  bytes: number;
  mtime: number;
}

export type PathRejection = { ok: false; reason: string } | { ok: true; abs: string; rel: string };

/** Validate a caller-supplied relative path against the bot's workspace.
 * Pure string checks first (fast, testable), filesystem truth second. */
export function resolveWorkspacePath(botId: string, rel: string, mustExist: boolean): PathRejection {
  if (!isText(rel) || !rel.length || rel.length > 400) return { ok: false, reason: "path is required" };
  if (rel.includes("\\") || rel.startsWith("/") || rel.endsWith("/")) return { ok: false, reason: "path is not valid" };
  const segments = rel.split("/");
  if (segments.length > FILES_DEPTH_MAX) return { ok: false, reason: "path is too deep" };
  for (const segment of segments) {
    if (!segment || segment === "." || segment === "..") return { ok: false, reason: "path is not valid" };
    if (segment.startsWith(".")) return { ok: false, reason: "hidden files are not exposed" };
    if (!/^[\w .()-]{1,80}$/.test(segment)) return { ok: false, reason: "path contains unsupported characters" };
  }
  const root = workspaceDir(botId);
  const abs = resolve(join(root, segments.join(sep)));
  // Containment is checked twice, on both views of the tree: the literal
  // paths (resolve, no symlinks) and the real ones (realpath). On macOS a
  // DATA_DIR under /tmp is a symlink to /private/tmp, so realpath(root) and
  // root never share a prefix — comparing real paths against the UNRESOLVED
  // root would reject every legitimate file. rootReal is the workspace's
  // own realpath when it exists (writes may target a not-yet-created dir).
  let rootReal = root;
  try {
    rootReal = realpathSync(root);
  } catch {
    /* workspace not created yet */
  }
  const underLiteral = (p: string): boolean => p === root || p.startsWith(root + sep);
  const underReal = (p: string): boolean => p === rootReal || p.startsWith(rootReal + sep);
  if (!underLiteral(abs)) return { ok: false, reason: "path is not valid" };
  let real: string | null = null;
  try {
    real = realpathSync(abs);
  } catch {
    if (mustExist) return { ok: false, reason: "no such file" };
    // A missing target is fine for writes — but its nearest existing
    // ancestor must still be inside the workspace (no symlinked parents).
    let probe = abs;
    for (;;) {
      const parent = resolve(probe, "..");
      if (parent === probe) return { ok: false, reason: "path is not valid" };
      probe = parent;
      if (!underLiteral(probe)) return { ok: false, reason: "path is not valid" };
      try {
        real = realpathSync(probe);
        break;
      } catch {
        if (probe === root) { real = rootReal; break; }
      }
    }
    if (real === null) return { ok: false, reason: "path is not valid" };
    if (!underReal(real)) return { ok: false, reason: "path is not valid" };
    return { ok: true, abs, rel: segments.join("/") };
  }
  if (!underReal(real)) return { ok: false, reason: "path escapes the workspace" };
  return { ok: true, abs: real, rel: segments.join("/") };
}

/** Recursive listing: visible files only, bounded, sorted by path. */
export function listWorkspaceFiles(botId: string): FileEntry[] {
  const root = workspaceDir(botId);
  const out: FileEntry[] = [];
  const walk = (dir: string, prefix: string, depth: number): void => {
    if (depth > FILES_DEPTH_MAX || out.length >= FILES_LIST_MAX) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (name.startsWith(".")) continue;
      const abs = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      let st;
      try {
        st = lstatSync(abs);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue; // never follow links planted in the workspace
      if (st.isDirectory()) walk(abs, rel, depth + 1);
      else if (st.isFile()) {
        if (out.length >= FILES_LIST_MAX) return;
        out.push({ path: rel, bytes: st.size, mtime: Math.round(st.mtimeMs) });
      }
      if (out.length >= FILES_LIST_MAX) return;
    }
  };
  try {
    statSync(root);
  } catch {
    return []; // the bot has never written anything — an honest empty list
  }
  walk(root, "", 1);
  return out;
}

export type ReadResult = { ok: true; text: string; bytes: number } | { ok: false; reason: string; status: number };

export function readWorkspaceFile(botId: string, rel: string): ReadResult {
  const at = resolveWorkspacePath(botId, rel, true);
  if (!at.ok) return { ok: false, reason: at.reason, status: at.reason === "no such file" ? 404 : 400 };
  let raw: Buffer;
  try {
    raw = readFileSync(at.abs);
  } catch {
    return { ok: false, reason: "no such file", status: 404 };
  }
  if (raw.length > FILES_READ_MAX_BYTES) return { ok: false, reason: "file is too large to edit here — download it instead", status: 413 };
  if (raw.subarray(0, Math.min(8192, raw.length)).includes(0)) return { ok: false, reason: "binary file — download it instead", status: 415 };
  return { ok: true, text: raw.toString("utf8"), bytes: raw.length };
}

export type WriteResult = { ok: true } | { ok: false; reason: string; status: number };

export function writeWorkspaceFile(botId: string, rel: string, text: string): WriteResult {
  if (!isText(text) || Buffer.byteLength(text, "utf8") > MEMORY_FILE_MAX_BYTES) {
    return { ok: false, reason: `file is capped at ${MEMORY_FILE_MAX_BYTES / 1024}KB`, status: 400 };
  }
  const at = resolveWorkspacePath(botId, rel, false);
  if (!at.ok) return { ok: false, reason: at.reason, status: 400 };
  const base = at.rel.split("/").pop() ?? "";
  if (at.rel.includes("/") === false && PROTECTED.has(base)) {
    return { ok: false, reason: "this file has its own editor", status: 400 };
  }
  ensureWorkspace(botId);
  try {
    // writeFileAtomic does not create parents; nested paths need the chain.
    mkdirSync(dirname(at.abs), { recursive: true, mode: 0o700 });
    writeFileAtomic(at.abs, text, { mode: 0o600 });
  } catch {
    return { ok: false, reason: "could not write the file", status: 500 };
  }
  return { ok: true };
}

export type DeleteResult = { ok: true } | { ok: false; reason: string; status: number };

export function deleteWorkspaceFile(botId: string, rel: string): DeleteResult {
  const at = resolveWorkspacePath(botId, rel, true);
  if (!at.ok) return { ok: false, reason: at.reason, status: at.reason === "no such file" ? 404 : 400 };
  const base = at.rel.split("/").pop() ?? "";
  if (!at.rel.includes("/") && PROTECTED.has(base)) {
    return { ok: false, reason: "this file cannot be deleted from here", status: 400 };
  }
  try {
    rmSync(at.abs, { force: true });
  } catch {
    return { ok: false, reason: "could not delete the file", status: 500 };
  }
  return { ok: true };
}

/** Raw bytes for download, size-capped; the route streams it as an
 * attachment with the basename as filename. */
export function readWorkspaceDownload(botId: string, rel: string): { ok: true; data: Buffer; name: string } | { ok: false; reason: string; status: number } {
  const at = resolveWorkspacePath(botId, rel, true);
  if (!at.ok) return { ok: false, reason: at.reason, status: at.reason === "no such file" ? 404 : 400 };
  try {
    const st = statSync(at.abs);
    if (st.size > 25 * 1024 * 1024) return { ok: false, reason: "file is too large to download", status: 413 };
    return { ok: true, data: readFileSync(at.abs), name: at.rel.split("/").pop() ?? "file" };
  } catch {
    return { ok: false, reason: "no such file", status: 404 };
  }
}
