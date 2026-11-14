// Runs a request to OBS and, when OBS is not open and the user allows it, opens OBS and asks
// again.

const fs = require('node:fs');
const { _sleep, readObsInstallDir, launchObs } = require('./obs-launch.js');
const { broadcastSSE } = require('../http/sse-clients.js');
const obsLaunch = require('../actions/obs-launch.js');
const { readHubSettings } = require('../settings/read.js');
const { obsStarting } = require('./obs-starting-state.js');

function _finishObsLaunch(ok) {
  if (!obsStarting.launching) return;
  obsStarting.launching = false;
  broadcastSSE('obs_launching', { launching: false, ok: !!ok });
}

// Run an OBS request; if it fails because OBS is unreachable AND auto-launch is on
// AND OBS is found, launch OBS and retry the SAME request until it connects (≤25s).
async function ensureObsRun(runFn) {
  try { return await runFn(); }
  catch (err) {
    if (!obsLaunch.isConnError(err)) throw err;                 // a real request error: surface it
    const s = (await readHubSettings().catch(() => null)) || {};
    if (s.obsAutoLaunch === false) throw err;                   // user opted out
    const exe = await obsLaunch.findObsExe({ readInstallDir: readObsInstallDir, fileExists: (p) => { try { return fs.existsSync(p); } catch { return false; } } });
    if (!exe) throw err;                                        // OBS not installed / not found
    if (!obsStarting.launching) { obsStarting.launching = true; broadcastSSE('obs_launching', { launching: true }); launchObs(exe); }
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      await _sleep(3000);
      try { const r = await runFn(); _finishObsLaunch(true); return r; }
      catch (e2) { if (!obsLaunch.isConnError(e2)) { _finishObsLaunch(true); throw e2; } } // OBS is up; the action itself failed
    }
    _finishObsLaunch(false);                                    // OBS never came up in time
    throw err;
  }
}

module.exports = { _finishObsLaunch, ensureObsRun };
