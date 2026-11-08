'use strict';
// The routes added since server.js stopped growing (structure-conventions.md
// §2 and §5): an explicit Map of exact `METHOD /path` to a feature's routes.js.
// server.js asks here only after its security gate (isAllowedRequest, the
// paired-device door, CSRF), which stays the authority for every path below:
// a mutating route still goes in CSRF_MUTATION_PATHS. Explicit requires, never
// readdir: the updater leaves old files on disk.

const FEATURES = Object.freeze([
  require('./net-path/routes.js'),
  require('./sensor-history/routes.js'),
]);

const ROUTES = new Map(FEATURES.flatMap((f) => Object.entries(f.routes)));

const has = (method, path) => ROUTES.has(`${method} ${path}`);

// Each handler writes its own answer and catches its own errors.
async function run(method, path, req, res, ctx) {
  const handler = ROUTES.get(`${method} ${path}`);
  if (!handler) return false;
  await handler(req, res, ctx);
  return true;
}

// At shutdown each feature stops what it started; one that throws does not
// keep the others running.
function stop() {
  for (const f of FEATURES) {
    try { if (typeof f.stop === 'function') f.stop(); } catch { /* best effort at shutdown */ }
  }
}

module.exports = { has, run, stop, keys: () => [...ROUTES.keys()] };
