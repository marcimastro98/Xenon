'use strict';
// The Store widgets a pump screen can show as its face: installed, made for a pump
// (manifest `pump`, widget-sdk/manifest-normalize.js) and approved, with Store widgets on.
// The menu offers them as faces and Bit reads them in get_pump_screen. The face page
// checks the same again before it runs one (js/pump/pump-widget-host.js).

const MAX_WIDGETS = 24;
const NAME_MAX = 40;

// `packages`: the last checked package list (widget-sdk/scan-state.js); `settings`: the hub's.
function pumpWidgets(packages, settings) {
  const sdk = settings?.sdkWidgets || {};
  if (!sdk.enabled || settings?.safeMode === true) return [];
  const grants = sdk.grants && typeof sdk.grants === 'object' ? sdk.grants : {};
  const paused = new Set(Array.isArray(sdk.suspended) ? sdk.suspended : []);
  return (Array.isArray(packages) ? packages : [])
    .filter((p) => p && Array.isArray(p.pump) && p.pump.length && grants[p.id] && !paused.has(p.id))
    .slice(0, MAX_WIDGETS)
    .map((p) => ({ id: p.id, name: String(p.name || p.id).slice(0, NAME_MAX), shapes: [...p.pump] }));
}

// The list on this PC: the engine's last scan (refreshed on every install, update and
// Rescan), or one read of the widgets folder when nothing has scanned yet.
async function installedPumpWidgets() {
  const { sdkScan } = require('../widget-sdk/scan-state.js');
  const { readHubSettings } = require('../settings/read.js');
  let packages = sdkScan.cache.packages;
  if (!sdkScan.cache.at) {
    const { SDK_WIDGETS_DIR } = require('../widget-sdk/data-places.js');
    packages = (await require('../sdk-widgets.js').listPackages(SDK_WIDGETS_DIR).catch(() => null))?.packages || [];
  }
  return pumpWidgets(packages, await readHubSettings().catch(() => null));
}

module.exports = { pumpWidgets, installedPumpWidgets, MAX_WIDGETS };
