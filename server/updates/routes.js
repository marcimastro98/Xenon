// What the engine answers about its version and the install of the app window.

const { APP_VERSION } = require('./app-version.js');
const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR } = require('../engine/paths.js');
const { readPwshJson } = require('../powershell/read-json.js');

/** @type {Record<string, (req: any, res: any, context: any) => Promise<void>>} */
const branches = {
  'GET /version': async (_req, _res, { json }) => {
    // `platform` so the dashboard can stop prescribing Windows remedies to
    // machines that have no Windows. Several hints named LibreHardwareMonitor
    // and told the user to "re-run INSTALL.bat" — a file that does not exist on
    // macOS or Linux, for a dependency those platforms do not use. The value is
    // Node's own, so the client never has to guess from a user agent.
    json({ version: APP_VERSION, platform: process.platform });
  },

  'GET /api/native/status': async (_req, _res, { json, err500 }) => {
    // Which surface the user set up (native kiosk vs iCUE), so the dashboard can
    // offer to install the native app when running on iCUE/browser. Reads the
    // installer's marker in DATA_DIR (never HTTP-reachable); absent => 'unknown'.
    try {
      let mode = 'unknown';
      try {
        const raw = await fs.promises.readFile(path.join(DATA_DIR, 'install-mode.json'), 'utf8');
        const m = JSON.parse(raw);
        if (m && (m.mode === 'native' || m.mode === 'icue')) mode = m.mode;
      } catch { /* no marker yet -> unknown */ }
      // 'installed' must reflect the app actually on disk, NOT just the chosen-
      // surface marker: uninstalling the native app leaves the marker as 'native',
      // so keying the promo off the marker alone kept it hidden after an uninstall.
      // The kiosk installs per-user to %LOCALAPPDATA%\Xenon\xenon-native.exe.
      let installed = false;
      if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
        try {
          await fs.promises.access(path.join(process.env.LOCALAPPDATA, 'Xenon', 'xenon-native.exe'));
          installed = true;
        } catch { /* exe absent -> not installed */ }
      }
      json({ mode, installed });
    } catch (e) { err500(e.message); }
  },

  'GET /api/native/install-status': async (_req, _res, { json, err500 }) => {
    // Progress of an in-flight native-app install (install-native.ps1 writes the
    // marker at each stage). Lets the dashboard show downloading -> installing ->
    // done/error instead of a single optimistic "launched". Absent marker => idle.
    try {
      let st = { state: 'idle', error: '', at: '' };
      // readPwshJson strips the PS5 UTF-8 BOM; absent marker → idle.
      const m = await readPwshJson(path.join(DATA_DIR, 'native-install-status.json'));
      if (m && typeof m.state === 'string') {
        st = { state: m.state, error: String(m.error || ''), at: String(m.at || '') };
      }
      json(st);
    } catch (e) { err500(e.message); }
  },
};

module.exports = { branches };
