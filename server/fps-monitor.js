'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// fps-monitor.js — one FPS interface, whichever platform is underneath.
//
// server.js drives frame-rate reading through nine calls (start/stop/pause/
// resume, getCurrentFps, getGamingProcess, isGaming, isAvailable, reload). That
// vocabulary was PresentMon's, and fpsmon.js returns null on every non-Windows
// platform, so this file is what lets a second backend exist without those nine
// call sites growing a platform branch each.
//
// Windows keeps PresentMon (ETW: every present by every process, no
// cooperation needed). Linux gets MangoHud, which is a fundamentally different
// bargain — it only sees games launched under it — and that difference is
// deliberately NOT hidden from the user: isAvailable() reports whether the
// backend could work at all, and the dashboard says which one it is. macOS has
// neither and keeps the null-returning stub.
// ─────────────────────────────────────────────────────────────────────────────

if (process.platform === 'linux') {
  const { createLinuxFps } = require('./linux-fps');
  const impl = createLinuxFps();
  let started = false;

  // start() writes the MangoHud config and is therefore async, while the
  // Windows entry points are synchronous. Callers only ever fire and forget, so
  // the promise is swallowed here rather than pushed up into server.js.
  const kick = () => {
    if (started) return;
    started = true;
    impl.start().catch(() => { /* no MangoHud, or an unwritable config */ });
  };

  module.exports = {
    startFpsMonitor: kick,
    resumeFpsMonitor: () => { if (started) impl.resume(); else kick(); },
    pauseFpsMonitor: () => impl.pause(),
    stopFpsMonitor: () => impl.stop(),
    getCurrentFps: () => impl.getCurrentFps(),
    // MangoHud reports one frame rate — the game's own. There is no display-side
    // number to compare it with, so the pair is answered honestly rather than by
    // repeating `fps` twice under two names: a widget that gets `displayFps: null`
    // knows this platform cannot tell it, instead of being told they are equal.
    getFpsDetail: () => ({ fps: impl.getCurrentFps(), presentFps: impl.getCurrentFps(), displayFps: null }),
    setForegroundPid: () => { /* MangoHud only ever sees the game it launched */ },
    getGamingProcess: () => impl.getGamingProcess(),
    isGaming: () => impl.isGaming(),
    isAvailable: () => impl.isAvailable(),
    reload: () => { impl.reload().catch(() => {}); },
    backend: 'mangohud',
    logDir: impl.logDir,
    configPath: impl.configPath,
  };
} else {
  module.exports = { ...require('./fpsmon'), backend: process.platform === 'win32' ? 'presentmon' : null };
}
