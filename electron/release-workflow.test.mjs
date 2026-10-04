import { describe, expect, it } from 'vitest';
import { evaluateGuard, readReleaseWorkflow, verifyReleaseWorkflow } from '../scripts/verify-release-workflow.mjs';

const original = readReleaseWorkflow(new URL('../.github/workflows/release.yml', import.meta.url));
const copy = () => structuredClone(original);
const upload = (workflow, platform) => workflow.jobs[platform].steps.find((step) => /gh release upload/.test(step.run ?? ''));
const step = (workflow, job, fragment) => workflow.jobs[job].steps.find((entry) => String(entry.run ?? '').includes(fragment));
const stepById = (workflow, job, id) => workflow.jobs[job].steps.find((entry) => entry.id === id);

describe('release control decision matrix', () => {
  it('permits real complete publication while rejecting dry, draft, prerelease and failed states', () => {
    expect(verifyReleaseWorkflow(original)).toEqual({ platformUploads: 4, mutationSteps: 9 });
  });

  it('fails closed if artifact trust is absent from public publication or mirror promotion', () => {
    const noOutput = copy();
    delete noOutput.jobs.macos.outputs.trust_evidence;
    expect(() => verifyReleaseWorkflow(noOutput)).toThrow(/Mac trust evidence/);
    const noConsumer = copy();
    noConsumer.jobs.publish.steps = noConsumer.jobs.publish.steps.filter((entry) => entry.id !== 'trust-gate');
    expect(() => verifyReleaseWorkflow(noConsumer)).toThrow(/Expected one release control step/);
    const optionalIntel = copy();
    optionalIntel.jobs['deploy-downloads'].if = optionalIntel.jobs['deploy-downloads'].if.replace(" && needs.macos-x64.result == 'success'", '');
    expect(() => verifyReleaseWorkflow(optionalIntel)).toThrow(/Mirror must revalidate/);
    const noStableTrust = copy();
    noStableTrust.jobs.publish.outputs.published = "${{ steps.release.outcome == 'success' && steps.draft.outputs.value == 'false' && !contains(needs.prepare.outputs.version, '-') }}";
    expect(() => verifyReleaseWorkflow(noStableTrust)).toThrow(/Public publication signal/);
  });

  it('declares both exact-SHA macOS artifact-bound trust outputs as release prerequisites', () => {
    for (const [platform, architecture] of [['macos', 'arm64'], ['macos-x64', 'intel']]) {
      const job = original.jobs[platform];
      const signing = job.steps.find((entry) => entry.id === 'signature');
      const attestation = job.steps.find((entry) => entry.id === 'attest-mac');
      const checksums = job.steps.find((entry) => /shasum -a 256/.test(entry.run ?? ''));
      expect(job.outputs.trust_evidence).toBe('${{ steps.attest-mac.outputs.evidence }}');
      expect(attestation).toMatchObject({
        id: 'attest-mac',
        run: 'node scripts/release-policy.mjs attest',
        env: {
          MAC_ARCH: architecture,
          RELEASE_VERSION: '${{ needs.prepare.outputs.version }}',
          RELEASE_SHA: '${{ needs.prepare.outputs.sha }}',
          SIGNATURE_OUTCOME: '${{ steps.signature.outcome }}',
          NOTARIZATION_OUTCOME: '${{ steps.notarize.outcome }}',
          GATEKEEPER_OUTCOME: '${{ steps.gatekeeper.outcome }}',
        },
      });
      expect(job.steps.indexOf(attestation)).toBeGreaterThan(job.steps.indexOf(checksums));
      expect(job.steps.indexOf(attestation)).toBeLessThan(job.steps.findIndex((entry) => /gh release upload/.test(entry.run ?? '')));
      expect(signing.continueOnError ?? signing['continue-on-error']).toBeUndefined();
    }
    const draft = original.jobs.publish.steps.find((entry) => entry.id === 'draft');
    expect(draft.env.ARM64_TRUST_EVIDENCE).toBe('${{ needs.macos.outputs.trust_evidence }}');
    expect(draft.env.INTEL_TRUST_EVIDENCE).toBe('${{ needs.macos-x64.outputs.trust_evidence }}');
    expect(original.jobs.publish.outputs.published).toContain("steps.draft.outputs.macos_trust == 'verified'");
    const trustGate = original.jobs.publish.steps.find((entry) => entry.id === 'trust-gate');
    expect(trustGate.run).toBe('node scripts/release-policy.mjs require-trust');
    expect(original.jobs['deploy-downloads'].needs).toEqual(expect.arrayContaining(['macos', 'macos-x64']));
  });

  it('covers blockmaps in platform checksums and uploads so differential updates can use the mirror', () => {
    for (const [platform, sums] of [['macos', '> SHA256SUMS-macos-arm64.txt'], ['macos-x64', '> SHA256SUMS-macos-x64.txt'], ['windows', '> SHA256SUMS-windows-x64.txt']]) {
      const sumsStep = step(original, platform, sums);
      expect(sumsStep.run).toMatch(/blockmap/);
      expect(sumsStep.run).toMatch(/shopt -s nullglob/);
      expect(upload(original, platform).run).toMatch(/blockmap/);
    }
  });

  it.each(['macos', 'macos-x64', 'windows', 'linux'])('catches an unguarded %s upload', (platform) => {
    const workflow = copy();
    delete upload(workflow, platform).if;
    expect(() => verifyReleaseWorkflow(workflow)).toThrow(/Uploads must fail closed/);
  });

  it.each(['macos', 'macos-x64', 'windows', 'linux'])('catches %s uploading after failed packaging', (platform) => {
    const workflow = copy();
    upload(workflow, platform).if = "${{ always() && needs.prepare.outputs.dry_run == 'false' }}";
    expect(() => verifyReleaseWorkflow(workflow)).toThrow(/Uploads must fail closed/);
  });

  const regressions = [
    ['missing CLI build', (w) => { w.jobs.macos.steps = w.jobs.macos.steps.filter((s) => s.id !== 'cli-build'); }],
    ['skipped CLI dry-run verification', (w) => { w.jobs.macos.steps.find((s) => s.id === 'cli-build').if = "${{ needs.prepare.outputs.dry_run == 'false' }}"; }],
    ['ignored CLI build failure', (w) => { w.jobs.macos.steps.find((s) => s.id === 'cli-build')['continue-on-error'] = true; }],
    ['wrong CLI build identity', (w) => { w.jobs.macos.steps.find((s) => s.id === 'cli-build').env.RELEASE_SHA = '${{ github.sha }}'; }],
    ['CLI build after upload', (w) => { const all = w.jobs.macos.steps; const i = all.findIndex((s) => s.id === 'cli-build'); all.push(...all.splice(i, 1)); }],
    ['missing immutable CLI upload', (w) => { const s = upload(w, 'macos'); s.run = s.run.replace('"release/Muster-${RELEASE_VERSION}-cli.mjs" ', ''); }],
    ['missing CLI checksums upload', (w) => { const s = upload(w, 'macos'); s.run = s.run.replace(' release/SHA256SUMS-cli.txt', ''); }],
    ['missing downloaded CLI verification', (w) => { w.jobs.publish.steps = w.jobs.publish.steps.filter((s) => s.id !== 'cli-verify'); }],
    ['downloaded CLI verification bypass', (w) => { w.jobs.publish.steps.find((s) => s.id === 'cli-verify').run = 'true'; }],
    ['ignored downloaded CLI failure', (w) => { w.jobs.publish.steps.find((s) => s.id === 'cli-verify')['continue-on-error'] = true; }],
    ['CLI verification before hash checks', (w) => { const all = w.jobs.publish.steps; const i = all.findIndex((s) => s.id === 'cli-verify'); all.splice(1, 0, ...all.splice(i, 1)); }],
    ['skipped published CLI verification', (w) => { w.jobs.publish.steps.find((s) => s.id === 'cli-verify').if = 'false'; }],
    ['missing selected-commit tests', (w) => { w.jobs.prepare.steps = w.jobs.prepare.steps.filter((s) => s.id !== 'tests'); }],
    ['ignored selected-commit failures', (w) => { w.jobs.prepare.steps.find((s) => s.id === 'tests')['continue-on-error'] = true; }],
    ['conditional selected-commit tests', (w) => { w.jobs.prepare.steps.find((s) => s.id === 'tests').if = 'false'; }],
    ['staging before tests', (w) => { const i = w.jobs.prepare.steps.findIndex((s) => s.id === 'staging'); w.jobs.prepare.steps.splice(2, 0, ...w.jobs.prepare.steps.splice(i, 1)); }],
    ['floating package install', (w) => { w.jobs.macos.steps.push({ run: 'pnpm add electron@latest' }); }],
    ['host Node desktop smoke', (w) => { w.jobs.windows.steps.find((s) => s.id === 'native-smoke').run = 'node release/win-unpacked/resources/server/index.js'; }],
    ['wrong desktop architecture', (w) => { const s = w.jobs.macos.steps.find((s) => s.id === 'native-smoke'); s.run = s.run.replace('--arch arm64', '--arch x64'); }],
    ['ignored native smoke failure', (w) => { w.jobs.linux.steps.find((s) => s.id === 'native-smoke')['continue-on-error'] = true; }],
    ['Gatekeeper before notarization', (w) => { const all = w.jobs.macos.steps; const index = all.findIndex((s) => s.id === 'gatekeeper'); all.splice(1, 0, ...all.splice(index, 1)); }],
    ['Gatekeeper on unsigned dry run', (w) => { delete w.jobs.macos.steps.find((s) => s.id === 'gatekeeper').if; }],
    ['ignored notarization failure', (w) => { w.jobs.macos.steps.find((s) => s.id === 'notarize')['continue-on-error'] = true; }],
    ['ignored Gatekeeper failure', (w) => { w.jobs.macos.steps.find((s) => s.id === 'gatekeeper')['continue-on-error'] = true; }],
    ['missing post-staple feed refresh', (w) => { w.jobs.macos.steps = w.jobs.macos.steps.filter((s) => s.id !== 'refresh-feed'); }],
    ['feed refresh before stapling', (w) => { const all = w.jobs.macos.steps; const index = all.findIndex((s) => s.id === 'refresh-feed'); all.splice(1, 0, ...all.splice(index, 1)); }],
    ['DMG change without successful stapling', (w) => { w.jobs.macos.steps.find((s) => s.id === 'refresh-feed').env.ALLOW_DMG_CHANGE = 'true'; }],
    ['dry-run input overridden', (w) => { w.jobs.prepare.steps.find((s) => s.id === 'pin').env.DRY_RUN = 'false'; }],
    ['dry-run derivation overridden', (w) => { w.jobs.prepare.steps.find((s) => s.id === 'pin').run = 'echo dry_run=false >> "$GITHUB_OUTPUT"'; }],
    ['partial builds declared complete', (w) => { w.jobs.publish.steps.find((s) => s.id === 'draft').run = 'echo value=false >> "$GITHUB_OUTPUT"'; }],
    ['fake successful core result', (w) => { w.jobs.publish.steps.find((s) => s.id === 'draft').env.WINDOWS_RESULT = 'success'; }],
    ['wrong actual upload tag', (w) => { const s = upload(w, 'windows'); s.run = s.run.replace('"v$RELEASE_VERSION"', '"v9.9.9"'); }],
    ['unprotected additional release edit', (w) => { w.jobs.prepare.steps.push({ run: 'gh release edit v1.10.5 --draft=false' }); }],
    ['unguarded staging', (w) => { delete step(w, 'prepare', 'release-state.mjs prepare').if; }],
    ['ambiguous staging SHA', (w) => { step(w, 'prepare', 'release-state.mjs prepare').env.RELEASE_SHA = '${{ github.sha }}'; }],
    ['implicit tag creation', (w) => { upload(w, 'macos').run = 'gh release create v1.10.5 --target "$GITHUB_SHA"'; }],
    ['missing draft recheck', (w) => { upload(w, 'windows').run = upload(w, 'windows').run.replace('node scripts/release-state.mjs assert-draft', 'true'); }],
    ['per-ref release race', (w) => { w.concurrency.group = 'release-${{ github.ref }}'; }],
    ['cancelled release replacement', (w) => { w.concurrency['cancel-in-progress'] = true; }],
    ['unsafe manual default', (w) => { w.on.workflow_dispatch.inputs.dry_run.default = false; }],
    ['incorrect Intel runner', (w) => { w.jobs['macos-x64']['runs-on'] = 'macos-latest'; }],
    ['dry-run Apple submission', (w) => { step(w, 'macos', 'notarytool submit').if = "${{ env.APPLE_ID != '' }}"; }],
    ['Intel notarization despite missing credentials', (w) => { delete step(w, 'macos-x64', 'notarytool submit').if; }],
    ['Intel notarization ignoring the certificate state', (w) => { const s = step(w, 'macos-x64', 'notarytool submit'); s.if = s.if.replace(" && env.APPLE_CERTIFICATE != ''", ''); }],
    ['Intel checksums before stapling', (w) => { const all = w.jobs['macos-x64'].steps; const index = all.findIndex((s) => /shasum -a 256/.test(s.run ?? '')); all.splice(1, 0, ...all.splice(index, 1)); }],
    ['publication after failed prepare', (w) => { w.jobs.publish.if = w.jobs.publish.if.replace("needs.prepare.result == 'success' && ", ''); }],
    ['draft mirror promotion', (w) => { w.jobs['deploy-downloads'].if = "${{ !cancelled() && needs.prepare.outputs.dry_run == 'false' && needs.publish.result == 'success' }}"; }],
    ['prerelease mirror promotion', (w) => { w.jobs.publish.outputs.published = "${{ steps.release.outcome == 'success' && steps.draft.outputs.value == 'false' }}"; }],
    ['wrong release target', (w) => { w.jobs.publish.steps.find((s) => s.id === 'release').with.target_commitish = '${{ github.sha }}'; }],
    ['missing payload validation', (w) => { w.jobs.publish.steps = w.jobs.publish.steps.filter((s) => s.id !== 'payload'); }],
    ['publish after failed payload', (w) => { w.jobs.publish.steps.find((s) => s.id === 'release').if = 'always()'; }],
    ['incomplete public mirror', (w) => { w.jobs['deploy-downloads'].env.REQUIRE_COMPLETE = 'false'; }],
    ['unchecked mirror glob', (w) => { const s = step(w, 'deploy-downloads', 'rsync '); s.run = s.run.replace('--files-from=artifacts/mirror-files.txt', 'artifacts/*'); }],
    ['missing publication recheck', (w) => { const s = step(w, 'deploy-downloads', 'rsync '); s.run = s.run.replace('node scripts/release-state.mjs assert-published', 'true'); }],
    ['nondeterministic mirror timestamp', (w) => { w.jobs['deploy-downloads'].steps.find((s) => s.id === 'payload').env.RELEASE_PUBLISHED_AT = '${{ github.run_id }}'; }],
    ['timestamp from another release', (w) => { const s = w.jobs['deploy-downloads'].steps.find((s) => s.id === 'download'); s.run = s.run.replace('tags/v$RELEASE_VERSION', 'latest'); }],
    ['direct live mirror transfer', (w) => { const s = step(w, 'deploy-downloads', 'rsync '); s.run = s.run.replace('"tarun@$VPS_HOST:$STAGE/"', '"tarun@$VPS_HOST:$REMOTE_ROOT/"'); }],
    ['reused staging path', (w) => { const s = step(w, 'deploy-downloads', 'rsync '); s.run = s.run.replace('STAGE_NAME="$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"', 'STAGE_NAME="shared"'); }],
    ['linked staging ancestor', (w) => { const s = step(w, 'deploy-downloads', 'rsync '); s.run = s.run.replace('root.resolve() != root', 'False'); }],
    ['linked incoming ancestor', (w) => { const s = step(w, 'deploy-downloads', 'rsync '); s.run = s.run.replace('incoming.resolve() != incoming', 'False'); }],
    ['missing remote promotion', (w) => { const s = step(w, 'deploy-downloads', 'rsync '); s.run = s.run.replace('< scripts/promote-release-mirror.py', '< /dev/null'); }],
    ['wrong remote release identity', (w) => { const s = step(w, 'deploy-downloads', 'rsync '); s.run = s.run.replace("--sha '$RELEASE_SHA'", "--sha 'arbitrary'"); }],
    ['unbound transfer manifest', (w) => { const s = step(w, 'deploy-downloads', 'rsync '); s.run = s.run.replace('sha256sum artifacts/mirror-manifest.json', 'echo fixed'); }],
    ['extra remote mirror mutation', (w) => { const s = step(w, 'deploy-downloads', 'rsync '); s.run += '\nssh host overwrite-live'; }],
    // Final distributed DMG gates: the inner .app checks and the stable-named
    // copy both sit outside these, so a weakened DMG gate ships unassessed bytes.
    ['arm64 DMG gate removed', (w) => { w.jobs.macos.steps = w.jobs.macos.steps.filter((entry) => entry.id !== 'dmg-trust'); }],
    ['intel DMG gate removed', (w) => { w.jobs['macos-x64'].steps = w.jobs['macos-x64'].steps.filter((entry) => entry.id !== 'dmg-trust'); }],
    ['DMG gate skips Gatekeeper assessment', (w) => { const s = stepById(w, 'macos', 'dmg-trust'); s.run = s.run.replace(/^\s*spctl --assess.*$/m, 'true'); }],
    ['DMG gate skips signature verification', (w) => { const s = stepById(w, 'macos', 'dmg-trust'); s.run = s.run.replace(/^\s*codesign --verify.*$/m, 'true'); }],
    ['DMG gate skips the stapled notarization ticket', (w) => { const s = stepById(w, 'macos', 'dmg-trust'); s.run = s.run.replace(/^\s*xcrun stapler validate.*$/m, 'true'); }],
    ['DMG gate stops enumerating shipped DMGs', (w) => { const s = stepById(w, 'macos', 'dmg-trust'); s.run = s.run.replace('DMGS=(release/*.dmg)', 'DMGS=(release/none.dmg)'); }],
    ['DMG gate accepts an empty DMG set', (w) => { const s = stepById(w, 'macos', 'dmg-trust'); s.run = s.run.replace('[ "${#DMGS[@]}" -gt 0 ]', '[ "${#DMGS[@]}" -ge 0 ]'); }],
    ['DMG gate stops pinning the architecture', (w) => { const s = stepById(w, 'macos', 'dmg-trust'); s.run = s.run.replace('*,arm64,*)', '*nothing,*)'); }],
    ['DMG gate is allowed to fail', (w) => { stepById(w, 'macos', 'dmg-trust')['continue-on-error'] = true; }],
    ['DMG gate runs before the stable-named copy', (w) => {
      const steps = w.jobs.macos.steps;
      const from = steps.findIndex((entry) => entry.id === 'dmg-trust');
      const target = steps.findIndex((entry) => /Stable-named copy/.test(entry.name ?? ''));
      steps.splice(target, 0, steps.splice(from, 1)[0]);
    }],
    ['DMG gate runs after artifact attestation', (w) => {
      const steps = w.jobs.macos.steps;
      const from = steps.findIndex((entry) => entry.id === 'dmg-trust');
      const target = steps.findIndex((entry) => entry.id === 'attest-mac');
      steps.splice(target, 0, steps.splice(from, 1)[0]);
    }],
  ];
  it.each(regressions)('rejects regression: %s', (_name, mutate) => {
    const workflow = copy(); mutate(workflow);
    expect(() => verifyReleaseWorkflow(workflow)).toThrow();
  });
});

describe('bounded guard evaluator', () => {
  it('handles precedence, missing outputs, and cancelled status without eval', () => {
    expect(evaluateGuard("${{ !cancelled() && (needs.build.result == 'success' || success()) }}", { success: true })).toBe(true);
    expect(evaluateGuard("${{ needs.publish.outputs.published == 'true' }}", {})).toBe(false);
    expect(evaluateGuard('success()', { success: false })).toBe(false);
  });
  it.each(['${{ process.exit(0) }}', '${{ 1 + 1 }}', "${{ contains('a') }}", 'success() trailing', '${{ }}'])('rejects unsupported or malformed guard %s', (guard) => {
    expect(() => evaluateGuard(guard)).toThrow();
  });
});
