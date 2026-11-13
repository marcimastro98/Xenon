// Finds out whether this system can press keys for a Deck key, and the reason when it cannot.

const fs = require('node:fs');
const { nativeCollectors } = require('../system/native-collectors.js');
const { POWERSHELL_SUPPORTED } = require('../powershell/supported.js');
const { HELPER_EXE } = require('../engine/paths.js');
const { runHelperOneShot } = require('../system/helper-one-shot.js');

async function _probeKeySend() {
  if (POWERSHELL_SUPPORTED) return { ok: true, reason: '' };
  if (process.platform === 'darwin') {
    if (!fs.existsSync(HELPER_EXE)) return { ok: false, reason: 'helper_missing' };
    try {
      // `keys --check` posts nothing — it only reports whether this helper
      // knows the mode and whether macOS has granted Accessibility. An older
      // helper exits non-zero on an unknown mode, which lands in the catch and
      // is reported as "cannot", exactly like every other staged mac feature.
      const r = await runHelperOneShot(['keys', '--check'], 4000);
      if (!r || r.ok !== true) return { ok: false, reason: 'helper_old' };
      return r.accessibility ? { ok: true, reason: '' } : { ok: false, reason: 'accessibility' };
    } catch { return { ok: false, reason: 'helper_old' }; }
  }
  if (nativeCollectors && typeof nativeCollectors.keysAvailable === 'function') {
    try { return (await nativeCollectors.keysAvailable()) ? { ok: true, reason: '' } : { ok: false, reason: 'no_key_tool' }; }
    catch { return { ok: false, reason: 'no_key_tool' }; }
  }
  return { ok: false, reason: 'unsupported' };
}

module.exports = { _probeKeySend };
