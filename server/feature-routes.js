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
  require('./sensor-service/routes.js'),
  require('./app-strings/routes.js'),
  require('./ffmpeg-install/routes.js'),
]);

const ROUTES = new Map(FEATURES.flatMap((f) => Object.entries(f.routes)));

// The tables of the routes that left server.js's chain of tests. Every function
// of a table whose key names whole addresses ('GET /x', 'POST|GET /x',
// 'POST /x|/y') answers those addresses; a key that asks for a beginning
// ('GET /x/*') stays a test in server.js, in its place in the chain.
// The list is in the order server.js always loaded these files, and loading them
// is all it does for a file marked `inChain`: every test of that one still stands
// in server.js. tools/restructure/dispatch-move.mjs takes the mark off.
const inChain = (_loaded) => ({ branches: {} });
const TABLE_FILES = () => [
  require('./lights/routes.js'),
  require('./ticker/routes.js'),
  inChain(require('./deck/routes.js')),
  require('./ai/routes.js'),
  require('./claude-code/routes.js'),
  require('./audio/routes.js'),
  inChain(require('./updates/routes.js')),
  inChain(require('./performance/routes.js')),
  inChain(require('./system/routes.js')),
  require('./windows-tiles/routes.js'),
  inChain(require('./install/routes.js')),
  inChain(require('./widget-sdk/routes.js')),
  inChain(require('./engine/routes.js')),
  require('./screens/routes.js'),
  require('./discord/routes.js'),
  inChain(require('./search/routes.js')),
  inChain(require('./store-catalog/routes.js')),
  inChain(require('./store-supporters/routes.js')),
  inChain(require('./paired/routes.js')),
  require('./claude-code/routes-session.js'),
  require('./claude-code/routes-run.js'),
  inChain(require('./widget-sdk/routes-calls.js')),
  inChain(require('./widget-sdk/routes-packages.js')),
  require('./ai/routes-memory.js'),
  require('./ai/routes-voice.js'),
  require('./vitals/routes.js'),
  inChain(require('./transfer/routes.js')),
  inChain(require('./transfer/routes-phone.js')),
  inChain(require('./paired/routes-access.js')),
  inChain(require('./paired/routes-push.js')),
  inChain(require('./search/routes-files.js')),
  inChain(require('./disk/routes.js')),
  require('./smart-home/routes.js'),
  require('./lights/routes-control.js'),
  inChain(require('./updates/routes-update.js')),
  inChain(require('./remote-control/routes.js')),
  inChain(require('./deck/routes-keys.js')),
  inChain(require('./store-catalog/routes-packs.js')),
  inChain(require('./store-supporters/routes-unlock.js')),
  inChain(require('./performance/routes-mode.js')),
  require('./audio/routes-volume.js'),
  require('./time/routes.js'),
  require('./codex/routes.js'),
  require('./ticker/routes-lists.js'),
  require('./screens/routes-capture.js'),
  require('./windows-tiles/routes-tiles.js'),
  require('./look/routes.js'),
  require('./grid/routes.js'),
  inChain(require('./settings/routes.js')),
  require('./streaming/routes.js'),
  require('./media/routes.js'),
  require('./weather/routes.js'),
  require('./system/routes-info.js'),
  require('./notification-open/routes.js'),
  require('./widget-options/routes.js'),
  require('./menu/routes.js'),
  require('./alerts/routes.js'),
  require('./streaming/routes-twitch.js'),
  require('./streaming/routes-youtube.js'),
  require('./streaming/routes-spotify.js'),
  require('./ai/routes-dictation.js'),
  inChain(require('./smart-home/routes-cameras.js')),
  require('./screens/routes-captures.js'),
  require('./ambient/routes.js'),
  require('./ai/routes-local.js'),
  inChain(require('./widget-sdk/routes-images.js')),
  inChain(require('./settings/routes-save.js')),
  inChain(require('./mcp/routes-dev.js')),
];

const TABLES = new Map();
const WHOLE_ADDRESSES = /^([A-Z]+(?:\|[A-Z]+)?) (\/[^*|]*(?:\|\/[^*|]*)*)$/;

// Every 'METHOD /address' a table answers, with its function.
function tableRoutes(branches) {
  return Object.entries(branches).flatMap(([key, handler]) => {
    const found = WHOLE_ADDRESSES.exec(key);
    if (!found) return [];
    return found[1].split('|').flatMap((method) => found[2].split('|').map((address) => [`${method} ${address}`, handler]));
  });
}

// server.js calls this once, where it used to require the tables one by one, so
// every file still loads in the order it always did. Two functions for one
// address would be a route nobody can reach: the engine does not start with it.
function loadTables(files = TABLE_FILES()) {
  for (const file of files) {
    for (const [key, handler] of tableRoutes(file.branches)) {
      if (TABLES.has(key) || ROUTES.has(key)) throw new Error(`feature-routes.js: two functions answer ${key}`);
      TABLES.set(key, handler);
    }
  }
}

const has = (method, path) => ROUTES.has(`${method} ${path}`) || TABLES.has(`${method} ${path}`);

// Each handler writes its own answer and catches its own errors. `engine` holds
// the names of server.js a table's function is handed.
async function run(method, path, req, res, ctx, engine) {
  const handler = ROUTES.get(`${method} ${path}`) ?? TABLES.get(`${method} ${path}`);
  if (!handler) return false;
  await handler(req, res, ctx, engine);
  return true;
}

// At shutdown each feature stops what it started; one that throws does not
// keep the others running.
function stop() {
  for (const f of FEATURES) {
    try { if (typeof f.stop === 'function') f.stop(); } catch { /* best effort at shutdown */ }
  }
}

module.exports = { has, run, stop, loadTables, tableRoutes, keys: () => [...ROUTES.keys()], tableKeys: () => [...TABLES.keys()] };
