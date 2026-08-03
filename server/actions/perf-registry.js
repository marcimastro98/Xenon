'use strict';
// Server-side allowlisted dispatcher for Performance Mode's system actions —
// the single place where guided app close/relaunch executes. Validation happens
// at this boundary (shared catalog) and OS side-effects are INJECTED so the
// security decisions live in one testable place, exactly like actions/registry.js.
const { validatePerfAction } = require('../js/performance-actions.js');
const { isAllowedAppPath } = require('./registry.js');

// deps: {
//   closeWindow(id)->Promise<{ok,app,path,error}>  graceful WM_CLOSE by HWND,
//   openExternal(path)->Promise                    launch an .exe/.lnk/.app,
//   launchApp(path)->Promise<{ok,error}>           Linux launcher (.desktop/binary),
//   fileExists(path)->bool,
//   setPriority(name, level)->Promise<{ok,...}>     reversible priority nudge,
//   platform: override for the extension gate (tests)
// }
function createPerfRegistry(deps) {
  const d = deps || {};
  const platform = d.platform || process.platform;
  async function run(rawAction) {
    const action = validatePerfAction(rawAction);
    if (!action) return { ok: false, error: 'unknown_action' };
    try {
      switch (action.type) {
        case 'closeApp': {
          if (typeof d.closeWindow !== 'function') return { ok: false, error: 'unavailable' };
          // The window helper resolves the process, refuses protected OS
          // processes, and returns the executable path for later relaunch.
          const r = await d.closeWindow(action.id);
          return r && typeof r === 'object' ? r : { ok: false, error: 'close_failed' };
        }
        case 'launchApp': {
          const p = action.path.trim();
          // Only real executables/shortcuts may be launched, and only if present
          // — mirrors the Deck registry's openApp guard, including the Linux
          // route: xdg-open opens documents, it does not run programs.
          if (!isAllowedAppPath(p, platform)) return { ok: false, error: 'bad_app_path' };
          if (!d.fileExists(p)) return { ok: false, error: 'not_found' };
          if (platform === 'linux') {
            if (typeof d.launchApp !== 'function') return { ok: false, error: 'unavailable' };
            const r = await d.launchApp(p);
            return r && r.ok === false ? { ok: false, error: r.error || 'launch_failed' } : { ok: true };
          }
          await d.openExternal(p);
          return { ok: true };
        }
        case 'setPriority': {
          if (typeof d.setPriority !== 'function') return { ok: false, error: 'unavailable' };
          // The helper refuses OS-critical processes and only uses AboveNormal.
          const r = await d.setPriority(action.name, action.level);
          return r && typeof r === 'object' ? r : { ok: false, error: 'priority_failed' };
        }
        default: return { ok: false, error: 'unsupported' };
      }
    } catch (err) {
      return { ok: false, error: (err && err.message) || 'effect_error' };
    }
  }
  return { run };
}

module.exports = { createPerfRegistry };
