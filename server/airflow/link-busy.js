'use strict';
// Whether another program talks to the iCUE LINK hub. Two programs at once send the
// hub's fans to full speed and fight over its mode, so Airflow keeps its hands off the
// hub while one runs. Windows: iCUE (with iCUE quit, its CORSAIR services left a real
// hub alone, measured 22 Nov 2026; driver-link.js still steps aside if anything takes the
// hub back). Linux: OpenLinkHub. On Windows the native process table answers in a few
// milliseconds and starts no process, so the held hub can be checked every few seconds;
// tasklist (argv array, never a shell) stands in when the table cannot be read. A check that
// cannot run counts as busy, so a doubt never takes the hub.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { processKey } = require('../perf-session/process-names');

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

async function windowsBusy(run, table) {
  const rows = table ? await table.read().catch(() => null) : null;
  if (Array.isArray(rows) && rows.length) {
    const names = new Set(rows.map((r) => r.name));
    return WINDOWS_APPS.filter((app) => names.has(processKey(app)));
  }
  const tasks = await run('tasklist', ['/FO', 'CSV', '/NH']);
  if (!tasks.ok || !tasks.out) return ['unknown'];
  const lower = tasks.out.toLowerCase();
  return WINDOWS_APPS.filter((app) => lower.includes(`"${app.toLowerCase()}"`));
}

// `known` keeps a process's name once two looks agree (a new one still has its launcher's
// name until it execs), so a look every few seconds reads only what started since.
async function linuxBusy(fsp, root, known = new Map()) {
  let names;
  try { names = await fsp.readdir(root); } catch { return ['unknown']; }
  const pids = names.filter((n) => /^\d+$/.test(n)).slice(0, MAX_PIDS);
  const live = new Set(pids);
  for (const p of known.keys()) if (!live.has(p)) known.delete(p);
  const comms = await Promise.all(pids.map(async (p) => {
    const k = known.get(p);
    if (k?.settled) return k.comm;
    const comm = await fsp.readFile(path.join(root, p, 'comm'), 'utf8').then((s) => s.trim(), () => '');
    known.set(p, { comm, settled: k?.comm === comm });
    return comm;
  }));
  return LINUX_APPS.filter((app) => comms.some((c) => c.toLowerCase() === app.toLowerCase()));
}

/**
 * @param {{ platform?: string, run?: (file: string, args: string[]) => Promise<{ ok: boolean, out: string }>,
 *   fsp?: typeof fs.promises, procRoot?: string, table?: { read: () => Promise<Array<{ name: string }>|null> } }} [opts]
 *   table: the Windows process table (perf-session/process-table-windows.js)
 * @returns {() => Promise<string[]>} the programs in the way, [] when none
 */
function createLinkBusy({ platform = process.platform, run = runFile, fsp = fs.promises, procRoot = '/proc', table } = {}) {
  if (platform === 'win32') return () => windowsBusy(run, table);
  const known = new Map();
  if (platform === 'linux') return () => linuxBusy(fsp, procRoot, known);
  return async () => [];
}

module.exports = { createLinkBusy };
