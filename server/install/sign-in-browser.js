'use strict';
// Hands the engine's own address to the user's browser at sign-in: one program, started with
// the address as its one argument, never through a shell.
//
// On Windows that program is explorer.exe, which passes the address to the desktop that is
// already running. Everything else the engine opens goes through PowerShell there
// (deck/open-external-path.js); a first PowerShell right after sign-in can take longer than
// its time limit, and the tab was lost with it. macOS and Linux keep `open` and `xdg-open`.

const { execFile } = require('node:child_process');
const path = require('node:path');
const { openExternalPath } = require('../deck/open-external-path.js');

// Only what sign-in-open.js builds from the engine's port. Nothing else is ever handed to
// explorer.exe here: given a path instead of an address, it would open that file.
const OWN_ADDRESS = /^http:\/\/127\.0\.0\.1:\d{1,5}\/$/;
const OPEN_TIMEOUT_MS = 15000;

// explorer.exe by its full path: a program of that name elsewhere on the PATH is never run.
function explorerExe(env) {
  const root = String(env.SystemRoot || env.windir || '');
  return path.win32.join(path.win32.isAbsolute(root) ? root : 'C:\\Windows', 'explorer.exe');
}

function openWithExplorer(url, run, env) {
  return new Promise((resolve, reject) => {
    // No `windowsHide`: explorer.exe has no console to hide, and a hidden start is a thing a
    // browser may copy for its own window.
    run(explorerExe(env), [url], { timeout: OPEN_TIMEOUT_MS }, (err) => {
      // explorer.exe ends with 1 even when it handed the address on, so a number is no
      // failure. Not starting at all (a code in letters) and running out of time are.
      if (err && (typeof err.code !== 'number' || err.killed)) reject(err); else resolve({ ok: true });
    });
  });
}

/**
 * @param {string} url the engine's own address (sign-in-open.js dashboardUrl)
 * @param {Record<string, string> | null} [session] variables of the desktop session to add to
 *   the engine's own for the browser (Linux, sign-in-linux.js display)
 * @param {{ platform?: NodeJS.Platform, run?: typeof execFile, env?: Record<string, string | undefined> }} [deps]
 *   for tests: the system to answer as, what starts a program, and the engine's environment
 * @returns {Promise<{ ok: boolean }>} rejects when the program did not start or did not end in time
 */
function openOwnAddress(url, session, { platform = process.platform, run = execFile, env = process.env } = {}) {
  if (typeof url !== 'string' || !OWN_ADDRESS.test(url)) return Promise.reject(new Error('not the engine address'));
  if (platform === 'win32') return openWithExplorer(url, run, env);
  const added = session && Object.keys(session).length ? { env: { ...env, ...session } } : {};
  return openExternalPath(url, undefined, { platform, run, ...added });
}

module.exports = { openOwnAddress };
