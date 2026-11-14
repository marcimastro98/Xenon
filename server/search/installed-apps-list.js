// Lists the apps installed on this PC for the search, kept for a while and asked once at a
// time.

const {
  INSTALLED_APPS_TTL_MS, _enumStartMenuLnks, _enumStoreApps,
} = require('./installed-apps-windows.js');
const { listPosixApps } = require('../installed-apps.js');
const { _installedApps } = require('./spotlight-state.js');

function getInstalledApps() {
  const now = Date.now();
  if (now - _installedApps.at < INSTALLED_APPS_TTL_MS) return Promise.resolve(_installedApps.list);
  if (_installedApps.inflight) return _installedApps.inflight;
  // macOS and Linux: .app bundles and .desktop entries (installed-apps.js).
  // Off Windows this tier used to answer nothing, so an app's name found its
  // files and never the app.
  const enumerate = process.platform === 'win32'
    ? Promise.all([_enumStartMenuLnks(), _enumStoreApps()])
    : listPosixApps({ lang: String(process.env.LANG || '').slice(0, 2) }).then((apps) => [apps, []]);
  _installedApps.inflight = enumerate
    .then(([lnks, store]) => {
      // Same display name in both worlds (a Store app plus a desktop shortcut):
      // the Store entry wins — it launches even when the lnk is stale.
      const byName = new Map();
      for (const a of [...lnks, ...store]) byName.set(a.name.toLowerCase(), a);
      _installedApps.list = [...byName.values()];
      _installedApps.at = Date.now();
      _installedApps.inflight = null;
      return _installedApps.list;
    })
    .catch(() => { _installedApps.inflight = null; return _installedApps.list; });
  return _installedApps.inflight;
}

module.exports = { getInstalledApps };
