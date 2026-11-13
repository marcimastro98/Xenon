// What a widget saved and the keys it was given: one file per package, kept outside the
// package's folder, with a copy in memory.

const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR } = require('../engine/paths.js');
const { readJsonMapSync } = require('../files/read-json-map.js');
const { writeFileAtomic } = require('../atomic-write.js');

// ── SDK persistent store + secret vault (per-package, host-mediated) ─────────
// The sandbox denies widgets localStorage/cookies (opaque origin), so these two
// on-disk stores are their ONLY persistence — and they live OUTSIDE the package
// folder (server/data/widget-store, /widget-secrets), so the updater that
// overwrites server/data/widgets/<id>/ never touches user data, and an exported
// package (readPackagePayload only walks the package folder) can never ship a
// stored key. sdk-store.js holds the pure validation; here we add the fs +
// grant/rate gates. Small in-memory caches keep the hot get/set paths off disk;
// writes are atomic + change-driven.
const SDK_STORE_DIR = path.join(DATA_DIR, 'widget-store');
const SDK_SECRETS_DIR = path.join(DATA_DIR, 'widget-secrets');

const _sdkStoreCache = new Map();     // namespace → map (lazy, kept in sync on write)
const _sdkSecretCache = new Map();    // pkgId → map
// A namespace ('g:<group>' or '<pkgId>') → a Windows-safe filename. The colon in
// a group namespace is illegal on NTFS, so map by kind; both id halves are the
// [a-z0-9-] package-id charset, so the result is always a safe leaf name.
function sdkStoreFile(ns) {
  const s = String(ns || '');
  const leaf = s.startsWith('g:') ? 'group_' + s.slice(2) : 'pkg_' + s;
  return path.join(SDK_STORE_DIR, leaf + '.json');
}

function sdkStoreLoad(ns) {
  if (_sdkStoreCache.has(ns)) return _sdkStoreCache.get(ns);
  const map = readJsonMapSync(sdkStoreFile(ns));
  _sdkStoreCache.set(ns, map);
  return map;
}
async function sdkStoreSave(ns, map) {
  _sdkStoreCache.set(ns, map);
  try { await fs.promises.mkdir(SDK_STORE_DIR, { recursive: true }); await writeFileAtomic(sdkStoreFile(ns), JSON.stringify(map)); }
  catch { /* store is best-effort local data — never throw into the bridge */ }
}
function sdkSecretsLoad(pkgId) {
  if (_sdkSecretCache.has(pkgId)) return _sdkSecretCache.get(pkgId);
  const map = readJsonMapSync(path.join(SDK_SECRETS_DIR, pkgId + '.json'));
  _sdkSecretCache.set(pkgId, map);
  return map;
}
async function sdkSecretsSave(pkgId, map) {
  _sdkSecretCache.set(pkgId, map);
  try { await fs.promises.mkdir(SDK_SECRETS_DIR, { recursive: true, mode: 0o700 }); await writeFileAtomic(path.join(SDK_SECRETS_DIR, pkgId + '.json'), JSON.stringify(map)); }
  catch { /* best-effort */ }
}

module.exports = {
  SDK_STORE_DIR, SDK_SECRETS_DIR, _sdkStoreCache, _sdkSecretCache, sdkStoreFile, sdkStoreLoad,
  sdkStoreSave, sdkSecretsLoad, sdkSecretsSave,
};
