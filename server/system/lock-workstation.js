// Locks the session: the one call the Deck action, Bit, the lock endpoint and the idle lock all
// use.

const { execFile } = require('node:child_process');
const { nativeCollectors } = require('./native-collectors.js');

// Lock the session. Single source of truth for the lock call, shared by the
// Deck lockWorkstation action, the AI lock_pc tool, the /lock endpoint and the
// idle auto-lock flow. execFile with an argv array — never a shell string.
function lockWorkstation() {
  // Locking is per-platform in a way no single command spans, so it goes
  // through the collector seam like every other such reading — this used to
  // branch here on process.platform and pointed macOS at a CGSession binary the
  // OS has since removed, which is exactly the drift the seam exists to stop.
  if (nativeCollectors) return nativeCollectors.lock();
  return new Promise((resolve, reject) => {
    execFile('rundll32.exe', ['user32.dll,LockWorkStation'], { windowsHide: true }, (err) => {
      if (err) reject(err); else resolve();
    });
  });
}

module.exports = { lockWorkstation };
