const { applyImagePolicy } = require('./scripts/metro-image-policy.cjs');

// Cover Metro's parent-side asset metadata/serving path as well as workers.
applyImagePolicy();
const { getDefaultConfig } = require('expo/metro-config');
const config = getDefaultConfig(__dirname);
config.transformerPath = require.resolve('./scripts/metro-transform-worker.cjs');

module.exports = config;
