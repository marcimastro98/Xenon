'use strict';
// Pump screens plugged into this PC, found by their USB ids, so the Screens page can
// offer the one step that puts Xenon on them. Read only when the menu asks, at most
// once every few minutes; hid/ reads what each device declares and never opens one for
// writing. A pump Xenon can draw on itself (`direct`: a driver in lcd-*.js, see direct.js)
// is found on Windows and Linux; the others only on Windows, where their own programs
// (iCUE, NZXT CAM) are the way onto them. Not on macOS yet: hid/ writes no reports there.

const { panelOf } = require('./lcd-corsair.js');

const CACHE_MS = 10 * 60000;
const CORSAIR = 0x1b1c;
const NZXT = 0x1e71;

// The ids are facts about the hardware: CORSAIR iCUE LINK AIO LCD (seen on a real PC),
// NZXT Kraken Z3, Kraken Elite (2023) and Kraken (2023). A CORSAIR device that names
// itself an LCD counts too, for the screens of older Elite LCD coolers.
const KNOWN = Object.freeze([
  { vendorId: CORSAIR, productIds: [0x0c4e], brand: 'corsair', route: 'icue' },
  { vendorId: NZXT, productIds: [0x3008, 0x300c, 0x300e], brand: 'nzxt', route: 'cam' },
]);

function pumpOf(d) {
  const known = KNOWN.find((k) => k.vendorId === d.vendorId && k.productIds.includes(d.productId));
  const ids = { vendorId: d.vendorId, productId: d.productId, direct: !!panelOf(d.vendorId, d.productId) };
  if (known) return { brand: known.brand, route: known.route, ...ids };
  if (d.vendorId === CORSAIR && /\bLCD\b/i.test(d.product || '')) return { brand: 'corsair', route: 'icue', ...ids };
  return null;
}

/**
 * [{ brand, route, vendorId, productId, direct }], one per pump: a device lists one entry per
 * USB interface. onlyDirect: off Windows, where no vendor program is a way onto the others.
 */
function pumpsIn(devices, onlyDirect = false) {
  const seen = new Set();
  const out = [];
  for (const d of devices || []) {
    const pump = pumpOf(d);
    const key = d.vendorId + ':' + d.productId;
    if (!pump || seen.has(key) || (onlyDirect && !pump.direct)) continue;
    seen.add(key);
    out.push(pump);
  }
  return out;
}

function createPumpDetect({ hid = require('../hid/index.js'), platform = process.platform, clock = Date.now, warn = (_msg) => {} } = {}) {
  let found = [];
  let at = -Infinity;
  let pending = null;
  let warned = false;

  async function scan() {
    try {
      return pumpsIn(await hid.list({ vendorIds: [CORSAIR, NZXT] }), platform !== 'win32');
    } catch (e) {
      if (!warned) warn(`pump screens: the USB list could not be read (${e.message})`);
      warned = true;
      return found;
    }
  }

  return function detect() {
    if (!['win32', 'linux'].includes(platform) || !hid.available) return Promise.resolve([]);
    if (clock() - at < CACHE_MS) return Promise.resolve(found);
    if (!pending) {
      pending = scan().then((list) => {
        found = list;
        at = clock();
        pending = null;
        return list;
      });
    }
    return pending;
  };
}

module.exports = { createPumpDetect, pumpsIn, CACHE_MS };
