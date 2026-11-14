'use strict';
// Whether macOS lets Xenon read the user's protected folders (Full Disk Access), and whether a
// folder is inside the home folder.

const fsp = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');

// ── Full Disk Access ────────────────────────────────────────────────────────
// Can THIS process read what macOS keeps behind Full Disk Access?
//
// It is asked because the answer decides whether the Living Index may walk the
// home directory. Without the grant that walk touches Desktop, Documents,
// Downloads, Pictures and Music, and macOS answers each one with a permission
// dialog -- so a first run, or any run after an update, buried the user under
// prompts for folders they never asked Xenon to look at. Measured here: five
// separate dialogs before the dashboard had finished starting.
//
// The probe is a real open() of a TCC-protected file, because that is the only
// thing that answers the question. `fs.access` tests POSIX bits, which say yes
// on a file TCC will refuse. And it is these files specifically because opening
// one NEVER prompts: Full Disk Access is granted by hand in System Settings and
// has no dialog, which is exactly what makes it safe to test. Probing ~/Desktop
// instead would raise the very prompt this exists to prevent.
//
// A grant is bound to the app's code signature, and Xenon's is ad-hoc, so its
// hash changes with every build: macOS silently drops the grant on every
// update. That is why this is re-asked while the server runs and not once at
// startup -- and why the user has to be TOLD, rather than left wondering why
// search went empty.
const FDA_PROBE_PATHS = [
  path.join(os.homedir(), 'Library/Application Support/com.apple.TCC/TCC.db'),
  '/Library/Application Support/com.apple.TCC/TCC.db',
];

// `probePaths` exists for the tests: a real refusal is the one state that
// cannot be arranged on a machine that HAS the grant (every child of a granted
// process inherits it), so the suite passes a chmod-000 file to exercise it.
async function fullDiskAccess(probePaths) {
  let refused = false;
  for (const probe of (Array.isArray(probePaths) ? probePaths : FDA_PROBE_PATHS)) {
    let handle = null;
    try {
      handle = await fsp.open(probe, 'r');
      return true;
    } catch (e) {
      // EPERM/EACCES is TCC saying no, and it is the only answer that proves
      // the grant is missing rather than the file.
      if (e && (e.code === 'EPERM' || e.code === 'EACCES')) refused = true;
    } finally {
      if (handle) { try { await handle.close(); } catch { /* ignore */ } }
    }
  }
  // Neither file was there to ask. Report the grant as present: switching the
  // index off on the strength of a file that does not exist would break a
  // working install on some future macOS, and the failure mode of being wrong
  // here is the prompts we already have, not lost data.
  return !refused;
}

// Does walking `root` reach the home directory, and so every folder macOS
// protects? Pure, and here rather than in server.js so it can be tested with a
// home directory that is not this machine's.
//
// It answers for ANCESTORS too ("/", "/Users"), which is the case a plain
// equality test misses: those walk the home just as thoroughly, and a user who
// points the index at "/" would otherwise get the full storm back. Comparison
// is case-SENSITIVE because it decides whether to WITHHOLD a root -- the loose
// form would withhold more, and withholding a root the user chose is the one
// mistake here that costs them a feature.
function rootReachesHome(root, home) {
  // Emptiness is checked BEFORE resolving: path.resolve('') returns the
  // process's current directory, so two empty inputs resolved to the same
  // string and compared EQUAL -- an unset root would have counted as "reaches
  // the home" and been withheld.
  const rawHome = String(home || '').trim();
  const rawRoot = String(root || '').trim();
  if (!rawHome || !rawRoot) return false;
  const h = path.resolve(rawHome);
  const r = path.resolve(rawRoot);
  if (r === h) return true;
  return h.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

module.exports = { FDA_PROBE_PATHS, fullDiskAccess, rootReachesHome };
