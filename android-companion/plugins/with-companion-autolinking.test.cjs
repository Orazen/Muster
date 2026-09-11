const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { test } = require('node:test');
const { withPlugins } = require('expo/config-plugins');
const withCompanionAutolinking = require('./with-companion-autolinking.cjs');
const { configureCompanionAutolinking } = withCompanionAutolinking;

// Relevant settings from the actual Expo 52 prebuild template. These are
// exercised through Expo's settings mod; native Gradle execution is a
// separate acceptance gate, not simulated by this test.
const prefix = String.raw`pluginManagement {
    includeBuild(new File(["node", "--print", "require.resolve('@react-native/gradle-plugin/package.json', { paths: [require.resolve('react-native/package.json')] })"].execute(null, rootDir).text.trim()).getParentFile().toString())
}
plugins { id("com.facebook.react.settings") }
rootProject.name = 'Muster Mobile'
apply from: new File(["node", "--print", "require.resolve('expo/package.json')"].execute(null, rootDir).text.trim(), "../scripts/autolinking.gradle");
`;
const suffix = "\n\ninclude ':app'\n";
const template = prefix + 'useExpoModules()' + suffix;
const expectedCall = "useExpoModules([searchPaths: [new File(rootDir, '../node_modules').absolutePath, new File(rootDir, '../node_modules/expo/node_modules').absolutePath]])";
const projectRoot = resolve(__dirname, '..');

async function runMod(contents, language = 'groovy', registrations = 1) {
  let config = { name: 'Muster Mobile', slug: 'muster-mobile', _internal: { projectRoot } };
  for (let i = 0; i < registrations; i++) config = withCompanionAutolinking(config);
  return config.mods.android.settingsGradle({
    ...config,
    modResults: { path: resolve(projectRoot, 'android/settings.gradle'), language, contents },
    modRequest: { projectRoot, platformProjectRoot: resolve(projectRoot, 'android'), platform: 'android', modName: 'settingsGradle', introspect: false },
  });
}

test('the app registers the local plugin through the real Expo plugin loader', () => {
  const app = JSON.parse(readFileSync(resolve(projectRoot, 'app.json'), 'utf8'));
  const registration = './plugins/with-companion-autolinking.cjs';
  assert.equal(app.expo.plugins.filter((plugin) => plugin === registration).length, 1);
  const config = withPlugins({ name: 'Muster Mobile', slug: 'muster-mobile', _internal: { projectRoot } }, [registration]);
  assert.equal(config.mods.android.settingsGradle.isProvider, false);
});

test('the real Expo settings mod adds cwd-independent paths while preserving the surrounding settings', async () => {
  const result = await runMod(template);
  assert.equal(result.modResults.contents, prefix + expectedCall + suffix);
  assert.equal(result.modResults.language, 'groovy');
  assert.equal(result.modResults.path, resolve(projectRoot, 'android/settings.gradle'));
  assert.equal(result.name, 'Muster Mobile');
  assert(!result.modResults.contents.includes(projectRoot), 'Generated settings must not embed this machine\'s checkout');
});

test('repeated mod application preserves byte-identical generated settings', async () => {
  const first = await runMod(template);
  const second = await runMod(first.modResults.contents, 'groovy', 2);
  assert.equal(second.modResults.contents, first.modResults.contents);
});

test('preserves Windows line endings, indentation and trailing whitespace', () => {
  const original = (prefix + '  useExpoModules()  ' + suffix).replaceAll('\n', '\r\n');
  const expected = (prefix + `  ${expectedCall}  ` + suffix).replaceAll('\n', '\r\n');
  assert.equal(configureCompanionAutolinking(original, 'groovy'), expected);
  assert.equal(configureCompanionAutolinking(expected, 'groovy'), expected);
});

test('ignores lookalikes in comments and quoted strings without modifying them', () => {
  const comments = "// useExpoModules()\n/*\nuseExpoModules()\n*/\ndef note = 'useExpoModules()'\ndef multiline = '''\nuseExpoModules()\n'''\n";
  assert.equal(configureCompanionAutolinking(comments + template, 'groovy'), comments + prefix + expectedCall + suffix);
});

for (const [name, input] of [
  ['missing call', prefix + suffix],
  ['line comment only', '// useExpoModules()\n'],
  ['block comment only', '/*\nuseExpoModules()\n*/\n'],
  ['quoted call only', "def note = '''\nuseExpoModules()\n'''\n"],
  ['duplicate original calls', template + '\nuseExpoModules()\n'],
  ['mixed original and configured calls', template + `\n${expectedCall}\n`],
  ['duplicate configured calls', `${expectedCall}\n${expectedCall}\n`],
]) {
  test(`rejects ${name} instead of reporting a configured template`, () => {
    assert.throws(() => configureCompanionAutolinking(input, 'groovy'), /exactly one useExpoModules invocation/);
  });
}

for (const call of [
  "useExpoModules([exclude: ['expo-camera']])",
  'useExpoModules(\n)',
  'useExpoModules() // custom options below',
  'useExpoModules();',
  'other.useExpoModules()',
]) {
  test(`refuses unsupported invocation ${JSON.stringify(call)}`, () => {
    assert.throws(() => configureCompanionAutolinking(prefix + call + suffix, 'groovy'), /unsupported useExpoModules/);
  });
}

test('the real Expo mod rejects Kotlin settings instead of applying a Groovy expression', async () => {
  await assert.rejects(runMod(template, 'kt'), /reviewed Groovy settings.gradle template/);
});

test('the real Expo mod propagates template failures and does not silently continue', async () => {
  await assert.rejects(runMod(prefix + 'useExpoModules([exclude: []])' + suffix), /unsupported useExpoModules/);
});
