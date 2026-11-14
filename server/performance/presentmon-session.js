'use strict';
// The names of Xenon's own ETW sessions for PresentMon, and how a session that a killed
// PresentMon left behind is stopped.

const { spawn } = require('node:child_process');

// Dedicated ETW session name. PresentMon's default name ("PresentMon") is
// shared territory: other frame tools use the same collector, and our
// -stop_existing_session would steal the session from whoever owns it (the
// NVIDIA App's FPS overlay reads frames through the same mechanism). With our
// own name, -stop_existing_session only ever clears a stale session left by a
// previous unclean Xenon exit — never another tool's.
const ETW_SESSION_NAME = 'XenonFps';
const GAME_SESSION_NAME = `${ETW_SESSION_NAME}Game`;

// A killed PresentMon cannot clean up after itself: proc.kill() is
// TerminateProcess on Windows, and the ETW session it registered survives the
// process — until reboot — unless stopped explicitly. logman ships with
// Windows. Without the admin rights PresentMon needs, no session was ever
// created and the stop fails; every outcome is deliberately ignored.
function stopEtwSession(name = ETW_SESSION_NAME) {
  if (process.platform !== 'win32') return;
  try {
    spawn('logman.exe', ['stop', name, '-ets'], { windowsHide: true, stdio: 'ignore' })
      .on('error', () => { /* ignore */ })
      .unref(); // must never delay server shutdown
  } catch { /* ignore */ }
}

module.exports = { ETW_SESSION_NAME, GAME_SESSION_NAME, stopEtwSession };
