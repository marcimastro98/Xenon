// What the engine does for the PC itself: turning the sensors on, locking the session and
// opening the macOS disk access settings.

const { runPowerShellScript } = require('../powershell/run-command.js');
const { ENABLE_SENSORS_SCRIPT } = require('./script-paths.js');
const { lockWorkstation } = require('./lock-workstation.js');
const { execFile } = require('node:child_process');

/** @type {Record<string, (req: any, res: any, context: any) => Promise<void>>} */
const branches = {
  'POST /system/enable-sensors': async (_req, _res, { json }) => {
    // One tap for `sensorAccess` 'needs_admin' or 'missing', or an outdated sensor
    // service: one UAC prompt installs LHM + PawnIO if missing and the sensor service.
    // Fixed argv, no request value reaches a command line; the prompt is the real
    // gate. POST-only, never JSONP, in CSRF_MUTATION_PATHS.
    try {
      const out = await runPowerShellScript(ENABLE_SENSORS_SCRIPT, [], 600000); // may install LHM + PawnIO first
      json(out && typeof out === 'object' ? out : { ok: false, status: 'failed', message: 'no result' });
    } catch (e) { json({ ok: false, status: 'failed', message: e.message }); }
  },

  'POST /lock': async (_req, _res, { json, err500 }) => {
    lockWorkstation().then(() => json({ ok: true }), e => err500(e.message));
  },

  'POST /macos/fda-settings': async (_req, _res, { json }) => {
    // Open the one System Settings pane the user needs. It exists because the
    // path there is four levels deep and its name differs per macOS version and
    // per language, so "go to Privacy & Security, scroll to Full Disk Access"
    // is instructions, not a fix. The URL is a fixed literal — nothing from the
    // request reaches the command line (spawn invariant).
    if (process.platform !== 'darwin') { json({ ok: false, error: 'unsupported' }); return; }
    try {
      execFile('open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'],
        { windowsHide: true }, () => {});
      json({ ok: true });
    } catch (e) { json({ ok: false, error: String(e.message || e) }); }
  },
};

module.exports = { branches };
