// The Windows task that opens the dashboard in a browser at sign-in: whether this system has
// it, and how to repair one that points at the wrong place.

const AUTO_OPEN_SUPPORTED = process.platform === 'win32';

// What to do with the logon task, given where it points and what is on disk:
//   'none'   — no task at all, or one that already points at the launcher we ship;
//   'repair' — it points somewhere else (an install that moved) while the launcher
//              is right here, so re-register it at the correct path;
//   'remove' — there is no launcher any more, so the task can only produce the
//              wscript error box. Take it out rather than leave it firing forever.
// It never answers 'create': a task is only ever registered by an explicit choice
// in the dashboard, so a pure-Edge install cannot grow a surprise browser tab out
// of a repair pass. Pure, so the rule is testable without a Windows scheduler.
function autoOpenTaskFix(state) {
  // The task stores its target as a quoted wscript argument, so the quotes come
  // back with it. Windows paths are case-insensitive and accept either slash.
  const norm = (p) => String(p == null ? '' : p)
    .trim()
    .replace(/^"+|"+$/g, '')
    .replace(/\//g, '\\')
    .replace(/\\+$/, '')
    .toLowerCase();
  const taskScript = norm(state && state.taskScript);
  if (!taskScript) return 'none';                       // nothing registered
  if (!(state && state.launcherPresent)) return 'remove';
  return taskScript === norm(state.scriptPath) ? 'none' : 'repair';
}

module.exports = { AUTO_OPEN_SUPPORTED, autoOpenTaskFix };
