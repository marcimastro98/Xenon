'use strict';
// The fan drivers this PC gets, chosen once where the engine is built (index.js),
// as server/hid/index.js chooses its backend. Windows: the sensor service's hands
// (driver-lhm.js). Linux: hwmon (driver-hwmon.js) with its watchdog and the note
// of the values it found, kept in DATA_DIR. macOS: none; a laptop (laptop-windows.js,
// linuxLaptop below): the driver answers "laptop". Either way the machine drives its
// own fans and Airflow says so. Windows and Linux also get a CORSAIR iCUE LINK hub
// (driver-link.js), taken only while the person allows it (wanted); while it holds the
// hub, its lights join the lighting list (link-lights.js, lighting-native/held.js).
const fs = require('node:fs');
const path = require('node:path');
const { writeFileAtomic } = require('../files/atomic-write.js');

const HELD_FILE = 'airflow-held.json';
const HELD_MAX_BYTES = 256 * 1024;
const POWER_SUPPLY = '/sys/class/power_supply';

/**
 * A laptop on Linux: a power supply that is a battery of the system (a mouse or a
 * headset reports scope "Device"). Its firmware owns the fans.
 * @param {{ fsp?: typeof fs.promises, root?: string }} [opts]
 */
async function linuxLaptop({ fsp = fs.promises, root = POWER_SUPPLY } = {}) {
  let names = [];
  try { names = await fsp.readdir(root); } catch { return false; }
  for (const name of names) {
    const read = (f) => fsp.readFile(path.join(root, name, f), 'utf8').then((s) => s.trim(), () => '');
    if ((await read('type')) === 'Battery' && (await read('scope')) !== 'Device') return true;
  }
  return false;
}

/**
 * Where driver-hwmon.js keeps the values it found before writing, so a crash in the
 * same boot can put them back. Its own shape is checked by the driver.
 * @param {{ dataDir: string, fsp?: typeof fs.promises }} opts
 */
function heldNote({ dataDir, fsp = fs.promises }) {
  const file = path.join(dataDir, HELD_FILE);
  return {
    async saveHeld(o) {
      const text = JSON.stringify(o);
      if (text.length > HELD_MAX_BYTES) return false;
      await writeFileAtomic(file, text + '\n');
      return true;
    },
    async loadHeld() {
      try {
        const text = await fsp.readFile(file, 'utf8');
        return text.length > HELD_MAX_BYTES ? null : JSON.parse(text);
      } catch { return null; }
    },
  };
}

// A laptop answers "not here" before the driver is asked anything (read once).
function notOnLaptop(driver, laptop) {
  let isLaptop = null;
  return {
    ...driver,
    async available() {
      isLaptop ??= laptop().catch(() => false);
      return (await isLaptop) ? { ok: false, why: 'laptop' } : driver.available();
    },
  };
}

/**
 * Whether Xenon may take the LINK hub: allowed, not "the PC drives", and only while Airflow
 * works (watching, driving or the fan check). Taking it turns its lights off, so a look at
 * the menu with Airflow off never does.
 * @param {any} model the store's model @param {boolean} checking a fan check asked for or running
 */
function linkWanted(model, checking) {
  if (model?.options?.linkHub !== true || model.mode === 'pc') return false;
  return model.drive !== 'off' || checking;
}

// The LINK hub over this OS's USB reports (Windows reads give the report id first).
// The hub's lights join the lighting list while the driver holds it.
function hubLights() {
  const { createLinkLights } = require('./link-lights.js');
  const held = require('../lighting-native/held.js');
  const lights = createLinkLights({ onChange: held.changed, warn: (m) => console.warn(m) });
  held.addSource(lights);
  return lights;
}

function linkDriver(platform, wanted, lights) {
  const win = platform === 'win32';
  const { createLinkDriver } = require('./driver-link.js');
  const { createLinkBusy } = require('./link-busy.js');
  return createLinkDriver({
    hid: require(win ? '../hid/hid-windows.js' : '../hid/hid-linux.js'),
    openReports: require(win ? '../hid/hid-reports-windows.js' : '../hid/hid-reports-linux.js').openReports,
    leadingZero: win,
    busy: createLinkBusy({ platform, table: win ? require('../perf-session/process-table-windows.js').createWindowsProcessTable() : undefined }),
    wanted,
    lights,
  });
}

/**
 * @param {{ platform?: string, dataDir: string, laptop?: () => Promise<boolean>, wantLink?: () => boolean }} opts
 *   laptop: this OS's own test by default; wantLink: whether the person lets Xenon take a LINK hub
 * @returns {{ drivers: any[], none: string|null, stop: () => void, hubLights: () => string|null }}
 *   none: why this PC has no driver; hubLights: why a held LINK hub shows no lights, or null
 */
function driversFor({ platform = process.platform, dataDir, laptop = platform === 'win32' ? require('./laptop-windows.js').windowsLaptop : linuxLaptop, wantLink = () => false }) {
  if (platform !== 'win32' && platform !== 'linux') return { drivers: [], none: 'platform', stop: () => {}, hubLights: () => null };
  const lights = hubLights();
  const link = notOnLaptop(linkDriver(platform, wantLink, lights), laptop);
  if (platform === 'win32') {
    const lhm = notOnLaptop(require('./driver-lhm.js').createLhmDriver(), laptop);
    return { drivers: [lhm, link], none: null, stop: () => { lhm.close().catch(() => {}); }, hubLights: lights.why };
  }
  const { startWatchdog } = require('./watchdog.js');
  const { createHwmonDriver } = require('./driver-hwmon.js');
  const watchdog = startWatchdog();
  const hwmon = createHwmonDriver({ watchdog, ...heldNote({ dataDir }) });
  return { drivers: [notOnLaptop(hwmon, laptop), link], none: null, stop: () => watchdog.stop(), hubLights: lights.why };
}

module.exports = { driversFor, linuxLaptop, heldNote, notOnLaptop, linkWanted, HELD_FILE };
