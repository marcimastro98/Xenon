// Removes the Windows task older versions registered to open the dashboard in a browser at
// sign-in, and keeps what it stood for: whoever had it asked for that tab.

const { PORT, updateHubSettingKey } = require('./engine-link.js');
const { INSTALLED_PORT } = require('./browser-auto-open.js');
const { runSchtasks } = require('../startup-task.js');

// Up to 5.1.0 a per-user scheduled task ran a small script at sign-in, and the script opened
// the browser. Antivirus software deletes that script, a task left without it shows an error
// box at every sign-in, and the script no longer ships. The engine opens the tab itself now
// (sign-in-open.js), so this task is only ever removed.
//
// The task was registered from a dashboard with the switch on and never by an installer, so
// finding it is the one trace left that this person had the feature on. That is written to
// the settings first and the task is deleted after: when the save or the delete fails the
// task stays, and every later start tries again. While the task is there the engine opens no
// tab of its own (sign-in-windows.js oldLauncher), so the two never open one each.
const BROWSER_TASK_NAME = 'Xenon Edge Dashboard';
const SCHTASKS_TIMEOUT_MS = 8000;

// The server-owned half of the switch (DEFAULT_HUB_SETTINGS in server.js): a real browser asked.
function armAutoOpen() {
  return updateHubSettingKey('autoOpenArmed', () => true);
}

/**
 * @param {{ platform?: string, port?: number, run?: (args: string[], opts?: object) => Promise<any>,
 *   arm?: () => Promise<any> }} [deps] stand-ins for tests: no test may reach the real scheduler
 * @returns {Promise<'not_here' | 'no_task' | 'removed' | 'kept'>}
 */
async function retireBrowserTask({ platform = process.platform, port = PORT, run = runSchtasks, arm = armAutoOpen } = {}) {
  // A copy beside the installed engine has its own settings: it must neither take the
  // installed engine's task away nor keep what the task meant in the wrong place.
  if (platform !== 'win32' || port !== INSTALLED_PORT) return 'not_here';
  const opts = { timeout: SCHTASKS_TIMEOUT_MS };
  try { await run(['/Query', '/TN', BROWSER_TASK_NAME], opts); } catch { return 'no_task'; }   // the usual case
  try {
    await arm();
    await run(['/Delete', '/TN', BROWSER_TASK_NAME, '/F'], opts);
    return 'removed';
  } catch {
    return 'kept';
  }
}

// Called a minute after start with the other leftovers (tidyLeftoverTasks in server.js). By then this
// start has already decided about its own tab, so the first start after the update opens
// nothing: the tab comes back with the next sign-in.
async function reconcileBrowserAutoOpenTask() {
  const outcome = await retireBrowserTask();
  if (outcome === 'removed') console.log('[startup] removed the old task "' + BROWSER_TASK_NAME + '": the engine opens the browser itself now');
  if (outcome === 'kept') console.log('[startup] the old task "' + BROWSER_TASK_NAME + '" is still there: no browser tab from the engine meanwhile, tried again at the next start');
}

module.exports = { BROWSER_TASK_NAME, retireBrowserTask, reconcileBrowserAutoOpenTask };
