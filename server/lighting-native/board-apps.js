'use strict';
// Programs that paint a motherboard's lights themselves. One that quits hands the board's
// ARGB headers back to the board's own effect, while Xenon still thinks it holds them: its
// next frames land nowhere, and only the onboard zones (a whole effect per packet) change.
// Seen 23 Nov 2026 on a GIGABYTE IT5711 after iCUE, with its GIGABYTE plugin, was opened and
// closed: fans white, deaf to every colour and alert. And while one runs, both write the same
// controller: the lights flicker and its calls time out (seen 24 Nov 2026 after a reboot that
// started iCUE). So while Xenon drives a board, the process table is read every
// BOARD_APPS_EVERY_MS: when one of these programs starts `onCome` leaves the board to it, and
// when the last is gone `onGone` sets the board up again. Xenon never closes one. iCUE counts
// only with a motherboard plugin of its own (its plugins folder); without one it never touches
// the board. Windows reads the table in one native call (perf-session/process-table-windows.js,
// nothing is started); Linux reads /proc. A table that cannot be read changes nothing.

const fs = require('fs');
const path = require('path');
const { processKey } = require('../perf-session/process-names.js');

// Process names as processKey() writes them (lower case, no .exe).
const BOARD_APPS = Object.freeze({
  win32: Object.freeze(['icue', 'gcc', 'openrgb', 'signalrgb']),
  linux: Object.freeze(['openrgb']),
});
const BOARD_APPS_EVERY_MS = 15000;
// iCUE's plugins for motherboard lights, by folder name.
const ICUE_BOARD_PLUGIN = /^(gigabyte|msi|asus|asrock)/i;
const MAX_PIDS = 4096;

async function linuxNames(fsp, root) {
  let pids;
  try { pids = (await fsp.readdir(root)).filter((n) => /^\d+$/.test(n)).slice(0, MAX_PIDS); } catch { return null; }
  return Promise.all(pids.map((p) => fsp.readFile(path.join(root, p, 'comm'), 'utf8').then(processKey, () => '')));
}

/** The names of the running processes, or null when nobody could answer. */
function namesReader(platform, { fsp = fs.promises, procRoot = '/proc' } = {}) {
  if (platform === 'win32') {
    const rows = require('../perf-session/process-table-windows.js').createWindowsProcessTable();
    return async () => {
      const list = await rows.read();
      return list ? list.map((r) => r.name) : null;
    };
  }
  if (platform === 'linux') return () => linuxNames(fsp, procRoot);
  return null;
}

/** Whether an installed iCUE has a plugin that paints motherboards (Windows). A folder that
 * cannot be read says no: Xenon keeps the board, as before this check. */
async function icueBoardPlugin({ fsp = fs.promises, root = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Corsair') } = {}) {
  const dirs = await fsp.readdir(root).catch(() => []);
  for (const dir of dirs.filter((d) => /icue/i.test(d))) {
    const plugins = await fsp.readdir(path.join(root, dir, 'plugins')).catch(() => []);
    if (plugins.some((p) => ICUE_BOARD_PLUGIN.test(p))) return true;
  }
  return false;
}

/**
 * @param {{ onGone: (apps: string[]) => void, onCome?: (apps: string[]) => void, platform?: string,
 *   read?: (() => Promise<string[] | null>) | null, every?: number,
 *   icuePaints?: () => Promise<boolean> }} o
 */
function createBoardApps({
  onGone, onCome = () => {}, platform = process.platform, read, every = BOARD_APPS_EVERY_MS,
  icuePaints = icueBoardPlugin,
}) {
  const wanted = BOARD_APPS[platform] || [];
  const names = read !== undefined ? read : (wanted.length ? namesReader(platform) : null);
  let running = [];
  let timer = null;
  let checking = null;

  async function look() {
    const list = names ? await names().catch(() => null) : null;
    if (!list) return running;
    let now = wanted.filter((app) => list.includes(app));
    if (now.includes('icue') && !(await icuePaints().catch(() => false))) now = now.filter((app) => app !== 'icue');
    const gone = running.length && !now.length ? running : null;
    const came = !running.length && now.length ? now : null;
    running = now;
    if (gone) onGone(gone);
    if (came) onCome(came);
    return running;
  }

  // One look at a time: a slow table never stacks reads.
  function check() {
    if (!checking) checking = look().finally(() => { checking = null; });
    return checking;
  }

  return {
    check,
    start() {
      if (timer || !names) return;
      timer = setInterval(check, every);
      if (timer.unref) timer.unref();
      check();
    },
    stop() {
      clearInterval(timer);
      timer = null;
      running = [];
    },
    running: () => [...running],
  };
}

module.exports = { createBoardApps, namesReader, icueBoardPlugin, BOARD_APPS, BOARD_APPS_EVERY_MS };
