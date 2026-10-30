'use strict';
// macOS: `pmset -g batt` for the battery, `pmset -g` for Low Power Mode (and
// the newer powermode). Reading needs nothing; changing it needs an
// administrator (`sudo pmset`), so Xenon reads it and says where to change it.

const { execFile } = require('child_process');
const P = require('./parse.js');

const PMSET = '/usr/bin/pmset';
const RUN_TIMEOUT_MS = 3000;

function pmset(args) {
  return new Promise((resolve) => {
    execFile(PMSET, args, { timeout: RUN_TIMEOUT_MS }, (err, out) => resolve(err ? '' : String(out || '')));
  });
}

function available() { return true; }

async function read() {
  const [batt, all] = await Promise.all([pmset(['-g', 'batt']), pmset(['-g'])]);
  const battery = P.pmsetBattery(batt);
  const mode = P.pmsetMode(all);
  return { battery, saver: mode === 'saver', mode, modes: [], canSet: false, why: 'needs_admin' };
}

async function setMode() {
  return { ok: false, error: 'needs_admin' };
}

module.exports = { available, read, setMode };
