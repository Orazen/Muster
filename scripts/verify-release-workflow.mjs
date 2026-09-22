import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { z } from 'zod';

const Text = z.string();

// Evaluate only the expression subset used by our release guards. Unknown
// syntax fails validation rather than being executed as JavaScript.
export function evaluateGuard(expression, context = {}) {
  if (expression === undefined) return context.success === true;
  const source = Text.parse(expression).replace(/^\s*\$\{\{/, '').replace(/\}\}\s*$/, '').trim();
  const tokens = source.match(/\s+|'[^']*'|&&|\|\||==|!=|[!(),]|[a-zA-Z_][a-zA-Z0-9_.-]*/g) ?? [];
  if (tokens.join('') !== source) throw new Error('Unsupported release guard syntax');
  const parts = tokens.filter((token) => !/^\s+$/.test(token));
  let cursor = 0;
  const take = () => parts[cursor++];
  const expect = (token) => { if (take() !== token) throw new Error(`Expected ${token}`); };
  function atom() {
    const token = take();
    if (token === '!') return !atom();
    if (token === '(') { const result = either(); expect(')'); return result; }
    if (token?.startsWith("'")) return token.slice(1, -1);
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (['success', 'cancelled', 'always'].includes(token) && parts[cursor] === '(') {
      expect('('); expect(')');
      return token === 'always' || context[token] === true;
    }
    if (token === 'contains' && parts[cursor] === '(') {
      expect('('); const value = either(); expect(','); const needle = either(); expect(')');
      const haystack = Text.safeParse(value), search = Text.safeParse(needle);
      return haystack.success && search.success && haystack.data.includes(search.data);
    }
    if (!token || !/^[a-zA-Z_][a-zA-Z0-9_.-]*$/.test(token)) throw new Error('Invalid release guard');
    return token.split('.').reduce((value, key) => value?.[key], context) ?? '';
  }
  function comparison() {
    const left = atom();
    const operator = parts[cursor];
    if (operator !== '==' && operator !== '!=') return left;
    take(); const right = atom();
    return operator === '==' ? left === right : left !== right;
  }
  function both() {
    let result = comparison();
    while (parts[cursor] === '&&') { take(); const right = comparison(); result = !!result && !!right; }
    return result;
  }
  function either() {
    let result = both();
    while (parts[cursor] === '||') { take(); const right = both(); result = !!result || !!right; }
    return result;
  }
  const result = either();
  if (cursor !== parts.length) throw new Error('Trailing release guard syntax');
  return !!result;
}

const check = (condition, message) => { if (!condition) throw new Error(message); };
const steps = (job) => job?.steps ?? [];
const one = (job, predicate) => {
  const matches = steps(job).filter(predicate);
  check(matches.length === 1, 'Expected one release control step');
  return matches[0];
};
const shell = (step) => Text.catch('').parse(step.run);

export function verifyReleaseWorkflow(workflow) {
  const jobs = workflow?.jobs;
  check(jobs && workflow.concurrency?.group === 'muster-release' && workflow.concurrency?.['cancel-in-progress'] === false,
    'Release runs must serialize across refs');
  check(workflow.on?.workflow_dispatch?.inputs?.dry_run?.default === true, 'Manual runs must default to dry run');
  check(jobs['macos-x64']?.['runs-on'] === 'macos-15-intel', 'Intel packaging requires an Intel runner');
  const allSteps = Object.values(jobs).flatMap(steps);
  const pin = one(jobs.prepare, (step) => step.id === 'pin');
  check(shell(pin) === 'node scripts/release-policy.mjs pin' && pin.if === undefined &&
    pin.env?.DRY_RUN === "${{ github.event_name == 'workflow_dispatch' && inputs.dry_run }}" &&
    pin.env?.EVENT_NAME === '${{ github.event_name }}' && pin.env?.REF_TYPE === '${{ github.ref_type }}' &&
    pin.env?.REF_NAME === '${{ github.ref_name }}', 'Pin must derive explicit dry-run state from the workflow input');
  check(!allSteps.some((step) => /\$GITHUB_SHA|\$\{GITHUB_SHA\}|gh\s+release\s+create/.test(shell(step))),
    'Release creation belongs to the exact-commit staging helper');
  const staging = one(jobs.prepare, (step) => /release-state\.mjs prepare\s*$/.test(shell(step)));
  check(steps(jobs.prepare).indexOf(pin) < steps(jobs.prepare).indexOf(staging), 'Pin must precede staging');
  const prepareSteps = steps(jobs.prepare);
  const installIndex = prepareSteps.findIndex((step) => shell(step) === 'pnpm install --frozen-lockfile');
  check(installIndex > prepareSteps.indexOf(pin), 'Release verification requires frozen dependencies after pinning');
  for (const [id, command] of [['lint', 'pnpm lint'], ['typecheck', 'pnpm typecheck'], ['tests', 'pnpm exec vitest run'],
    ['broker', 'pnpm broker:test'], ['updater', 'pnpm test:updater'], ['electron-syntax', 'pnpm check:electron']]) {
    const gate = one(jobs.prepare, (step) => step.id === id);
    check(shell(gate) === command && gate.if === undefined && gate['continue-on-error'] === undefined &&
      prepareSteps.indexOf(gate) > installIndex && prepareSteps.indexOf(gate) < prepareSteps.indexOf(staging),
      'Selected commit verification must pass before staging');
  }
  check(staging.env?.RELEASE_SHA === '${{ steps.pin.outputs.sha }}' &&
    staging.env?.RELEASE_VERSION === '${{ steps.pin.outputs.version }}', 'Staging must use the pinned version and SHA');
  for (const dry of ['true', 'false', '', undefined]) {
    for (const success of [true, false]) {
      check(evaluateGuard(staging.if, { success, steps: { pin: { outputs: { dry_run: dry } } } }) ===
        (success && dry === 'false'), 'Staging must fail closed on dry runs and failed preparation');
    }
  }
  const uploads = allSteps.filter((step) => /gh\s+release\s+upload/.test(shell(step)));
  check(uploads.length === 4, 'Expected four bounded platform uploads');
  for (const platform of ['macos', 'macos-x64', 'windows', 'linux']) {
    const job = jobs[platform];
    check(job?.needs === 'prepare', 'Every platform must await verified staging');
    const upload = one(job, (step) => /gh\s+release\s+upload/.test(shell(step)));
    const native = one(job, (step) => step.id === 'native-smoke');
    const nativePlatform = platform.startsWith('macos') ? 'darwin' : platform === 'windows' ? 'win32' : 'linux';
    const arch = platform === 'macos' ? 'arm64' : 'x64';
    check(shell(native).trim().endsWith(`node scripts/release-native-smoke.mjs --platform ${nativePlatform} --arch ${arch}`) &&
      native.if === undefined && native['continue-on-error'] === undefined && steps(job).indexOf(native) < steps(job).indexOf(upload),
      'Platform upload requires the actual packaged Electron smoke');
    check(!steps(job).some((step) => /pnpm add|node "\$(?:staging|res)\//.test(shell(step))),
      'Packaging must preserve pinned dependencies and avoid host-Node smoke');
    check(upload.env?.RELEASE_SHA === '${{ needs.prepare.outputs.sha }}' &&
      upload.env?.RELEASE_VERSION === '${{ needs.prepare.outputs.version }}', 'Uploads must use pinned release identity');
    check(/set -euo pipefail/.test(shell(upload)) && /release-state\.mjs assert-draft\s*\n\s*gh release upload/.test(shell(upload)),
      'Upload must recheck the matching draft and stop on errors');
    check(shell(upload).match(/gh release upload[^\n]*/g)?.length === 1 &&
      /gh release upload "v\$RELEASE_VERSION" /.test(shell(upload)) &&
      !/RELEASE_VERSION\s*=/.test(shell(upload)), 'Upload command must target the pinned version');
    for (const dry of ['true', 'false', '', undefined]) {
      for (const success of [true, false]) {
        check(evaluateGuard(upload.if, { success, needs: { prepare: { outputs: { dry_run: dry } } } }) ===
          (success && dry === 'false'), 'Uploads must fail closed on dry runs and failed builds');
      }
    }
  }
  const cliBuild = one(jobs.macos, (step) => step.id === 'cli-build');
  const cliUpload = one(jobs.macos, (step) => /gh release upload/.test(shell(step)));
  const macNative = one(jobs.macos, (step) => step.id === 'native-smoke');
  check(shell(cliBuild) === 'node scripts/build-cli.mjs' && cliBuild.if === undefined && cliBuild['continue-on-error'] === undefined &&
    cliBuild.env?.RELEASE_VERSION === '${{ needs.prepare.outputs.version }}' &&
    cliBuild.env?.RELEASE_SHA === '${{ needs.prepare.outputs.sha }}' && cliBuild.env?.CLI_OUT_DIR === 'release' &&
    steps(jobs.macos).indexOf(cliBuild) > steps(jobs.macos).indexOf(macNative) &&
    steps(jobs.macos).indexOf(cliBuild) < steps(jobs.macos).indexOf(cliUpload),
    'CLI must build and verify pinned identity before upload, including dry runs');
  check(shell(cliUpload).includes('"release/Muster-${RELEASE_VERSION}-cli.mjs" release/muster-cli.mjs release/SHA256SUMS-cli.txt'),
    'Mac upload must include both exact CLI filenames and dedicated checksums');
  const notarize = one(jobs.macos, (step) => /notarytool submit/.test(shell(step)));
  const intelNotarize = one(jobs['macos-x64'], (step) => /notarytool submit/.test(shell(step)));
  const gatekeeper = one(jobs.macos, (step) => /spctl --assess/.test(shell(step)));
  check(notarize.id === 'notarize' && notarize['continue-on-error'] === undefined && gatekeeper['continue-on-error'] === undefined &&
    steps(jobs.macos).indexOf(gatekeeper) > steps(jobs.macos).indexOf(notarize),
    'Gatekeeper assessment must follow notarization');
  for (const outcome of ['success', 'failure', 'skipped', '']) for (const success of [true, false]) {
    check(evaluateGuard(gatekeeper.if, { success, steps: { notarize: { outcome } } }) === (success && outcome === 'success'),
      'Gatekeeper requires successful notarization');
  }
  const refresh = one(jobs.macos, (step) => step.id === 'refresh-feed');
  const checksums = one(jobs.macos, (step) => /shasum -a 256/.test(shell(step)));
  check(shell(refresh) === 'node scripts/refresh-mac-feed.mjs' && refresh.if === undefined && refresh['continue-on-error'] === undefined &&
    refresh.env?.RELEASE_VERSION === '${{ needs.prepare.outputs.version }}' && refresh.env?.ASSETS_DIR === 'release' &&
    refresh.env?.ALLOW_DMG_CHANGE === "${{ steps.notarize.outcome == 'success' }}" &&
    steps(jobs.macos).indexOf(refresh) > steps(jobs.macos).indexOf(notarize) && steps(jobs.macos).indexOf(refresh) < steps(jobs.macos).indexOf(checksums),
    'Mac feed must follow stapling and precede final checksums');
  for (const success of [true, false]) for (const dry of ['false', 'true', '']) {
    for (const credentials of [true, false]) {
      const env = Object.fromEntries(['ASC_KEY_ID', 'ASC_ISSUER_ID', 'ASC_KEY_CONTENT', 'APPLE_TEAM_ID'].map((key) => [key, credentials ? 'present' : '']));
      check(evaluateGuard(notarize.if, { success, env, needs: { prepare: { outputs: { dry_run: dry } } } }) ===
        (success && dry === 'false' && credentials), 'Notarization must not submit from a dry or failed run');
    }
  }
  check(evaluateGuard(intelNotarize.if, { success: true, env: Object.fromEntries(['ASC_KEY_ID', 'ASC_ISSUER_ID', 'ASC_KEY_CONTENT', 'APPLE_CERTIFICATE'].map((key) => [key, 'present'])), needs: { prepare: { outputs: { dry_run: 'false' } } } }) === true,
    'Intel notarization must submit only with credentials from a non-dry run');
  check(evaluateGuard(intelNotarize.if, { success: true, env: { ASC_KEY_ID: '' }, needs: { prepare: { outputs: { dry_run: 'false' } } } }) === false,
    'Intel notarization must skip when the ASC key is missing');
  check(evaluateGuard(intelNotarize.if, { success: true, env: { ASC_KEY_ID: 'present', ASC_ISSUER_ID: 'present', ASC_KEY_CONTENT: 'present', APPLE_CERTIFICATE: '' }, needs: { prepare: { outputs: { dry_run: 'false' } } } }) === false,
    'Intel notarization must refuse an unsigned build');
  const intelChecksums = one(jobs['macos-x64'], (step) => /shasum -a 256/.test(shell(step)));
  check(steps(jobs['macos-x64']).indexOf(intelChecksums) > steps(jobs['macos-x64']).indexOf(intelNotarize),
    'Intel checksums must follow stapling (stapling rewrites the dmg bytes)');
  const publish = jobs.publish;
  const mirror = jobs['deploy-downloads'];
  const release = one(publish, (step) => String(step.uses ?? '').startsWith('softprops/action-gh-release@'));
  const draft = one(publish, (step) => step.id === 'draft');
  check(shell(draft) === 'node scripts/release-policy.mjs draft' && draft.if === undefined &&
    ['MACOS', 'WINDOWS', 'LINUX'].every((platform) => draft.env?.[`${platform}_RESULT`] === `\${{ needs.${platform.toLowerCase()}.result }}`) &&
    draft.env?.INTEL_RESULT === '${{ needs.macos-x64.result }}', 'Draft state must derive from actual platform results');
  check(release.id === 'release' && release.with?.target_commitish === '${{ needs.prepare.outputs.sha }}' &&
    release.with?.tag_name === 'v${{ needs.prepare.outputs.version }}' && release.with?.draft === '${{ steps.draft.outputs.value }}',
    'Publication must preserve pinned identity and explicit draft state');
  const payloadIndex = steps(publish).findIndex((step) => shell(step) === 'node scripts/release-payload.mjs validate');
  const releaseIndex = steps(publish).indexOf(release);
  check(payloadIndex >= 0 && payloadIndex < releaseIndex &&
    steps(publish)[payloadIndex].env?.REQUIRE_COMPLETE === "${{ steps.draft.outputs.value == 'false' }}" &&
    shell(steps(publish)[releaseIndex - 1]) === 'node scripts/release-state.mjs assert-draft',
    'Publication must validate payload and recheck the draft first');
  check(release.if === undefined && steps(publish)[payloadIndex].if === undefined,
    'Publication and its payload gate must require all preceding steps to succeed');
  const cliVerify = one(publish, (step) => step.id === 'cli-verify');
  check(shell(cliVerify) === 'node scripts/build-cli.mjs verify' && cliVerify.env?.CLI_OUT_DIR === 'assets' &&
    publish.env?.RELEASE_VERSION === '${{ needs.prepare.outputs.version }}' &&
    publish.env?.RELEASE_SHA === '${{ needs.prepare.outputs.sha }}' && cliVerify['continue-on-error'] === undefined &&
    steps(publish).indexOf(cliVerify) > payloadIndex && steps(publish).indexOf(cliVerify) < releaseIndex,
    'Downloaded CLI identity and behavior must verify after hashes and before publication');
  for (const success of [true, false]) for (const mac of ['success', 'failure', 'skipped', '']) {
    check(evaluateGuard(cliVerify.if, { success, needs: { macos: { result: mac } } }) === (success && mac === 'success'),
      'CLI publication verification must run for every successful CLI-producing platform');
  }
  for (const prepare of ['success', 'failure', 'skipped', '']) {
    for (const dry of ['true', 'false', '']) for (const cancelled of [true, false]) {
      for (const mac of ['success', 'failure']) for (const linux of ['success', 'failure']) {
        const needs = { prepare: { result: prepare, outputs: { dry_run: dry } }, macos: { result: mac }, linux: { result: linux } };
        const expected = !cancelled && prepare === 'success' && dry === 'false' && (mac === 'success' || linux === 'success');
        check(evaluateGuard(publish.if, { cancelled, needs }) === expected, 'Publication guard fails the dry/failure matrix');
      }
      for (const result of ['success', 'failure', 'skipped']) for (const published of ['true', 'false', '']) {
        const needs = { prepare: { result: prepare, outputs: { dry_run: dry } }, publish: { result, outputs: { published } } };
        const expected = !cancelled && prepare === 'success' && dry === 'false' && result === 'success' && published === 'true';
        check(evaluateGuard(mirror?.if, { cancelled, needs }) === expected, 'Mirror must require confirmed stable publication');
      }
    }
  }
  for (const outcome of ['success', 'failure', 'skipped']) for (const draft of ['true', 'false', '']) {
    for (const version of ['1.10.5', '1.10.5-beta.1']) {
      const context = { steps: { release: { outcome }, draft: { outputs: { value: draft } } }, needs: { prepare: { outputs: { version } } } };
      check(evaluateGuard(publish.outputs?.published, context) === (outcome === 'success' && draft === 'false' && !version.includes('-')),
        'Drafts and prereleases must not signal stable publication');
    }
  }
  const mirrorPayload = one(mirror, (step) => shell(step) === 'node scripts/release-payload.mjs mirror');
  const download = one(mirror, (step) => step.id === 'download');
  const deploy = one(mirror, (step) => /rsync /.test(shell(step)));
  const knownMutations = new Set([staging, ...uploads, notarize, intelNotarize, release, deploy]);
  const mutationSteps = allSteps.filter((step) => /gh\s+release\s+(create|upload|edit|delete)|release-state\.mjs prepare|notarytool submit|\brsync\b|\bssh\b/.test(shell(step)) ||
    String(step.uses ?? '').startsWith('softprops/action-gh-release@'));
  check(mutationSteps.length === knownMutations.size && mutationSteps.every((step) => knownMutations.has(step)),
    'Unexpected release mutation outside the validated gates');
  check(mirror.env?.REQUIRE_COMPLETE === 'true' && steps(mirror).indexOf(mirrorPayload) < steps(mirror).indexOf(deploy) &&
    mirrorPayload.if === undefined && deploy.if === undefined, 'Mirror must validate complete payload before deployment');
  check(download.if === undefined && steps(mirror).indexOf(download) < steps(mirror).indexOf(mirrorPayload) &&
    shell(download).includes('gh api "repos/$GITHUB_REPOSITORY/releases/tags/v$RELEASE_VERSION" --jq .published_at') &&
    shell(download).includes('published_at=%s\\n') &&
    mirrorPayload.env?.RELEASE_PUBLISHED_AT === '${{ steps.download.outputs.published_at }}',
    'Mirror must use the published release timestamp for deterministic retry bytes');
  check(/set -euo pipefail/.test(shell(deploy)) && /release-state\.mjs assert-published/.test(shell(deploy)) &&
    shell(deploy).indexOf('release-state.mjs assert-published') < shell(deploy).indexOf('ssh-keyscan') &&
    shell(deploy).includes('--files-from=artifacts/mirror-files.txt'), 'Mirror must recheck publication and use only the validated manifest');
  const deployment = shell(deploy);
  check(deployment.includes('REMOTE_ROOT=/opt/muster-downloads') &&
    deployment.includes('STAGE_NAME="$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"') &&
    deployment.includes('STAGE="$REMOTE_ROOT/.incoming/$STAGE_NAME"') &&
    deployment.includes('root.resolve() != root') && deployment.includes('incoming.resolve() != incoming') &&
    deployment.includes('-e "$SSH_OPTS" artifacts/ "tarun@$VPS_HOST:$STAGE/"') &&
    (deployment.match(/^\s*rsync /gm) ?? []).length === 1 && !/\bsudo\b/.test(deployment),
    'Mirror transfer must target unique staging below the existing public root');
  const promotion = 'python3 - --root \'$REMOTE_ROOT\' --candidate \'$STAGE\' --version \'$RELEASE_VERSION\' --sha \'$RELEASE_SHA\' --manifest-sha256 \'$MANIFEST_SHA256\'';
  check(deployment.includes('sha256sum artifacts/mirror-manifest.json') && deployment.includes(promotion) &&
    deployment.includes('< scripts/promote-release-mirror.py') &&
    deployment.indexOf(promotion) > deployment.indexOf('rsync -') &&
    (deployment.match(/^\s*ssh /gm) ?? []).length === 2,
    'Mirror promotion must validate transferred bytes and identity through the locked atomic helper');
  return { platformUploads: uploads.length, mutationSteps: mutationSteps.length };
}

export function readReleaseWorkflow(file) {
  return parse(readFileSync(file, 'utf8'), { uniqueKeys: true, maxAliasCount: 0 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify(verifyReleaseWorkflow(readReleaseWorkflow(process.argv[2] ?? '.github/workflows/release.yml'))));
  } catch (error) {
    console.error(`[release-workflow] ${error.message}`);
    process.exitCode = 1;
  }
}
