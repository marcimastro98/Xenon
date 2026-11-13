// Tidies the scheduled tasks an older version may have left behind, a minute after start, and
// says how often the start task is checked.

const { execFile } = require('node:child_process');
const { POWERSHELL_SUPPORTED } = require('../powershell/supported.js');
const { reconcileBrowserAutoOpenTask } = require('./browser-auto-open-task.js');

const STARTUP_TASK_CHECK_MS = 6 * 60 * 60 * 1000;   // twice a working day is plenty

// Scheduled tasks that only matter at the next sign-in, so nobody waits for them.
const LEFTOVER_TASKS_DELAY_MS = 60 * 1000;
function tidyLeftoverTasks() {
  // The logon task that opens the dashboard in a browser outlives the script it
  // points at, and a stale one greets the user with a wscript error box at every
  // sign-in (see reconcileBrowserAutoOpenTask). It reads one scheduled task, and
  // only writes when something is out of step.
  reconcileBrowserAutoOpenTask().catch(() => {});
  // OpenRGB was removed from the product. Tear down anything a previous version
  // may have left so it never launches itself again: drop the auto-start
  // scheduled task (one fire-and-forget call, silent if absent).
  if (POWERSHELL_SUPPORTED) {
    try { execFile('schtasks', ['/Delete', '/TN', 'XenonEdge OpenRGB', '/F'], { windowsHide: true }, () => {}); } catch { /* ignore */ }
  }
}

module.exports = { STARTUP_TASK_CHECK_MS, LEFTOVER_TASKS_DELAY_MS, tidyLeftoverTasks };
