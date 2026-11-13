'use strict';
// Disk space: the folders that count as the user's temporary files.
//
// Only the user's own %TEMP%. C:\Windows\Temp is deliberately absent: the guard
// protects %WINDIR% outright, so classifying it produced a Clean button that
// always came back `protected:windir` (same reason the winUpdate category was
// retired, see disk-categories.js). The filter keeps that true even if %TEMP%
// itself ever resolves under Windows.
//
// Windows spells %TEMP% as a short name (C:\Users\LONGNA~1\AppData\Local\Temp)
// when the user's folder is longer than eight characters or holds a space,
// while the index and the file system give the same files their long path.
// With the short spelling kept, no file was ever "under" the temp folder, so
// the category stayed empty; and a folder named through it failed the junction
// test in diskspace.js (its real path differs) and was refused. So the folder
// is asked for under its real name, once, when Disk space is built. The real
// machine decides that, not a platform forced for a test: it is about how this
// disk spells the path.

const fs = require('node:fs');
const os = require('node:os');

/** @returns {string} the temp folder as the file system itself names it */
function realTempDir() {
  const dir = os.tmpdir();
  if (process.platform !== 'win32') return dir;
  try { return fs.realpathSync.native(dir); } catch { return dir; }
}

/**
 * @param {{ isWin: boolean, windir: string }} where the platform Disk space works as, and its Windows folder
 * @returns {string[]} the temp folders it may offer: none when %TEMP% is inside Windows
 */
function userTempDirs({ isWin, windir }) {
  return [realTempDir()].filter((d) => {
    if (!isWin) return !!d;
    const dl = String(d || '').toLowerCase();
    const wl = windir.toLowerCase().replace(/\\+$/, '');
    return dl !== wl && !dl.startsWith(wl + '\\');
  });
}

module.exports = { userTempDirs };
