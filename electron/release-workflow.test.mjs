import { describe, expect, it } from 'vitest';
import { evaluateGuard, readReleaseWorkflow, verifyReleaseWorkflow } from '../scripts/verify-release-workflow.mjs';

const original = readReleaseWorkflow(new URL('../.github/workflows/release.yml', import.meta.url));
const copy = () => structuredClone(original);
const upload = (workflow, platform) => workflow.jobs[platform].steps.find((step) => /gh release upload/.test(step.run ?? ''));
const step = (workflow, job, fragment) => workflow.jobs[job].steps.find((entry) => String(entry.run ?? '').includes(fragment));

describe('release control decision matrix', () => {
  it('permits real complete publication while rejecting dry, draft, prerelease and failed states', () => {
    expect(verifyReleaseWorkflow(original)).toEqual({ platformUploads: 4, mutationSteps: 8 });
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
