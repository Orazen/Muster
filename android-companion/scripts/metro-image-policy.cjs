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

// The reviewed 1.2.1 detector advances through zero-sized boxes; the remaining
// ICNS/JXL loops occur in calculate(), after disableTypes is checked. Reassess
// both call order and parsers when changing this dependency stack.
if (versions.expoMetro !== '0.19.12' || versions.metro !== '0.81.5' || versions.imageSize !== '1.2.1') {
  throw new Error('Muster image policy requires review for the installed Expo/Metro/image-size versions.');
}

const disabledTypes = Object.freeze(['icns', 'heif', 'jxl', 'jxl-stream']);
function applyImagePolicy() {
  imageSize.disableTypes([...disabledTypes]);
}

module.exports = {
  applyImagePolicy,
  upstreamTransformerPath: configRequire.resolve('./transform-worker/transform-worker'),
};
