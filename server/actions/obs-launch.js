'use strict';
// Pure, injectable helpers for launching OBS Studio when a Deck OBS action is
// triggered while OBS isn't running. No side effects here — the registry read,
// the spawn, and the launch+retry orchestration live in server.js.
const path = require('path');

// The OBS executable under an install directory. '' for a falsy dir.
function obsExeFromDir(dir) {
  return dir ? path.join(dir, 'bin', '64bit', 'obs64.exe') : '';
}

const COMMON_OBS_DIRS = ['C:\\Program Files\\obs-studio', 'C:\\Program Files (x86)\\obs-studio'];

// True only when the error means OBS is unreachable (so we should launch it).
// A request that reached OBS but was rejected ('obs_request_failed', a comment)
// must NOT trigger a launch.
function isConnError(err) {
  const m = (err && err.message) || String(err == null ? '' : err);
  return /obs_connect_failed|obs_timeout|obs_closed/i.test(m);
}

// Find the OBS exe to launch. deps: { readInstallDir: async()->string|null,
// fileExists: (path)->bool }. Tries the registry-reported install dir (if any),
// then the common Program Files locations; returns the first candidate that is
// obs64.exe AND exists, else null. Always tries the common dirs, so a stale/empty
// registry value still finds a standard install. The obs64.exe check keeps us
// from launching an arbitrary path.
async function findObsExe(deps) {
  const d = deps || {};
  const dirs = [];
  try { const reg = await d.readInstallDir(); if (reg) dirs.push(reg); } catch (e) { /* ignore */ }
  for (const c of COMMON_OBS_DIRS) dirs.push(c);
  for (const dir of dirs) {
    const exe = obsExeFromDir(dir);
    if (exe && /obs64\.exe$/i.test(exe) && d.fileExists(exe)) return exe;
  }
  return null;
}

module.exports = { obsExeFromDir, COMMON_OBS_DIRS, isConnError, findObsExe };
