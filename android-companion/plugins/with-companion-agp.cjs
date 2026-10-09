const { withProjectBuildGradle } = require('expo/config-plugins');

const originalCoordinate = 'com.android.tools.build:gradle';
const configuredCoordinate = `${originalCoordinate}:8.7.3`;

function configureCompanionAgp(contents, language) {
  if (language !== 'groovy') {
    throw new Error('Muster AGP requires the reviewed Groovy project build.gradle template.');
  }
  // Match active invocations only. Retain offsets so comments, quoted text and
  // every setting except the dependency coordinate remain byte-identical.
  const code = contents.replace(
    /"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g,
    (text) => text.replace(/[^\r\n]/g, ' '),
  );
  const blocks = [...code.matchAll(/\bbuildscript\s*\{/g)];
  if (blocks.length !== 1) {
    throw new Error('Muster AGP requires exactly one buildscript block. Review the generated build.gradle.');
  }
  const blockLineStart = code.lastIndexOf('\n', blocks[0].index - 1) + 1;
  const rootDepth = [...code.slice(0, blocks[0].index).matchAll(/[{}]/g)].reduce((level, match) => level + (match[0] === '{' ? 1 : -1), 0);
  if (rootDepth !== 0 || !/^\s*buildscript\s*\{$/.test(code.slice(blockLineStart, blocks[0].index + blocks[0][0].length))) {
    throw new Error('Muster AGP requires the standalone project buildscript block.');
  }
  const buildStart = blocks[0].index + blocks[0][0].length;
  let buildEnd = buildStart;
  let depth = 1;
  for (; buildEnd < code.length && depth; buildEnd++) {
    if (code[buildEnd] === '{') depth++;
    if (code[buildEnd] === '}') depth--;
  }
  const dependencies = [...code.slice(buildStart, buildEnd - 1).matchAll(/\bdependencies\s*\{/g)];
  if (depth || dependencies.length !== 1) {
    throw new Error('Muster AGP requires one complete buildscript dependencies block.');
  }
  const dependencyDepth = [...code.slice(buildStart, buildStart + dependencies[0].index).matchAll(/[{}]/g)].reduce((level, match) => level + (match[0] === '{' ? 1 : -1), 0);
  if (dependencyDepth !== 0) throw new Error('Muster AGP requires direct buildscript dependencies.');
  const dependencyStart = buildStart + dependencies[0].index + dependencies[0][0].length;
  let dependencyEnd = dependencyStart;
  depth = 1;
  for (; dependencyEnd < buildEnd && depth; dependencyEnd++) {
    if (code[dependencyEnd] === '{') depth++;
    if (code[dependencyEnd] === '}') depth--;
  }
  if (depth) throw new Error('Muster AGP found an incomplete dependencies block.');

  // The reviewed template uses one literal classpath call per active line.
  // Refuse alternate dependency notation even beside a supported declaration.
  for (const line of code.slice(dependencyStart, dependencyEnd - 1).split(/\r?\n/)) {
    if (line.trim() && !/^\s*classpath\(\s*\)\s*$/.test(line)) {
      throw new Error('Muster AGP found an unsupported classpath dependency body. Review the generated build.gradle.');
    }
  }

  let selected;
  for (const call of code.matchAll(/\bclasspath\s*\(/g)) {
    const lineStart = contents.lastIndexOf('\n', call.index - 1) + 1;
    const nextLine = contents.indexOf('\n', call.index);
    const line = contents.slice(lineStart, nextLine === -1 ? contents.length : nextLine);
    const literal = line.match(/^\s*classpath\((['"])([^'"\r\n]+)\1\)\s*(?:\/\/[^\r\n]*)?\r?$/);
    const callDepth = [...code.slice(dependencyStart, call.index).matchAll(/[{}]/g)].reduce((level, match) => level + (match[0] === '{' ? 1 : -1), 0);
    if (call.index < dependencyStart || call.index >= dependencyEnd - 1 || callDepth !== 0 || !literal) {
      throw new Error('Muster AGP found an unsupported classpath invocation. Review the generated build.gradle.');
    }
    const coordinate = literal[2];
    if (coordinate === originalCoordinate || coordinate.startsWith(`${originalCoordinate}:`)) {
      if (selected) throw new Error('Muster AGP requires exactly one Android Gradle plugin dependency.');
      if (coordinate !== originalCoordinate && coordinate !== configuredCoordinate) {
        throw new Error('Muster AGP found a conflicting Android Gradle plugin version.');
      }
      selected = { coordinate, start: lineStart + line.indexOf(coordinate) };
    }
  }
  if (!selected) throw new Error('Muster AGP requires exactly one Android Gradle plugin dependency.');
  if (selected.coordinate === configuredCoordinate) return contents;
  return contents.slice(0, selected.start) + configuredCoordinate + contents.slice(selected.start + selected.coordinate.length);
}

function withCompanionAgp(config) {
  return withProjectBuildGradle(config, (mod) => {
    mod.modResults.contents = configureCompanionAgp(mod.modResults.contents, mod.modResults.language);
    return mod;
  });
}

module.exports = withCompanionAgp;
module.exports.configureCompanionAgp = configureCompanionAgp;
