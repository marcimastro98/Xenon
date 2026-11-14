'use strict';
// Whether a game is in front and whether it is still running: the full-screen window or the
// windowed one the frame reader confirms, the grace time, the user's own list, the process that
// is asked if it lives.

const { IGNORE_PROC_RE, WINDOWED_IGNORE_RE } = require('./game-ignore-lists.js');
const { gameWatch } = require('./game-watch-state.js');

const STALE_MS = 6000;           // ignore probe data older than this
const GRACE_MS = 4000;           // stay "gaming" briefly across focus blips (Alt-Tab, alerts)

const WINDOWED_MIN_FPS = 24;

// Windowed/borderless game: the focused (non-fullscreen) window belongs to the
// same process PresentMon sees presenting flip-model frames at game-like rates.
// Focus + flip-model + rate together avoid the old false positives (browsers,
// the dashboard host, background video) that raw frame-rate detection had.
function _windowedGameActive(s) {
  if (!gameWatch.hint || !s || s.fullscreen) return false;
  if (!s.process || isIgnoredProc(s.process) || WINDOWED_IGNORE_RE.test(s.process)) return false;
  let hint = null;
  try { const ask = gameWatch.hint; hint = ask(); } catch { return false; }
  if (!hint || !hint.name || !Number.isFinite(hint.fps) || hint.fps < WINDOWED_MIN_FPS) return false;
  const hintName = String(hint.name).toLowerCase().replace(/\.exe$/, '');
  return hintName !== '' && hintName === s.process.replace(/\.exe$/, '');
}


function bareName(name) {
  return String(name || '').trim().toLowerCase().replace(/\.exe$/, '');
}

function userIgnore() {
  let list = null;
  try { const source = gameWatch.ignoreSource; list = source ? source() : null; } catch { list = null; }
  if (list === gameWatch.ignoreRef) return gameWatch.ignoreSet;
  gameWatch.ignoreRef = list;
  gameWatch.ignoreSet = new Set((Array.isArray(list) ? list : []).map(bareName).filter(Boolean));
  // The game tracked right now was just ruled out: stop tracking it here, or
  // the PID check would hold "a game is running" (and game mode) until it closed.
  if (gameWatch.gameProc && gameWatch.ignoreSet.has(gameWatch.gameProc)) {
    gameWatch.gamePid = 0; gameWatch.gameProc = ''; gameWatch.pidFirstDeadAt = 0; gameWatch.lastGamingAt = 0;
  }
  return gameWatch.ignoreSet;
}

function isIgnoredProc(name) {
  if (!name) return false;
  return IGNORE_PROC_RE.test(name) || userIgnore().has(bareName(name));
}

const PID_DEAD_CONFIRM_MS = 2500; // a second negative this much later confirms the game exited

// True while a real game owns the FOREGROUND window — full-screen, or windowed when
// the PresentMon hint confirms it is the active presenter. A short grace window
// keeps it stable across brief focus changes so game mode doesn't blink. Drives
// game-mode/performance (which should follow focus — effects resume when you tab
// out). The Companion pill uses isGameRunning() instead.
function isGaming() {
  const s = gameWatch.last;
  if (s && (Date.now() - s.at) < STALE_MS && !isIgnoredProc(s.process)
      && (s.fullscreen || _windowedGameActive(s))) {
    gameWatch.lastGamingAt = Date.now();
    gameWatch.gameSeenAt = gameWatch.lastGamingAt;
    gameWatch.gameProc = String(s.process || '').toLowerCase().replace(/\.exe$/, '');  // remember the real game
    gameWatch.gamePid = Number(s.pid) || 0;
    gameWatch.pidFirstDeadAt = 0;
    return true;
  }
  if (gameWatch.lastGamingAt > 0 && (Date.now() - gameWatch.lastGamingAt) < GRACE_MS) {
    // The grace window exists to ride out focus blips while the game is still
    // alive (Alt-Tab, notification popups). If the remembered game process is
    // gone, the user actually closed it — drop game mode right away instead of
    // sitting out the rest of the grace.
    if (gameWatch.gamePid && !_pidAlive(gameWatch.gamePid)) { gameWatch.lastGamingAt = 0; return false; }
    return true;
  }
  return false;
}

// PID liveness probe: signal 0 doesn't signal, it only checks existence.
// EPERM means the process exists but is elevated → alive.
function _pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return !!(e && e.code === 'EPERM'); }
}

// True while the game is still RUNNING — foreground OR backgrounded/minimised —
// verified by probing the remembered PID for liveness (signal 0). This is what the
// Game Companion pill follows: it stays available the whole time the game is alive
// (so tapping the touchscreen doesn't drop it) and disappears the moment the game
// exits — no arbitrary linger, and never pinned to a bystander like iCUE.
function isGameRunning() {
  if (isGaming()) { gameWatch.gameSeenAt = Date.now(); return true; }   // foreground / grace
  if (!gameWatch.gamePid) return false;
  if (_pidAlive(gameWatch.gamePid)) { gameWatch.pidFirstDeadAt = 0; gameWatch.gameSeenAt = Date.now(); return true; }
  // The PID probe reported the game as gone (ESRCH). Don't end the session on a
  // single negative — it can be a transient quirk — but a second negative a
  // beat later confirms the exit for real. (Replaces the old flat 15s linger:
  // same protection, and the Companion pill / auto-restore react in ~3s.)
  const now = Date.now();
  if (!gameWatch.pidFirstDeadAt) { gameWatch.pidFirstDeadAt = now; return true; }
  if (now - gameWatch.pidFirstDeadAt < PID_DEAD_CONFIRM_MS) return true;
  gameWatch.gamePid = 0; gameWatch.gameProc = ''; gameWatch.pidFirstDeadAt = 0;
  return false;
}

module.exports = {
  STALE_MS, GRACE_MS, WINDOWED_MIN_FPS, _windowedGameActive, bareName, userIgnore, isIgnoredProc,
  PID_DEAD_CONFIRM_MS, isGaming, _pidAlive, isGameRunning,
};
