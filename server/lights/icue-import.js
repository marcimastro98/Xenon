'use strict';
// "Import from iCUE": the effect each light had in iCUE, brought onto the lights Xenon drives
// itself, for whoever leaves iCUE closed. Read from iCUE's own files on this PC (icue-profile.js),
// never sent anywhere, and offered only for a light that still follows Xenon, so a look set in
// Xenon is never overwritten by surprise. The profile is looked at again at most once a minute
// and read again only when it changed. iCUE keeps these files on Windows only.

const fs = require('node:fs/promises');
const path = require('node:path');
const { profileLooks } = require('./icue-profile.js');

const SPAN_MS = 60000;
// A device in an iCUE profile ("vid:pid") and the id Xenon gives the same device when it drives
// it itself: the iCUE LINK System Hub held by Airflow (airflow/link-lights.js DEVICE_ID).
const XENON_IDS = new Map([['1b1c:0c3f', 'corsair-link-hub']]);

/** @param {string|undefined} appData */
function icueDir(appData) { return appData ? path.join(appData, 'Corsair', 'CUE5') : null; }

/**
 * @param {{ dir: () => string|null, fs?: typeof fs, now?: () => number }} o
 */
function createIcueImport(o) {
  const io = o.fs || fs;
  const now = o.now || Date.now;
  let at = -Infinity;
  let seen = '';
  /** @type {{ usb: string, effect: string, look: any }[]} */
  let looks = [];
  /** @type {Promise<void>|null} */
  let running = null;

  // The profile iCUE starts with (config.cuecfg defaultProfile), else the newest one.
  async function profileFile(dir) {
    const profiles = path.join(dir, 'profiles');
    const config = await io.readFile(path.join(dir, 'config.cuecfg'), 'utf8').catch(() => '');
    const chosen = /<value name="defaultProfile">(\{[0-9a-fA-F-]{36}\})<\/value>/.exec(config);
    if (chosen) {
      const file = path.join(profiles, chosen[1] + '.cueprofiledata');
      const st = await io.stat(file).catch(() => null);
      if (st) return { file, st };
    }
    const names = (await io.readdir(profiles).catch(() => [])).filter((n) => n.endsWith('.cueprofiledata'));
    const found = await Promise.all(names.map(async (n) => ({ file: path.join(profiles, n), st: await io.stat(path.join(profiles, n)).catch(() => null) })));
    return found.filter((f) => f.st).sort((a, b) => b.st.mtimeMs - a.st.mtimeMs)[0] || null;
  }

  async function look() {
    const dir = o.dir();
    const found = dir ? await profileFile(dir) : null;
    if (!found) { looks = []; seen = ''; return; }
    const stamp = found.file + ':' + found.st.mtimeMs + ':' + found.st.size;
    if (stamp === seen) return;
    looks = profileLooks(await io.readFile(found.file, 'utf8'));
    seen = stamp;
  }

  /** Look at the profile again when the last look is old (force: now). Never throws. */
  function refresh(force = false) {
    if (!force && now() - at < SPAN_MS) return Promise.resolve();
    if (!running) {
      running = look().catch(() => { looks = []; seen = ''; }).finally(() => { at = now(); running = null; });
    }
    return running;
  }

  /**
   * The lights Xenon drives itself that still follow Xenon and had a look in iCUE.
   * @param {{ id: string, model?: string, mode?: string }[]} devices as the status lists them
   */
  function offer(devices) {
    const out = [];
    for (const entry of looks) {
      const id = XENON_IDS.get(entry.usb);
      const dev = id && devices.find((d) => d.id === id);
      if (dev && (dev.mode || 'follow') === 'follow' && !out.some((x) => x.id === id)) out.push({ id, name: dev.model || id, look: entry.look });
    }
    return out;
  }

  return { refresh, offer };
}

const icueImport = createIcueImport({ dir: () => (process.platform === 'win32' ? icueDir(process.env.APPDATA) : null) });

module.exports = { createIcueImport, icueImport, icueDir, XENON_IDS, SPAN_MS };
