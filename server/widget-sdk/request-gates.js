// How often one SDK widget may ask the server for a fetch, a hook or a store write: a short
// floor between requests, per package.

const sdkWidgets = require('../sdk-widgets.js');

// Per-package gate for the fetch proxy: a floor between requests plus a small
// concurrency cap, so one chatty widget can't turn the server into a scraper.
const _sdkFetchGate = new Map();   // pkgId → { last, inflight }
function sdkFetchGateAcquire(pkgId) {
  const g = _sdkFetchGate.get(pkgId) || { last: 0, inflight: 0 };
  if (g.inflight >= sdkWidgets.SDK_LIMITS.fetch.maxInFlight || Date.now() - g.last < 250) return null;
  g.last = Date.now();
  g.inflight++;
  _sdkFetchGate.set(pkgId, g);
  return () => { g.inflight = Math.max(0, g.inflight - 1); };
}

// Per-hook rate floor: a local script POSTing a hook in a tight loop can't turn
// one webhook into an SSE flood across every surface. Bounded (~64 keys) — hook
// ids come from validated manifests (≤32 packages × ≤8 hooks).
const _sdkHookGate = new Map();   // "pkg/hookId" → last accept ts
function sdkHookGateOk(key) {
  const now = Date.now();
  if (now - (_sdkHookGate.get(key) || 0) < 250) return false;
  if (_sdkHookGate.size > 512) _sdkHookGate.clear();   // hard bound against churn
  _sdkHookGate.set(key, now);
  return true;
}

// Per-package write-rate floor for the store/secret bridges — same shape as the
// fetch/hook gates: a chatty widget can't turn set() into a disk-write flood.
const _sdkStoreGate = new Map();   // pkgId → last-accept ts
function sdkStoreGateOk(pkgId) {
  const now = Date.now();
  if (now - (_sdkStoreGate.get(pkgId) || 0) < 100) return false;
  if (_sdkStoreGate.size > 512) _sdkStoreGate.clear();
  _sdkStoreGate.set(pkgId, now);
  return true;
}

module.exports = {
  _sdkFetchGate, sdkFetchGateAcquire, _sdkHookGate, sdkHookGateOk, _sdkStoreGate, sdkStoreGateOk,
};
