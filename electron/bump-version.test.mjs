import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../scripts/bump-version.mjs", import.meta.url));
let directory;
const manifest = { name: "muster-bump-fixture", private: true, version: "1.10.3" };
const page = '<h1>Download Muster <span id="dl-version" class="version">v1.10.3</span></h1>\n<p>Historical note: v1.10.3</p>';

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "muster-bump-version-"));
  writeFileSync(join(directory, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
  mkdirSync(join(directory, "www"));
  writeFileSync(join(directory, "www", "download.html"), page);
});
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

function run(...args) {
  // The script is executed only in an owned fixture, with no Git executable
  // available through PATH. Printed release commands are never executed.
  const env = { PATH: "" };
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  return spawnSync(process.execPath, [script, ...args], {
    cwd: directory, encoding: "utf8", timeout: 5_000, env,
  });
}

describe("release candidate preparation", () => {
  it.each([
    ["patch", "1.10.4"], ["minor", "1.11.0"], ["major", "2.0.0"], ["1.12.3", "1.12.3"],
  ])("prepares %s while preserving manifest fields and unrelated page text", (argument, version) => {
    const result = run(argument);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(directory, "package.json"), "utf8"))).toEqual({ ...manifest, version });
    const updated = readFileSync(join(directory, "www", "download.html"), "utf8");
    expect(updated).toContain(`id="dl-version" class="version">v${version}</span>`);
    expect(updated).toContain("Historical note: v1.10.3");
    expect(readdirSync(directory).sort()).toEqual(["package.json", "www"]);
  });

  it("prints a dry-run-first path and a single exact tag push without running Git", () => {
    const result = run("patch");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("No Git commands or release actions were run.");
    expect(result.stdout).toContain('CANDIDATE_SHA="$(git rev-parse HEAD)"');
    expect(result.stdout).toContain("set ref to that full CANDIDATE_SHA");
    expect(result.stdout).toContain("Keep dry_run checked (the default)");
    expect(result.stdout).toContain("After the dry run passes");
    expect(result.stdout).toContain('git tag v1.10.4 "$CANDIDATE_SHA"');
    const pushCommands = result.stdout.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("git push"));
    expect(pushCommands).toEqual(["git push origin main", "git push origin refs/tags/v1.10.4"]);
    expect(result.stdout).toContain("That tag push starts the publishing pipeline");
    expect(result.stdout).toContain("partial platform set remains a draft");
  });

  it("keeps the version bump and warns when the badge needs manual correction", () => {
    writeFileSync(join(directory, "www", "download.html"), "<h1>Custom download page</h1>");
    const result = run("patch");
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).version).toBe("1.10.4");
    expect(readFileSync(join(directory, "www", "download.html"), "utf8")).toBe("<h1>Custom download page</h1>");
    expect(result.stderr).toContain("version badge for v1.10.3 not found");
  });

  it.each([{ args: [] }, { args: ["invalid"] }])("rejects invalid arguments $args without changing candidate files", ({ args }) => {
    const before = readFileSync(join(directory, "package.json"), "utf8");
    const result = run(...args);
    expect(result.status).toBe(1);
    expect(readFileSync(join(directory, "package.json"), "utf8")).toBe(before);
    expect(readFileSync(join(directory, "www", "download.html"), "utf8")).toBe(page);
    expect(result.stdout).not.toContain("git push");
  });
});
