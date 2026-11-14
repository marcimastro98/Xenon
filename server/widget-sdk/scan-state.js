// The last checked list of installed widget packages, kept a short while for the paths asked
// often.

const sdkScan = {
  // Short-lived cache of the validated package scan, shared by the hot SDK paths
  // (fetch proxy, webhook ingress, deck macros) so they don't re-read manifests
  // from disk per request. GET /sdk/widgets always rescans and refreshes it.
  cache: { at: 0, packages: [], invalid: [] },
};

module.exports = { sdkScan };
