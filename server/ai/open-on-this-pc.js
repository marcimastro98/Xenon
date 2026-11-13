'use strict';

// Hands what Bit was asked to open to the system this PC runs: Windows, macOS or Linux.
// What may be opened is decided before, in ai-pc-apps.js; this only starts it.

const { execFile } = require('node:child_process');
const { psEscape } = require('../ps-quote.js');
const { openExternalPath } = require('../deck/open-external-path.js');

const TIMEOUT_MS = 10000;

/**
 * @param {typeof execFile} run @param {string} file @param {string[]} argv
 * @returns {Promise<void>} resolved when the program ended well
 */
function ended(run, file, argv) {
  return new Promise((resolve, reject) => {
    run(file, argv, { windowsHide: true, timeout: TIMEOUT_MS }, (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * The command that starts an app known by its name alone, where the system has one.
 * @param {string} name @param {string} platform
 * @returns {[string, string[]] | null}
 */
function byName(name, platform) {
  if (platform === 'darwin') return ['/usr/bin/open', ['-a', name]];
  // gtk-launch takes the name of the app's desktop entry, which is its name in lowercase for most apps.
  if (platform === 'linux') return ['gtk-launch', [name.toLowerCase().replace(/\s+/g, '-')]];
  return null;
}

/**
 * @param {{ target: string, kind: string }} allowed what ai-pc-apps.js let through
 * @param {{ platform?: string, run?: typeof execFile, open?: (target: string) => Promise<unknown> }} [deps] for tests
 * @returns {Promise<{ ok: boolean, error?: string }>} `error` is 'not_found' or 'not_on_this_system'
 */
async function openOnThisPc(allowed, { platform = process.platform, run = execFile, open = openExternalPath } = {}) {
  try {
    if (platform === 'win32') {
      // ShellExecute looks the name up in App Paths and the registered links, and fails for real when
      // there is nothing to start. Every quote PowerShell ends a single-quoted string on is escaped (ps-quote.js).
      const ps = `try{[void][System.Diagnostics.Process]::Start([System.Diagnostics.ProcessStartInfo]@{FileName='${psEscape(allowed.target)}';UseShellExecute=$true})}catch{exit 1}`;
      await ended(run, 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]);
      return { ok: true };
    }
    // A website or an app's own link goes to the program the system has for it.
    if (allowed.kind === 'url' || allowed.kind === 'protocol') { await open(allowed.target); return { ok: true }; }
    const command = allowed.kind === 'name' ? byName(allowed.target, platform) : null;
    // A path with a drive letter is a Windows path: there is nothing to open here.
    if (!command) return { ok: false, error: 'not_on_this_system' };
    await ended(run, command[0], command[1]);
    return { ok: true };
  } catch {
    return { ok: false, error: 'not_found' };
  }
}

module.exports = { openOnThisPc, byName };
