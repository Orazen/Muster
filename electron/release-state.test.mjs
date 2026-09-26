import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { manageReleaseState, readReleaseEnvironment } from "../scripts/release-state.mjs";

const sha = () => randomBytes(20).toString("hex");
function fixture() {
  const env = {
    GITHUB_REPOSITORY: "Orazen/Muster",
    RELEASE_VERSION: "1.10.4",
    RELEASE_SHA: sha(),
    GH_TOKEN: randomBytes(32).toString("hex"),
  };
  const tag = `v${env.RELEASE_VERSION}`;
  return {
    env, tag,
    ref: { ref: `refs/tags/${tag}`, object: { type: "commit", sha: env.RELEASE_SHA } },
    release: { id: 1234, tag_name: tag, target_commitish: env.RELEASE_SHA, draft: true, prerelease: false },
  };
}

function http(body, status = 200) {
  return { stdout: `HTTP/2.0 ${status} Status\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}`, stderr: "" };
}

function rejectedHttp(status, message = "fixture provider error") {
  return Object.assign(new Error(message), { code: 1, ...http({ message }, status) });
}

function runner(responses) {
  const calls = [];
  return {
    calls,
    run: async (executable, args, options) => {
      calls.push({ executable, args, options });
      const answer = responses.shift();
      if (!answer) throw new Error("Unexpected fixture command");
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

function expectReadsOnly(calls) {
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    expect(call.executable).toBe("gh");
    expect(call.args.slice(0, 7)).toEqual(["api", "--hostname", "github.com", "--include", "--method", "GET", call.args[6]]);
    expect(call.args).toHaveLength(7);
  }
}

describe("release-state input boundary", () => {
  it.each([
    ["GITHUB_REPOSITORY", "Orazen/Muster/other"],
    ["GITHUB_REPOSITORY", "Orazen/.."],
    ["RELEASE_VERSION", "v1.10.4"],
    ["RELEASE_VERSION", "1.10.4\n"],
    ["RELEASE_VERSION", "1.10.4-beta.01"],
    ["RELEASE_SHA", "main"],
    ["GH_TOKEN", ""],
  ])("rejects invalid %s before calling gh", async (key, value) => {
    const owned = fixture();
    owned.env[key] = value;
    const fake = runner([]);
    await expect(manageReleaseState("prepare", { env: owned.env, run: fake.run })).rejects.toThrow();
    expect(fake.calls).toEqual([]);
  });

  it("accepts a semver prerelease/build tag without exposing the token", () => {
    const owned = fixture();
    owned.env.RELEASE_VERSION = "1.10.4-beta.1+build.2";
    const result = readReleaseEnvironment(owned.env);
    expect(result.tag).toBe("v1.10.4-beta.1+build.2");
    expect(JSON.stringify(result)).not.toContain(owned.env.GH_TOKEN);
  });
});

describe("remote tag proof", () => {
  it("reuses an exact lightweight-tag draft with reads only", async () => {
    const owned = fixture();
    const fake = runner([http(owned.ref), rejectedHttp(404), http([owned.release])]);
    const result = await manageReleaseState("prepare", { env: owned.env, run: fake.run });
    expect(result).toEqual({
      repository: owned.env.GITHUB_REPOSITORY, version: owned.env.RELEASE_VERSION,
      sha: owned.env.RELEASE_SHA, tag: owned.tag, releaseId: 1234, state: "draft", action: "reused",
    });
    expect(fake.calls[0].args[6]).toBe(`repos/Orazen/Muster/git/ref/tags/${owned.tag}`);
    expectReadsOnly(fake.calls);
  });

  it("dereferences nested annotated tags to the exact prepared commit", async () => {
    const owned = fixture();
    const first = sha();
    const second = sha();
    const fake = runner([
      http({ ...owned.ref, object: { type: "tag", sha: first } }),
      http({ object: { type: "tag", sha: second } }),
      http({ object: { type: "commit", sha: owned.env.RELEASE_SHA } }),
      http(owned.release),
    ]);
    await expect(manageReleaseState("assert-draft", { env: owned.env, run: fake.run })).resolves.toMatchObject({ state: "draft" });
    expect(fake.calls.map((call) => call.args[6])).toEqual([
      `repos/Orazen/Muster/git/ref/tags/${owned.tag}`,
      `repos/Orazen/Muster/git/tags/${first}`, `repos/Orazen/Muster/git/tags/${second}`,
      `repos/Orazen/Muster/releases/tags/${owned.tag}`,
    ]);
    expectReadsOnly(fake.calls);
  });

  it.each(["missing", "different commit", "invalid object"])("refuses a %s tag without creating a release", async (kind) => {
    const owned = fixture();
    const response = kind === "missing" ? rejectedHttp(404)
      : http({ ...owned.ref, object: { type: kind === "invalid object" ? "blob" : "commit", sha: sha() } });
    const fake = runner([response]);
    await expect(manageReleaseState("prepare", { env: owned.env, run: fake.run })).rejects.toThrow(/tag/i);
    expect(fake.calls).toHaveLength(1);
    expectReadsOnly(fake.calls);
  });

  it("rejects a cycle instead of repeatedly resolving annotated tags", async () => {
    const owned = fixture();
    const object = { type: "tag", sha: sha() };
    const fake = runner([http({ ...owned.ref, object }), http({ object })]);
    await expect(manageReleaseState("prepare", { env: owned.env, run: fake.run })).rejects.toThrow(/cycle/);
    expect(fake.calls).toHaveLength(2);
    expectReadsOnly(fake.calls);
  });

  it("bounds distinct nested tag lookups", async () => {
    const owned = fixture();
    const fake = runner([
      http({ ...owned.ref, object: { type: "tag", sha: sha() } }),
      ...Array.from({ length: 8 }, () => http({ object: { type: "tag", sha: sha() } })),
    ]);
    await expect(manageReleaseState("prepare", { env: owned.env, run: fake.run })).rejects.toThrow(/bounded/);
    expect(fake.calls).toHaveLength(9);
    expectReadsOnly(fake.calls);
  });
});

describe("fail-closed staging", () => {
  const fullUnrelatedPage = () => Array.from({ length: 100 }, (_, index) => ({
    id: index + 1, tag_name: `v0.0.0-fixture.${index}`, draft: false,
  }));

  it("finds an existing draft on a later release-list page instead of creating one", async () => {
    const owned = fixture();
    const fake = runner([http(owned.ref), rejectedHttp(404), http(fullUnrelatedPage()), http([owned.release])]);
    await expect(manageReleaseState("prepare", { env: owned.env, run: fake.run })).resolves.toMatchObject({ action: "reused" });
    expect(fake.calls.map((call) => call.args[6]).slice(2)).toEqual([
      "repos/Orazen/Muster/releases?per_page=100&page=1", "repos/Orazen/Muster/releases?per_page=100&page=2",
    ]);
    expectReadsOnly(fake.calls);
  });

  it("fails closed when the release listing reaches its pagination limit", async () => {
    const owned = fixture();
    const fake = runner([http(owned.ref), rejectedHttp(404), ...Array.from({ length: 10 }, () => http(fullUnrelatedPage()))]);
    await expect(manageReleaseState("prepare", { env: owned.env, run: fake.run })).rejects.toThrow("absence is not confirmed");
    expect(fake.calls).toHaveLength(12);
    expectReadsOnly(fake.calls);
  });

  it.each([null, {}, [null], [{ id: 1, tag_name: "v0.0.0", draft: "false" }]])("rejects malformed draft listings %j", async (value) => {
    const owned = fixture();
    const fake = runner([http(owned.ref), rejectedHttp(404), http(value)]);
    await expect(manageReleaseState("prepare", { env: owned.env, run: fake.run })).rejects.toThrow();
    expect(fake.calls).toHaveLength(3);
    expectReadsOnly(fake.calls);
  });

  it("does not treat a 404 on the draft listing as proof of release absence", async () => {
    const owned = fixture();
    const fake = runner([http(owned.ref), rejectedHttp(404), rejectedHttp(404)]);
    await expect(manageReleaseState("prepare", { env: owned.env, run: fake.run })).rejects.toThrow(/listing/);
    expect(fake.calls).toHaveLength(3);
    expectReadsOnly(fake.calls);
  });

  it("rejects oversized list pages", async () => {
    const owned = fixture();
    const fake = runner([http(owned.ref), rejectedHttp(404), http([...fullUnrelatedPage(), owned.release])]);
    await expect(manageReleaseState("prepare", { env: owned.env, run: fake.run })).rejects.toThrow(/count/);
    expectReadsOnly(fake.calls);
  });

  it("rejects ambiguous matching drafts", async () => {
    const owned = fixture();
    const fake = runner([http(owned.ref), rejectedHttp(404), http([owned.release, { ...owned.release, id: 5678 }])]);
    await expect(manageReleaseState("prepare", { env: owned.env, run: fake.run })).rejects.toThrow(/ambiguous/);
    expectReadsOnly(fake.calls);
  });

  it("also rejects matching drafts spread across listing pages", async () => {
    const owned = fixture();
    const firstPage = fullUnrelatedPage();
    firstPage[0] = owned.release;
    const fake = runner([http(owned.ref), rejectedHttp(404), http(firstPage), http([{ ...owned.release, id: 5678 }])]);
    await expect(manageReleaseState("prepare", { env: owned.env, run: fake.run })).rejects.toThrow(/ambiguous/);
    expect(fake.calls).toHaveLength(4);
    expectReadsOnly(fake.calls);
  });

  it("creates only after confirmed 404, then rechecks the tag and draft", async () => {
    const owned = fixture();
    const fake = runner([http(owned.ref), rejectedHttp(404), http([]), { stdout: "fixture release URL" }, http(owned.ref), http(owned.release)]);
    const result = await manageReleaseState("prepare", { env: owned.env, run: fake.run });
    expect(result).toMatchObject({ action: "created", state: "draft", releaseId: 1234 });
    expect(fake.calls).toHaveLength(6);
    expect(fake.calls[3].args).toEqual([
      "release", "create", owned.tag, "--repo", "https://github.com/Orazen/Muster",
      "--draft", "--prerelease=false", "--verify-tag", "--target", owned.env.RELEASE_SHA,
      "--title", "Muster 1.10.4 (staging)", "--notes", `Staging build from Orazen/Muster@${owned.env.RELEASE_SHA}.`,
    ]);
    expectReadsOnly([fake.calls[0], fake.calls[1], fake.calls[2], fake.calls[4], fake.calls[5]]);
    for (const call of fake.calls) {
      expect(call.args).not.toContain(owned.env.GH_TOKEN);
      expect(call.options.env.GH_HOST).toBe("github.com");
    }
  });

  it.each([401, 403, 500])("does not treat HTTP %i as release absence", async (status) => {
    const owned = fixture();
    const fake = runner([http(owned.ref), rejectedHttp(status, owned.env.GH_TOKEN)]);
    const error = await manageReleaseState("prepare", { env: owned.env, run: fake.run }).catch((failure) => failure);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain(`HTTP ${status}`);
    expect(error.message).not.toContain(owned.env.GH_TOKEN);
    expect(fake.calls).toHaveLength(2);
    expectReadsOnly(fake.calls);
  });

  it("does not trust a network error merely mentioning 404", async () => {
    const owned = fixture();
    const failure = Object.assign(new Error(`404 ${owned.env.GH_TOKEN}`), { stderr: "gh: Not Found (HTTP 404)" });
    const fake = runner([http(owned.ref), failure]);
    await expect(manageReleaseState("prepare", { env: owned.env, run: fake.run })).rejects.toThrow("without a confirmed HTTP response");
    expect(fake.calls).toHaveLength(2);
    expectReadsOnly(fake.calls);
  });

  it.each([null, [], "404", { message: "Not Found" }])("does not treat HTTP 200 with invalid payload %j as absence", async (value) => {
    const owned = fixture();
    const fake = runner([http(owned.ref), http(value)]);
    await expect(manageReleaseState("prepare", { env: owned.env, run: fake.run })).rejects.toThrow();
    expect(fake.calls).toHaveLength(2);
    expectReadsOnly(fake.calls);
  });

  it.each(["HTTP/2.0 404oops\r\n\r\n{}", "HTTP/2.0 200 OK\r\n\r\n{broken"])("rejects malformed provider output", async (stdout) => {
    const owned = fixture();
    const fake = runner([http(owned.ref), { stdout }]);
    await expect(manageReleaseState("prepare", { env: owned.env, run: fake.run })).rejects.toThrow(/malformed/);
    expect(fake.calls).toHaveLength(2);
    expectReadsOnly(fake.calls);
  });

  it("propagates failed creation without exposing command errors", async () => {
    const owned = fixture();
    const fake = runner([http(owned.ref), rejectedHttp(404), http([]), new Error(owned.env.GH_TOKEN)]);
    await expect(manageReleaseState("prepare", { env: owned.env, run: fake.run })).rejects.toThrow("Draft creation failed; release state was not confirmed");
    expect(fake.calls).toHaveLength(4);
  });

  it("does not report success when creation leaves the release absent", async () => {
    const owned = fixture();
    const absent = () => [rejectedHttp(404), http([])];
    const fake = runner([http(owned.ref), rejectedHttp(404), http([]), { stdout: "" }, http(owned.ref), ...absent(), http(owned.ref), ...absent(), http(owned.ref), ...absent()]);
    await expect(manageReleaseState("prepare", { env: owned.env, run: fake.run })).rejects.toThrow("did not produce a confirmed matching draft");
    expect(fake.calls).toHaveLength(13);
  });

  it("waits out listing lag: a draft visible only on a later settle check is confirmed", async () => {
    const owned = fixture();
    let settles = 0;
    const delay = async () => { settles += 1; };
    // create, then two invisible checks (tag + tag-404 + empty listing),
    // then the draft shows up on the third attempt.
    const fake = runner([
      http(owned.ref), rejectedHttp(404), http([]), { stdout: "fixture release URL" },
      http(owned.ref), rejectedHttp(404), http([]),
      http(owned.ref), rejectedHttp(404), http([]),
      http(owned.ref), http(owned.release),
    ]);
    await expect(manageReleaseState("prepare", { env: owned.env, run: fake.run, delay })).resolves.toMatchObject({ action: "created", state: "draft", releaseId: 1234 });
    expect(settles).toBe(2);
    expect(fake.calls).toHaveLength(12);
  });

  it("bounds the settle window before giving up on an invisible draft", async () => {
    const owned = fixture();
    let settles = 0;
    const delay = async () => { settles += 1; };
    const fake = runner([
      http(owned.ref), rejectedHttp(404), http([]), { stdout: "" },
      http(owned.ref), rejectedHttp(404), http([]),
      http(owned.ref), rejectedHttp(404), http([]),
      http(owned.ref), rejectedHttp(404), http([]),
    ]);
    await expect(manageReleaseState("prepare", { env: owned.env, run: fake.run, delay })).rejects.toThrow("did not produce a confirmed matching draft");
    expect(settles).toBe(2);
    expect(fake.calls).toHaveLength(13);
  });

  it("detects a tag moved during creation", async () => {
    const owned = fixture();
    const moved = { ...owned.ref, object: { type: "commit", sha: sha() } };
    const fake = runner([http(owned.ref), rejectedHttp(404), http([]), { stdout: "" }, http(moved)]);
    await expect(manageReleaseState("prepare", { env: owned.env, run: fake.run })).rejects.toThrow("does not resolve to RELEASE_SHA");
    expect(fake.calls).toHaveLength(5);
  });
});

describe("release state assertions", () => {
  it.each(["prepare", "assert-draft"])("%s rejects an already published release without mutations", async (mode) => {
    const owned = fixture();
    const fake = runner([http(owned.ref), http({ ...owned.release, draft: false })]);
    await expect(manageReleaseState(mode, { env: owned.env, run: fake.run })).rejects.toThrow();
    expectReadsOnly(fake.calls);
  });

  it.each(["prepare", "assert-draft", "assert-published"])("%s rejects ambiguous target_commitish even with a matching tag", async (mode) => {
    const owned = fixture();
    const fake = runner([http(owned.ref), http({ ...owned.release, target_commitish: "main", draft: mode !== "assert-published" })]);
    await expect(manageReleaseState(mode, { env: owned.env, run: fake.run })).rejects.toThrow(/metadata/);
    expectReadsOnly(fake.calls);
  });

  it.each(["assert-draft", "assert-published"])("%s rejects absent release without creating it", async (mode) => {
    const owned = fixture();
    const fake = runner([http(owned.ref), rejectedHttp(404), http([])]);
    await expect(manageReleaseState(mode, { env: owned.env, run: fake.run })).rejects.toThrow(/required/);
    expectReadsOnly(fake.calls);
  });

  it("asserts the exact stable published release with reads only", async () => {
    const owned = fixture();
    const fake = runner([http(owned.ref), http({ ...owned.release, draft: false })]);
    await expect(manageReleaseState("assert-published", { env: owned.env, run: fake.run })).resolves.toMatchObject({
      sha: owned.env.RELEASE_SHA, state: "published", action: "verified", releaseId: 1234,
    });
    expectReadsOnly(fake.calls);
  });

  it.each(["draft", "prerelease flag", "prerelease version"])("blocks stable mirroring for a %s", async (kind) => {
    const owned = fixture();
    if (kind === "prerelease version") {
      owned.env.RELEASE_VERSION = "1.10.4-beta.1";
      owned.ref.ref = "refs/tags/v1.10.4-beta.1";
      owned.release.tag_name = "v1.10.4-beta.1";
    }
    const fake = runner([http(owned.ref), http({ ...owned.release, draft: kind === "draft", prerelease: kind === "prerelease flag" })]);
    await expect(manageReleaseState("assert-published", { env: owned.env, run: fake.run })).rejects.toThrow(/non-prerelease/);
    expectReadsOnly(fake.calls);
  });
});
