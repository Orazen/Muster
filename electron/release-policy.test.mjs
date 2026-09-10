import { describe, expect, it } from 'vitest';
import { decideReleaseDraft, pinRelease } from '../scripts/release-policy.mjs';

const sha = 'a'.repeat(40);
const selected = { version: '1.10.5', sha, eventName: 'workflow_dispatch', refType: 'tag', refName: 'v1.10.4', dryRun: 'true' };
describe('release identity and dry-run derivation', () => {
  it('uses the selected commit even when a manual run originates from another tag', () => {
    expect(pinRelease(selected)).toEqual({ version: '1.10.5', sha, dry_run: 'true' });
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

describe('core platform publication policy', () => {
  it('keeps partial and cancelled core builds as drafts, with Intel optional', () => {
    const statuses = ['success', 'failure', 'cancelled', 'skipped'];
    let cases = 0;
    for (const macos of statuses) for (const windows of statuses) for (const linux of statuses) for (const intel of statuses) {
      expect(decideReleaseDraft({ macos, windows, linux, intel }).value)
        .toBe([macos, windows, linux].every((status) => status === 'success') ? 'false' : 'true');
      cases++;
    }
    expect(cases).toBe(256);
  });
  it.each(['', undefined, 'unknown'])('refuses an unavailable platform result %s', (windows) => {
    expect(() => decideReleaseDraft({ macos: 'success', windows, linux: 'success', intel: 'skipped' })).toThrow();
  });
});
