// The folders the file index may walk: the ones the user saved, or this machine's default,
// minus on macOS the ones that would bring up permission dialogs nobody asked for.

const os = require('node:os');
const { POWERSHELL_SUPPORTED } = require('../powershell/supported.js');
const { macDiskAccess } = require('./mac-disk-access.js');
const { macRootReachesHome } = require('./mac-home-roots.js');

function usableIndexRoots(saved) {
  const platformDefault = POWERSHELL_SUPPORTED ? 'C:\\' : os.homedir();
  let roots;
  if (!Array.isArray(saved)) roots = [platformDefault];
  else if (!saved.length) roots = [];
  else {
    const usable = saved.filter((r) => (process.platform === 'win32'
      ? /^[A-Za-z]:\\/.test(String(r))
      : String(r).startsWith('/')));
    roots = usable.length ? usable : [platformDefault];
  }
  // The macOS gate, applied AFTER the default is resolved — the default IS the
  // home directory here, so gating before it would hand the home root straight
  // back. Without Full Disk Access, walking the home means Desktop, Documents,
  // Downloads, Pictures and Music, and macOS raises a permission dialog for
  // each, on every walk, forever. Those folders are unreadable either way; the
  // only thing the walk adds is the prompts.
  //
  // A root the user chose explicitly is left alone even when it is protected:
  // they pointed Xenon at that folder, so one dialog for that one folder is an
  // answer to a question they asked. What is dropped is only the root that
  // sweeps up folders nobody asked about.
  if (process.platform === 'darwin' && !macDiskAccess.granted) {
    const kept = roots.filter((r) => !macRootReachesHome(r));
    macDiskAccess.blockedRoots = roots.filter((r) => macRootReachesHome(r));
    return kept;
  }
  macDiskAccess.blockedRoots = [];
  return roots;
}

module.exports = { usableIndexRoots };
