// B3: the served bundle could not name its own source.
//
// `/api/build-identity` reported `revision: null` in production, which reads as
// "no provenance, nothing to check" rather than "this build is unprovable". The
// mechanism was never broken — `MUSTER_SOURCE_REVISION` works and is already
// covered — the ARG was simply supplied by nothing, and nothing failed when it
// was not. These cases pin the refusal and the path that avoids needing it.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error The build producer is plain Node ESM, also used by the bundler.
import { assertProvenanceClaimed, createBuildMetadata } from "../scripts/build-identity.mjs";

const ROOT = process.cwd();
const REVISION = /^[a-f0-9]{40}$/;

/** A directory that is emphatically not a git checkout, so the fallback finds
 *  nothing and the identity is the honest "unknown" it should be. */
function noCheckout(): string {
  return mkdtempSync(join(tmpdir(), "muster-provenance-"));
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Does the REAL guard refuse this build? It calls the exported guard, because
 *  the first version of this file reimplemented the condition inline — and
 *  deleting the guard from the bundle build left that copy passing 5/5. A test
 *  that restates the logic under test cannot fail when the logic is removed. */
function guardRefuses(metadata: { source: { revision: string | null } }, requireProvenance: string | undefined): boolean {
  try {
    assertProvenanceClaimed(metadata, requireProvenance);
    return false;
  } catch {
    return true;
  }
}

describe("production build provenance", () => {
  it("a checkout with no claim still records the observed revision", () => {
    // The historical local path: git is available, so the fallback works and
    // the guard is never needed for a dev build.
    const metadata = createBuildMetadata(ROOT, "1.2.3");
    expect(metadata.source.revision).toMatch(REVISION);
    expect(guardRefuses(metadata, undefined)).toBe(false);
  });

  it("a stamped claim is recorded verbatim and is what makes the build provable", () => {
    const head = execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const metadata = createBuildMetadata(ROOT, "1.2.3", head);
    expect(metadata.source.revision).toBe(head);
    expect(guardRefuses(metadata, "1")).toBe(false);
  });

  it("a build with no checkout and no claim is unprovable, and the guard says so", () => {
    const dir = noCheckout();
    dirs.push(dir);
    const metadata = createBuildMetadata(dir, "1.2.3");
    expect(metadata.source.revision, "a tree with no .git cannot know its own revision").toBeNull();
    // This is exactly production's state today, and the whole point of the
    // guard: it must be REFUSED, not quietly shipped.
    expect(guardRefuses(metadata, "1")).toBe(true);
  });

  it("an explicitly unrequired build is still allowed, so local docker build works", () => {
    // The Dockerfile documents this on purpose: inventing a claim for a local
    // build would be worse than admitting ignorance.
    const dir = noCheckout();
    dirs.push(dir);
    const metadata = createBuildMetadata(dir, "1.2.3");
    expect(guardRefuses(metadata, undefined)).toBe(false);
    expect(guardRefuses(metadata, "0")).toBe(false);
  });

  it("the Dockerfile actually declares both build args", () => {
    // The guard is unreachable if the ARG is not plumbed through, and that is
    // exactly the class of gap this is closing.
    const dockerfile = readFileSync(join(ROOT, "Dockerfile"), "utf8");
    expect(dockerfile).toMatch(/ARG MUSTER_SOURCE_REVISION/);
    expect(dockerfile).toMatch(/ARG MUSTER_REQUIRE_PROVENANCE/);
    // And the bundle build must actually CALL the guard. Asserting the env
    // name in bundle-server.mjs was the first version of this and it went
    // stale the moment the guard moved into build-identity.mjs — the bundle now
    // names neither string, so the assertion failed for a reason that had
    // nothing to do with the wiring. What matters is the call, not where the
    // constant is spelled.
    const bundle = readFileSync(join(ROOT, "scripts/bundle-server.mjs"), "utf8");
    expect(bundle, "the server bundle build never calls the provenance guard").toContain("assertProvenanceClaimed(identity)");
    // The guard itself is where the env name lives, next to the claim it reads.
    const producer = readFileSync(join(ROOT, "scripts/build-identity.mjs"), "utf8");
    expect(producer).toContain("MUSTER_REQUIRE_PROVENANCE");
    expect(producer).toContain("MUSTER_SOURCE_REVISION");
  });
});
