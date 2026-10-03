// Dependency-free release policy and artifact binding for the pre-install workflow gate.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ReleaseVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
const FullSha = /^[a-f0-9]{40}$/;
const Sha256 = /^[a-f0-9]{64}$/;
const TrustOutcomes = new Set(['success', 'failure', 'cancelled', 'skipped']);
const trustKeys = ['architecture', 'checks', 'files', 'runAttempt', 'runId', 'schemaVersion', 'sha', 'status', 'version'];
const checkKeys = ['gatekeeper', 'notarization', 'signature'];

function macArtifactNames(version, architecture) {
  if (!ReleaseVersion.test(String(version))) throw new Error('Invalid Mac trust release version');
  if (architecture === 'arm64') return [
    `Muster-${version}.dmg`, `Muster-${version}-arm64.zip`, 'Muster.dmg',
    'latest-mac.yml', 'SHA256SUMS-macos-arm64.txt',
  ];
  if (architecture === 'intel') return [
    `Muster-${version}-intel.dmg`, `Muster-${version}-x64.zip`, 'Muster-intel.dmg',
    'SHA256SUMS-macos-x64.txt',
  ];
  throw new Error('Mac trust architecture must be arm64 or intel');
}

function macOptionalArtifactNames(version, architecture) {
  if (architecture === 'arm64') return [`Muster-${version}-arm64.zip.blockmap`];
  if (architecture === 'intel') return [`Muster-${version}-x64.zip.blockmap`];
  throw new Error('Mac trust architecture must be arm64 or intel');
}

function assertMacInventory(assetsDir, version, architecture) {
  const allMacArtifacts = new Set([
    ...macArtifactNames(version, 'arm64'), ...macOptionalArtifactNames(version, 'arm64'),
    ...macArtifactNames(version, 'intel'), ...macOptionalArtifactNames(version, 'intel'),
  ]);
  const directoryNames = readdirSync(resolve(assetsDir));
  // Match the actual platform upload globs exactly: all .dmg/.zip files and
  // ZIP blockmaps are uploaded; stapler-invalidated DMG blockmaps are not.
  const observed = directoryNames.filter((name) => /\.(?:dmg|zip)$/.test(name) || name.endsWith('.zip.blockmap'));
  const selectedNames = new Set([...macArtifactNames(version, architecture), ...macOptionalArtifactNames(version, architecture)]);
  const present = observed.filter((name) => selectedNames.has(name));
  const required = macArtifactNames(version, architecture);
  const unexpected = observed.filter((name) => !allMacArtifacts.has(name));
  const missing = required.filter((name) => !directoryNames.includes(name));
  if (unexpected.length > 0 || missing.length > 0) {
    throw new Error(`Mac release artifact inventory differs from the attested upload set (unexpected=${unexpected.join(',')}; missing=${missing.join(',')})`);
  }
  return [...required, ...macOptionalArtifactNames(version, architecture).filter((name) => present.includes(name))];
}

function digestRegularFile(path) {
  const before = lstatSync(path);
  if (!before.isFile() || before.nlink !== 1 || !Number.isSafeInteger(before.size) || before.size <= 0) {
    throw new Error('Mac trust asset must be a nonempty unlinked regular file');
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size
      || opened.nlink !== 1 || opened.mtimeMs !== before.mtimeMs || opened.ctimeMs !== before.ctimeMs) {
      throw new Error('Mac trust asset changed while opening');
    }
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(1024 * 1024);
    let size = 0;
    while (true) {
      const count = readSync(fd, buffer, 0, buffer.length, size);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
      size += count;
    }
    const after = fstatSync(fd);
    const pathAfter = lstatSync(path);
    const sameSnapshot = (left, right) => left.isFile() && right.isFile() && left.dev === right.dev
      && left.ino === right.ino && left.size === right.size && left.nlink === 1
      && right.nlink === 1 && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
    if (size !== opened.size || !sameSnapshot(opened, after) || !sameSnapshot(after, pathAfter)) {
      throw new Error('Mac trust asset changed while hashing');
    }
    return { size, sha256: hash.digest('hex') };
  } finally {
    closeSync(fd);
  }
}

function validRunIdentity(runId, runAttempt) {
  return /^[1-9]\d*$/.test(String(runId)) && /^[1-9]\d*$/.test(String(runAttempt));
}

export function createMacTrustEvidence({
  assetsDir, version, sha, architecture, runId, runAttempt,
  signatureOutcome, notarizationOutcome, gatekeeperOutcome,
}) {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  if (typeof sha !== 'string' || !FullSha.test(sha)) throw new Error('Mac trust requires the full lowercase source SHA');
  if (!validRunIdentity(runId, runAttempt)) throw new Error('Mac trust requires the current workflow run and attempt');
  const checks = { signature: signatureOutcome, notarization: notarizationOutcome, gatekeeper: gatekeeperOutcome };
  if (!Object.values(checks).every((outcome) => TrustOutcomes.has(outcome))) throw new Error('Mac trust requires explicit check outcomes');
  const evidence = { schemaVersion: 1, status: 'untrusted', version, sha, architecture, runId, runAttempt, checks, files: [] };
  if (!Object.values(checks).every((outcome) => outcome === 'success')) return evidence;
  const files = assertMacInventory(assetsDir, version, architecture);
  evidence.files = files.map((name) => ({ name, ...digestRegularFile(join(resolve(assetsDir), name)) }));
  evidence.status = 'verified';
  return evidence;
}

export function verifyMacTrustEvidence(serialized, { assetsDir, version, sha, architecture, runId, runAttempt }) {
  try {
    const serializedText = String(serialized);
    const evidence = JSON.parse(serializedText);
    if (!evidence || Array.isArray(evidence)
      || (serialized instanceof String && JSON.stringify(evidence) !== serializedText)
      || Object.keys(evidence).sort().join(',') !== [...trustKeys].sort().join(',')) return false;
    if (evidence.schemaVersion !== 1 || evidence.status !== 'verified' || evidence.version !== version
      || evidence.sha !== sha || !FullSha.test(sha ?? '') || evidence.architecture !== architecture
      || evidence.runId !== runId || evidence.runAttempt !== runAttempt || !validRunIdentity(runId, runAttempt)) return false;
    if (!evidence.checks || Array.isArray(evidence.checks)
      || Object.keys(evidence.checks).sort().join(',') !== [...checkKeys].sort().join(',')
      || !checkKeys.every((key) => evidence.checks[key] === 'success')) return false;
    const expectedNames = assertMacInventory(assetsDir, version, architecture);
    if (!Array.isArray(evidence.files) || evidence.files.length !== expectedNames.length) return false;
    return evidence.files.every((entry, index) => {
      if (!entry || Array.isArray(entry)
        || Object.keys(entry).sort().join(',') !== 'name,sha256,size'
        || entry.name !== expectedNames[index] || !Number.isSafeInteger(entry.size) || entry.size <= 0
        || !Sha256.test(String(entry.sha256))) return false;
      const actual = digestRegularFile(join(resolve(assetsDir), expectedNames[index]));
      return entry.size === actual.size && entry.sha256 === actual.sha256;
    });
  } catch {
    return false;
  }
}

export function decideMacTrust({ assetsDir, version, sha, runId, runAttempt, arm64Evidence, intelEvidence }) {
  const context = { assetsDir, version, sha, runId, runAttempt };
  const evidence = [arm64Evidence, intelEvidence];
  if (!evidence.every((entry) => entry !== undefined && entry !== null && String(entry).length > 0)) return false;
  return verifyMacTrustEvidence(evidence[0], { ...context, architecture: 'arm64' })
    && verifyMacTrustEvidence(evidence[1], { ...context, architecture: 'intel' });
}

export function attestMacArtifacts(options) {
  const evidence = createMacTrustEvidence(options);
  if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required for Mac artifact attestation');
  appendFileSync(process.env.GITHUB_OUTPUT, `evidence=${JSON.stringify(evidence)}\nstatus=${evidence.status}\n`);
  console.log(JSON.stringify({ architecture: evidence.architecture, status: evidence.status, files: evidence.files.length }));
  return evidence;
}

export function requireMacTrust({ assetsDir, version, sha, runId, runAttempt, arm64Evidence, intelEvidence }) {
  if (!decideMacTrust({ assetsDir, version, sha, runId, runAttempt, arm64Evidence, intelEvidence })) {
    throw new Error('Both distributed Mac architectures must have current-run verified artifact-bound trust');
  }
  console.log('Both distributed Mac architectures have current-run verified artifact-bound trust.');
  return true;
}

function writeOutputs(result) {
  if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required');
  appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(result).map(([key, value]) => `${key}=${value}\n`).join(''));
}

function statusText(value) {
  const normalized = String(value);
  return TrustOutcomes.has(normalized) ? normalized : 'skipped';
}

export function pinRelease({ version, sha, eventName, refType, refName, dryRun }) {
  // package.json and environment values are the untyped runtime input boundary.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  if (typeof version !== 'string' || !ReleaseVersion.test(version)) throw new Error('Invalid package version');
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  if (typeof sha !== 'string' || !FullSha.test(sha)) throw new Error('Invalid prepared commit');
  if (!['push', 'workflow_dispatch'].includes(eventName)) throw new Error('Unsupported release event');
  if (!['true', 'false'].includes(dryRun)) throw new Error('Explicit dry-run state required');
  if (eventName === 'push' && (dryRun !== 'false' || refType !== 'tag' || refName !== `v${version}`)) {
    if (refType === 'tag') {
      if (dryRun !== 'false') {
        throw new Error(`Release tag push for v${version} must run with dry_run disabled; re-run the workflow with dry_run unchecked`);
      }
      throw new Error(`Release tag ${refName} does not match the package version ${version}; re-tag the tested commit as v${version} (see scripts/bump-version.mjs output) or fix package.json`);
    }
    throw new Error('Release tag push must match the package version');
  }
  return { sha, version, dry_run: dryRun };
}

export function decideReleaseDraft({ macos, windows, linux, intel, assetsDir, version, sha, runId, runAttempt, arm64Evidence, intelEvidence }) {
  const statuses = ['success', 'failure', 'cancelled', 'skipped'];
  if (![macos, windows, linux, intel].every((status) => statuses.includes(status))) {
    throw new Error('Explicit platform results required');
  }
  const trust = decideMacTrust({ assetsDir, version, sha, runId, runAttempt, arm64Evidence, intelEvidence });
  return {
    value: [macos, windows, linux, intel].every((status) => status === 'success') && trust ? 'false' : 'true',
    macos_trust: trust ? 'verified' : 'unverified',
  };
}

function main(command, env) {
  if (command === 'pin') {
    const result = pinRelease({
      version: JSON.parse(readFileSync('package.json', 'utf8')).version,
      sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      eventName: env.EVENT_NAME, refType: env.REF_TYPE, refName: env.REF_NAME, dryRun: env.DRY_RUN,
    });
    writeOutputs(result);
    console.log(JSON.stringify(result));
    return;
  }
  if (command === 'attest') {
    attestMacArtifacts({
      assetsDir: env.ASSETS_DIR ?? 'release', version: env.RELEASE_VERSION, sha: env.RELEASE_SHA,
      architecture: env.MAC_ARCH, runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT,
      signatureOutcome: statusText(env.SIGNATURE_OUTCOME),
      notarizationOutcome: statusText(env.NOTARIZATION_OUTCOME), gatekeeperOutcome: statusText(env.GATEKEEPER_OUTCOME),
    });
    return;
  }
  if (command === 'require-trust') {
    requireMacTrust({
      assetsDir: env.ASSETS_DIR ?? 'assets', version: env.RELEASE_VERSION, sha: env.RELEASE_SHA,
      runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT,
      arm64Evidence: env.ARM64_TRUST_EVIDENCE, intelEvidence: env.INTEL_TRUST_EVIDENCE,
    });
    return;
  }
  if (command === 'draft') {
    const result = decideReleaseDraft({
      macos: env.MACOS_RESULT, windows: env.WINDOWS_RESULT, linux: env.LINUX_RESULT, intel: env.INTEL_RESULT,
      assetsDir: env.ASSETS_DIR ?? 'assets', version: env.RELEASE_VERSION, sha: env.RELEASE_SHA,
      runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT,
      arm64Evidence: env.ARM64_TRUST_EVIDENCE, intelEvidence: env.INTEL_TRUST_EVIDENCE,
    });
    writeOutputs(result);
    console.log(JSON.stringify(result));
    return;
  }
  throw new Error('Usage: release-policy.mjs pin|attest|require-trust|draft');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3 || !['pin', 'attest', 'require-trust', 'draft'].includes(process.argv[2])) {
      throw new Error('Usage: release-policy.mjs pin|attest|require-trust|draft');
    }
    main(process.argv[2], process.env);
  } catch (error) {
    console.error(`[release-policy] ${error.message}`);
    process.exitCode = 1;
  }
}
