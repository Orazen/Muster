import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error The build producer is plain Node ESM, also used by the bundler.
import { createBuildMetadata, IDENTITY_LIMITS, readBuildContextRevision, webBuildIdentityPlugin, writeBuildIdentity } from "../scripts/build-identity.mjs";

const roots: string[] = [];
function fixture() { const root = mkdtempSync(join(tmpdir(), "muster-identity-")); roots.push(root); return root; }
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe("Docker build-context source identity", () => {
  const sha = "a".repeat(40);
  function context(head = sha) {
    const root = fixture(); mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git", "HEAD"), head + "\n");
    return root;
  }
  function ref(root: string, value = sha) {
    mkdirSync(join(root, ".git", "refs", "heads", "release"), { recursive: true });
    writeFileSync(join(root, ".git", "refs", "heads", "release", "next"), value + "\n");
  }
  it("observes detached HEAD without Git config or an object database", () => {
    const root = context(sha.toUpperCase());
    expect(readBuildContextRevision(root)).toBe(sha);
    vi.stubEnv("MUSTER_SOURCE_CONTEXT", root);
    expect(createBuildMetadata(fixture(), "1.2.3").source).toEqual({ revision: sha, dirty: null });
  });
  it("resolves a nested loose ref from the same context and keeps dirtiness unknown", () => {
    const root = context("ref: refs/heads/release/next"); ref(root);
    vi.stubEnv("MUSTER_SOURCE_CONTEXT", root);
    expect(createBuildMetadata(fixture(), "1.2.3").source).toEqual({ revision: sha, dirty: null });
  });
  it("resolves an exact packed ref when the loose ref does not exist", () => {
    const root = context("ref: refs/heads/main");
    writeFileSync(join(root, ".git", "packed-refs"), `# pack-refs with: peeled\n${"b".repeat(40)} refs/heads/main-old\n${sha} refs/heads/main\n^${"c".repeat(40)}\n`);
    expect(readBuildContextRevision(root)).toBe(sha);
  });
  it("does not revive a stale packed value when the loose ref is corrupt", () => {
    const root = context("ref: refs/heads/release/next"); ref(root, "broken");
    writeFileSync(join(root, ".git", "packed-refs"), `${sha} refs/heads/release/next\n`);
    expect(readBuildContextRevision(root)).toBeNull();
  });
  it("rejects conflicting duplicate packed references", () => {
    const root = context("ref: refs/heads/main");
    writeFileSync(join(root, ".git", "packed-refs"), `${sha} refs/heads/main\n${"b".repeat(40)} refs/heads/main\n`);
    expect(readBuildContextRevision(root)).toBeNull();
  });
  it.each(["ref: ../outside", "ref: refs/heads/../../config", "ref: refs/heads/branch..name", "ref: refs/heads/a.lock", "ref: refs/heads//main", "ref: refs/heads/a\\b", "x".repeat(513), "b".repeat(64)])("refuses malformed or escaping HEAD %s", head => {
    expect(readBuildContextRevision(context(head))).toBeNull();
  });
  it("does not follow a Git worktree pointer outside the context", () => {
    const root = fixture(); const outside = context();
    writeFileSync(join(root, ".git"), `gitdir: ${join(outside, ".git")}\n`);
    expect(readBuildContextRevision(root)).toBeNull();
  });
  it.each(["git", "head", "ref", "parent", "packed"])("refuses a symlink at %s", kind => {
    const root = fixture(); const outside = fixture();
    writeFileSync(join(outside, "value"), sha);
    if (kind === "git") {
      mkdirSync(join(outside, "metadata")); writeFileSync(join(outside, "metadata", "HEAD"), sha);
      symlinkSync(join(outside, "metadata"), join(root, ".git"));
    } else {
      mkdirSync(join(root, ".git"));
      if (kind === "head") symlinkSync(join(outside, "value"), join(root, ".git", "HEAD"));
      else {
        writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
        if (kind === "parent") symlinkSync(outside, join(root, ".git", "refs"));
        else if (kind === "packed") symlinkSync(join(outside, "value"), join(root, ".git", "packed-refs"));
        else {
          mkdirSync(join(root, ".git", "refs", "heads"), { recursive: true });
          symlinkSync(join(outside, "value"), join(root, ".git", "refs", "heads", "main"));
        }
      }
    }
    expect(readBuildContextRevision(root)).toBeNull();
  });
  it("bounds packed metadata and rejects non-files", () => {
    const root = context("ref: refs/heads/main");
    writeFileSync(join(root, ".git", "packed-refs"), `${"#".repeat(256 * 1024)}\n${sha} refs/heads/main\n`);
    expect(readBuildContextRevision(root)).toBeNull();
    rmSync(join(root, ".git", "packed-refs")); mkdirSync(join(root, ".git", "packed-refs"));
    expect(readBuildContextRevision(root)).toBeNull();
  });
  it("keeps missing context metadata unknown instead of borrowing the local checkout", () => {
    vi.stubEnv("MUSTER_SOURCE_CONTEXT", fixture());
    expect(createBuildMetadata(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "1.2.3").source)
      .toEqual({ revision: null, dirty: null });
    expect(createBuildMetadata(fixture(), "1.2.3", sha).source).toEqual({ revision: sha, dirty: null });
  });
  it("rejects an explicit claim that conflicts with the observed build context", () => {
    vi.stubEnv("MUSTER_SOURCE_CONTEXT", context());
    expect(() => createBuildMetadata(fixture(), "1.2.3", "b".repeat(40))).toThrow("Source revision claim conflicts with build context");
    expect(createBuildMetadata(fixture(), "1.2.3", sha.toUpperCase()).source).toEqual({ revision: sha, dirty: null });
  });
  it.skipIf(process.platform === "win32")("executes both real Docker build commands with the same source-context binding", () => {
    const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const dockerfile = readFileSync(join(project, "Dockerfile"), "utf8");
    const buildStep = dockerfile.match(/RUN --mount=type=bind,source=\.,target=\/muster-source,readonly \\\n([\s\S]+?)\n\n/);
    expect(buildStep).not.toBeNull();
    const root = context(); const bin = join(root, "bin"); mkdirSync(bin);
    const record = join(root, "commands.jsonl");
    const fakePnpm = join(bin, "pnpm");
    writeFileSync(fakePnpm, `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';\nimport {createBuildMetadata} from ${JSON.stringify(new URL("../scripts/build-identity.mjs", import.meta.url).href)};\nappendFileSync(${JSON.stringify(record)},JSON.stringify({command:process.argv.slice(2),source:createBuildMetadata(process.cwd(),'1.2.3').source})+'\\n');\n`);
    chmodSync(fakePnpm, 0o700);
    const command = buildStep![1].replaceAll("/muster-source", root);
    execFileSync("sh", ["-c", command], { cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, MUSTER_SOURCE_REVISION: "" } });
    expect(readFileSync(record, "utf8").trim().split("\n").map(line => JSON.parse(line)))
      .toEqual(["build", "build:server"].map(command => ({ command: [command], source: { revision: sha, dirty: null } })));
    const runtime = dockerfile.slice(dockerfile.indexOf(" AS runtime\n"));
    expect(runtime).not.toContain("MUSTER_SOURCE_CONTEXT");
    expect(runtime).not.toMatch(/COPY[^\n]*(?:\.git|muster-source)/);
  });
});
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
