'use strict';
// Linux: the battery from /sys/class/power_supply, the power mode from
// power-profiles-daemon (`powerprofilesctl`, the switch GNOME and KDE show).
// Without the daemon there is no mode to read or change, and Xenon says so.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const P = require('./parse.js');

const SUPPLY_DIR = '/sys/class/power_supply';
const FIELDS = ['type', 'scope', 'capacity', 'status', 'online', 'power_now', 'energy_now', 'current_now', 'charge_now'];
const RUN_TIMEOUT_MS = 3000;
const MAX_SUPPLIES = 16;

async function readField(dir, name) {
  try { return (await fs.promises.readFile(path.join(dir, name), 'utf8')).trim(); } catch { return undefined; }
}

async function supplies(root) {
  let names = [];
  try { names = (await fs.promises.readdir(root)).slice(0, MAX_SUPPLIES); } catch { return []; }
  return Promise.all(names.map(async (n) => {
    const dir = path.join(root, n);
    const vals = await Promise.all(FIELDS.map((f) => readField(dir, f)));
    return Object.fromEntries(FIELDS.map((f, i) => [f, vals[i]]).filter(([, v]) => v !== undefined));
  }));
}

function ppd(args) {
  return new Promise((resolve) => {
    execFile('powerprofilesctl', args, { timeout: RUN_TIMEOUT_MS }, (err, out) => {
      if (err) resolve({ ok: false, missing: err.code === 'ENOENT' });
      else resolve({ ok: true, out: String(out || '') });
    });
  });
}

function available() { return true; }

async function read(opts) {
  const root = (opts && opts.root) || SUPPLY_DIR;
  const [list, prof] = await Promise.all([supplies(root), ppd(['list'])]);
  const battery = P.sysfsBattery(list);
  if (!prof.ok) return { battery, saver: false, mode: null, modes: [], canSet: false, why: 'no_daemon' };
  const { mode, modes } = P.ppdList(prof.out);
  return { battery, saver: mode === 'saver', mode, modes, canSet: modes.length > 1 };
}

async function setMode(mode) {
  const r = await ppd(['set', P.MODE_TO_PPD[mode]]);
  if (r.ok) return { ok: true };
  return { ok: false, error: r.missing ? 'no_daemon' : 'failed' };
}

module.exports = { available, read, setMode };
