// Starts an application on Linux, where opening a program file with the desktop's "open" would
// show it as a document.

const { execFile, spawn } = require('node:child_process');

// Launch an application on Linux — the half of openApp that xdg-open cannot
// be: xdg-open OPENS a path with its mime handler, so a binary or a .desktop
// file handed to it is treated as a document (text editor, archive manager, or
// a refusal), never launched. A .desktop entry goes through `gio launch`,
// which parses Exec=/Terminal=/field codes per the spec (glib ships on every
// desktop that has .desktop files at all); an AppImage or a plain executable
// is spawned directly, detached, resolved on the 'spawn' event so ENOENT and
// a missing execute bit surface as clean errors instead of silent successes.
// The registry has already validated shape + existence before this runs.
function launchLinuxApp(p, args) {
  const target = String(p);
  const argv = Array.isArray(args) ? args.map(String) : [];
  if (/\.desktop$/i.test(target)) {
    return new Promise((resolve, reject) => {
      execFile('gio', ['launch', target], { timeout: 8000 }, (err) => {
        if (err) reject(err); else resolve({ ok: true });
      });
    });
  }
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(target, argv, { detached: true, stdio: 'ignore' });
    } catch (e) { reject(e); return; }
    child.once('error', (e) => reject(e));
    child.once('spawn', () => { child.unref(); resolve({ ok: true }); });
  });
}

module.exports = { launchLinuxApp };
