// Dependency-free release gates: prepare runs immediately after checkout.
// Only prepare may mutate GitHub, after proving the tag and absent release.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const execute = promisify(execFile);
const SHA = /^[a-f0-9]{40}$/i;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const MAX_TAG_DEPTH = 8;
const RELEASE_PAGE_SIZE = 100;
const MAX_RELEASE_PAGES = 10;

function requiredText(value, label) {
  // Environment and external JSON are untyped runtime boundaries.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  if (typeof value !== "string" || !value || value.trim() !== value) throw new Error(`${label} must be a nonempty string without surrounding whitespace`);
  return value;
}

export function readReleaseEnvironment(env) {
  const repository = requiredText(env.GITHUB_REPOSITORY, "GITHUB_REPOSITORY");
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(repository)
    || [".", ".."].includes(repository.split("/")[1])) throw new Error("Invalid GITHUB_REPOSITORY");
  const version = requiredText(env.RELEASE_VERSION, "RELEASE_VERSION");
  const match = VERSION.exec(version);
  if (!match || match[4]?.split(".").some((part) => /^0\d+$/.test(part))) throw new Error("Invalid RELEASE_VERSION");
  const sha = requiredText(env.RELEASE_SHA, "RELEASE_SHA");
  if (!SHA.test(sha)) throw new Error("RELEASE_SHA must be a full commit SHA");
  requiredText(env.GH_TOKEN, "GH_TOKEN");
  return { repository, version, sha: sha.toLowerCase(), tag: `v${version}` };
}

// gh api --include prints an HTTP status/header block before its JSON body.
// An error message merely mentioning 404 is never evidence of absence.
function httpResponse(stdout) {
  // Child-process output may be absent on spawn/network failures.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  if (typeof stdout !== "string") return null;
  const boundary = /\r?\n\r?\n/.exec(stdout);
  if (!boundary) return null;
  const headers = stdout.slice(0, boundary.index);
  const status = /^HTTP\/\d+(?:\.\d+)?[ \t]+([1-5]\d{2})(?:[ \t].*)?$/.exec(headers.split(/\r?\n/)[0]);
  if (!status) return null;
  return { status: Number(status[1]), body: stdout.slice(boundary.index + boundary[0].length) };
}

export async function manageReleaseState(mode, { env = process.env, run = execute } = {}) {
  if (!["prepare", "assert-draft", "assert-published"].includes(mode)) throw new Error("Expected prepare, assert-draft, or assert-published");
  const release = readReleaseEnvironment(env);
  const childEnv = { ...env, GH_HOST: "github.com", GH_PROMPT_DISABLED: "1", GH_PAGER: "cat", NO_COLOR: "1" };
  delete childEnv.GH_DEBUG;
  // The release listing is the one paged endpoint here and it is large —
  // 53 releases already exceed a 1 MB buffer once each carries its full
  // asset list, and maxBuffer overflow surfaces as a confusing "HTTP 200
  // failed" from the catch below. 32 MB bounds the worst case this repo
  // can produce while staying far under any runner memory limit.
  const options = { env: childEnv, timeout: 30_000, maxBuffer: 32 * 1024 * 1024 };

  const api = async (endpoint, list = false) => {
    let response;
    try {
      const result = await run("gh", ["api", "--hostname", "github.com", "--include", "--method", "GET", endpoint], options);
      response = httpResponse(result?.stdout);
    } catch (error) {
      response = httpResponse(error?.stdout);
      if (response?.status === 404) return null;
      throw new Error(response ? `GitHub API request failed (HTTP ${response.status})` : "GitHub API request failed without a confirmed HTTP response");
    }
    if (!response) throw new Error("GitHub API returned a malformed HTTP response");
    if (response.status === 404) return null;
    if (response.status !== 200) throw new Error(`GitHub API request failed (HTTP ${response.status})`);
    let value;
    try { value = JSON.parse(response.body); }
    catch { throw new Error("GitHub API returned malformed JSON"); }
    // API endpoints used here return objects. A 200/null must never become
    // indistinguishable from a confirmed 404 release absence.
    // oxlint-disable-next-line anti-slop/no-runtime-typeof
    if (value === null || typeof value !== "object" || Array.isArray(value) !== list) throw new Error("GitHub API returned an invalid JSON shape");
    return value;
  };

  const verifyTag = async () => {
    const ref = await api(`repos/${release.repository}/git/ref/tags/${encodeURIComponent(release.tag)}`);
    if (ref === null) throw new Error("Release tag is missing; implicit tag creation is prohibited");
    if (ref?.ref !== `refs/tags/${release.tag}`) throw new Error("GitHub returned an unexpected release tag");
    let object = ref.object;
    const visited = new Set();
    for (let depth = 0; depth <= MAX_TAG_DEPTH; depth++) {
      const sha = requiredText(object?.sha, "Tag object SHA");
      if (!SHA.test(sha) || !["commit", "tag"].includes(object?.type)) throw new Error("GitHub returned an invalid tag object");
      const normalizedSha = sha.toLowerCase();
      if (object.type === "commit") {
        if (normalizedSha !== release.sha) throw new Error("Release tag does not resolve to RELEASE_SHA");
        return;
      }
      if (depth === MAX_TAG_DEPTH || visited.has(normalizedSha)) throw new Error("Annotated release tag exceeds the bounded resolution limit or contains a cycle");
      visited.add(normalizedSha);
      const annotated = await api(`repos/${release.repository}/git/tags/${normalizedSha}`);
      if (annotated === null) throw new Error("Annotated release tag object is missing");
      object = annotated?.object;
    }
    throw new Error("Unable to resolve release tag");
  };

  const readState = async () => {
    let value = await api(`repos/${release.repository}/releases/tags/${encodeURIComponent(release.tag)}`);
    if (value === null) {
      // The tag endpoint may exclude drafts. A 404 therefore requires a
      // complete bounded draft scan before it can authorize creation.
      for (let page = 1; page <= MAX_RELEASE_PAGES; page++) {
        const entries = await api(`repos/${release.repository}/releases?per_page=${RELEASE_PAGE_SIZE}&page=${page}`, true);
        if (entries === null || entries.length > RELEASE_PAGE_SIZE) throw new Error("Release listing is unavailable or has an invalid count");
        const matches = [];
        for (const entry of entries) {
          requiredText(entry?.tag_name, "Release listing tag");
          if (!Number.isSafeInteger(entry?.id) || entry.id <= 0 || ![true, false].includes(entry.draft)) throw new Error("Release listing contains invalid metadata");
          if (entry.tag_name === release.tag) matches.push(entry);
        }
        if (matches.length > 1 || (matches.length === 1 && value !== null)) throw new Error("Release listing contains ambiguous matching releases");
        if (matches.length === 1) value = matches[0];
        if (entries.length < RELEASE_PAGE_SIZE) {
          if (value === null) return null;
          break;
        }
        if (page === MAX_RELEASE_PAGES) throw new Error("Release lookup exceeded its bounded pagination limit; absence is not confirmed");
      }
    }
    if (!Number.isSafeInteger(value?.id) || value.id <= 0 || value.tag_name !== release.tag
      || ![true, false].includes(value.draft) || ![true, false].includes(value.prerelease)
      || value.target_commitish !== release.sha) throw new Error("Release metadata does not match the exact prepared tag, SHA, and state contract");
    return { id: value.id, draft: value.draft, prerelease: value.prerelease };
  };

  await verifyTag();
  let state = await readState();
  let action = "verified";
  if (mode === "prepare") {
    if (state?.draft === false) throw new Error("Refusing to modify an already published release");
    if (state) action = "reused";
    else {
      try {
        await run("gh", [
          "release", "create", release.tag, "--repo", `https://github.com/${release.repository}`,
          "--draft", "--prerelease=false", "--verify-tag", "--target", release.sha,
          "--title", `Muster ${release.version} (staging)`,
          "--notes", `Staging build from ${release.repository}@${release.sha}.`,
        ], options);
      } catch {
        throw new Error("Draft creation failed; release state was not confirmed");
      }
      await verifyTag();
      state = await readState();
      if (!state?.draft) throw new Error("Draft creation did not produce a confirmed matching draft");
      action = "created";
    }
  } else if (mode === "assert-draft") {
    if (!state?.draft) throw new Error("A matching draft release is required");
  } else if (!state || state.draft || state.prerelease || VERSION.exec(release.version)?.[4]) {
    throw new Error("A matching published, non-prerelease release is required");
  }
  return { ...release, releaseId: state.id, state: state.draft ? "draft" : "published", action };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error("Usage: release-state.mjs prepare|assert-draft|assert-published");
    console.log(JSON.stringify(await manageReleaseState(process.argv[2])));
  } catch (error) {
    // All public helper errors are fixed messages; never print gh output or
    // the cause, either of which may contain credentials or provider data.
    console.error(`[release-state] ${error instanceof Error ? error.message : "Release gate failed"}`);
    process.exitCode = 1;
  }
}
