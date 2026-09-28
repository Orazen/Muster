/** Unit coverage for the stale-UI guard in the pairing harness: a bundle
 * older than any src/** source must refuse to start with an actionable
 * hint, and the escape hatch must be honored. This caught the real failure
 * where a stale dist/ bundle masked the command-palette Tab-trap fix. */
import { afterAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertBuiltUiIsCurrent } from "./pairing-harness.ts";

describe("assertBuiltUiIsCurrent", () => {
  const created: string[] = [];

  const scratch = async () => {
    const root = await mkdtemp(join(tmpdir(), "stale-ui-guard-"));
    created.push(root);
    return root;
  };

  afterAll(async () => {
    await Promise.all(created.map((root) => rm(root, { recursive: true, force: true })));
  });

  it("passes when the bundle is newer than every source file", async () => {
    const root = await scratch();
    const src = join(root, "src", "lib");
    const ui = join(root, "dist");
    await mkdir(src, { recursive: true });
    await mkdir(ui, { recursive: true });
    await writeFile(join(src, "widget.tsx"), "export {};\n");
    await utimes(join(src, "widget.tsx"), new Date("2026-09-28T10:00:00Z"), new Date("2026-09-28T10:00:00Z"));
    await writeFile(join(ui, "index.html"), "<html></html>\n");
    await utimes(join(ui, "index.html"), new Date("2026-09-28T11:00:00Z"), new Date("2026-09-28T11:00:00Z"));
    await expect(assertBuiltUiIsCurrent(ui, join(root, "src"))).resolves.toBeUndefined();
  });

  it("refuses when a src file is newer than the bundle, naming the file and the fix", async () => {
    const root = await scratch();
    const src = join(root, "src", "components");
    const ui = join(root, "dist");
    await mkdir(src, { recursive: true });
    await mkdir(ui, { recursive: true });
    await writeFile(join(src, "Widget.tsx"), "export {};\n");
    await utimes(join(src, "Widget.tsx"), new Date("2026-09-28T12:00:00Z"), new Date("2026-09-28T12:00:00Z"));
    await writeFile(join(ui, "index.html"), "<html></html>\n");
    await utimes(join(ui, "index.html"), new Date("2026-09-28T11:00:00Z"), new Date("2026-09-28T11:00:00Z"));
    let error: unknown;
    try {
      await assertBuiltUiIsCurrent(ui, join(root, "src"));
      expect.unreachable("a stale bundle must refuse to start");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    const message = error instanceof Error ? error.message : String(error);
    expect(message).toContain("Widget.tsx");
    expect(message).toContain("vite build");
  });

  it("ignores non-source files and unreaddable directories", async () => {
    const root = await scratch();
    const src = join(root, "src");
    const ui = join(root, "dist");
    await mkdir(join(src, "sub"), { recursive: true });
    await mkdir(ui, { recursive: true });
    await writeFile(join(src, "README.md"), "docs never count\n");
    await writeFile(join(src, "notes.txt"), "scratch never counts\n");
    await writeFile(join(src, "sub", "deep.ts"), "export {};\n");
    await utimes(join(src, "sub", "deep.ts"), new Date("2026-09-28T09:00:00Z"), new Date("2026-09-09T09:00:00Z"));
    await writeFile(join(ui, "index.html"), "<html></html>\n");
    await utimes(join(ui, "index.html"), new Date("2026-09-28T11:00:00Z"), new Date("2026-09-28T11:00:00Z"));
    await expect(assertBuiltUiIsCurrent(ui, join(root, "src"))).resolves.toBeUndefined();
  });

  it("escape hatch: MUSTER_E2E_ALLOW_STALE_UI=1 bypasses the refusal", async () => {
    const root = await scratch();
    const src = join(root, "src");
    const ui = join(root, "dist");
    await mkdir(src, { recursive: true });
    await mkdir(ui, { recursive: true });
    await writeFile(join(src, "Fresh.tsx"), "export {};\n");
    await utimes(join(src, "Fresh.tsx"), new Date("2026-09-28T13:00:00Z"), new Date("2026-09-28T13:00:00Z"));
    await writeFile(join(ui, "index.html"), "<html></html>\n");
    await utimes(join(ui, "index.html"), new Date("2026-09-28T11:00:00Z"), new Date("2026-09-28T11:00:00Z"));
    const previous = process.env.MUSTER_E2E_ALLOW_STALE_UI;
    process.env.MUSTER_E2E_ALLOW_STALE_UI = "1";
    try {
      await expect(assertBuiltUiIsCurrent(ui, join(root, "src"))).resolves.toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.MUSTER_E2E_ALLOW_STALE_UI;
      else process.env.MUSTER_E2E_ALLOW_STALE_UI = previous;
    }
  });
});
