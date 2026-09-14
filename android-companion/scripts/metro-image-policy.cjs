const { realpathSync } = require('node:fs');
const { createRequire } = require('node:module');

// Follow Expo's resolution chain so a nested Metro installation receives the
// same policy as a hoisted one. Asset plugins run after dimension parsing.
const expoRequire = createRequire(require.resolve('expo/metro-config'));
const configRequire = createRequire(expoRequire.resolve('@expo/metro-config'));
const assetsPath = configRequire.resolve('metro/src/Assets');
const assetsRequire = createRequire(assetsPath);
const imageSize = assetsRequire('image-size');
const versions = {
  expoMetro: expoRequire('@expo/metro-config/package.json').version,
  metro: configRequire('metro/package.json').version,
  imageSize: assetsRequire('image-size/package.json').version,
};
// `1.2.1` is the upstream API level this policy was reviewed against, not a
// publish: Metro's `image-size` is the owned copy in `vendor/image-size`,
// linked into `node_modules` as a workspace. Resolving through realpath means
// both the link and a direct path agree, and a registry install -- which would
// bring the unpatched ICNS/JXL/HEIF parsers back -- fails here instead.
const vendoredImageSize = /[\\/]vendor[\\/]image-size[\\/]/.test(realpathSync(assetsRequire.resolve('image-size')));

// disableTypes stays as a second gate: an asset renamed to `.png` is refused by
// name before any parser is consulted, and `disabled file type: <type>` is the
// message the asset verification depends on. Reassess all three versions and
// the parser source when changing this dependency stack.
if (versions.expoMetro !== '0.19.12' || versions.metro !== '0.81.5' || versions.imageSize !== '1.2.1' || !vendoredImageSize) {
  throw new Error('Muster image policy requires review: Metro must resolve the owned parser at vendor/image-size for the installed Expo/Metro versions.');
}

const disabledTypes = Object.freeze(['icns', 'heif', 'jxl', 'jxl-stream']);
function applyImagePolicy() {
  imageSize.disableTypes([...disabledTypes]);
}

module.exports = {
  applyImagePolicy,
  upstreamTransformerPath: configRequire.resolve('./transform-worker/transform-worker'),
};
