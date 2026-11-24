'use strict';
// Whether another program talks to the iCUE LINK hub. Two programs at once send the
// hub's fans to full speed and fight over its mode, so Airflow keeps its hands off the
// hub while one runs. Windows: iCUE (with iCUE quit, its CORSAIR services left a real
// hub alone, measured 22 Nov 2026; driver-link.js still steps aside if anything takes the
// hub back). Linux: OpenLinkHub. Spawned with an argv array, never a shell; a check that
// cannot run counts as busy, so a doubt never takes the hub.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const WINDOWS_APPS = ['iCUE.exe'];
const LINUX_APPS = ['OpenLinkHub'];
const RUN_MS = 5000;
const MAX_PIDS = 4096;

function runFile(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: RUN_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve({ ok: !err || typeof err.code === 'number', out: String(stdout || '') });
    });
  });
}

async function windowsBusy(run) {
  const tasks = await run('tasklist', ['/FO', 'CSV', '/NH']);
  if (!tasks.ok || !tasks.out) return ['unknown'];
  const lower = tasks.out.toLowerCase();
  return WINDOWS_APPS.filter((app) => lower.includes(`"${app.toLowerCase()}"`));
}

async function linuxBusy(fsp, root) {
  let names;
  try { names = await fsp.readdir(root); } catch { return ['unknown']; }
  const pids = names.filter((n) => /^\d+$/.test(n)).slice(0, MAX_PIDS);
  const comms = await Promise.all(pids.map((p) => fsp.readFile(path.join(root, p, 'comm'), 'utf8').then((s) => s.trim(), () => '')));
  return LINUX_APPS.filter((app) => comms.some((c) => c.toLowerCase() === app.toLowerCase()));
}

/**
 * @param {{ platform?: string, run?: (file: string, args: string[]) => Promise<{ ok: boolean, out: string }>,
 *   fsp?: typeof fs.promises, procRoot?: string }} [opts]
 * @returns {() => Promise<string[]>} the programs in the way, [] when none
 */
function createLinkBusy({ platform = process.platform, run = runFile, fsp = fs.promises, procRoot = '/proc' } = {}) {
  if (platform === 'win32') return () => windowsBusy(run);
  if (platform === 'linux') return () => linuxBusy(fsp, procRoot);
  return async () => [];
}

module.exports = { createLinkBusy };
