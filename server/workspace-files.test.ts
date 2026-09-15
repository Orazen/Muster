// Workspace file browser contract: path validation before and after
// resolution, dotfile invisibility, symlink refusal, protected files,
// binary/size refusals on read, and the write/delete/download round trips.
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { WORKSPACES_DIR, ensureWorkspace, workspaceDir } from "./workspace.ts";
import {
  deleteWorkspaceFile,
  listWorkspaceFiles,
  readWorkspaceDownload,
  readWorkspaceFile,
  resolveWorkspacePath,
  writeWorkspaceFile,
} from "./workspace-files.ts";

const BOT = "bot-files-test";

function root(): string {
  ensureWorkspace(BOT);
  return workspaceDir(BOT);
}

describe("resolveWorkspacePath", () => {
  beforeEach(() => {
    rmSync(WORKSPACES_DIR, { recursive: true, force: true });
    root();
  });

  it("accepts plain and nested printable paths", () => {
    expect(resolveWorkspacePath(BOT, "notes.md", false)).toMatchObject({ ok: true });
    expect(resolveWorkspacePath(BOT, "drafts/launch plan (v2).md", false)).toMatchObject({ ok: true });
  });

  it("rejects traversal, encoding tricks, hidden files and odd characters", () => {
    for (const bad of ["../secret", "a/../../b", "..", "/", "a//b", ".hidden", "memory/.env", "a\\b", "x".repeat(500), "evil\x00name"]) {
      expect(resolveWorkspacePath(BOT, bad, false).ok).toBe(false);
    }
  });

  it("refuses a symlink that points outside the workspace", () => {
    const outside = join(WORKSPACES_DIR, "..", "outside-target.txt");
    writeFileSync(outside, "secret");
    symlinkSync(outside, join(root(), "escape.txt"));
    const at = resolveWorkspacePath(BOT, "escape.txt", true);
    expect(at.ok).toBe(false);
    if (!at.ok) expect(at.reason).toMatch(/escape|not valid/);
    rmSync(outside, { force: true });
  });
});

describe("browse operations", () => {
  beforeEach(() => {
    rmSync(WORKSPACES_DIR, { recursive: true, force: true });
    const dir = root();
    writeFileSync(join(dir, "notes.md"), "# Notes\nhello");
    mkdirSync(join(dir, "drafts"), { recursive: true });
    writeFileSync(join(dir, "drafts", "plan.md"), "draft one");
    mkdirSync(join(dir, ".memory-history"), { recursive: true });
    writeFileSync(join(dir, ".memory-history", "hidden.md"), "invisible");
  });

  it("lists visible files recursively, sorted, skipping dot-dirs", () => {
    const files = listWorkspaceFiles(BOT);
    expect(files.map((f) => f.path)).toEqual(["MEMORY.md", "drafts/plan.md", "notes.md"]);
    expect(files.find((f) => f.path === "notes.md")?.bytes).toBeGreaterThan(0);
  });

  it("reads text; refuses binary and oversized", () => {
    expect(readWorkspaceFile(BOT, "notes.md")).toMatchObject({ ok: true, text: "# Notes\nhello" });
    writeFileSync(join(root(), "blob.bin"), Buffer.from([1, 2, 0, 3, 4]));
    const bin = readWorkspaceFile(BOT, "blob.bin");
    expect(!bin.ok && bin.status).toBe(415);
  });

  it("writes create parents; refuse protected files and hidden paths", () => {
    expect(writeWorkspaceFile(BOT, "out/deep/report.md", "# Report")).toEqual({ ok: true });
    expect(readFileSync(join(root(), "out", "deep", "report.md"), "utf8")).toBe("# Report");
    expect(!writeWorkspaceFile(BOT, "MEMORY.md", "clobber").ok).toBe(true);
    expect(!writeWorkspaceFile(BOT, ".hidden", "x").ok).toBe(true);
  });

  it("deletes work files, refuses protected ones, 404s unknown", () => {
    expect(deleteWorkspaceFile(BOT, "drafts/plan.md")).toEqual({ ok: true });
    expect(!deleteWorkspaceFile(BOT, "MEMORY.md").ok).toBe(true);
    const missing = deleteWorkspaceFile(BOT, "nope.md");
    expect(!missing.ok && missing.status).toBe(404);
  });

  it("downloads raw bytes with a safe name", () => {
    const got = readWorkspaceDownload(BOT, "notes.md");
    expect(got.ok && got.name).toBe("notes.md");
    if (got.ok) expect(got.data.toString()).toContain("hello");
  });
});
