// Whether this computer can send key presses, why not when it cannot, and the sending of one
// key combination.

const { nativeCollectors } = require('../system/native-collectors.js');
const { POWERSHELL_SUPPORTED } = require('../powershell/supported.js');
const { DECK_HOTKEY_SCRIPT } = require('./script-paths.js');
const { runPowerShellScript } = require('../powershell/run-command.js');
const { runHelperOneShot } = require('../system/helper-one-shot.js');
const { keySend } = require('./key-send-state.js');
const { _probeKeySend } = require('./key-send-probe.js');

function refreshKeySendProbe() {
  _probeKeySend().then((r) => { keySend.probe = r; }).catch(() => { keySend.probe = { ok: false, reason: 'unsupported' }; });
}
// Synchronous read for the render/capability path. Before the first probe
// resolves it reports "not available", which is the safe direction: a button
// that appears a second late is fine, one that appears and fails is not.
function keySendAvailable() { return !!(keySend.probe && keySend.probe.ok); }
function keySendProblem() { return (keySend.probe && !keySend.probe.ok) ? keySend.probe.reason : ''; }

async function sendHotkeyCombo(keys) {
  if (POWERSHELL_SUPPORTED) {
    try {
      const r = await runPowerShellScript(DECK_HOTKEY_SCRIPT, ['-Keys', keys], 6000);
      return (r && r.ok === false) ? { ok: false, error: r.error || 'hotkey_failed' } : { ok: true };
    } catch { return { ok: false, error: 'hotkey_failed' }; }
  }
  if (process.platform === 'darwin') {
    try {
      const r = await runHelperOneShot(['keys', String(keys)], 6000);
      if (r && r.ok === false) {
        // A denied grant is worth re-probing: the user can grant it in System
        // Settings without restarting anything, and the capability flag should
        // follow rather than stay stale until the next boot.
        if (r.error === 'accessibility_denied') refreshKeySendProbe();
        return { ok: false, error: r.error || 'hotkey_failed' };
      }
      return { ok: true };
    } catch { return { ok: false, error: 'hotkey_unavailable' }; }
  }
  if (nativeCollectors && typeof nativeCollectors.sendKeys === 'function') {
    try { return await nativeCollectors.sendKeys(String(keys)); }
    catch { return { ok: false, error: 'hotkey_failed' }; }
  }
  return { ok: false, error: 'hotkey_unavailable' };
}

module.exports = { refreshKeySendProbe, keySendAvailable, keySendProblem, sendHotkeyCombo };
