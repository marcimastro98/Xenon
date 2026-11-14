'use strict';
// How long nobody has touched a Linux PC, from logind or xprintidle.

const { run, splitLines } = require('./linux-read.js');

// --- Idle time, from logind ---------------------------------------------------
// There is no one Linux answer: X11 has XScreenSaver, Wayland compositors each
// have their own. logind's per-user IdleHint is the common ground, set by the
// desktop session (GNOME, KDE) when it considers the user idle. A desktop that
// never sets it leaves IdleSinceHint at 0 and IdleHint at "no" forever, which
// must NOT read as "someone is always here" (the automatic updater would never
// run) nor as "idle" (it would run on top of the user): it is null, unknown,
// and the caller falls back to its night window. The value is the time since
// the session DECLARED idle, so it undercounts, which errs toward waiting.
function parseLoginctlIdle(text, nowMs) {
  const props = {};
  for (const line of splitLines(text)) {
    const i = line.indexOf('=');
    if (i > 0) props[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const sinceUs = Number(props.IdleSinceHint);
  if (!Number.isFinite(sinceUs) || sinceUs <= 0) return null;
  if (props.IdleHint === 'no') return 0;
  if (props.IdleHint !== 'yes') return null;
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  return Math.max(0, Math.floor((now * 1000 - sinceUs) / 1e6));
}
// On X11 `xprintidle` (when installed) reads the XScreenSaver extension: the
// exact time since the last input, in milliseconds. Not on Wayland, where it
// would only see the XWayland apps.
function parseXprintidle(text) {
  const t = String(text || '').trim();
  if (!/^\d{1,15}$/.test(t)) return null;
  return Math.floor(Number(t) / 1000);
}
async function idleSeconds() {
  if (process.env.DISPLAY && process.env.XDG_SESSION_TYPE !== 'wayland' && !process.env.WAYLAND_DISPLAY) {
    try {
      const sec = parseXprintidle(await run('xprintidle', [], 4000));
      if (sec != null) return sec;
    } catch { /* not installed: logind below */ }
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (uid == null) return null;
  try {
    const out = await run('loginctl', ['show-user', String(uid), '-p', 'IdleHint', '-p', 'IdleSinceHint'], 4000);
    return parseLoginctlIdle(out, Date.now());
  } catch { return null; }
}

module.exports = { parseLoginctlIdle, parseXprintidle, idleSeconds };
