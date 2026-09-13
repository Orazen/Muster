import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error The build producer is plain Node ESM, also used by the bundler.
import { createBuildMetadata, IDENTITY_LIMITS, webBuildIdentityPlugin, writeBuildIdentity } from "../scripts/build-identity.mjs";

const roots: string[] = [];
function fixture() { const root = mkdtempSync(join(tmpdir(), "muster-identity-")); roots.push(root); return root; }
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe("build identity producer", () => {
  it("keeps source archives unknown and creates distinct build identifiers", () => {
    const root = fixture();
    const first = createBuildMetadata(root, "1.2.3", undefined);
    expect(first.source).toEqual({ revision: null, dirty: null });
    expect(first.buildId).not.toBe(createBuildMetadata(root, "1.2.3", undefined).buildId);
  });
  it("accepts a revision claim without claiming a clean archive", () => {
    expect(createBuildMetadata(fixture(), "1.2.3", "A".repeat(40)).source).toEqual({ revision: "a".repeat(40), dirty: null });
  });
  it("rejects malformed source claims without disclosing their contents", () => {
    expect(() => createBuildMetadata(fixture(), "1.2.3", "secret-value")).toThrow("Invalid source revision claim");
  });
  it("records clean and dirty git source accurately including untracked files", () => {
    const root = fixture();
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
    git("init"); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture");
    expect(createBuildMetadata(root, "1.2.3").source.dirty).toBe(false);
    writeFileSync(join(root, "untracked"), "changed");
    expect(createBuildMetadata(root, "1.2.3").source.dirty).toBe(true);
    expect(createBuildMetadata(root, "1.2.3", "b".repeat(40)).source.dirty).toBeNull();
  });
  it("fingerprints actual output bytes and excludes its own sidecar", () => {
    const root = fixture(); const metadata = createBuildMetadata(root, "1.2.3");
    mkdirSync(join(root, "assets")); writeFileSync(join(root, "index.html"), "hello"); writeFileSync(join(root, "assets", "main.js"), "code");
    const first = writeBuildIdentity(root, metadata, "web");
    expect(first.files).toHaveLength(2);
    expect(first.files[1]).toEqual({ path: "index.html", sha256: createHash("sha256").update("hello").digest("hex"), size: 5 });
    expect(writeBuildIdentity(root, metadata, "web")).toEqual(first);
    writeFileSync(join(root, "index.html"), "other");
    expect(writeBuildIdentity(root, metadata, "web").files).not.toEqual(first.files);
    expect(JSON.parse(readFileSync(join(root, "build-identity.json"), "utf8")).artifact).toBe("web");
  });
  it("scopes server fingerprints to final selected JavaScript", () => {
    const root = fixture(); writeFileSync(join(root, "index.js"), "final"); writeFileSync(join(root, "native.node"), "native");
    expect(writeBuildIdentity(root, createBuildMetadata(root, "1"), "server", ["index.js"]).files).toHaveLength(1);
  });
  it.each(["../escape", "/absolute", "nested/../index.js", "build-identity.json", "a\\b"])("rejects unsafe or self-referential path %s", (path) => {
    const root = fixture(); expect(() => writeBuildIdentity(root, createBuildMetadata(root, "1"), "server", [path])).toThrow();
  });
  it("rejects symbolic links and refuses to overwrite a linked manifest", () => {
    const root = fixture(); const outside = fixture(); writeFileSync(join(outside, "outside"), "private"); symlinkSync(join(outside, "outside"), join(root, "linked"));
    expect(() => writeBuildIdentity(root, createBuildMetadata(root, "1"), "web")).toThrow();
    rmSync(join(root, "linked")); writeFileSync(join(root, "index.js"), "code"); symlinkSync(join(outside, "outside"), join(root, "build-identity.json"));
    expect(() => writeBuildIdentity(root, createBuildMetadata(root, "1"), "server", ["index.js"])).toThrow();
    expect(readFileSync(join(outside, "outside"), "utf8")).toBe("private");
  });
  it.each([{ fileBytes: 2 }, { totalBytes: 2 }, { files: 0 }, { manifestBytes: 2 }])("enforces bounded work %j", (limit) => {
    const root = fixture(); writeFileSync(join(root, "index.js"), "code");
    expect(() => writeBuildIdentity(root, createBuildMetadata(root, "1"), "web", undefined, { ...IDENTITY_LIMITS, ...limit })).toThrow();
  });
  it("bounds empty-directory traversal", () => {
    const root = fixture(); mkdirSync(join(root, "a")); mkdirSync(join(root, "b")); mkdirSync(join(root, "c"));
    expect(() => writeBuildIdentity(root, createBuildMetadata(root, "1"), "web", undefined, { ...IDENTITY_LIMITS, files: 1 })).toThrow("Artifact traversal limit exceeded");
  });
  it("emits only after a successful build finishes", () => {
    vi.stubEnv("VITEST", "");
    const root = fixture(); writeFileSync(join(root, "package.json"), '{"version":"1.2.3"}');
    mkdirSync(join(root, "dist")); writeFileSync(join(root, "dist", "index.html"), "built");
    const plugin = webBuildIdentityPlugin();
    plugin.configResolved({ command: "build", mode: "production", root, build: { outDir: "dist" } });
    plugin.buildEnd(new Error("build failed")); plugin.closeBundle();
    expect(() => readFileSync(join(root, "dist", "build-identity.json"))).toThrow();
    plugin.buildEnd(); plugin.closeBundle();
    expect(JSON.parse(readFileSync(join(root, "dist", "build-identity.json"), "utf8")).files[0].path).toBe("index.html");
  });
  it("does no source or disk work for dev and test configurations", () => {
    for (const config of [{ command: "serve", mode: "development" }, { command: "build", mode: "test" }]) {
      const plugin = webBuildIdentityPlugin(); expect(plugin.apply).toBe("build");
      expect(() => { plugin.configResolved(config); plugin.closeBundle(); }).not.toThrow();
    }
  });
});
