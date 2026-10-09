const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { test } = require('node:test');
const { withPlugins } = require('expo/config-plugins');
const withCompanionAgp = require('./with-companion-agp.cjs');
const { configureCompanionAgp } = withCompanionAgp;

// Actual Expo SDK 52 project template settings. This exercises Expo's mod,
// while Gradle resolution and native execution remain separate gates.
const prefix = `// Top-level build file where you can add configuration options common to all sub-projects/modules.

buildscript {
    ext {
        buildToolsVersion = findProperty('android.buildToolsVersion') ?: '35.0.0'
        minSdkVersion = Integer.parseInt(findProperty('android.minSdkVersion') ?: '24')
        compileSdkVersion = Integer.parseInt(findProperty('android.compileSdkVersion') ?: '35')
        targetSdkVersion = Integer.parseInt(findProperty('android.targetSdkVersion') ?: '34')
        kotlinVersion = findProperty('android.kotlinVersion') ?: '1.9.25'
        ndkVersion = "26.1.10909125"
    }
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
`;
const originalCall = "        classpath('com.android.tools.build:gradle')";
const pinnedCall = "        classpath('com.android.tools.build:gradle:8.7.3')";
const suffix = `
        classpath('com.facebook.react:react-native-gradle-plugin')
        classpath('org.jetbrains.kotlin:kotlin-gradle-plugin')
    }
}

apply plugin: "com.facebook.react.rootproject"

allprojects {
    repositories {
        google()
        mavenCentral()
        maven { url 'https://www.jitpack.io' }
    }
}
`;
const template = prefix + originalCall + suffix;
const projectRoot = resolve(__dirname, '..');

async function runMod(contents, language = 'groovy', registrations = 1) {
  let config = { name: 'Muster Mobile', slug: 'muster-mobile', _internal: { projectRoot } };
  for (let i = 0; i < registrations; i++) config = withCompanionAgp(config);
  return config.mods.android.projectBuildGradle({
    ...config,
    modResults: { path: resolve(projectRoot, 'android/build.gradle'), language, contents },
    modRequest: { projectRoot, platformProjectRoot: resolve(projectRoot, 'android'), platform: 'android', modName: 'projectBuildGradle', introspect: false },
  });
}

test('the app registers the AGP plugin through the real Expo loader', () => {
  const app = JSON.parse(readFileSync(resolve(projectRoot, 'app.json'), 'utf8'));
  const registration = './plugins/with-companion-agp.cjs';
  assert.equal(app.expo.plugins.filter((plugin) => plugin === registration).length, 1);
  const config = withPlugins({ name: 'Muster Mobile', slug: 'muster-mobile', _internal: { projectRoot } }, [registration]);
  assert.equal(config.mods.android.projectBuildGradle.isProvider, false);
});

test('the real Expo mod changes only the AGP coordinate, preserving all settings and other dependencies', async () => {
  const result = await runMod(template);
  assert.equal(result.modResults.contents, prefix + pinnedCall + suffix);
  assert.equal(result.modResults.path, resolve(projectRoot, 'android/build.gradle'));
  assert.equal(result.modResults.language, 'groovy');
  assert.equal(result.name, 'Muster Mobile');
  assert(!result.modResults.contents.includes(projectRoot));
});

test('repeated mod application is byte-identical', async () => {
  const first = await runMod(template);
  const second = await runMod(first.modResults.contents, 'groovy', 2);
  assert.equal(second.modResults.contents, first.modResults.contents);
});

test('preserves double quotes, CRLF, indentation and trailing comments', () => {
  const call = '  classpath("com.android.tools.build:gradle")  // keep this comment';
  const original = (prefix + call + suffix).replaceAll('\n', '\r\n');
  const expected = original.replace('com.android.tools.build:gradle"', 'com.android.tools.build:gradle:8.7.3"');
  assert.equal(configureCompanionAgp(original, 'groovy'), expected);
  assert.equal(configureCompanionAgp(expected, 'groovy'), expected);
});

test('ignores comments and quoted classpath lookalikes without modifying them', () => {
  const comments = "// classpath('com.android.tools.build:gradle:8.6.0')\n/*\nbuildscript { dependencies { classpath('com.android.tools.build:gradle') } }\n*/\ndef note = \"classpath('com.android.tools.build:gradle')\"\ndef multiline = '''\nclasspath('com.android.tools.build:gradle')\n'''\n";
  assert.equal(configureCompanionAgp(comments + template, 'groovy'), comments + prefix + pinnedCall + suffix);
});

for (const [name, input] of [
  ['missing AGP dependency', prefix + suffix],
  ['comment-only AGP dependency', prefix + '// ' + originalCall + suffix],
  ['duplicate unversioned dependencies', prefix + originalCall + '\n' + originalCall + suffix],
  ['duplicate pinned dependencies', prefix + pinnedCall + '\n' + pinnedCall + suffix],
  ['mixed pinned and unversioned dependencies', prefix + pinnedCall + '\n' + originalCall + suffix],
]) {
  test(`rejects ${name}`, () => {
    assert.throws(() => configureCompanionAgp(input, 'groovy'), /exactly one Android Gradle plugin dependency/);
  });
}

for (const version of ['8.6.0', '8.7.0', '8.7.+', '$agpVersion', '8.7.3@jar']) {
  test(`rejects conflicting version ${JSON.stringify(version)}`, () => {
    assert.throws(() => configureCompanionAgp(prefix + originalCall.replace("gradle'", `gradle:${version}'`) + suffix, 'groovy'), /conflicting Android Gradle plugin version/);
  });
}

for (const call of [
  'classpath(agpDependency)',
  "classpath('com.android.tools.build:gradle', 'other')",
  "classpath(\n'com.android.tools.build:gradle')",
  "classpath 'com.android.tools.build:gradle'",
  "other.classpath('com.android.tools.build:gradle')",
  "classpath('com.android.tools.build:gradle');",
]) {
  test(`refuses unsupported invocation ${JSON.stringify(call)}`, () => {
    assert.throws(() => configureCompanionAgp(prefix + call + suffix, 'groovy'), /unsupported classpath|exactly one Android Gradle plugin dependency/);
  });
}

test('refuses dynamic classpaths even alongside an otherwise valid AGP declaration', () => {
  assert.throws(() => configureCompanionAgp(prefix + originalCall + '\nclasspath(customDependency)' + suffix, 'groovy'), /unsupported classpath/);
});

for (const call of [
  "classpath 'com.android.tools.build:gradle:8.8.0'",
  "classpath 'com.android.tools.build:gradle:8.7.3'",
  'classpath customDependency',
  "add('classpath', 'com.android.tools.build:gradle:8.8.0')",
]) {
  for (const position of ['before', 'after']) {
    test(`refuses mixed unsupported dependency ${JSON.stringify(call)} ${position} the valid declaration`, () => {
      const calls = position === 'before' ? `${call}\n${originalCall}` : `${originalCall}\n${call}`;
      assert.throws(() => configureCompanionAgp(prefix + calls + suffix, 'groovy'), /unsupported classpath/);
    });
  }
}

test('preserves dependency-body comments around supported literal declarations', () => {
  const comments = "// classpath 'com.android.tools.build:gradle:8.8.0'\n/* add('classpath', 'com.android.tools.build:gradle:8.8.0') */\n";
  assert.equal(configureCompanionAgp(prefix + comments + originalCall + suffix, 'groovy'), prefix + comments + pinnedCall + suffix);
});

test('refuses a classpath outside the buildscript dependency block', () => {
  assert.throws(() => configureCompanionAgp(prefix + suffix + '\n' + originalCall, 'groovy'), /unsupported classpath/);
});

test('refuses missing, duplicate or incomplete buildscript blocks', () => {
  for (const input of ['', template + '\nbuildscript {}', template.replace('buildscript {', 'buildscript ')]) {
    assert.throws(() => configureCompanionAgp(input, 'groovy'), /exactly one buildscript/);
  }
  assert.throws(() => configureCompanionAgp(prefix + originalCall, 'groovy'), /complete buildscript dependencies/);
});

test('refuses ambiguous dependency blocks', () => {
  assert.throws(() => configureCompanionAgp(template.replace('    dependencies {', '    dependencies {}\n    dependencies {'), 'groovy'), /complete buildscript dependencies/);
});

test('refuses nested or qualified buildscript invocations', () => {
  assert.throws(() => configureCompanionAgp('if (enabled) {\n' + template + '}\n', 'groovy'), /standalone project buildscript/);
  assert.throws(() => configureCompanionAgp(template.replace('buildscript {', 'other.buildscript {'), 'groovy'), /standalone project buildscript/);
});

test('refuses dependency blocks nested inside an unrelated buildscript closure', () => {
  assert.throws(() => configureCompanionAgp(template.replace('    dependencies {', '    custom {\n    dependencies {').replace('apply plugin:', '}\napply plugin:'), 'groovy'), /direct buildscript dependencies/);
});

test('refuses classpaths nested inside another dependency closure', () => {
  assert.throws(() => configureCompanionAgp(prefix + 'constraints {\n' + originalCall + '\n}' + suffix, 'groovy'), /unsupported classpath/);
});

test('the real Expo mod rejects Kotlin and propagates conflicting versions', async () => {
  await assert.rejects(runMod(template, 'kt'), /reviewed Groovy project build.gradle template/);
  await assert.rejects(runMod(template.replace("gradle'", "gradle:8.6.0'")), /conflicting Android Gradle plugin version/);
});
