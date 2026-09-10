// Dependency-free: preparation runs before installing project packages.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function pinRelease({ version, sha, eventName, refType, refName, dryRun }) {
  // package.json and environment values are the untyped input boundary.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(version)) {
    throw new Error('Invalid package version');
  }
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  if (typeof sha !== 'string' || !/^[a-f0-9]{40}$/.test(sha)) throw new Error('Invalid prepared commit');
  if (!['push', 'workflow_dispatch'].includes(eventName)) throw new Error('Unsupported release event');
  if (!['true', 'false'].includes(dryRun)) throw new Error('Explicit dry-run state required');
  if (eventName === 'push' && (dryRun !== 'false' || refType !== 'tag' || refName !== `v${version}`)) {
    throw new Error('Release tag push must match the package version');
  }
  return { sha, version, dry_run: dryRun };
}

export function decideReleaseDraft({ macos, windows, linux, intel }) {
  const statuses = ['success', 'failure', 'cancelled', 'skipped'];
  if (![macos, windows, linux, intel].every((status) => statuses.includes(status))) {
    throw new Error('Explicit platform results required');
  }
  return { value: [macos, windows, linux].every((status) => status === 'success') ? 'false' : 'true' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3 || !['pin', 'draft'].includes(process.argv[2]) || !process.env.GITHUB_OUTPUT) {
      throw new Error('Usage: release-policy.mjs pin|draft with GITHUB_OUTPUT');
    }
    const env = process.env;
    const result = process.argv[2] === 'pin'
      ? pinRelease({
        version: JSON.parse(readFileSync('package.json', 'utf8')).version,
        sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        eventName: env.EVENT_NAME, refType: env.REF_TYPE, refName: env.REF_NAME, dryRun: env.DRY_RUN,
      })
      : decideReleaseDraft({ macos: env.MACOS_RESULT, windows: env.WINDOWS_RESULT, linux: env.LINUX_RESULT, intel: env.INTEL_RESULT });
    appendFileSync(env.GITHUB_OUTPUT, Object.entries(result).map(([key, value]) => `${key}=${value}\n`).join(''));
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(`[release-policy] ${error.message}`);
    process.exitCode = 1;
  }
}
