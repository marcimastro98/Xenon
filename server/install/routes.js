// What the engine answers about opening the dashboard at sign-in.

const { autoOpenSwitch } = require('./auto-open-switch.js');
const { readBody } = require('../http/read-body.js');
const path = require('node:path');
const fs = require('node:fs');
const { nativeInstall } = require('../updates/native-install-state.js');
const { DATA_DIR } = require('../engine/paths.js');
const { createNativeInstallerFetch } = require('../updates/native-installer.js');
const { spawn } = require('node:child_process');

const SERVER_DIR = path.join(__dirname, '..');

/** @type {Record<string, (req: any, res: any, context: any, engine?: any) => Promise<void>>} */
const branches = {
  'GET /startup/auto-open': async (_req, _res, { json, err500 }) => {
    // Whether the switch is shown (`supported`) and whether a real browser asked
    // for the tab (`enabled`): auto-open-switch.js.
    try { json(await autoOpenSwitch.state()); } catch (e) { err500(e.message); }
  },

  'POST /startup/auto-open': async (req, _res, { json, err500 }) => {
    // Posted by the dashboard in a real browser at the PC, and by nothing else:
    // the engine refuses this address to a paired device and to another site.
    try {
      const body = JSON.parse(await readBody(req));
      json(await autoOpenSwitch.turn(!!body && body.enabled === true));
    } catch (e) { err500(e.message); }
  },

  'GET /api/startup-task': async (_req, _res, { json }, { startupTaskCheck }) => {
    // Will Xenon still be here after the next sign-in? Answered from the last
    // check (boot, then every few hours) rather than by spawning schtasks per
    // request — the answer changes on the timescale of somebody running a
    // cleanup tool, not of a page load. `repaired` names conditions this engine
    // put back on its own, which the user is entitled to be told about.
    json({
      ok: true,
      checked: startupTaskCheck.last.checked,
      found: startupTaskCheck.last.found,
      problems: startupTaskCheck.last.problems,
      repaired: startupTaskCheck.last.repaired,
      failed: startupTaskCheck.last.failed,
      at: startupTaskCheck.last.at,
    });
  },

  'POST /api/native/install': async (req, _res, { json }) => {
    // One-click install of the native kiosk app from the dashboard (offered to
    // iCUE/browser users). The installer runs SILENTLY and, under the LocalSystem
    // service, in the user's session through a scheduled task, so nobody sees what
    // is executed: it is downloaded HERE and checked against the release's
    // Ed25519-signed SHA256SUMS with the pinned key (native-installer.js) before
    // install-native.ps1 is ever started. A download that does not verify is
    // deleted and reported as an error; nothing runs. The script gets the verified
    // path and its signed hash and re-checks the hash before launching.
    // Do NOT pass detached:true here — Windows PowerShell (powershell.exe) fails to
    // initialize its host when started with DETACHED_PROCESS (no console), so the
    // script silently never runs (the install button looked like it hung). stdio:
    // 'ignore' + unref() already detach enough: the child outlives the request.
    try {
      await readBody(req);
      if (process.platform !== 'win32') { json({ ok: false, error: 'windows_only' }); return; }
      const script = path.join(SERVER_DIR, 'install-native.ps1');
      try { await fs.promises.access(script); } catch { json({ ok: false, error: 'helper_missing' }); return; }
      // A second tap while a download is in flight joins it rather than starting a
      // second writer on the same file.
      if (nativeInstall.inFlight) { json({ ok: true }); return; }
      const statusFile = path.join(DATA_DIR, 'native-install-status.json');
      const writeStatus = (state, error) => fs.promises.writeFile(
        statusFile, JSON.stringify({ state, error: error || '', at: new Date().toISOString() })
      ).catch(() => { /* non-fatal: the poll just falls back to a timeout */ });
      // Reset the progress marker so the dashboard's poll starts clean and never
      // reads a stale 'error'/'done' from a previous attempt. The download is now
      // ours, so we report it; the PS script takes over at installing -> done/error.
      await writeStatus('downloading', '');
      json({ ok: true });
      nativeInstall.inFlight = (async () => {
        const got = await createNativeInstallerFetch({ destDir: path.join(DATA_DIR, 'native-installer') }).fetchVerified();
        if (!got.ok) { await writeStatus('error', got.error); return; }
        const child = spawn('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
          '-InstallerPath', got.path, '-ExpectedSha256', got.sha256,
        ], { windowsHide: true, stdio: 'ignore' });
        child.on('error', () => { writeStatus('error', 'helper_missing'); });
        child.unref();
      })().catch(() => writeStatus('error', 'download_failed'))
        .finally(() => { nativeInstall.inFlight = null; });
    } catch (e) { json({ ok: false, error: String((e && e.message) || e) }); }
  },
};

module.exports = { branches };
