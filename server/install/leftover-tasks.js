// Tidies the scheduled tasks an older version may have left behind, a minute after start, and
// says how often the start task is checked.

const { execFile } = require('node:child_process');
const { POWERSHELL_SUPPORTED } = require('../powershell/supported.js');
const { reconcileBrowserAutoOpenTask } = require('./browser-auto-open-task.js');

const STARTUP_TASK_CHECK_MS = 6 * 60 * 60 * 1000;   // twice a working day is plenty

// Scheduled tasks that only matter at the next sign-in, so nobody waits for them.
const LEFTOVER_TASKS_DELAY_MS = 60 * 1000;
function tidyLeftoverTasks() {
  // The task older versions registered to open the dashboard in a browser at
  // sign-in runs a script that no longer ships, and greets the user with an
  // error box at every sign-in. The engine opens that tab itself now, so the
  // task is removed, and what it meant is kept (browser-auto-open-task.js).
  // One read of one task; it writes only where the task is still there.
  reconcileBrowserAutoOpenTask().catch(() => {});
  // OpenRGB was removed from the product. Tear down anything a previous version
  // may have left so it never launches itself again: drop the auto-start
  // scheduled task (one fire-and-forget call, silent if absent).
  if (POWERSHELL_SUPPORTED) {
    try { execFile('schtasks', ['/Delete', '/TN', 'XenonEdge OpenRGB', '/F'], { windowsHide: true }, () => {}); } catch { /* ignore */ }
  }
}

module.exports = { STARTUP_TASK_CHECK_MS, LEFTOVER_TASKS_DELAY_MS, tidyLeftoverTasks };
