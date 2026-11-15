'use strict';
// Where things are on this machine: the platform the rules run under, how two paths compare,
// and the home, system, temp, trash and container folders.

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { userTempDirs } = require('./temp-dirs.js');
const { parseXdgUserDirs } = require('./xdg-user-dirs.js');

function makeMachinePlaces({ o }) {
  // Every machine path is resolved ONCE here and passed into the two pure
  // modules; neither of them touches fs or the environment. The platform is
  // passed explicitly rather than left to each module's process.platform
  // default, so the value the rules ran under is always visible at the call
  // site (and pinnable in tests).
  // Overridable so the POSIX branches can be exercised from a Windows test run
  // and vice versa. The two pure modules take the same option for the same
  // reason: the alternative is a suite that silently skips half of itself and
  // leaves the user's Mac as the first machine ever to run this code. Only the
  // BRANCHING follows it — os.homedir()/os.tmpdir() still answer for the real
  // machine, so a forced platform exercises the decisions, not the layout.
  const PLATFORM = o.platform || process.platform;
  const IS_WIN = PLATFORM === 'win32';
  const IS_MAC = PLATFORM === 'darwin';

  // ── path comparison ───────────────────────────────────────────────────────
  // The same doctrine the two pure modules follow, stated once here because
  // this file compares paths in six places and every one of them was written
  // with a hard-coded '\\'. Off Windows that separator appears in no path, so
  // each of those tests silently answered "no" forever: the classified-ancestor
  // skip stopped skipping (a cache dir and its child both became items and the
  // category counted the same bytes twice) and browse minted no ids at all.
  // On Windows separators and case both fold; on POSIX neither does — a
  // backslash is a legal filename character there.
  const SEP = IS_WIN ? '\\' : '/';
  const cmpKey = (p) => {
    const raw = String(p == null ? '' : p);
    return IS_WIN ? raw.replace(/\//g, '\\').toLowerCase() : raw;
  };
  // Trailing separators go, except a POSIX root, which IS its separator.
  const trimSep = (p) => {
    const raw = String(p == null ? '' : p);
    if (IS_WIN) return raw.replace(/[\\/]+$/, '');
    return raw === '/' ? raw : raw.replace(/\/+$/, '');
  };
  // Strictly below — equality is the caller's business, because the two cases
  // are not always allowed to be wrong in the same direction. Both arguments
  // must already have been through cmpKey.
  const isBelow = (child, ancestor) => {
    if (!ancestor || !child) return false;
    if (!IS_WIN && ancestor === '/') return child !== '/' && child.startsWith('/');
    return child.startsWith(ancestor + SEP);
  };

  const userProfile = os.homedir();
  const localAppData = process.env.LOCALAPPDATA || path.join(userProfile, 'AppData', 'Local');
  const windir = IS_WIN ? (process.env.WINDIR || 'C:\\Windows') : '';
  const programFiles = IS_WIN ? (process.env.ProgramFiles || 'C:\\Program Files') : '';
  const programFilesX86 = IS_WIN ? (process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)') : '';
  // The user's own %TEMP% under its full name, never C:\Windows\Temp: the
  // reasons are in disk-space/temp-dirs.js.
  const tempDirs = userTempDirs({ isWin: IS_WIN, windir });
  // ── the localised user directories (Linux) ────────────────────────────────
  // xdg-user-dirs writes the REAL directory names into ~/.config/user-dirs.dirs,
  // and on a non-English desktop they are localised: an Italian install has
  // ~/Documenti and ~/Scrivania, not ~/Documents and ~/Desktop. Guarding only
  // the English names would leave the user's actual documents unprotected,
  // which is the one mistake this module exists to prevent. Read once at
  // construction (boot, not a request path) and used only to ADD protected
  // prefixes — the English defaults stay guarded whether or not they exist.
  function readXdgUserDirs() {
    if (IS_WIN || IS_MAC) return {};   // macOS keeps English names on disk and localises only the display
    try {
      const cfg = path.join(process.env.XDG_CONFIG_HOME || path.join(userProfile, '.config'), 'user-dirs.dirs');
      return parseXdgUserDirs(fs.readFileSync(cfg, 'utf8'), userProfile);
    } catch { /* no xdg-user-dirs: the English defaults are all there is */ }
    return {};
  }
  const xdgDirs = readXdgUserDirs();

  const downloads = xdgDirs.download || path.join(userProfile, 'Downloads');
  // Defaults; a relocated Documents (OneDrive) is additionally covered by
  // protecting the OneDrive root itself when the env names one.
  const known = (n) => path.join(userProfile, n);
  // The user's own Trash, the POSIX counterpart of $Recycle.Bin. macOS keeps
  // one per volume (`/Volumes/X/.Trashes/<uid>`); only the home one is listed
  // here because that is the only one the categories offer, and the widget's
  // "empty" is the helper's job either way.
  const trashDirs = IS_WIN ? []
    : IS_MAC ? [path.join(userProfile, '.Trash')]
      : [path.join(process.env.XDG_DATA_HOME || path.join(userProfile, '.local', 'share'), 'Trash')];

  // ── container directories: the contents are disposable, the folder is not ──
  // %TEMP% is the case that matters. Windows and every running app resolve that
  // path from the environment, so recycling the FOLDER would be a real breakage
  // — and it never even got that far: one file held open by any running app
  // makes SHFileOperation refuse the whole folder, so the category reported the
  // same 9.42 GB after every attempt with nothing moved. A container is
  // therefore never an item; its children are, so a locked child refuses on its
  // own and everything else is freed.
  // Xcode's DerivedData is the same shape of thing on macOS: the children are
  // disposable, the folder is one Xcode expects to find.
  const containerDirs = new Set(
    [...tempDirs, ...(IS_MAC ? [path.join(userProfile, 'Library', 'Developer', 'Xcode', 'DerivedData')] : [])]
      .map((d) => String(d).toLowerCase().replace(/[\\/]+$/, '')),
  );

  // OneDrive is guarded as an extra protected prefix via a tiny wrapper.
  const oneDrive = IS_WIN ? (process.env.OneDrive || '') : '';

  return {
    PLATFORM, IS_WIN, IS_MAC, SEP, cmpKey, trimSep, isBelow, userProfile, localAppData, windir,
    programFiles, programFilesX86, tempDirs, xdgDirs, downloads, known, trashDirs, containerDirs,
    oneDrive,
  };
}

module.exports = { makeMachinePlaces };
