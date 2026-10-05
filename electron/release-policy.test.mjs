import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createMacTrustEvidence, decideReleaseDraft, pinRelease, requireMacTrust, verifyMacTrustEvidence,
} from '../scripts/release-policy.mjs';

const sha = 'a'.repeat(40);
const version = '1.10.5';
const runId = '1234567890';
const runAttempt = '2';
const selected = { version, sha, eventName: 'workflow_dispatch', refType: 'tag', refName: 'v1.10.4', dryRun: 'true' };
const architectureFiles = {
  arm64: [`Muster-${version}.dmg`, `Muster-${version}-arm64.zip`, 'Muster.dmg', 'latest-mac.yml', 'SHA256SUMS-macos-arm64.txt', `Muster-${version}-arm64.zip.blockmap`],
  intel: [`Muster-${version}-intel.dmg`, `Muster-${version}-x64.zip`, 'Muster-intel.dmg', 'SHA256SUMS-macos-x64.txt', `Muster-${version}-x64.zip.blockmap`],
};
let assetsDir;
let scratch;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'muster-mac-trust-'));
  assetsDir = join(scratch, 'assets');
  mkdirSync(assetsDir);
  for (const [architecture, names] of Object.entries(architectureFiles)) {
    for (const name of names) writeFileSync(join(assetsDir, name), `verified fixture bytes for ${architecture}: ${name}`);
  }
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

const context = (architecture, overrides = {}) => ({
  assetsDir, version, sha, architecture, runId, runAttempt,
  signatureOutcome: 'success', notarizationOutcome: 'success', gatekeeperOutcome: 'success', ...overrides,
});
const evidence = (architecture, overrides = {}) => JSON.stringify(createMacTrustEvidence(context(architecture, overrides)));
const digest = (value) => createHash('sha256').update(value).digest('hex');
const validPair = () => ({ arm64Evidence: evidence('arm64'), intelEvidence: evidence('intel') });
const draft = (overrides = {}) => decideReleaseDraft({
  macos: 'success', windows: 'success', linux: 'success', intel: 'success',
  assetsDir, version, sha, runId, runAttempt, ...validPair(), ...overrides,
});

describe('release identity and dry-run derivation', () => {
  it('uses the selected commit even when a manual run originates from another tag', () => {
    expect(pinRelease(selected)).toEqual({ version, sha, dry_run: 'true' });
  });
  it('allows a matching version tag push', () => {
    expect(pinRelease({ ...selected, eventName: 'push', refName: 'v1.10.5', dryRun: 'false' }).dry_run).toBe('false');
  });
  it('preserves explicit manual publication', () => {
    expect(pinRelease({ ...selected, dryRun: 'false' }).dry_run).toBe('false');
  });
  it.each([
    { dryRun: undefined }, { dryRun: '' }, { dryRun: false },
    { eventName: 'schedule' }, { eventName: 'push', dryRun: 'false' },
    { eventName: 'push', refName: 'v1.10.5' },
    { sha: 'main' }, { sha: 'a'.repeat(39) }, { sha: sha + '\ndry_run=false' },
    { version: '1.10.5\ndry_run=false' }, { version: '01.10.5' }, { version: undefined },
  ])('rejects ambiguous or unsafe pin inputs %j', (patch) => {
    expect(() => pinRelease({ ...selected, ...patch })).toThrow();
  });
});

describe('artifact-bound macOS trust evidence', () => {
  it.each(['arm64', 'intel'])('hashes the complete %s upload inventory and accepts its exact serialized evidence', (architecture) => {
    const receipt = evidence(architecture);
    expect(verifyMacTrustEvidence(receipt, context(architecture))).toBe(true);
    const parsed = JSON.parse(receipt);
    expect(parsed).toMatchObject({ schemaVersion: 1, status: 'verified', version, sha, architecture, runId, runAttempt });
    expect(parsed.files.map((file) => file.name)).toEqual(architectureFiles[architecture]);
    for (const file of parsed.files) {
      expect(file).toEqual({ name: file.name, size: Buffer.byteLength(`verified fixture bytes for ${architecture}: ${file.name}`),
        sha256: digest(`verified fixture bytes for ${architecture}: ${file.name}`) });
    }
  });

  it.each([
    ['missing evidence', undefined], ['empty evidence', ''], ['malformed JSON', '{'], ['array evidence', '[]'],
    ['unknown schema fields', (receipt) => ({ ...JSON.parse(receipt), forged: true })],
    ['wrong schema version', (receipt) => ({ ...JSON.parse(receipt), schemaVersion: 2 })],
    ['wrong architecture', (receipt) => ({ ...JSON.parse(receipt), architecture: 'intel' })],
    ['stale workflow run', (receipt) => ({ ...JSON.parse(receipt), runId: '1234567888' })],
    ['stale workflow attempt', (receipt) => ({ ...JSON.parse(receipt), runAttempt: '1' })],
    ['wrong source SHA', (receipt) => ({ ...JSON.parse(receipt), sha: 'b'.repeat(40) })],
    ['wrong release version', (receipt) => ({ ...JSON.parse(receipt), version: '1.10.4' })],
    ['failed signature gate', (receipt) => ({ ...JSON.parse(receipt), checks: { ...JSON.parse(receipt).checks, signature: 'failure' } })],
    ['skipped notarization gate', (receipt) => ({ ...JSON.parse(receipt), checks: { ...JSON.parse(receipt).checks, notarization: 'skipped' } })],
    ['failed Gatekeeper gate', (receipt) => ({ ...JSON.parse(receipt), checks: { ...JSON.parse(receipt).checks, gatekeeper: 'failure' } })],
    ['missing digest', (receipt) => { const value = JSON.parse(receipt); delete value.files[0].sha256; return value; }],
    ['malformed digest', (receipt) => { const value = JSON.parse(receipt); value.files[0].sha256 = 'z'.repeat(64); return value; }],
    ['mismatched digest', (receipt) => { const value = JSON.parse(receipt); value.files[0].sha256 = '0'.repeat(64); return value; }],
    ['missing file entry', (receipt) => { const value = JSON.parse(receipt); value.files.pop(); return value; }],
    ['unlisted file entry', (receipt) => { const value = JSON.parse(receipt); value.files.push(value.files[0]); return value; }],
    ['wrong artifact name', (receipt) => { const value = JSON.parse(receipt); value.files[0].name = 'other.dmg'; return value; }],
    ['digest list not canonical', (receipt) => { const value = JSON.parse(receipt); value.files.reverse(); return value; }],
  ])('rejects %s evidence', (_name, mutate) => {
    const original = evidence('arm64');
    const candidate = mutate instanceof Function ? mutate(original) : mutate;
    expect(verifyMacTrustEvidence(candidate, context('arm64'))).toBe(false);
  });

  it('rejects any selected asset whose bytes changed after attestation', () => {
    const receipt = evidence('arm64');
    for (const name of JSON.parse(receipt).files.map((file) => file.name)) {
      const path = join(assetsDir, name);
      const original = `verified fixture bytes for arm64: ${name}`;
      writeFileSync(path, `${original} tampered`);
      expect(verifyMacTrustEvidence(receipt, context('arm64'))).toBe(false);
      writeFileSync(path, original);
      expect(verifyMacTrustEvidence(receipt, context('arm64'))).toBe(true);
    }
  });

  it('refuses stale or unexpected macOS files in the selected artifact inventory', () => {
    const receipt = evidence('arm64');
    writeFileSync(join(assetsDir, 'Muster-1.10.4-x64.zip'), 'stale Intel asset');
    expect(verifyMacTrustEvidence(receipt, context('arm64'))).toBe(false);
  });

  it.each(['failure', 'cancelled', 'skipped'])('does not create passing evidence when a trust gate is %s', (outcome) => {
    const receipt = createMacTrustEvidence(context('arm64', { notarizationOutcome: outcome }));
    expect(receipt).toMatchObject({ status: 'untrusted', files: [], checks: { notarization: outcome } });
  });

  it('runs the actual artifact attestation CLI and forwards its producer outputs to policy', () => {
    const receipts = {};
    for (const architecture of ['arm64', 'intel']) {
      const outputFile = join(scratch, `output-${architecture}.txt`);
      const output = execFileSync(process.execPath, ['scripts/release-policy.mjs', 'attest'], {
        cwd: process.cwd(), encoding: 'utf8',
        env: {
          ...process.env, GITHUB_OUTPUT: outputFile, GITHUB_RUN_ID: runId, GITHUB_RUN_ATTEMPT: runAttempt,
          ASSETS_DIR: assetsDir, RELEASE_VERSION: version, RELEASE_SHA: sha, MAC_ARCH: architecture,
          SIGNATURE_OUTCOME: 'success', NOTARIZATION_OUTCOME: 'success', GATEKEEPER_OUTCOME: 'success',
        },
      });
      expect(JSON.parse(output)).toEqual({ architecture, status: 'verified', files: JSON.parse(readFileSync(outputFile, 'utf8').match(/^evidence=(.*)$/m)[1]).files.length });
      const receipt = readFileSync(outputFile, 'utf8').match(/^evidence=(.*)$/m)?.[1];
      expect(verifyMacTrustEvidence(receipt, context(architecture))).toBe(true);
      receipts[architecture] = receipt;
    }
    const policyEnv = {
      ...process.env, RELEASE_VERSION: version, RELEASE_SHA: sha, GITHUB_RUN_ID: runId,
      GITHUB_RUN_ATTEMPT: runAttempt, ASSETS_DIR: assetsDir,
      ARM64_TRUST_EVIDENCE: receipts.arm64, INTEL_TRUST_EVIDENCE: receipts.intel,
    };
    expect(() => execFileSync(process.execPath, ['scripts/release-policy.mjs', 'require-trust'], {
      cwd: process.cwd(), encoding: 'utf8', env: policyEnv,
    })).not.toThrow();
    const policyOutput = join(scratch, 'draft-output.txt');
    const draftOutput = execFileSync(process.execPath, ['scripts/release-policy.mjs', 'draft'], {
      cwd: process.cwd(), encoding: 'utf8', env: {
        ...policyEnv, GITHUB_OUTPUT: policyOutput, MACOS_RESULT: 'success', WINDOWS_RESULT: 'success',
        LINUX_RESULT: 'success', INTEL_RESULT: 'success',
      },
    });
    expect(JSON.parse(draftOutput)).toEqual({ value: 'false', macos_trust: 'verified' });
    expect(readFileSync(policyOutput, 'utf8')).toContain('value=false\nmacos_trust=verified\n');
    expect(decideReleaseDraft({ macos: 'success', windows: 'success', linux: 'success', intel: 'success',
      assetsDir, version, sha, runId, runAttempt,
      arm64Evidence: receipts.arm64, intelEvidence: receipts.intel }))
      .toEqual({ value: 'false', macos_trust: 'verified' });
    expect(() => execFileSync(process.execPath, ['scripts/release-policy.mjs', 'require-trust'], {
      cwd: process.cwd(), encoding: 'utf8', env: { ...policyEnv, ARM64_TRUST_EVIDENCE: '' },
    })).toThrow();
  });

  it('requires both architecture receipts and validates their digests against downloaded bytes', () => {
    expect(draft()).toEqual({ value: 'false', macos_trust: 'verified' });
    expect(draft({ intelEvidence: undefined })).toEqual({ value: 'true', macos_trust: 'unverified' });
    expect(draft({ arm64Evidence: undefined })).toEqual({ value: 'true', macos_trust: 'unverified' });
    expect(() => requireMacTrust({ assetsDir, version, sha, runId, runAttempt,
      arm64Evidence: undefined, intelEvidence: evidence('intel') })).toThrow(/Both distributed Mac architectures/);
  });

  it.each(['missing', 'malformed', 'mismatched'])('blocks the release draft for %s arm64 digest evidence', (kind) => {
    const candidate = JSON.parse(evidence('arm64'));
    if (kind === 'missing') delete candidate.files[0].sha256;
    if (kind === 'malformed') candidate.files[0].sha256 = 'not-a-sha256';
    if (kind === 'mismatched') candidate.files[0].sha256 = '0'.repeat(64);
    expect(draft({ arm64Evidence: JSON.stringify(candidate) })).toEqual({ value: 'true', macos_trust: 'unverified' });
  });
});

describe('pin failure messages name the mismatch', () => {
  it('tells the operator to disable dry run for a matching tag push', () => {
    expect(() => pinRelease({ ...selected, eventName: 'push', refName: 'v1.10.5', dryRun: 'true' }))
      .toThrow(/dry_run disabled/);
  });
  it('names both tag and package version on a version mismatch', () => {
    expect(() => pinRelease({ ...selected, eventName: 'push', refName: 'v1.10.4', dryRun: 'false' }))
      .toThrow(/v1\.10\.4 does not match the package version 1\.10\.5/);
  });
});

describe('platform publication policy', () => {
  it('keeps partial and cancelled core builds, or an untrusted Intel build, in draft state', () => {
    const statuses = ['success', 'failure', 'cancelled', 'skipped'];
    let cases = 0;
    for (const macos of statuses) for (const windows of statuses) for (const linux of statuses) for (const intel of statuses) {
      const result = decideReleaseDraft({ macos, windows, linux, intel, assetsDir, version, sha, runId, runAttempt, ...validPair() });
      expect(result.value).toBe([macos, windows, linux, intel].every((status) => status === 'success') ? 'false' : 'true');
      cases++;
    }
    expect(cases).toBe(256);
  });
  it.each(['', undefined, 'unknown'])('refuses an unavailable platform result %s', (windows) => {
    expect(() => decideReleaseDraft({ macos: 'success', windows, linux: 'success', intel: 'success', assetsDir, version, sha, runId, runAttempt, ...validPair() })).toThrow();
  });
});
