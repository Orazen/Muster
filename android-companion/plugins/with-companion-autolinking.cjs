const { withSettingsGradle } = require('expo/config-plugins');

const originalCall = 'useExpoModules()';
const configuredCall = "useExpoModules([searchPaths: [new File(rootDir, '../node_modules').absolutePath, new File(rootDir, '../node_modules/expo/node_modules').absolutePath]])";

function configureCompanionAutolinking(contents, language) {
  if (language !== 'groovy') {
    throw new Error('Muster autolinking requires the reviewed Groovy settings.gradle template.');
  }
  // Ignore quoted text and comments when locating the call. Preserve offsets
  // so the replacement changes only the reviewed standalone invocation.
  const code = contents.replace(
    /"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g,
    (text) => text.replace(/[^\r\n]/g, ' '),
  );
  const calls = [...code.matchAll(/\buseExpoModules\s*\(/g)];
  if (calls.length !== 1) {
    throw new Error('Muster autolinking requires exactly one useExpoModules invocation. Review the generated settings.gradle.');
  }
  const start = calls[0].index;
  const lineStart = contents.lastIndexOf('\n', start - 1) + 1;
  const nextLine = contents.indexOf('\n', start);
  const line = contents.slice(lineStart, nextLine === -1 ? contents.length : nextLine).trim();
  if (line === configuredCall) return contents;
  if (line !== originalCall) {
    throw new Error('Muster autolinking found unsupported useExpoModules options or formatting. Review the generated settings.gradle.');
  }
  return contents.slice(0, start) + configuredCall + contents.slice(start + originalCall.length);
}

function withCompanionAutolinking(config) {
  return withSettingsGradle(config, (mod) => {
    // Gradle invokes Expo discovery from android/. Resolve the same two
    // package search paths against rootDir rather than the process cwd.
    mod.modResults.contents = configureCompanionAutolinking(mod.modResults.contents, mod.modResults.language);
    return mod;
  });
}

module.exports = withCompanionAutolinking;
module.exports.configureCompanionAutolinking = configureCompanionAutolinking;
