const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { applyImagePolicy, upstreamTransformerPath } = require('./metro-image-policy.cjs');

// Each Metro worker has a separate module cache. A config-only policy would
// leave those processes using the original parser options.
applyImagePolicy();
const upstream = require(upstreamTransformerPath);
const policyBytes = readFileSync(require.resolve('./metro-image-policy.cjs'));

module.exports = {
  ...upstream,
  getCacheKey(...args) {
    return createHash('sha256')
      .update(upstream.getCacheKey(...args))
      .update(policyBytes)
      .update(readFileSync(__filename))
      .digest('hex');
  },
  transform(...args) {
    applyImagePolicy();
    return upstream.transform(...args);
  },
};
